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
  });

  test('rejects sends to unreachable identities', async () => {
    const adapter = new FakeAdapter({ blockedInboxIds: ['inbox-blocked'] });
    const client = await makeClient(adapter);
    await client.saveContact({ name: 'Blocked', inboxId: 'inbox-blocked' });

    await expect(client.sendText('Blocked', 'hello')).rejects.toThrow(/not XMTP-reachable/i);
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

    const backup = await client.exportBackup();
    const restored = new MemoryStore();
    const restoredClient = await makeClient(adapter, restored);
    await restoredClient.importBackup(backup);

    expect((await restoredClient.listContacts()).some((contact) => contact.inboxId === 'inbox-inbound')).toBe(true);
  });
});

async function makeClient(adapter: FakeAdapter, store = new MemoryStore()) {
  const account = deriveAccount(secretKeyFromHexSeed('01'.repeat(32)), { env: 'dev' });
  return createConeClient({ account, store, xmtp: adapter });
}

class FakeAdapter implements XmtpAdapter {
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

  listConversations(): Promise<ConeConversation[]> {
    return Promise.resolve([]);
  }

  async emit(message: IncomingMessage): Promise<void> {
    await this.handler?.(message);
  }
}
