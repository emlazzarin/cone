import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createRendezvousServer, openRoomStore } from '../src/server';

// The Bun host over real HTTP. Room semantics are covered in room.test.ts;
// this exercises the layer the CLI/PWA actually talk to: routing, validation
// responses (what `cone doctor` probes), persistence, and revocation.
describe('rendezvous bun server', () => {
  let server: ReturnType<typeof createRendezvousServer>;
  let db: Database;
  let base: string;

  beforeAll(() => {
    db = openRoomStore(':memory:');
    server = createRendezvousServer({ port: 0, db });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop();
  });

  const roomId = 'ab'.repeat(32);
  const offer = (participantId: string, iv: string) => ({
    roomId,
    participantId,
    role: 'pair' as const,
    encryptedOffer: { iv, ciphertext: 'c2VjcmV0', schema: 'cone.pair.v1' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  test('empty exchange is rejected with 400 (the doctor probe contract)', async () => {
    const response = await fetch(`${base}/v2/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(400);
  });

  test('unknown paths 404', async () => {
    const response = await fetch(`${base}/anything`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });

  test('pair exchange round-trips and persists across requests', async () => {
    const first = await fetch(`${base}/v2/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(offer('alpha', 'iv-a')),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { offers: unknown[] }).offers).toHaveLength(1);

    const second = await fetch(`${base}/v2/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(offer('beta', 'iv-b')),
    });
    expect(second.status).toBe(200);
    const { offers } = (await second.json()) as { offers: { participantId: string }[] };
    expect(offers.map((o) => o.participantId).sort()).toEqual(['alpha', 'beta']);
  });

  test('room errors surface with the worker-compatible shape', async () => {
    const third = await fetch(`${base}/v2/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(offer('gamma', 'iv-c')),
    });
    expect(third.status).toBe(409);
    expect(((await third.json()) as { error: string }).error).toBe('pairing room is full');
  });

  test('DELETE revokes the room', async () => {
    const deletion = await fetch(`${base}/v2/exchange`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId }),
    });
    expect(deletion.status).toBe(200);

    const after = await fetch(`${base}/v2/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(offer('gamma', 'iv-c')),
    });
    expect(after.status).toBe(200);
  });
});
