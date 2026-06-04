import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';

import { deriveAccount, encryptJson, secretKeyFromHexSeed, type Contact, type StoredMessage } from '@cone/core';

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

    await store.putContact(contact);
    await store.putMessage(message);
    expect(await store.markMessageProcessed('msg-1')).toBe(true);
    expect(await store.markMessageProcessed('msg-1')).toBe(false);
    store.close();

    const reopened = new BunSQLiteStore(path);
    expect(await reopened.getContactByName('contact')).toEqual(contact);
    expect(await reopened.listMessages()).toEqual([message]);
    expect((await reopened.exportSnapshot()).processedMessageIds).toEqual(['msg-1']);
    reopened.close();
  });
});

function tempPath(): string {
  const path = `/tmp/cone-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
  paths.push(path);
  return path;
}
