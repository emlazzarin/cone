import type { RendezvousRole, RendezvousStoredOffer } from '@cone/core';

// Rendezvous v2 room semantics, host-agnostic. Two hosts consume this: the
// Cloudflare Worker (index.ts, Durable Object per room) and the Bun server
// (server.ts, SQLite row per room). Room state transitions live here so the
// two cannot drift.
export interface ExchangeBody {
  roomId: string;
  participantId: string;
  role: RendezvousRole;
  encryptedOffer: RendezvousStoredOffer['encryptedOffer'];
  expiresAt: string;
}

export const ROOM_ID_PATTERN = /^[0-9a-f]{64}$/u;
// Pairing and sync-code rooms are two-party; link rooms hold one descriptor
// plus a bounded queue of join requests awaiting the minter's next sync.
export const MAX_JOIN_OFFERS = 32;
// TTL ceilings by role: two-party exchanges are ephemeral, descriptors may
// out-live them by design (async links), joins wait for the minter's sync.
export const TTL_CEILING_MS: Record<RendezvousRole, number> = {
  pair: 30 * 60 * 1000,
  descriptor: 30 * 24 * 60 * 60 * 1000,
  join: 24 * 60 * 60 * 1000,
};

// Pure room-state transition, kept separate from host plumbing so it is
// unit-testable. Returns the offers to store and the caller's view.
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

export function validateExchangeBody(body: ExchangeBody): void {
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

export function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}
