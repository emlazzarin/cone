import { describe, expect, test } from 'bun:test';

import {
  codeScopedKey,
  createConeClient,
  createEncryptedPairingOffer,
  decryptJson,
  deriveAccount,
  MemoryStore,
  secretKeyFromHexSeed,
  type ConeConsentState,
  type ConeConversation,
  type ConeIdentity,
  type IncomingMessage,
  type MessageHandler,
  type PairingOffer,
  type RendezvousClient,
  type RendezvousRole,
  type RendezvousStoredOffer,
  type ResolvedIdentity,
  type SentMessage,
  type XmtpAdapter,
} from '../src/index';

describe('pairing protocol', () => {
  test('pairs two clients with the same code and saves contacts on both sides', async () => {
    const rendezvous = new MemoryRendezvous();
    const firstAdapter = new PairingAdapter('inbox-one', '0x1111111111111111111111111111111111111111');
    const secondAdapter = new PairingAdapter('inbox-two', '0x2222222222222222222222222222222222222222');
    const first = await createConeClient({
      account: deriveAccount(secretKeyFromHexSeed('02'.repeat(32)), { env: 'dev' }),
      rendezvous,
      store: new MemoryStore(),
      xmtp: firstAdapter,
    });
    const second = await createConeClient({
      account: deriveAccount(secretKeyFromHexSeed('03'.repeat(32)), { env: 'dev' }),
      rendezvous,
      store: new MemoryStore(),
      xmtp: secondAdapter,
    });

    const [firstResult, secondResult] = await Promise.all([
      first.pairWithCode('anchor-beacon-cedar-drift-ember', { proposedName: 'One', timeoutMs: 2_000 }),
      second.pairWithCode('anchor-beacon-cedar-drift-ember', { proposedName: 'Two', timeoutMs: 2_000 }),
    ]);

    expect(firstResult.contact.inboxId).toBe('inbox-two');
    expect(secondResult.contact.inboxId).toBe('inbox-one');
    expect((await first.listContacts()).some((contact) => contact.source === 'paired' && contact.inboxId === 'inbox-two')).toBe(true);
    expect((await second.listContacts()).some((contact) => contact.source === 'paired' && contact.inboxId === 'inbox-one')).toBe(true);
    expect(firstAdapter.sentConfirmations).toBe(1);
    expect(secondAdapter.sentConfirmations).toBe(1);
  });

  test('wrong handshake code cannot decrypt a pairing offer', async () => {
    const encrypted = await createEncryptedPairingOffer({
      code: 'correct-code-value',
      identity: { env: 'dev', inboxId: 'inbox-a' },
    });

    await expect(decryptJson<PairingOffer>(codeScopedKey('wrong-code-value'), encrypted.encryptedOffer)).rejects.toThrow();
  });

  test('pairing the same account with itself fails fast instead of timing out', async () => {
    const rendezvous = new MemoryRendezvous();
    // Two apps (two adapters), one identity — e.g. the PWA and the CLI
    // unlocked with the same SECRET KEY.
    const firstApp = new PairingAdapter('inbox-same', '0x1111111111111111111111111111111111111111');
    const secondApp = new PairingAdapter('inbox-same', '0x1111111111111111111111111111111111111111');
    const first = await createConeClient({
      account: deriveAccount(secretKeyFromHexSeed('06'.repeat(32)), { env: 'dev' }),
      rendezvous,
      store: new MemoryStore(),
      xmtp: firstApp,
    });
    const second = await createConeClient({
      account: deriveAccount(secretKeyFromHexSeed('06'.repeat(32)), { env: 'dev' }),
      rendezvous,
      store: new MemoryStore(),
      xmtp: secondApp,
    });

    const outcomes = await Promise.allSettled([
      first.pairWithCode('anchor-beacon-cedar-drift-ember', { timeoutMs: 5_000 }),
      second.pairWithCode('anchor-beacon-cedar-drift-ember', { timeoutMs: 5_000 }),
    ]);

    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason.message).toMatch(/same account/);
    }
  });

  test('rendezvous rejects a third participant', async () => {
    const rendezvous = new MemoryRendezvous();
    const offer = await fakeStoredOffer('a');

    await rendezvous.exchangeOffer({ roomId: 'room-hash', role: 'pair', participantId: 'one', encryptedOffer: offer.encryptedOffer, expiresAt: offer.expiresAt });
    await rendezvous.exchangeOffer({ roomId: 'room-hash', role: 'pair', participantId: 'two', encryptedOffer: offer.encryptedOffer, expiresAt: offer.expiresAt });

    await expect(
      rendezvous.exchangeOffer({ roomId: 'room-hash', role: 'pair', participantId: 'three', encryptedOffer: offer.encryptedOffer, expiresAt: offer.expiresAt }),
    ).rejects.toThrow(/full/i);
  });

  test('rendezvous drops expired offers', async () => {
    const rendezvous = new MemoryRendezvous();
    const expired = await fakeStoredOffer('expired', new Date(Date.now() - 1000).toISOString());
    const active = await fakeStoredOffer('active');

    await rendezvous.exchangeOffer({ roomId: 'ttl-hash', role: 'pair', participantId: 'expired', encryptedOffer: expired.encryptedOffer, expiresAt: expired.expiresAt });
    const offers = await rendezvous.exchangeOffer({ roomId: 'ttl-hash', role: 'pair', participantId: 'active', encryptedOffer: active.encryptedOffer, expiresAt: active.expiresAt });

    expect(offers.map((offer) => offer.participantId)).toEqual(['active']);
  });
});

