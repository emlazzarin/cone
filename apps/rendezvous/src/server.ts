import { Database } from 'bun:sqlite';
import type { RendezvousStoredOffer } from '@cone/core';

import { applyExchange, corsHeaders, ROOM_ID_PATTERN, validateExchangeBody } from './exchange';
import type { ExchangeBody } from './exchange';

// Rendezvous v2, Bun host — the deployed counterpart of the Cloudflare
// Worker in index.ts; room semantics are shared via exchange.ts. One SQLite
// row per room. Bun serves requests on one thread and the read→transition→
// write path below has no await inside it, so each exchange is atomic
// without explicit transactions.
const SWEEP_INTERVAL_MS = 60 * 1000;

export function openRoomStore(path: string): Database {
  const db = new Database(path, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY,
    offers TEXT NOT NULL,
    max_expiry INTEGER NOT NULL
  )`);
  return db;
}

export function createRendezvousServer(options: { port: number; db: Database }) {
  const { db } = options;
  const selectRoom = db.prepare('SELECT offers FROM rooms WHERE room_id = ?');
  const upsertRoom = db.prepare(
    'INSERT INTO rooms (room_id, offers, max_expiry) VALUES (?, ?, ?) ' +
    'ON CONFLICT(room_id) DO UPDATE SET offers = excluded.offers, max_expiry = excluded.max_expiry',
  );
  const deleteRoom = db.prepare('DELETE FROM rooms WHERE room_id = ?');
  // A room is garbage once its longest-lived offer has expired; per-offer
  // expiry within a live room is enforced by applyExchange on read.
  const sweepRooms = db.prepare('DELETE FROM rooms WHERE max_expiry <= ?');

  const sweeper = setInterval(() => sweepRooms.run(Date.now()), SWEEP_INTERVAL_MS);

  const server = Bun.serve({
    port: options.port,
    async fetch(request) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      const url = new URL(request.url);
      if (url.pathname !== '/v2/exchange' || (request.method !== 'POST' && request.method !== 'DELETE')) {
        return json({ error: 'not found' }, 404);
      }

      let body: ExchangeBody;
      try {
        body = await request.json() as ExchangeBody;
        if (typeof body.roomId !== 'string' || !ROOM_ID_PATTERN.test(body.roomId)) {
          throw new Error('roomId must be a 64-char hex hash');
        }
        if (request.method === 'POST') {
          validateExchangeBody(body);
        }
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'invalid request' }, 400);
      }

      if (request.method === 'DELETE') {
        // Revocation. Addressing the room requires the shared secret, so any
        // holder may revoke — a leaked token being revocable beats the reverse.
        deleteRoom.run(body.roomId);
        return json({ deleted: true });
      }

      const row = selectRoom.get(body.roomId) as { offers: string } | null;
      const offers: RendezvousStoredOffer[] = row ? JSON.parse(row.offers) : [];
      const result = applyExchange(offers, body, Date.now());
      if ('error' in result) {
        return json({ error: result.error }, result.status);
      }

      const maxExpiry = Math.max(...result.stored.map((offer) => Date.parse(offer.expiresAt)));
      upsertRoom.run(body.roomId, JSON.stringify(result.stored), maxExpiry);
      return json({ offers: result.visible });
    },
  });

  return {
    port: server.port,
    stop() {
      clearInterval(sweeper);
      server.stop(true);
    },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json', ...corsHeaders() },
    status,
  });
}

if (import.meta.main) {
  const dbPath = process.env.CONE_RENDEZVOUS_DB ?? 'state/rendezvous.sqlite';
  const port = Number(process.env.PORT ?? 8787);
  const server = createRendezvousServer({ port, db: openRoomStore(dbPath) });
  console.log(`cone rendezvous v2 listening on :${server.port} (db: ${dbPath})`);
}
