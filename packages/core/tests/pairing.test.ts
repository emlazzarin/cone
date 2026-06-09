import { describe, expect, test } from 'bun:test';

import {
  codeScopedKey,
  createConeClient,
  createEncryptedPairingOffer,
  decryptJson,
  deriveAccount,
  MemoryStore,
  secretKeyFromHexSeed,
  type ConeConversation,
  type ConeIdentity,
  type IncomingMessage,
  type MessageHandler,
  type PairingOffer,
  type RendezvousClient,
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
    const account = deriveAccount(secretKeyFromHexSeed('04'.repeat(32)), { env: 'dev' });
    const encrypted = await createEncryptedPairingOffer({
      account,
      code: 'correct-code-value',
      identity: { env: 'dev', inboxId: 'inbox-a' },
    });

    await expect(decryptJson<PairingOffer>(codeScopedKey(account.pairingKey, 'wrong-code-value'), encrypted.encryptedOffer)).rejects.toThrow();
  });

  test('rendezvous rejects a third participant', async () => {
    const rendezvous = new MemoryRendezvous();
    const offer = await fakeStoredOffer('a');

    await rendezvous.exchangeOffer({ code: 'room-code', participantId: 'one', encryptedOffer: offer.encryptedOffer, expiresAt: offer.expiresAt });
    await rendezvous.exchangeOffer({ code: 'room-code', participantId: 'two', encryptedOffer: offer.encryptedOffer, expiresAt: offer.expiresAt });

    await expect(
      rendezvous.exchangeOffer({ code: 'room-code', participantId: 'three', encryptedOffer: offer.encryptedOffer, expiresAt: offer.expiresAt }),
    ).rejects.toThrow(/full/i);
  });

  test('rendezvous drops expired offers', async () => {
    const rendezvous = new MemoryRendezvous();
    const expired = await fakeStoredOffer('expired', new Date(Date.now() - 1000).toISOString());
    const active = await fakeStoredOffer('active');

    await rendezvous.exchangeOffer({ code: 'ttl-code', participantId: 'expired', encryptedOffer: expired.encryptedOffer, expiresAt: expired.expiresAt });
    const offers = await rendezvous.exchangeOffer({ code: 'ttl-code', participantId: 'active', encryptedOffer: active.encryptedOffer, expiresAt: active.expiresAt });

    expect(offers.map((offer) => offer.participantId)).toEqual(['active']);
  });
});

class MemoryRendezvous implements RendezvousClient {
  private readonly rooms = new Map<string, RendezvousStoredOffer[]>();

  async exchangeOffer(input: {
    code: string;
    participantId: string;
    encryptedOffer: RendezvousStoredOffer['encryptedOffer'];
    expiresAt: string;
  }): Promise<RendezvousStoredOffer[]> {
    const active = (this.rooms.get(input.code) ?? []).filter((offer) => Date.parse(offer.expiresAt) > Date.now());
    const existingIndex = active.findIndex((offer) => offer.participantId === input.participantId);
    if (existingIndex === -1 && active.length >= 2) {
      throw new Error('pairing room is full');
    }

    const offer = {
      encryptedOffer: input.encryptedOffer,
      expiresAt: input.expiresAt,
      offerId: input.encryptedOffer.iv,
      participantId: input.participantId,
    };
    if (existingIndex >= 0) {
      active[existingIndex] = offer;
    } else {
      active.push(offer);
    }
    this.rooms.set(input.code, active);
    return active;
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
}

async function fakeStoredOffer(id: string, expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  const account = deriveAccount(secretKeyFromHexSeed('05'.repeat(32)), { env: 'dev' });
  const offer = await createEncryptedPairingOffer({
    account,
    code: 'room-code',
    identity: { env: 'dev', inboxId: `inbox-${id}` },
  });
  return { ...offer, expiresAt };
}