// Mirrors the v2 worker semantics: rooms keyed by a hash of the secret,
// capacity 2 for 'pair', join offers visible only to the descriptor holder.
class MemoryRendezvous implements RendezvousClient {
  private readonly rooms = new Map<string, RendezvousStoredOffer[]>();

  async exchangeOffer(input: {
    roomId: string;
    participantId: string;
    role: RendezvousRole;
    encryptedOffer: RendezvousStoredOffer['encryptedOffer'];
    expiresAt: string;
  }): Promise<RendezvousStoredOffer[]> {
    const active = (this.rooms.get(input.roomId) ?? []).filter((offer) => Date.parse(offer.expiresAt) > Date.now());
    const existingIndex = active.findIndex((offer) => offer.participantId === input.participantId);
    if (existingIndex === -1 && input.role === 'pair' && active.length >= 2) {
      throw new Error('pairing room is full');
    }

    const offer = {
      encryptedOffer: input.encryptedOffer,
      expiresAt: input.expiresAt,
      offerId: input.encryptedOffer.iv,
      participantId: input.participantId,
      role: input.role,
    };
    if (existingIndex >= 0) {
      active[existingIndex] = offer;
    } else {
      active.push(offer);
    }
    this.rooms.set(input.roomId, active);
    return input.role === 'join'
      ? active.filter((stored) => stored.role === 'descriptor' || stored.participantId === input.participantId)
      : active;
  }

  async deleteRoom(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
  }
}

class PairingAdapter implements XmtpAdapter {
  sentConfirmations = 0;

  constructor(private readonly inboxId: string, private readonly address: string) {}

  identity(): Promise<ConeIdentity> {
    return Promise.resolve({ address: this.address, env: 'dev', inboxId: this.inboxId });
  }

  resolveIdentity(): Promise<ResolvedIdentity | null> {
    return Promise.resolve(null);
  }

  canMessage(): Promise<boolean> {
    return Promise.resolve(true);
  }

  sendText(_identity: ResolvedIdentity, _text: string): Promise<SentMessage> {
    return Promise.resolve({ messageId: crypto.randomUUID(), sentAt: new Date().toISOString() });
  }

  // Pair confirmations ride the envelope content type.
  sendEnvelope(_identity: ResolvedIdentity, _envelope: unknown): Promise<SentMessage> {
    this.sentConfirmations += 1;
    return Promise.resolve({ messageId: crypto.randomUUID(), sentAt: new Date().toISOString() });
  }

  streamMessages(_handler: MessageHandler) {
    return Promise.resolve(() => undefined);
  }

  sync() {
    return Promise.resolve({ conversations: [], messages: [] });
  }

  listConversations(): Promise<ConeConversation[]> {
    return Promise.resolve([]);
  }

  listMessages(): Promise<IncomingMessage[]> {
    return Promise.resolve([]);
  }

  setConsent(): Promise<void> {
    return Promise.resolve();
  }

  getConsent(): Promise<ConeConsentState> {
    return Promise.resolve('unknown');
  }

  setGroupConsent(): Promise<void> {
    return Promise.resolve();
  }

  sendToConversation(): Promise<SentMessage> {
    return Promise.resolve({ messageId: crypto.randomUUID(), sentAt: new Date().toISOString() });
  }

  createGroup(): Promise<ConeConversation> {
    return Promise.reject(new Error('groups unsupported in pairing tests'));
  }

  getGroupInfo(): Promise<ConeConversation | null> {
    return Promise.resolve(null);
  }

  listGroupMembers(): Promise<never[]> {
    return Promise.resolve([]);
  }

  addGroupMembers(): Promise<void> {
    return Promise.resolve();
  }

  removeGroupMembers(): Promise<void> {
    return Promise.resolve();
  }

  leaveGroup(): Promise<void> {
    return Promise.resolve();
  }

  updateGroupName(): Promise<void> {
    return Promise.resolve();
  }

  updateGroupDescription(): Promise<void> {
    return Promise.resolve();
  }

  addGroupAdmin(): Promise<void> {
    return Promise.resolve();
  }

  removeGroupAdmin(): Promise<void> {
    return Promise.resolve();
  }

  addGroupSuperAdmin(): Promise<void> {
    return Promise.resolve();
  }

  removeGroupSuperAdmin(): Promise<void> {
    return Promise.resolve();
  }

  setRetention(): Promise<void> {
    return Promise.resolve();
  }

  getRetention(): Promise<null> {
    return Promise.resolve(null);
  }
}

async function fakeStoredOffer(id: string, expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  const offer = await createEncryptedPairingOffer({
    code: 'room-code',
    identity: { env: 'dev', inboxId: `inbox-${id}` },
  });
  return { ...offer, expiresAt };
}
