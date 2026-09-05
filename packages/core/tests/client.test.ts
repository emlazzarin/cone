import { describe, expect, test } from 'bun:test';

import {
  createConeClient,
  deriveAccount,
  encryptJson,
  MemoryStore,
  secretKeyFromHexSeed,
  type ConeConsentState,
  type ConeConversation,
  type ConeEnvelope,
  type ConeGroupMember,
  type ConeIdentity,
  type ConsentFilter,
  type CreateGroupOptions,
  type IncomingMessage,
  type MessageHandler,
  type MessageRetention,
  type ResolvedIdentity,
  type SentMessage,
  type XmtpAdapter,
} from '../src/index';

describe('ConeClient', () => {
  test('saves contacts, deduplicates by inbox ID, and sends by contact name', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);

    await client.saveContact({ name: 'Alice', inboxId: 'inbox-alice', address: '0x1111111111111111111111111111111111111111' });
    await client.saveContact({ name: 'Alice Renamed', inboxId: 'inbox-alice' });

    const contacts = await client.listContacts();
    expect(contacts.filter((contact) => contact.inboxId === 'inbox-alice')).toHaveLength(1);
    expect(contacts.find((contact) => contact.inboxId === 'inbox-alice')?.name).toBe('Alice Renamed');

    const sent = await client.sendText('Alice Renamed', 'hello');
    expect(sent.messageId).toBe('sent-1');
    expect(adapter.sent[0]).toEqual({ inboxId: 'inbox-alice', text: 'hello' });
    expect((await client.listMessages())[0]?.text).toBe('hello');
    expect((await client.listMessages())[0]?.direction).toBe('outbound');
  });

  test('rejects sends to unreachable identities', async () => {
    const adapter = new FakeAdapter({ blockedInboxIds: ['inbox-blocked'] });
    const client = await makeClient(adapter);
    await client.saveContact({ name: 'Blocked', inboxId: 'inbox-blocked' });

    await expect(client.sendText('Blocked', 'hello')).rejects.toThrow(/not XMTP-reachable/i);
  });

  test('rejects duplicate contact names that point to different inboxes', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);

    await client.saveContact({ name: 'Dana', inboxId: 'inbox-dana' });

    await expect(client.saveContact({ name: 'Dana', inboxId: 'inbox-other' })).rejects.toThrow(/contact name already exists/i);
    await expect(client.saveContact({ name: 'Dana', inboxId: 'inbox-dana' })).resolves.toMatchObject({
      inboxId: 'inbox-dana',
      name: 'Dana',
    });
  });

  test('an unknown inbound sender becomes a Request conversation, not a contact', async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const client = await makeClient(adapter, store);
    const events: IncomingMessage[] = [];

    await client.streamMessages((message) => {
      events.push(message);
    }, { consentStates: ['allowed', 'unknown'] });
    await adapter.emit({
      conversationId: 'dm-inbound',
      conversationKind: 'dm',
      messageId: 'msg-inbound',
      raw: {},
      senderAddress: '0x2222222222222222222222222222222222222222',
      senderInboxId: 'inbox-inbound',
      sentAt: new Date().toISOString(),
      text: 'hi',
    });

    expect(events).toHaveLength(1);
    // No address-book entry is created for an unknown sender.
    expect((await client.listContacts()).some((contact) => contact.inboxId === 'inbox-inbound')).toBe(false);
    // It lands as an unknown-consent conversation (a Request).
    const conversation = (await client.listConversations()).find((entry) => entry.conversationId === 'dm-inbound');
    expect(conversation?.consentState).toBe('unknown');
    expect((await client.listMessages('dm-inbound'))[0]?.text).toBe('hi');
    expect((await client.listMessages('dm-inbound'))[0]?.direction).toBe('inbound');

    const backup = await client.exportBackup();
    const restored = new MemoryStore();
    const restoredClient = await makeClient(adapter, restored);
    await restoredClient.importBackup(backup);

    // The Request conversation (and its consent mirror) survives a backup round-trip.
    expect((await restoredClient.listConversations()).find((entry) => entry.conversationId === 'dm-inbound')?.consentState).toBe('unknown');
  });

  test('new accepted DMs stream immediately while strangers stay outside the agent handler', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    await client.saveContact({ name: 'Peer', inboxId: 'inbox-peer' });
    const received: string[] = [];
    await client.streamMessages(message => { received.push(message.messageId); });
    const message = { conversationId: 'dm-new', conversationKind: 'dm' as const, messageId: 'accepted', senderInboxId: 'inbox-peer', text: 'hello', sentAt: '2026-01-01T00:00:00.000Z', raw: {} };
    await adapter.emit(message);
    await adapter.emit({ ...message, conversationId: 'dm-stranger', messageId: 'request', senderInboxId: 'inbox-stranger' });
    await client.setConsent({ inboxId: 'inbox-peer' }, 'denied');
    await adapter.emit({ ...message, conversationId: 'dm-bypass', messageId: 'blocked' });
    expect(received).toEqual(['accepted']);
    expect(adapter.streamFilter).toEqual({ consentStates: ['allowed', 'unknown'] });
  });

  test('sending implies consent and marks the conversation allowed', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    await client.saveContact({ name: 'Eve', inboxId: 'inbox-eve' });
    adapter.consent.clear(); // ignore the manual-add consent write

    await client.sendText('Eve', 'hello');

    expect(adapter.consent.get('inbox-eve')).toBe('allowed');
    const conversation = (await client.listConversations()).find((entry) => entry.peerInboxId === 'inbox-eve');
    expect(conversation?.consentState).toBe('allowed');
  });

  test('accepting and blocking set peer consent and update the local mirror', async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const client = await makeClient(adapter, store);
    await client.streamMessages(() => {}, { consentStates: ['allowed', 'unknown'] });
    await adapter.emit({
      conversationId: 'dm-req',
      conversationKind: 'dm',
      messageId: 'msg-req',
      raw: {},
      senderInboxId: 'inbox-stranger',
      sentAt: new Date().toISOString(),
      text: 'gm',
    });

    await client.setConsent({ inboxId: 'inbox-stranger' }, 'allowed');
    expect(adapter.consent.get('inbox-stranger')).toBe('allowed');
    expect((await client.listConversations()).find((entry) => entry.conversationId === 'dm-req')?.consentState).toBe('allowed');

    await client.setConsent({ inboxId: 'inbox-stranger' }, 'denied');
    expect(adapter.consent.get('inbox-stranger')).toBe('denied');
    expect((await client.listConversations()).find((entry) => entry.conversationId === 'dm-req')?.consentState).toBe('denied');
  });

  test('a known contact\'s inbound message is allowed, never a Request', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    await client.saveContact({ name: 'Frank', inboxId: 'inbox-frank' });
    await client.streamMessages(() => {}, { consentStates: ['allowed', 'unknown'] });

    await adapter.emit({
      conversationId: 'dm-frank',
      conversationKind: 'dm',
      messageId: 'msg-frank',
      raw: {},
      senderInboxId: 'inbox-frank',
      sentAt: new Date().toISOString(),
      text: 'hi',
    });

    expect((await client.listConversations()).find((entry) => entry.conversationId === 'dm-frank')?.consentState).toBe('allowed');
  });

  test('classifies Cone protocol envelopes as control messages', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);

    await client.streamMessages(() => {});
    // Envelopes arrive with json only — they ride the Cone envelope content
    // type, never text.
    await adapter.emit({
      conversationId: 'dm-control',
      conversationKind: 'dm',
      json: {
        type: 'cone.pair.confirm.v1',
        inboxId: 'inbox-peer',
        codeAcceptedAt: new Date().toISOString(),
      },
      messageId: 'msg-control',
      raw: {},
      senderInboxId: 'inbox-peer',
      sentAt: new Date().toISOString(),
    });

    const [message] = await client.listMessages('dm-control');
    expect(message?.kind).toBe('control');
    expect(message?.json).toMatchObject({ type: 'cone.pair.confirm.v1' });
  });

  test('sendReadReceipt publishes a cone.read.v1 envelope without persisting it locally', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);

    await client.sendReadReceipt({ inboxId: 'inbox-peer' });

    // Receipts ride the envelope content type, never the text one.
    expect(adapter.sentEnvelopes.at(-1)).toEqual({ inboxId: 'inbox-peer', envelope: { type: 'cone.read.v1' } });
    expect(adapter.sent).toHaveLength(0);
    // Our own receipts are fire-and-forget; only the peer's receipts matter.
    expect(await client.listMessages()).toHaveLength(0);
  });

  test('sync persists conversations and messages into the local read model', async () => {
    const adapter = new FakeAdapter();
    adapter.conversations = [{
      conversationId: 'dm-synced',
      kind: 'dm' as const, peerInboxId: 'inbox-peer', consentState: 'allowed',
      title: 'inbox-peer',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }];
    adapter.networkMessages = [{
      conversationId: 'dm-synced',
      conversationKind: 'dm',
      messageId: 'msg-synced',
      raw: {},
      senderInboxId: 'inbox-peer',
      sentAt: '2026-01-01T00:00:00.000Z',
      text: 'synced hello',
    }];
    const client = await makeClient(adapter);

    const result = await client.sync();

    expect(result).toMatchObject({ conversationsSynced: 1, messagesSynced: 1, ok: true });
    expect((await client.listConversations())[0]?.conversationId).toBe('dm-synced');
    expect((await client.listMessages('dm-synced'))[0]?.text).toBe('synced hello');
  });

  test('setRetention writes the local mirror and the network settings', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    await client.sendText({ inboxId: 'inbox-peer' }, 'hello');

    await client.setRetention('dm:inbox-peer', 3_600_000);
    const withTimer = (await client.listConversations()).find((entry) => entry.conversationId === 'dm:inbox-peer');
    expect(withTimer?.retention?.durationMs).toBe(3_600_000);
    expect(adapter.retention.get('dm:inbox-peer')?.durationMs).toBe(3_600_000);

    await client.setRetention('dm:inbox-peer', null);
    const withoutTimer = (await client.listConversations()).find((entry) => entry.conversationId === 'dm:inbox-peer');
    expect(withoutTimer?.retention).toBeUndefined();
    expect(adapter.retention.has('dm:inbox-peer')).toBe(false);
  });

  test('a failed network settings write still holds locally (mirror-first)', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    await client.sendText({ inboxId: 'inbox-peer' }, 'hello');
    adapter.failRetentionWrites = true;

    await client.setRetention('dm:inbox-peer', 60_000);

    const conversation = (await client.listConversations()).find((entry) => entry.conversationId === 'dm:inbox-peer');
    expect(conversation?.retention?.durationMs).toBe(60_000);
    expect(adapter.retention.size).toBe(0);
  });

  test('messages sent under the timer disappear; earlier history is exempt', async () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = () => new Date(nowMs);
    const adapter = new FakeAdapter();
    adapter.clock = clock;
    const store = new MemoryStore();
    const client = await makeClient(adapter, store, clock);

    await client.sendText({ inboxId: 'inbox-peer' }, 'pre-timer');
    nowMs += 1_000;
    await client.setRetention('dm:inbox-peer', 60_000);
    nowMs += 1_000;
    await client.sendText({ inboxId: 'inbox-peer' }, 'fleeting');

    // Before expiry both are visible; only the timed message carries expiresAt.
    let messages = await client.listMessages('dm:inbox-peer');
    expect(messages.map((message) => message.text)).toEqual(['pre-timer', 'fleeting']);
    expect(messages[0]?.expiresAt).toBeUndefined();
    expect(messages[1]?.expiresAt).toBe('2026-01-01T00:01:02.000Z');

    // Past expiry it is hidden from the read model immediately…
    nowMs += 2 * 60_000;
    messages = await client.listMessages('dm:inbox-peer');
    expect(messages.map((message) => message.text)).toEqual(['pre-timer']);
    expect(await store.listMessages('dm:inbox-peer')).toHaveLength(2);

    // …and deleted from Cone storage by the purge that runs on sync.
    await client.sync();
    expect(await store.listMessages('dm:inbox-peer')).toHaveLength(1);
  });

  test('turning the timer off keeps live messages but never resurrects expired ones', async () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = () => new Date(nowMs);
    const adapter = new FakeAdapter();
    adapter.clock = clock;
    const store = new MemoryStore();
    const client = await makeClient(adapter, store, clock);

    await client.sendText({ inboxId: 'inbox-peer' }, 'seed');
    nowMs += 1_000;
    await client.setRetention('dm:inbox-peer', 60_000);
    nowMs += 1_000;
    await client.sendText({ inboxId: 'inbox-peer' }, 'already gone');
    nowMs += 30_000;
    await client.sendText({ inboxId: 'inbox-peer' }, 'survivor');
    nowMs += 40_000; // 'already gone' is past its 60s; 'survivor' is not

    await client.setRetention('dm:inbox-peer', null);

    expect((await client.listMessages('dm:inbox-peer')).map((message) => message.text)).toEqual(['seed', 'survivor']);
    expect(await store.listMessages('dm:inbox-peer')).toHaveLength(2);

    // With the timer off, the survivor no longer expires.
    nowMs += 365 * 24 * 60 * 60_000;
    expect((await client.listMessages('dm:inbox-peer')).map((message) => message.text)).toEqual(['seed', 'survivor']);
  });

  test('sync reconciles a peer-initiated timer change into the mirror', async () => {
    const adapter = new FakeAdapter();
    const conversation: ConeConversation = {
      conversationId: 'dm-peer',
      kind: 'dm' as const, peerInboxId: 'inbox-peer',
      consentState: 'allowed',
      title: 'inbox-peer',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    adapter.conversations = [{ ...conversation, retention: { durationMs: 300_000, fromAt: '2026-01-01T00:00:00.000Z' } }];
    const client = await makeClient(adapter);

    await client.sync();
    expect((await client.listConversations())[0]?.retention?.durationMs).toBe(300_000);

    // The peer turned the timer off; the next sync clears the mirror.
    adapter.conversations = [conversation];
    await client.sync();
    expect((await client.listConversations())[0]?.retention).toBeUndefined();
  });

  test('backups never include expired messages', async () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = () => new Date(nowMs);
    const adapter = new FakeAdapter();
    adapter.clock = clock;
    const client = await makeClient(adapter, new MemoryStore(), clock);

    await client.sendText({ inboxId: 'inbox-peer' }, 'keep');
    nowMs += 1_000;
    await client.setRetention('dm:inbox-peer', 60_000);
    nowMs += 1_000;
    await client.sendText({ inboxId: 'inbox-peer' }, 'gone');
    nowMs += 2 * 60_000;

    const backup = await client.exportBackup();
    const restored = new MemoryStore();
    const restoredClient = await makeClient(adapter, restored, clock);
    await restoredClient.importBackup(backup);

    expect((await restoredClient.listMessages('dm:inbox-peer')).map((message) => message.text)).toEqual(['keep']);
    expect(await restored.listMessages('dm:inbox-peer')).toHaveLength(1);
  });

  test('createGroup resolves members, persists an allowed group row, and saves no contacts', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    await client.saveContact({ name: 'Alice', inboxId: 'inbox-alice' });

    const created = await client.createGroup({ name: 'Crew', members: ['Alice', { inboxId: 'inbox-bob' }, { inboxId: 'inbox-bob' }] });

    // Resolved through contacts, deduped; the creator is excluded (XMTP adds them).
    expect(adapter.createdGroups[0]?.memberInboxIds).toEqual(['inbox-alice', 'inbox-bob']);
    expect(adapter.createdGroups[0]?.options?.name).toBe('Crew');
    const conversation = (await client.listConversations()).find((entry) => entry.conversationId === created.conversationId);
    expect(conversation).toMatchObject({ kind: 'group', title: 'Crew', consentState: 'allowed' });
    // No auto-contacts: bob was never saved.
    expect((await client.listContacts()).some((contact) => contact.inboxId === 'inbox-bob')).toBe(false);
  });

  test('a group added by an address-book contact is auto-allowed (toggle default on)', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    await client.saveContact({ name: 'Adder', inboxId: 'inbox-adder' });
    adapter.conversations = [{
      conversationId: 'group-w',
      kind: 'group',
      title: 'Crew',
      groupName: 'Crew',
      addedByInboxId: 'inbox-adder',
      consentState: 'unknown',
    }];

    await client.sync();

    const conversation = (await client.listConversations()).find((entry) => entry.conversationId === 'group-w');
    expect(conversation?.consentState).toBe('allowed');
    // The decision propagates to network group consent (best-effort).
    expect(adapter.groupConsent.get('group-w')).toBe('allowed');
  });

  test('a group added by an unknown sender stays a Request regardless of the toggle', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    adapter.conversations = [{
      conversationId: 'group-w',
      kind: 'group',
      title: 'Crew',
      addedByInboxId: 'inbox-stranger',
      consentState: 'unknown',
    }];

    await client.sync();

    expect((await client.listConversations()).find((entry) => entry.conversationId === 'group-w')?.consentState).toBe('unknown');
    expect(adapter.groupConsent.has('group-w')).toBe(false);
  });

  test('with the toggle off, a contact\'s group add still lands in Requests', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter, new MemoryStore(), undefined, { autoAllowGroupsFromContacts: false });
    await client.saveContact({ name: 'Adder', inboxId: 'inbox-adder' });
    adapter.conversations = [{
      conversationId: 'group-w',
      kind: 'group',
      title: 'Crew',
      addedByInboxId: 'inbox-adder',
      consentState: 'unknown',
    }];

    await client.sync();

    expect((await client.listConversations()).find((entry) => entry.conversationId === 'group-w')?.consentState).toBe('unknown');
  });

  test('a group added by a blocked inbox is silently discarded (denied, never a Request)', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    await client.setConsent({ inboxId: 'inbox-spammer' }, 'denied');
    adapter.conversations = [{
      conversationId: 'group-spam',
      kind: 'group',
      title: 'Free Money',
      addedByInboxId: 'inbox-spammer',
      consentState: 'unknown',
    }];

    await client.sync();

    const conversation = (await client.listConversations()).find((entry) => entry.conversationId === 'group-spam');
    expect(conversation?.consentState).toBe('denied');
    expect(adapter.groupConsent.get('group-spam')).toBe('denied');
    // We never auto-leave: leaving is visible to the group, blocking must not be.
    expect(adapter.leftGroups).toEqual([]);
  });

  test('sending into a group publishes to the conversation and implies group consent', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    const created = await client.createGroup({ name: 'Crew', members: [{ inboxId: 'inbox-bob' }] });
    adapter.groupConsent.clear(); // ignore the creation consent write

    const sent = await client.sendToConversation(created.conversationId, 'hello group');

    expect(adapter.sentToConversation).toEqual([{ conversationId: created.conversationId, text: 'hello group' }]);
    expect(adapter.groupConsent.get(created.conversationId)).toBe('allowed');
    const [message] = await client.listMessages(created.conversationId);
    expect(message).toMatchObject({ messageId: sent.messageId, direction: 'outbound', text: 'hello group' });
  });

  test('a denied sender\'s in-group messages are dropped from streams and views', async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const client = await makeClient(adapter, store);
    const created = await client.createGroup({ name: 'Crew', members: [{ inboxId: 'inbox-bob' }, { inboxId: 'inbox-troll' }] });
    await client.setConsent({ inboxId: 'inbox-troll' }, 'denied');
    const events: IncomingMessage[] = [];
    await client.streamMessages((message) => {
      events.push(message);
    });

    await adapter.emit({
      conversationId: created.conversationId,
      conversationKind: 'group',
      messageId: 'msg-troll',
      raw: {},
      senderInboxId: 'inbox-troll',
      sentAt: new Date().toISOString(),
      text: 'spam',
    });
    await adapter.emit({
      conversationId: created.conversationId,
      conversationKind: 'group',
      messageId: 'msg-bob',
      raw: {},
      senderInboxId: 'inbox-bob',
      sentAt: new Date().toISOString(),
      text: 'hi all',
    });

    // The denied sender never reaches the handler (the agent boundary) and is
    // never persisted; the other member's message flows normally.
    expect(events.map((event) => event.messageId)).toEqual(['msg-bob']);
    expect((await client.listMessages(created.conversationId)).map((message) => message.text)).toEqual(['hi all']);
  });

  test('a streamed message from an unseen group creates a group-shaped row, never a phantom DM', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    adapter.groups.set('group-x', {
      conversationId: 'group-x',
      kind: 'group',
      title: 'Crew',
      groupName: 'Crew',
      addedByInboxId: 'inbox-stranger',
      consentState: 'unknown',
    });
    await client.streamMessages(() => {}, { consentStates: ['allowed', 'unknown'] });

    await adapter.emit({
      conversationId: 'group-x',
      conversationKind: 'group',
      messageId: 'msg-x',
      raw: {},
      senderInboxId: 'inbox-someone',
      sentAt: new Date().toISOString(),
      text: 'first message',
    });

    const conversation = (await client.listConversations()).find((entry) => entry.conversationId === 'group-x');
    expect(conversation).toMatchObject({ kind: 'group', title: 'Crew', consentState: 'unknown' });
    // The sender must not be mistaken for a DM peer.
    expect(conversation?.peerInboxId).toBeUndefined();
  });

  test('renameGroup is mirror-first: the local row updates even when the network write fails', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    const created = await client.createGroup({ name: 'Crew', members: [{ inboxId: 'inbox-bob' }] });

    await client.renameGroup(created.conversationId, 'New Crew');
    expect(adapter.metadataUpdates).toEqual([{ conversationId: created.conversationId, name: 'New Crew' }]);
    let conversation = (await client.listConversations()).find((entry) => entry.conversationId === created.conversationId);
    expect(conversation?.title).toBe('New Crew');
    expect(conversation?.groupName).toBe('New Crew');

    adapter.failGroupMetadataWrites = true;
    await client.renameGroup(created.conversationId, 'Offline Name');
    conversation = (await client.listConversations()).find((entry) => entry.conversationId === created.conversationId);
    expect(conversation?.title).toBe('Offline Name');
  });

  test('setGroupMemberLevel diffs the current role into admin/super-admin list changes', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    const created = await client.createGroup({ name: 'Crew', members: [{ inboxId: 'inbox-bob' }] });

    // member -> admin
    await client.setGroupMemberLevel(created.conversationId, { inboxId: 'inbox-bob' }, 'admin');
    expect(adapter.adminChanges).toEqual([{ conversationId: created.conversationId, inboxId: 'inbox-bob', op: 'addAdmin' }]);

    // admin -> superAdmin (transfer ownership is this, pointed at someone else)
    adapter.adminChanges = [];
    await client.setGroupMemberLevel(created.conversationId, { inboxId: 'inbox-bob' }, 'superAdmin');
    expect(adapter.adminChanges.map((change) => change.op)).toEqual(['addSuperAdmin', 'removeAdmin']);

    // superAdmin -> member
    adapter.adminChanges = [];
    await client.setGroupMemberLevel(created.conversationId, { inboxId: 'inbox-bob' }, 'member');
    expect(adapter.adminChanges.map((change) => change.op)).toEqual(['removeSuperAdmin']);

    // Same level is a no-op; a non-member is an error.
    adapter.adminChanges = [];
    await client.setGroupMemberLevel(created.conversationId, { inboxId: 'inbox-bob' }, 'member');
    expect(adapter.adminChanges).toEqual([]);
    await expect(client.setGroupMemberLevel(created.conversationId, { inboxId: 'inbox-nobody' }, 'admin')).rejects.toThrow(/not a group member/);
  });

  test('leaving a group marks the row inactive and blocks further sends', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    const created = await client.createGroup({ name: 'Crew', members: [{ inboxId: 'inbox-bob' }] });

    await client.leaveGroup(created.conversationId);

    expect(adapter.leftGroups).toEqual([created.conversationId]);
    const conversation = (await client.listConversations()).find((entry) => entry.conversationId === created.conversationId);
    // The row and its history survive; it is just no longer sendable.
    expect(conversation?.active).toBe(false);
    await expect(client.sendToConversation(created.conversationId, 'hello?')).rejects.toThrow(/no longer a member/);
  });

  test('group accept/block targets the group id, not a member inbox', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    adapter.conversations = [{
      conversationId: 'group-r',
      kind: 'group',
      title: 'Crew',
      addedByInboxId: 'inbox-stranger',
      consentState: 'unknown',
    }];
    await client.sync();

    await client.setConversationConsent('group-r', 'allowed');
    expect(adapter.groupConsent.get('group-r')).toBe('allowed');
    expect((await client.listConversations()).find((entry) => entry.conversationId === 'group-r')?.consentState).toBe('allowed');
    // No inbox-level consent was written for anyone.
    expect(adapter.consent.size).toBe(0);

    await client.setConversationConsent('group-r', 'denied');
    expect(adapter.groupConsent.get('group-r')).toBe('denied');
  });

  test('deletes a local conversation and its cached messages', async () => {
    const adapter = new FakeAdapter();
    adapter.conversations = [{
      conversationId: 'dm-local',
      kind: 'dm' as const, peerInboxId: 'inbox-peer', consentState: 'allowed',
      title: 'Peer',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }];
    adapter.networkMessages = [{
      conversationId: 'dm-local',
      conversationKind: 'dm',
      messageId: 'msg-local',
      raw: {},
      senderInboxId: 'inbox-peer',
      sentAt: '2026-01-01T00:00:00.000Z',
      text: 'cached hello',
    }];
    const client = await makeClient(adapter);
    await client.sync();

    await client.deleteConversation('dm-local');

    expect(await client.listConversations()).toHaveLength(0);
    expect(await client.listMessages('dm-local')).toHaveLength(0);
  });

  test('sync folds a duplicate DM row into the canonical thread', async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    // A duplicate MLS DM persisted earlier (or created by a streamed message),
    // with history in it.
    await store.putConversation({
      conversationId: 'dm-duplicate',
      kind: 'dm',
      peerInboxId: 'inbox-peer',
      title: 'inbox-peer',
      consentState: 'allowed',
    });
    await store.putMessage({
      messageId: 'msg-old',
      conversationId: 'dm-duplicate',
      senderInboxId: 'inbox-peer',
      sentAt: '2026-01-01T00:00:00.000Z',
      kind: 'text',
      encryptedPayload: await encryptJson(deriveAccount(secretKeyFromHexSeed('01'.repeat(32)), { env: 'dev' }).coneStorageKey, 'cone.message.v1', 'old hello'),
    });
    // The network lists only the canonical DM for that peer.
    adapter.conversations = [{
      conversationId: 'dm-canonical',
      kind: 'dm',
      peerInboxId: 'inbox-peer',
      title: 'inbox-peer',
      consentState: 'allowed',
    }];

    const client = await makeClient(adapter, store);
    await client.sync();

    const rows = (await client.listConversations()).filter((row) => row.peerInboxId === 'inbox-peer');
    expect(rows.map((row) => row.conversationId)).toEqual(['dm-canonical']);
    // The duplicate's history now lives under the canonical thread.
    expect((await client.listMessages('dm-canonical')).map((message) => message.messageId)).toContain('msg-old');
    expect(await client.listMessages('dm-duplicate')).toHaveLength(0);
    const incoming = (await client.receiveMessages()).messages[0]!;
    expect(incoming.conversationId).toBe('dm-duplicate');
    expect((await client.receiveMessages({ excludeConversationIds: ['dm-duplicate'] })).messages).toEqual([]);
    adapter.getConversationInfo = async id => ({ ...adapter.conversations[0]!, conversationId: id });
    await client.sendToConversation(incoming.conversationId, 'first reply', { idempotencyKey: 'reply-old' });
    await client.sync();
    const replay = (await client.receiveMessages()).messages[0]!;
    expect(replay.conversationId).toBe('dm-duplicate');
    expect((await client.sendToConversation(replay.conversationId, 'regenerated reply', { idempotencyKey: 'reply-old' })).deduplicated).toBe(true);
    expect(adapter.sentToConversation).toEqual([{ conversationId: 'dm-duplicate', text: 'first reply' }]);
  });

  test('self contacts are removed and self-DMs are hidden', async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    // A "Me" contact created by an earlier build.
    await store.putContact({
      contactId: 'contact-self',
      name: 'Me',
      inboxId: 'inbox-self',
      source: 'self',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await store.putConversation({
      conversationId: 'dm-self',
      kind: 'dm',
      peerInboxId: 'inbox-self',
      title: 'Me',
      consentState: 'allowed',
    });
    await store.putConversation({
      conversationId: 'dm-peer',
      kind: 'dm',
      peerInboxId: 'inbox-peer',
      title: 'Peer',
      consentState: 'allowed',
    });

    const client = await makeClient(adapter, store);

    expect((await client.listContacts()).some((contact) => contact.source === 'self')).toBe(false);
    expect((await client.listConversations()).map((row) => row.conversationId)).toEqual(['dm-peer']);
  });

  test('receiving never acknowledges mail and an exact acknowledgement cannot consume a later arrival', async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    adapter.conversations = [{ conversationId: 'dm-friend', kind: 'dm', peerInboxId: 'inbox-friend', title: 'Friend', consentState: 'allowed' }];
    const message = (id: string): IncomingMessage => ({
      conversationId: 'dm-friend', conversationKind: 'dm', messageId: id, senderInboxId: 'inbox-friend',
      sentAt: '2026-01-01T10:00:00.000Z', text: id, raw: {},
    });
    adapter.networkMessages = [message('one'), message('two')];
    const client = await makeClient(adapter, store);
    await client.sync();
    const first = await client.receiveMessages({ consumer: 'hermes', limit: 1 });
    expect(first.messages.map(m => m.messageId)).toEqual(['one']);
    expect(first.more).toBe(true);
    expect((await client.receiveMessages({ consumer: 'hermes', limit: 1 })).messages.map(m => m.messageId)).toEqual(['one']);
    adapter.networkMessages.push(message('three'));
    await client.sync();
    await client.acknowledgeMessages(['one'], { consumer: 'hermes' });
    const restored = new MemoryStore();
    await restored.importSnapshot(await store.exportSnapshot());
    const restarted = await makeClient(adapter, restored);
    expect((await restarted.receiveMessages({ consumer: 'hermes' })).messages.map(m => m.messageId)).toEqual(['two', 'three']);
    expect((await restarted.receiveMessages({ consumer: 'another-agent' })).messages).toHaveLength(3);
  });

  test('accepting an older request makes its unacknowledged messages available', async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    adapter.conversations = [{ conversationId: 'dm-stranger', kind: 'dm', peerInboxId: 'inbox-stranger', title: 'Stranger', consentState: 'unknown' }];
    adapter.networkMessages = [{ conversationId: 'dm-stranger', conversationKind: 'dm', messageId: 'old-request', senderInboxId: 'inbox-stranger', sentAt: '2026-01-01T10:00:00.000Z', text: 'hi', raw: {} }];
    const client = await makeClient(adapter, store);
    await client.sync();
    expect((await client.receiveMessages()).messages).toEqual([]);
    await client.setConversationConsent('dm-stranger', 'allowed');
    expect((await client.receiveMessages()).messages.map(m => m.messageId)).toEqual(['old-request']);
  });

  test('a crash after publishing retries the original encrypted payload with the same native key', async () => {
    class InterruptedStore extends MemoryStore {
      interrupted = false;
      override async settleSend(key: string, sent: SentMessage) {
        if (!this.interrupted) { this.interrupted = true; throw new Error('simulated crash after publish'); }
        return super.settleSend(key, sent);
      }
    }
    const store = new InterruptedStore();
    const adapter = new FakeAdapter();
    const attempts: Array<{ text: string; key?: string }> = [];
    adapter.sendText = async (_identity, text, options: { idempotencyKey?: string } = {}) => {
      attempts.push({ text, key: options.idempotencyKey });
      return { messageId: 'native-deduplicated-id', conversationId: 'dm-peer', sentAt: '2026-01-01T10:00:00.000Z' };
    };
    const client = await makeClient(adapter, store);
    await expect(client.sendText({ inboxId: 'inbox-peer' }, 'original reply', { idempotencyKey: 'reply-1' })).rejects.toThrow('simulated crash');
    const pending = await store.listPendingSends();
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending)).not.toContain('original reply');
    const restarted = await makeClient(adapter, store);
    const result = await restarted.sendText({ inboxId: 'inbox-peer' }, 'regenerated reply', { idempotencyKey: 'reply-1' });
    expect(result.messageId).toBe('native-deduplicated-id');
    expect(attempts).toEqual([{ text: 'original reply', key: 'reply-1' }, { text: 'original reply', key: 'reply-1' }]);
    expect(await store.listPendingSends()).toEqual([]);
  });

  test('pollMessages returns new allowed inbound messages once, with a durable cursor', async () => {
    const adapter = new FakeAdapter();
    adapter.conversations = [
      { conversationId: 'dm-friend', kind: 'dm', peerInboxId: 'inbox-friend', title: 'Friend', consentState: 'allowed' },
      { conversationId: 'dm-req', kind: 'dm', peerInboxId: 'inbox-stranger', title: 'inbox-stranger', consentState: 'unknown' },
    ];
    adapter.networkMessages = [
      { conversationId: 'dm-friend', conversationKind: 'dm', messageId: 'new-1', raw: {}, senderInboxId: 'inbox-friend', sentAt: '2026-01-01T10:00:00.000Z', text: 'hello' },
      // Control envelopes and request-conversation messages never wake a poll.
      { conversationId: 'dm-friend', conversationKind: 'dm', messageId: 'ctl-1', raw: {}, senderInboxId: 'inbox-friend', sentAt: '2026-01-01T10:01:00.000Z', json: { type: 'cone.read.v1' } },
      { conversationId: 'dm-req', conversationKind: 'dm', messageId: 'req-1', raw: {}, senderInboxId: 'inbox-stranger', sentAt: '2026-01-01T10:02:00.000Z', text: 'psst' },
    ];
    const store = new MemoryStore();
    const client = await makeClient(adapter, store);
    await client.sync();

    const first = await client.pollMessages({ cursorName: 'agent-main' });
    expect(first.messages.map((message) => message.messageId)).toEqual(['new-1']);

    // Advanced: the same poll comes back empty until something new arrives.
    const second = await client.pollMessages({ cursorName: 'agent-main' });
    expect(second.messages).toEqual([]);
    expect(second.cursor).toBe(first.cursor);

    // A later message — even one sharing the previous watermark instant —
    // arrives exactly once.
    adapter.networkMessages.push({
      conversationId: 'dm-friend', conversationKind: 'dm', messageId: 'new-2', raw: {}, senderInboxId: 'inbox-friend', sentAt: '2026-01-01T10:00:00.000Z', text: 'same instant',
    });
    await client.sync();
    const third = await client.pollMessages({ cursorName: 'agent-main' });
    expect(third.messages.map((message) => message.messageId)).toEqual(['new-2']);
    expect((await client.pollMessages({ cursorName: 'agent-main' })).messages).toEqual([]);
  });

  test('pollMessages with advance:false peeks without moving the cursor', async () => {
    const adapter = new FakeAdapter();
    adapter.conversations = [
      { conversationId: 'dm-friend', kind: 'dm', peerInboxId: 'inbox-friend', title: 'Friend', consentState: 'allowed' },
    ];
    adapter.networkMessages = [
      { conversationId: 'dm-friend', conversationKind: 'dm', messageId: 'peek-1', raw: {}, senderInboxId: 'inbox-friend', sentAt: '2026-01-01T10:00:00.000Z', text: 'hello' },
    ];
    const client = await makeClient(adapter);
    await client.sync();

    expect((await client.pollMessages({ advance: false })).messages).toHaveLength(1);
    expect((await client.pollMessages({ advance: false })).messages).toHaveLength(1);
    expect((await client.pollMessages()).messages).toHaveLength(1);
    expect((await client.pollMessages()).messages).toHaveLength(0);
  });

  test('an idempotency key returns the original send instead of publishing again', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);

    const first = await client.sendText({ inboxId: 'inbox-peer' }, 'transfer $5', { idempotencyKey: 'tx-42' });
    const retry = await client.sendText({ inboxId: 'inbox-peer' }, 'transfer $5', { idempotencyKey: 'tx-42' });

    expect(adapter.sent).toHaveLength(1);
    expect(retry.messageId).toBe(first.messageId);
    expect(retry.deduplicated).toBe(true);

    await client.sendText({ inboxId: 'inbox-peer' }, 'transfer $5', { idempotencyKey: 'tx-43' });
    expect(adapter.sent).toHaveLength(2);
  });

  test('pollMessages catches a late-synced message with an older sentAt', async () => {
    const adapter = new FakeAdapter();
    adapter.conversations = [
      { conversationId: 'dm-friend', kind: 'dm', peerInboxId: 'inbox-friend', title: 'Friend', consentState: 'allowed' },
    ];
    adapter.networkMessages = [
      { conversationId: 'dm-friend', conversationKind: 'dm', messageId: 'newer', raw: {}, senderInboxId: 'inbox-friend', sentAt: '2026-01-01T10:05:00.000Z', text: 'first to arrive' },
    ];
    const client = await makeClient(adapter);
    await client.sync();
    expect((await client.pollMessages()).messages.map((m) => m.messageId)).toEqual(['newer']);

    // Clock skew / delayed publish: an OLDER sentAt arrives on a later sync.
    // The seq cursor still surfaces it; a sentAt watermark would drop it.
    adapter.networkMessages.push({
      conversationId: 'dm-friend', conversationKind: 'dm', messageId: 'older-late', raw: {}, senderInboxId: 'inbox-friend', sentAt: '2026-01-01T10:04:00.000Z', text: 'published late',
    });
    await client.sync();
    expect((await client.pollMessages()).messages.map((m) => m.messageId)).toEqual(['older-late']);
  });

  test('an idempotency key reused for a different recipient is a conflict, not a silent skip', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    await client.sendText({ inboxId: 'inbox-alice' }, 'transfer $5', { idempotencyKey: 'tx-1' });
    await expect(client.sendText({ inboxId: 'inbox-bob' }, 'transfer $5', { idempotencyKey: 'tx-1' }))
      .rejects.toThrow(/different recipient/);
    expect(adapter.sent).toHaveLength(1);
  });

  test('an unsettled idempotency claim blocks the retry (at-most-once), and a definite failure releases it', async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    // A crash left a claim without a messageId: the send may have published.
    await store.putMetadata({ idempotencySends: [{ key: 'tx-crash', scope: 'inbox-peer' }] });
    const client = await makeClient(adapter, store);
    await expect(client.sendText({ inboxId: 'inbox-peer' }, 'hi', { idempotencyKey: 'tx-crash' }))
      .rejects.toThrow(/may or may not have published/);

    // A definite failure (unreachable) releases the claim so a retry works.
    const blocked = new FakeAdapter({ blockedInboxIds: ['inbox-x'] });
    const client2 = await makeClient(blocked, new MemoryStore());
    await expect(client2.sendText({ inboxId: 'inbox-x' }, 'hi', { idempotencyKey: 'tx-2' })).rejects.toThrow(/not XMTP-reachable/);
    (blocked as unknown as { options: { blockedInboxIds?: string[] } }).options.blockedInboxIds = [];
    const retried = await client2.sendText({ inboxId: 'inbox-x' }, 'hi', { idempotencyKey: 'tx-2' });
    expect(retried.deduplicated).toBeUndefined();
  });

  test('reads unwrap app JSON: json is the payload, replyTo is first-class', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    await client.sendJson({ inboxId: 'inbox-peer' }, { kind: 'quote', amount: 5 }, { replyTo: 'msg-q' });

    const sent = (await client.listMessages()).find((m) => m.kind === 'json');
    expect(sent?.json).toEqual({ kind: 'quote', amount: 5 });
    expect(sent?.replyTo).toBe('msg-q');
    expect(sent?.conversationKind).toBe('dm');
  });

  test('sendJson carries replyTo correlation in the envelope', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);

    await client.sendJson({ inboxId: 'inbox-peer' }, { answer: 42 }, { replyTo: 'msg-question' });

    expect(adapter.sentEnvelopes).toHaveLength(1);
    expect(adapter.sentEnvelopes[0]?.envelope).toMatchObject({
      type: 'cone.app.json.v1',
      value: { answer: 42 },
      replyTo: 'msg-question',
    });
  });
});

