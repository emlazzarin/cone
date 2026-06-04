import { codeScopedKey, decryptJson, encryptJson, normalizeHandshakeCode, randomHandshakeCode, randomId, sha256Hex } from './crypto';
import type { ConeIdentity, DerivedAccount, HandshakeCode, PairingOffer, RendezvousClient, RendezvousStoredOffer } from './types';

export const PAIRING_TTL_MS = 10 * 60 * 1000;

export function createHandshakeCode(now: Date = new Date()): HandshakeCode {
  return {
    code: randomHandshakeCode(),
    expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
  };
}

export async function createEncryptedPairingOffer(input: {
  account: DerivedAccount;
  code: string;
  identity: ConeIdentity;
  proposedName?: string;
  now?: Date;
}): Promise<{ participantId: string; offer: PairingOffer; encryptedOffer: RendezvousStoredOffer['encryptedOffer'] }> {
  const now = input.now ?? new Date();
  const offer: PairingOffer = {
    offerId: randomId('offer'),
    env: input.identity.env,
    inboxId: input.identity.inboxId,
    address: input.identity.address,
    nonce: crypto.randomUUID(),
    capabilities: ['text', 'json'],
    proposedName: input.proposedName,
    createdAt: now.toISOString(),
  };
  const key = codeScopedKey(input.account.pairingKey, input.code);
  const encryptedOffer = await encryptJson<PairingOffer>(key, 'cone.pairing.offer.v1', offer);
  const participantId = sha256Hex(`${normalizeHandshakeCode(input.code)}:${offer.inboxId}:${offer.nonce}`);

  return { participantId, offer, encryptedOffer };
}

export async function exchangePairingOffer(input: {
  rendezvous: RendezvousClient;
  account: DerivedAccount;
  code: string;
  identity: ConeIdentity;
  proposedName?: string;
  now?: Date;
}): Promise<PairingOffer> {
  const now = input.now ?? new Date();
  const { participantId, encryptedOffer } = await createEncryptedPairingOffer(input);
  const offers = await input.rendezvous.exchangeOffer({
    code: normalizeHandshakeCode(input.code),
    participantId,
    encryptedOffer,
    expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
  });
  const key = codeScopedKey(input.account.pairingKey, input.code);

  for (const storedOffer of offers) {
    if (storedOffer.participantId === participantId) {
      continue;
    }

    try {
      const peer = await decryptJson<PairingOffer>(key, storedOffer.encryptedOffer);
      if (peer.inboxId !== input.identity.inboxId && peer.env === input.identity.env) {
        return peer;
      }
    } catch {
      continue;
    }
  }

  throw new Error('pairing peer not available yet');
}
