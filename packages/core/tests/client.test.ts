import { describe, expect, test } from 'bun:test';

import {
  createConeClient,
  deriveAccount,
  MemoryStore,
  secretKeyFromHexSeed,
  type ConeConsentState,
  type ConeConversation,
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
    });
    await adapter.emit({
      conversationId: 'dm-inbound',
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

  test('streams allowed-only by default (the agent trust boundary)', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);
    await client.streamMessages(() => {});
    expect(adapter.streamFilter).toEqual({ consentStates: ['allowed'] });

    await client.streamMessages(() => {}, { consentStates: ['allowed', 'unknown'] });
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
    await adapter.emit({
      conversationId: 'dm-control',
      json: {
        type: 'cos.pair.confirm.v1',
        inboxId: 'inbox-peer',
        codeAcceptedAt: new Date().toISOString(),
      },
      messageId: 'msg-control',
      raw: {},
      senderInboxId: 'inbox-peer',
      sentAt: new Date().toISOString(),
      text: JSON.stringify({ type: 'cos.pair.confirm.v1' }),
    });

    const [message] = await client.listMessages('dm-control');
    expect(message?.kind).toBe('control');
    expect(message?.json).toMatchObject({ type: 'cos.pair.confirm.v1' });
  });

  test('sendReadReceipt publishes a cos.read.v1 envelope without persisting it locally', async () => {
    const adapter = new FakeAdapter();
    const client = await makeClient(adapter);

    await client.sendReadReceipt({ inboxId: 'inbox-peer' });

    expect(adapter.sent.at(-1)).toEqual({ inboxId: 'inbox-peer', text: JSON.stringify({ type: 'cos.read.v1' }) });
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
  conversations: ConeConversation[] = [];
  networkMessages: IncomingMessage[] = [];
  sent: Array<{ inboxId: string; text: string }> = [];
  sentToConversation: Array<{ conversationId: string; text: string }> = [];
  consent = new Map<string, ConeConsentState>();
  groupConsent = new Map<string, ConeConsentState>();
  groups = new Map<string, ConeConversation>();
  createdGroups: Array<{ memberInboxIds: string[]; options?: CreateGroupOptions }> = [];
  memberChanges: Array<{ conversationId: string; added?: string[]; removed?: string[] }> = [];
  leftGroups: string[] = [];
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

  async emit(message: IncomingMessage): Promise<void> {
    await this.handler?.(message);
  }
}
