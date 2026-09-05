import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, rmSync } from 'node:fs';

import { deriveAccount, encryptJson, secretKeyFromHexSeed, type ConeConversation, type Contact, type StoredMessage } from '@cone/core';

import { BunSQLiteStore } from '../src/store';

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  }
});

describe('BunSQLiteStore', () => {
  test('upgrades the old message table without reusing a deleted ingestion sequence', async () => {
    const path = tempPath();
    const old = new Database(path);
    old.exec('create table messages (message_id text primary key, conversation_id text not null, sender_inbox_id text not null, sent_at text not null, kind text not null, data text not null)');
    old.query('insert into messages values (?, ?, ?, ?, ?, ?)').run('old', 'dm', 'peer', '2026-01-01', 'text', '{}');
    old.close();
    const store = new BunSQLiteStore(path);
    expect((await store.listMessages())[0]?.seq).toBe(1);
    await store.deleteMessage('old');
    const account = deriveAccount(secretKeyFromHexSeed('08'.repeat(32)), { env: 'dev' });
    await store.putMessage({ messageId: 'new', conversationId: 'dm', senderInboxId: 'peer', sentAt: '2026-01-02', kind: 'text', encryptedPayload: await encryptJson(account.coneStorageKey, 'test', 'hello') });
    expect((await store.listMessages())[0]?.seq).toBe(2);
    store.close();
  });

  test('two connections share exact acknowledgements and atomically keep the first pending send', async () => {
    const path = tempPath();
    const a = new BunSQLiteStore(path);
    const b = new BunSQLiteStore(path);
    const account = deriveAccount(secretKeyFromHexSeed('09'.repeat(32)), { env: 'dev' });
    const encryptedPayload = await encryptJson(account.coneStorageKey, 'test', 'reply');
    for (const messageId of ['one', 'two']) await a.putMessage({ messageId, conversationId: 'dm', senderInboxId: 'peer', sentAt: '2026-01-01', kind: 'text', encryptedPayload });
    await b.acknowledgeMessages('hermes', ['one']);
    const query = { consumer: 'hermes', conversationIds: ['dm'], excludeSenderInboxIds: [], limit: 10 };
    expect((await a.listPendingMessages(query)).map(m => m.messageId)).toEqual(['two']);
    const first = { key: 'reply-one', scope: 'peer', kind: 'text' as const, encryptedPayload };
    const records = await Promise.all([a.prepareSend(first), b.prepareSend({ ...first, scope: 'different-peer' })]);
    expect(records).toEqual([first, first]);
    await Promise.all([a.updateDeniedInboxId('peer-a', true), b.updateDeniedInboxId('peer-b', true)]);
    await a.updateDeniedInboxId('peer-a', false);
    a.close(); b.close();
    const reopened = new BunSQLiteStore(path);
    expect((await reopened.listPendingMessages(query)).map(m => m.messageId)).toEqual(['two']);
    expect(await reopened.listPendingSends()).toEqual([first]);
    expect((await reopened.getMetadata()).deniedInboxIds).toEqual(['peer-b']);
    reopened.close();
  });

  test('persists contacts, messages, processed IDs, and snapshots', async () => {
    const path = tempPath();
    const account = deriveAccount(secretKeyFromHexSeed('06'.repeat(32)), { env: 'dev' });
    const store = new BunSQLiteStore(path);
    const contact: Contact = {
      contactId: 'contact-1',
      createdAt: new Date().toISOString(),
      inboxId: 'inbox-contact',
      name: 'Contact',
      source: 'manual',
      updatedAt: new Date().toISOString(),
    };
    const message: StoredMessage = {
      conversationId: 'dm-contact',
      encryptedPayload: await encryptJson(account.coneStorageKey, 'test', 'hello'),
      kind: 'text',
      messageId: 'msg-1',
      senderInboxId: 'inbox-contact',
      sentAt: new Date().toISOString(),
    };
    const conversation: ConeConversation = {
      conversationId: 'dm-contact',
      kind: 'dm' as const, peerInboxId: 'inbox-contact', consentState: 'allowed',
      title: 'Contact',
      updatedAt: message.sentAt,
    };

    await store.putContact(contact);
    await store.putConversation(conversation);
    await store.putMessage(message);
    await store.putMetadata({ lastStreamStartedAt: '2026-01-01T00:00:00.000Z', lastSyncedAt: '2026-01-01T00:01:00.000Z' });
    expect(await store.markMessageProcessed('msg-1')).toBe(true);
    expect(await store.markMessageProcessed('msg-1')).toBe(false);
    store.close();

    const reopened = new BunSQLiteStore(path);
    expect(await reopened.getContactByName('contact')).toEqual(contact);
    expect(await reopened.getConversationById('dm-contact')).toEqual(conversation);
    expect(await reopened.listConversations()).toEqual([conversation]);
    // The store stamps ingestion order (rowid) on reads.
    expect(await reopened.listMessages()).toEqual([{ ...message, seq: 1 }]);
    const snapshot = await reopened.exportSnapshot();
    expect(snapshot.metadata).toEqual({ lastStreamStartedAt: '2026-01-01T00:00:00.000Z', lastSyncedAt: '2026-01-01T00:01:00.000Z' });
    expect(snapshot.processedMessageIds).toEqual(['msg-1']);

    // Purging an expired message removes the payload but keeps the processed
    // marker, so a copy lingering in the XMTP-level DB cannot re-ingest it.
    await reopened.deleteMessage('msg-1');
    expect(await reopened.listMessages()).toEqual([]);
    expect(await reopened.markMessageProcessed('msg-1')).toBe(false);
    reopened.close();
  });

  test('persists group conversations (no peer inbox) and the denied-inbox set', async () => {
    const path = tempPath();
    const store = new BunSQLiteStore(path);
    const group: ConeConversation = {
      conversationId: 'group-1',
      kind: 'group',
      title: 'Crew',
      groupName: 'Crew',
      memberCount: 3,
      addedByInboxId: 'inbox-adder',
      members: [{ inboxId: 'inbox-adder', level: 'superAdmin', consentState: 'allowed' }],
      consentState: 'unknown',
    };

    await store.putConversation(group);
    await store.putMetadata({ deniedInboxIds: ['inbox-spammer', 'inbox-troll'] });
    store.close();

    const reopened = new BunSQLiteStore(path);
    expect(await reopened.getConversationById('group-1')).toEqual(group);
    expect((await reopened.getMetadata()).deniedInboxIds).toEqual(['inbox-spammer', 'inbox-troll']);
    reopened.close();
  });

  test('two store handles on one database coexist (listen + send pattern)', async () => {
    // Agents run `cone listen` in one process and `cone send` in another
    // against the same CONE_HOME; WAL + busy_timeout make that safe.
    const path = tempPath();
    const writer = new BunSQLiteStore(path);
    const reader = new BunSQLiteStore(path);

    await writer.putContact({
      contactId: 'contact-a',
      name: 'Alice',
      inboxId: 'inbox-a',
      source: 'manual',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect((await reader.listContacts()).map((contact) => contact.name)).toEqual(['Alice']);

    // Interleaved writes from both handles land without SQLITE_BUSY.
    await Promise.all([
      writer.putMetadata({ lastSyncedAt: '2026-01-01T00:00:01.000Z' }),
      reader.putMetadata({ lastStreamStartedAt: '2026-01-01T00:00:02.000Z' }),
    ]);
    const metadata = await writer.getMetadata();
    expect(metadata.lastSyncedAt).toBe('2026-01-01T00:00:01.000Z');
    expect(metadata.lastStreamStartedAt).toBe('2026-01-01T00:00:02.000Z');

    writer.close();
    reader.close();
  });
});

function tempPath(): string {
  const path = `/tmp/cone-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
  paths.push(path);
  return path;
}