async function makeClient(
  adapter: FakeAdapter,
  store = new MemoryStore(),
  now?: () => Date,
  options: { autoAllowGroupsFromContacts?: boolean } = {},
) {
  const account = deriveAccount(secretKeyFromHexSeed('01'.repeat(32)), { env: 'dev' });
  return createConeClient({ account, store, xmtp: adapter, now, ...options });
}

class FakeAdapter implements XmtpAdapter {
  getConversationInfo = async (_id: string): Promise<ConeConversation | null> => null;
  conversations: ConeConversation[] = [];
  networkMessages: IncomingMessage[] = [];
  sent: Array<{ inboxId: string; text: string }> = [];
  sentEnvelopes: Array<{ inboxId: string; envelope: ConeEnvelope }> = [];
  sentToConversation: Array<{ conversationId: string; text: string }> = [];
  consent = new Map<string, ConeConsentState>();
  groupConsent = new Map<string, ConeConsentState>();
  groups = new Map<string, ConeConversation>();
  createdGroups: Array<{ memberInboxIds: string[]; options?: CreateGroupOptions }> = [];
  memberChanges: Array<{ conversationId: string; added?: string[]; removed?: string[] }> = [];
  leftGroups: string[] = [];
  metadataUpdates: Array<{ conversationId: string; name?: string; description?: string }> = [];
  adminChanges: Array<{ conversationId: string; inboxId: string; op: 'addAdmin' | 'removeAdmin' | 'addSuperAdmin' | 'removeSuperAdmin' }> = [];
  failGroupMetadataWrites = false;
  retention = new Map<string, MessageRetention>();
  failRetentionWrites = false;
  clock: (() => Date) | null = null;
  streamFilter: ConsentFilter | undefined;
  private handler: MessageHandler | null = null;
  private sentCount = 0;

