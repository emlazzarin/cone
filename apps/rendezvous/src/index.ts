import type { RendezvousStoredOffer } from '@cone/core';

import { applyExchange, corsHeaders, ROOM_ID_PATTERN, validateExchangeBody } from './exchange';
import type { ExchangeBody } from './exchange';

// Re-exported so tests (and any host) get the room semantics from one place.
export { applyExchange } from './exchange';

export interface Env {
  ROOMS: DurableObjectNamespace;
}

// Rendezvous v2, Cloudflare Worker host. Rooms are addressed by SHA-256 of
// the shared secret, so this worker only ever relays ciphertext it cannot
// decrypt — it never sees a handshake code or invite token. Offers declare a
// cleartext role so capacity and visibility can be enforced without
// decrypting anything (see the RendezvousRole docs in @cone/core).
// Room semantics live in exchange.ts, shared with the Bun host (server.ts).
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    if (url.pathname !== '/v2/exchange' || (request.method !== 'POST' && request.method !== 'DELETE')) {
      return cors(json({ error: 'not found' }, 404));
    }

    let body: { roomId?: string };
    try {
      body = await request.json();
      if (typeof body.roomId !== 'string' || !ROOM_ID_PATTERN.test(body.roomId)) {
        throw new Error('roomId must be a 64-char hex hash');
      }
      if (request.method === 'POST') {
        validateExchangeBody(body as ExchangeBody);
      }
    } catch (error) {
      return cors(json({ error: error instanceof Error ? error.message : 'invalid request' }, 400));
    }

    const id = env.ROOMS.idFromName(body.roomId);
    const response = await env.ROOMS.get(id).fetch('https://room.local/exchange', {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: request.method,
    });
    return cors(response);
  },
};

export class RendezvousRoom {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'DELETE') {
      // Revocation. Addressing the room requires the shared secret, so any
      // holder may revoke — a leaked token being revocable beats the reverse.
      await this.state.storage.deleteAll();
      return json({ deleted: true });
    }
    if (request.method !== 'POST') {
      return json({ error: 'not found' }, 404);
    }

    const body = await request.json() as ExchangeBody;
    const result = applyExchange(await this.loadOffers(), body, Date.now());
    if ('error' in result) {
      return json({ error: result.error }, result.status);
    }

    await this.state.storage.put('offers', result.stored);
    await this.state.storage.setAlarm(Math.min(...result.stored.map((offer) => Date.parse(offer.expiresAt))));
    return json({ offers: result.visible });
  }

  async alarm(): Promise<void> {
    const activeOffers = (await this.loadOffers()).filter((offer) => Date.parse(offer.expiresAt) > Date.now());
    if (activeOffers.length === 0) {
      await this.state.storage.deleteAll();
      return;
    }

    await this.state.storage.put('offers', activeOffers);
    await this.state.storage.setAlarm(Math.min(...activeOffers.map((offer) => Date.parse(offer.expiresAt))));
  }

  private async loadOffers(): Promise<RendezvousStoredOffer[]> {
    return (await this.state.storage.get<RendezvousStoredOffer[]>('offers')) ?? [];
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
