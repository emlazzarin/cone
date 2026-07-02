import { afterEach, describe, expect, test } from 'bun:test';
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
    expect(await reopened.listMessages()).toEqual([message]);
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

});

function tempPath(): string {
  const path = `/tmp/cone-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
  paths.push(path);
  return path;
}
