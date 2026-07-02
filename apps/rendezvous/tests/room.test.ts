import { describe, expect, test } from 'bun:test';

import type { RendezvousRole, RendezvousStoredOffer } from '@cone/core';

import { applyExchange } from '../src/index';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');

describe('rendezvous v2 room semantics', () => {
  test('pair rooms cap at two participants', () => {
    let offers: RendezvousStoredOffer[] = [];
    offers = mustStore(applyExchange(offers, body('one', 'pair'), NOW));
    offers = mustStore(applyExchange(offers, body('two', 'pair'), NOW));

    const third = applyExchange(offers, body('three', 'pair'), NOW);
    expect('error' in third && third.status).toBe(409);

    // A known participant may refresh its own offer.
    const refresh = applyExchange(offers, body('two', 'pair'), NOW);
    expect('stored' in refresh && refresh.stored.length).toBe(2);
  });

  test('pair and invite roles never share a room', () => {
    const offers = mustStore(applyExchange([], body('minter', 'descriptor'), NOW));
    const clash = applyExchange(offers, body('pairer', 'pair'), NOW);
    expect('error' in clash && clash.status).toBe(409);
  });

  test('a room holds exactly one descriptor', () => {
    const offers = mustStore(applyExchange([], body('minter', 'descriptor'), NOW));
    const second = applyExchange(offers, body('other-minter', 'descriptor'), NOW);
    expect('error' in second && second.error).toMatch(/descriptor/);
  });

  test('a join may wait in an empty room and joiners never see each other', () => {
    let offers = mustStore(applyExchange([], body('early-joiner', 'join'), NOW));
    offers = mustStore(applyExchange(offers, body('minter', 'descriptor'), NOW));
    const result = applyExchange(offers, body('late-joiner', 'join'), NOW);
    if ('error' in result) {
      throw new Error(result.error);
    }

    // The room stores all three; the late joiner sees only the descriptor
    // and itself, while the descriptor holder sees everything.
    expect(result.stored.map((offer) => offer.participantId).sort()).toEqual(['early-joiner', 'late-joiner', 'minter']);
    expect(result.visible.map((offer) => offer.participantId).sort()).toEqual(['late-joiner', 'minter']);

    const minterView = applyExchange(result.stored, body('minter', 'descriptor'), NOW);
    expect('visible' in minterView && minterView.visible.length).toBe(3);
  });

  test('join offers saturate at the cap', () => {
    let offers = mustStore(applyExchange([], body('minter', 'descriptor'), NOW));
    for (let i = 0; i < 32; i += 1) {
      offers = mustStore(applyExchange(offers, body(`joiner-${i}`, 'join'), NOW));
    }
    const overflow = applyExchange(offers, body('joiner-32', 'join'), NOW);
    expect('error' in overflow && overflow.status).toBe(429);
  });

  test('expired offers are pruned and TTLs are capped per role', () => {
    const stale = mustStore(applyExchange([], body('old', 'pair', new Date(NOW - 1000).toISOString()), NOW - 60_000));
    const offers = mustStore(applyExchange(stale, body('fresh', 'pair'), NOW));
    expect(offers.map((offer) => offer.participantId)).toEqual(['fresh']);

    // A pair offer asking for a week is capped to the 10-minute ceiling.
    const greedy = mustStore(applyExchange([], body('greedy', 'pair', new Date(NOW + 7 * 24 * 60 * 60_000).toISOString()), NOW));
    expect(Date.parse(greedy[0]!.expiresAt)).toBe(NOW + 10 * 60_000);
  });
});

function body(participantId: string, role: RendezvousRole, expiresAt = new Date(NOW + 60_000).toISOString()) {
  return {
    roomId: 'a'.repeat(64),
    participantId,
    role,
    encryptedOffer: {
      alg: 'AES-256-GCM' as const,
      contentType: 'application/json' as const,
      schema: 'test',
      iv: `iv-${participantId}`,
      data: 'ciphertext',
    },
    expiresAt,
  };
}

function mustStore(result: ReturnType<typeof applyExchange>): RendezvousStoredOffer[] {
  if ('error' in result) {
    throw new Error(result.error);
  }
  return result.stored;
}