  constructor(private readonly options: { blockedInboxIds?: string[] } = {}) {}

  identity(): Promise<ConeIdentity> {
    return Promise.resolve({
      address: '0x9999999999999999999999999999999999999999',
      env: 'dev',
      inboxId: 'inbox-self',
    });
  }

  resolveIdentity(ref: unknown): Promise<ResolvedIdentity | null> {
    const value = ref as { inboxId?: string; address?: string };
    if (value.inboxId) {
      return Promise.resolve({ inboxId: value.inboxId, address: value.address, source: 'inboxId' });
    }
    if (value.address) {
      return Promise.resolve({ inboxId: `inbox-${value.address.slice(2, 8)}`, address: value.address, source: 'address' });
    }
    return Promise.resolve(null);
  }

  canMessage(identity: ResolvedIdentity): Promise<boolean> {
    return Promise.resolve(!this.options.blockedInboxIds?.includes(identity.inboxId));
  }

  sendText(identity: ResolvedIdentity, text: string): Promise<SentMessage> {
    this.sent.push({ inboxId: identity.inboxId, text });
    this.sentCount += 1;
    return Promise.resolve({
      conversationId: `dm:${identity.inboxId}`,
      messageId: `sent-${this.sentCount}`,
      sentAt: (this.clock?.() ?? new Date()).toISOString(),
    });
  }

