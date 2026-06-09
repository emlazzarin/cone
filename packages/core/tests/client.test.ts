import { describe, expect, test } from 'bun:test';

import {
  createConeClient,
  deriveAccount,
  MemoryStore,
  secretKeyFromHexSeed,
  type ConeConversation,
  type ConeIdentity,
  type IncomingMessage,
  type MessageHandler,
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

  test('creates inbound contacts and persists encrypted message snapshots', async () => {
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
    expect((await client.listContacts()).some((contact) => contact.source === 'inbound' && contact.inboxId === 'inbox-inbound')).toBe(true);
    expect((await client.listMessages('dm-inbound'))[0]?.text).toBe('hi');
    expect((await client.listMessages('dm-inbound'))[0]?.direction).toBe('inbound');

    const backup = await client.exportBackup();
    const restored = new MemoryStore();
    const restoredClient = await makeClient(adapter, restored);
    await restoredClient.importBackup(backup);

    expect((await restoredClient.listContacts()).some((contact) => contact.inboxId === 'inbox-inbound')).toBe(true);
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

  test('sync persists conversations and messages into the local read model', async () => {
    const adapter = new FakeAdapter();
    adapter.conversations = [{
      conversationId: 'dm-synced',
      peerInboxId: 'inbox-peer',
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

  test('deletes a local conversation and its cached messages', async () => {
    const adapter = new FakeAdapter();
    adapter.conversations = [{
      conversationId: 'dm-local',
      peerInboxId: 'inbox-peer',
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

async function makeClient(adapter: FakeAdapter, store = new MemoryStore()) {
  const account = deriveAccount(secretKeyFromHexSeed('01'.repeat(32)), { env: 'dev' });
  return createConeClient({ account, store, xmtp: adapter });
}

class FakeAdapter implements XmtpAdapter {
  conversations: ConeConversation[] = [];
  networkMessages: IncomingMessage[] = [];
  sent: Array<{ inboxId: string; text: string }> = [];
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
      sentAt: new Date().toISOString(),
    });
  }

  streamMessages(handler: MessageHandler) {
    this.handler = handler;
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

  async emit(message: IncomingMessage): Promise<void> {
    await this.handler?.(message);
  }
}
