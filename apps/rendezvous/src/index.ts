import type { RendezvousRole, RendezvousStoredOffer } from '@cone/core';

export interface Env {
  ROOMS: DurableObjectNamespace;
}

// Rendezvous v2. Rooms are addressed by SHA-256 of the shared secret, so this
// worker only ever relays ciphertext it cannot decrypt — it never sees a
// handshake code or invite token. Offers declare a cleartext role so capacity
// and visibility can be enforced without decrypting anything (see the
// RendezvousRole docs in @cone/core).
interface ExchangeBody {
  roomId: string;
  participantId: string;
  role: RendezvousRole;
  encryptedOffer: RendezvousStoredOffer['encryptedOffer'];
  expiresAt: string;
}

const ROOM_ID_PATTERN = /^[0-9a-f]{64}$/u;
// Pairing and sync-code rooms are two-party; link rooms hold one descriptor
// plus a bounded queue of join requests awaiting the minter's next sync.
const MAX_JOIN_OFFERS = 32;
// TTL ceilings by role: two-party exchanges are ephemeral, descriptors may
// out-live them by design (async links), joins wait for the minter's sync.
const TTL_CEILING_MS: Record<RendezvousRole, number> = {
  pair: 10 * 60 * 1000,
  descriptor: 30 * 24 * 60 * 60 * 1000,
  join: 24 * 60 * 60 * 1000,
};

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

// Pure room-state transition, kept separate from Durable Object plumbing so
// it is unit-testable. Returns the offers to store and the caller's view.
export function applyExchange(
  offers: RendezvousStoredOffer[],
  body: ExchangeBody,
  now: number,
): { stored: RendezvousStoredOffer[]; visible: RendezvousStoredOffer[] } | { error: string; status: number } {
  const active = offers.filter((offer) => Date.parse(offer.expiresAt) > now);

  // Two-party and link rooms never mix: a secret is either a pairing/sync
  // code or a link token, so mixed roles indicate a client bug or mischief.
  const hasPair = active.some((offer) => offer.role === 'pair');
  if ((body.role === 'pair') !== hasPair && active.length > 0) {
    return { error: 'room role mismatch', status: 409 };
  }

  const existingIndex = active.findIndex((offer) => offer.participantId === body.participantId);
  if (existingIndex === -1) {
    if (body.role === 'pair' && active.length >= 2) {
      return { error: 'pairing room is full', status: 409 };
    }
    if (body.role === 'descriptor' && active.some((offer) => offer.role === 'descriptor')) {
      return { error: 'room already has a descriptor', status: 409 };
    }
    // A join may arrive before its descriptor (sync-code flows race); it
    // simply waits in the room. The cap bounds what a spammed room can hold.
    if (body.role === 'join' && active.filter((offer) => offer.role === 'join').length >= MAX_JOIN_OFFERS) {
      return { error: 'invite is saturated', status: 429 };
    }
  }

  const cappedExpiry = Math.min(Date.parse(body.expiresAt), now + TTL_CEILING_MS[body.role]);
  const nextOffer: RendezvousStoredOffer = {
    offerId: body.encryptedOffer.iv,
    participantId: body.participantId,
    role: body.role,
    encryptedOffer: body.encryptedOffer,
    expiresAt: new Date(cappedExpiry).toISOString(),
  };
  const stored = existingIndex >= 0
    ? active.map((offer, index) => (index === existingIndex ? nextOffer : offer))
    : [...active, nextOffer];

  // Visibility: joiners see only the descriptor and themselves — never each
  // other. Pair participants and the descriptor holder see the whole room.
  const visible = body.role === 'join'
    ? stored.filter((offer) => offer.role === 'descriptor' || offer.participantId === body.participantId)
    : stored;

  return { stored, visible };
}

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

function validateExchangeBody(body: ExchangeBody): void {
  if (!body || typeof body !== 'object') {
    throw new Error('body must be an object');
  }
  if (typeof body.participantId !== 'string' || body.participantId.length === 0) {
    throw new Error('participantId is required');
  }
  if (body.role !== 'pair' && body.role !== 'descriptor' && body.role !== 'join') {
    throw new Error('role must be pair, descriptor, or join');
  }
  if (typeof body.expiresAt !== 'string' || Number.isNaN(Date.parse(body.expiresAt))) {
    throw new Error('expiresAt is required');
  }
  if (!body.encryptedOffer || typeof body.encryptedOffer !== 'object') {
    throw new Error('encryptedOffer is required');
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
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'POST, DELETE, OPTIONS');
  headers.set('access-control-allow-headers', 'content-type');
  headers.set('access-control-max-age', '86400');
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