  sendEnvelope(identity: ResolvedIdentity, envelope: ConeEnvelope): Promise<SentMessage> {
    this.sentEnvelopes.push({ inboxId: identity.inboxId, envelope });
    this.sentCount += 1;
    return Promise.resolve({
      conversationId: `dm:${identity.inboxId}`,
      messageId: `sent-${this.sentCount}`,
      sentAt: (this.clock?.() ?? new Date()).toISOString(),
    });
  }

  streamMessages(handler: MessageHandler, filter?: ConsentFilter) {
    this.handler = handler;
    this.streamFilter = filter;
    return Promise.resolve(() => {
      this.handler = null;
    });
  }

  sync() {
    return Promise.resolve({
      conversations: this.conversations,
      messages: this.networkMessages,
    });
  }

  listConversations(): Promise<ConeConversation[]> {
    return Promise.resolve(this.conversations);
  }

  listMessages(conversationId: string): Promise<IncomingMessage[]> {
    return Promise.resolve(this.networkMessages.filter((message) => message.conversationId === conversationId));
  }

  setConsent(inboxId: string, state: ConeConsentState): Promise<void> {
    this.consent.set(inboxId, state);
    return Promise.resolve();
  }

  getConsent(inboxId: string): Promise<ConeConsentState> {
    return Promise.resolve(this.consent.get(inboxId) ?? 'unknown');
  }

