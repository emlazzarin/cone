import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';

import { JsonFileStore } from '../src/stores/JsonFileStore';
import { MemoryStore } from '../src/stores/MemoryStore';
import type { ConeStore, StoredConnection, StoredInvite } from '../src/types';

function makeInvite(id: string): StoredInvite {
  return {
    inviteId: id,
    pairId: `pair-${id}`,
    inviterInboxId: 'inbox-a',
    env: 'dev',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    secretHash: `hash-${id}`,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

function makeConnection(id: string, peerInboxId: string): StoredConnection {
  return {
    connectionId: id,
    pairId: `pair-${id}`,
    status: 'active',
    peerInboxId,
    createdAt: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
  };
}

function runStoreContractTests(name: string, createStore: () => ConeStore) {
  describe(name, () => {
    let store: ConeStore;

    beforeEach(() => {
      store = createStore();
    });

    test('putInvite / getInvite', async () => {
      const invite = makeInvite('invite-1');

      await store.putInvite(invite);

      expect(await store.getInvite(invite.inviteId)).toEqual(invite);
      expect(await store.getInvite('missing-invite')).toBeNull();
    });

    test('consumeInvite', async () => {
      const invite = makeInvite('invite-2');

      await store.putInvite(invite);
      await store.consumeInvite(invite.inviteId, { inboxId: 'peer-inbox', address: '0x1234' });

      expect(await store.getInvite(invite.inviteId)).toEqual({
        ...invite,
        status: 'consumed',
        consumedBy: { inboxId: 'peer-inbox', address: '0x1234' },
      });
    });

    test('putConnection / getConnectionById', async () => {
      const connection = makeConnection('connection-1', 'peer-a');

      await store.putConnection(connection);

      expect(await store.getConnectionById(connection.connectionId)).toEqual(connection);
    });

    test('getConnectionByInboxId', async () => {
      const connection = makeConnection('connection-2', 'peer-b');

      await store.putConnection(connection);

      expect(await store.getConnectionByInboxId('peer-b')).toEqual(connection);
    });

    test('listConnections', async () => {
      const first = makeConnection('connection-3', 'peer-c');
      const second = makeConnection('connection-4', 'peer-d');

      await store.putConnection(first);
      await store.putConnection(second);

      expect(await store.listConnections()).toEqual(expect.arrayContaining([first, second]));
      expect(await store.listConnections()).toHaveLength(2);
    });

    test('markMessageProcessed is idempotent', async () => {
      expect(await store.markMessageProcessed('message-1')).toBe(true);
      expect(await store.markMessageProcessed('message-1')).toBe(false);
    });
  });
}

describe('stores', () => {
  runStoreContractTests('MemoryStore', () => new MemoryStore());

  describe('JsonFileStore', () => {
    let filePath: string;

    beforeEach(() => {
      filePath = `/tmp/cone-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    });

    afterEach(() => {
      if (existsSync(filePath)) {
        rmSync(filePath, { force: true });
      }
    });

    runStoreContractTests('contract', () => new JsonFileStore(filePath));

    test('persists data across store instances', async () => {
      const invite = makeInvite('persisted-invite');
      const connection = makeConnection('persisted-connection', 'persisted-peer');
      const firstStore = new JsonFileStore(filePath);

      await firstStore.putInvite(invite);
      await firstStore.putConnection(connection);
      await firstStore.markMessageProcessed('persisted-message');

      const secondStore = new JsonFileStore(filePath);

      expect(await secondStore.getInvite(invite.inviteId)).toEqual(invite);
      expect(await secondStore.getConnectionById(connection.connectionId)).toEqual(connection);
      expect(await secondStore.markMessageProcessed('persisted-message')).toBe(false);
    });
  });
});