  setRetention(conversationId: string, retention: MessageRetention | null): Promise<void> {
    if (this.failRetentionWrites) {
      return Promise.reject(new Error('network unavailable'));
    }
    if (retention) {
      this.retention.set(conversationId, retention);
    } else {
      this.retention.delete(conversationId);
    }
    return Promise.resolve();
  }

  getRetention(conversationId: string): Promise<MessageRetention | null> {
    return Promise.resolve(this.retention.get(conversationId) ?? null);
  }

  sendToConversation(conversationId: string, text: string): Promise<SentMessage> {
    this.sentToConversation.push({ conversationId, text });
    this.sentCount += 1;
    return Promise.resolve({
      conversationId,
      messageId: `sent-${this.sentCount}`,
      sentAt: (this.clock?.() ?? new Date()).toISOString(),
    });
  }

  setGroupConsent(conversationId: string, state: ConeConsentState): Promise<void> {
    this.groupConsent.set(conversationId, state);
    return Promise.resolve();
  }

  createGroup(memberInboxIds: string[], options?: CreateGroupOptions): Promise<ConeConversation> {
    this.createdGroups.push({ memberInboxIds, options });
    const members: ConeGroupMember[] = [
      { inboxId: 'inbox-self', level: 'superAdmin', consentState: 'allowed' },
      ...memberInboxIds.map((inboxId) => ({ inboxId, level: 'member' as const, consentState: 'unknown' as const })),
    ];
    const conversation: ConeConversation = {
      conversationId: `group-${this.createdGroups.length}`,
      kind: 'group',
      title: options?.name ?? `Group (${members.length})`,
      groupName: options?.name,
      groupDescription: options?.description,
      memberCount: members.length,
      members,
      consentState: 'allowed',
    };
    this.groups.set(conversation.conversationId, conversation);
    this.groupConsent.set(conversation.conversationId, 'allowed');
    return Promise.resolve(conversation);
  }

  getGroupInfo(conversationId: string): Promise<ConeConversation | null> {
    return Promise.resolve(this.groups.get(conversationId) ?? null);
  }

  listGroupMembers(conversationId: string): Promise<ConeGroupMember[]> {
    return Promise.resolve(this.groups.get(conversationId)?.members ?? []);
  }

  addGroupMembers(conversationId: string, memberInboxIds: string[]): Promise<void> {
    this.memberChanges.push({ conversationId, added: memberInboxIds });
    return Promise.resolve();
  }

  removeGroupMembers(conversationId: string, memberInboxIds: string[]): Promise<void> {
    this.memberChanges.push({ conversationId, removed: memberInboxIds });
    return Promise.resolve();
  }

  leaveGroup(conversationId: string): Promise<void> {
    this.leftGroups.push(conversationId);
    return Promise.resolve();
  }

  updateGroupName(conversationId: string, name: string): Promise<void> {
    if (this.failGroupMetadataWrites) {
      return Promise.reject(new Error('network unavailable'));
    }
    this.metadataUpdates.push({ conversationId, name });
    return Promise.resolve();
  }

  updateGroupDescription(conversationId: string, description: string): Promise<void> {
    if (this.failGroupMetadataWrites) {
      return Promise.reject(new Error('network unavailable'));
    }
    this.metadataUpdates.push({ conversationId, description });
    return Promise.resolve();
  }

  addGroupAdmin(conversationId: string, inboxId: string): Promise<void> {
    return this.recordAdminChange(conversationId, inboxId, 'addAdmin');
  }

  removeGroupAdmin(conversationId: string, inboxId: string): Promise<void> {
    return this.recordAdminChange(conversationId, inboxId, 'removeAdmin');
  }

  addGroupSuperAdmin(conversationId: string, inboxId: string): Promise<void> {
    return this.recordAdminChange(conversationId, inboxId, 'addSuperAdmin');
  }

  removeGroupSuperAdmin(conversationId: string, inboxId: string): Promise<void> {
    return this.recordAdminChange(conversationId, inboxId, 'removeSuperAdmin');
  }

  private recordAdminChange(conversationId: string, inboxId: string, op: 'addAdmin' | 'removeAdmin' | 'addSuperAdmin' | 'removeSuperAdmin'): Promise<void> {
    this.adminChanges.push({ conversationId, inboxId, op });
    // Keep the fake's member mirror consistent so setGroupMemberLevel diffs
    // work. XMTP tracks two separate lists and reports the highest — so
    // removeAdmin must not downgrade a super admin.
    const group = this.groups.get(conversationId);
    if (group?.members) {
      this.groups.set(conversationId, {
        ...group,
        members: group.members.map((member) => {
          if (member.inboxId !== inboxId) {
            return member;
          }
          if (op === 'addSuperAdmin') {
            return { ...member, level: 'superAdmin' as const };
          }
          if (op === 'addAdmin') {
            return member.level === 'superAdmin' ? member : { ...member, level: 'admin' as const };
          }
          if (op === 'removeAdmin') {
            return member.level === 'admin' ? { ...member, level: 'member' as const } : member;
          }
          return member.level === 'superAdmin' ? { ...member, level: 'member' as const } : member;
        }),
      });
    }
    return Promise.resolve();
  }

  async emit(message: IncomingMessage): Promise<void> {
    await this.handler?.(message);
  }
}
