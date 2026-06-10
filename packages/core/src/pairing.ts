import { codeScopedKey, decryptJson, encryptJson, normalizeHandshakeCode, randomHandshakeCode, randomId, sha256Hex } from './crypto';
import type { ConeIdentity, HandshakeCode, PairingOffer, RendezvousStoredOffer } from './types';

export const PAIRING_TTL_MS = 10 * 60 * 1000;

export function createHandshakeCode(now: Date = new Date()): HandshakeCode {
  return {
    code: randomHandshakeCode(),
    expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
  };
}

export async function createEncryptedPairingOffer(input: {
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
  const encryptedOffer = await encryptJson<PairingOffer>(codeScopedKey(input.code), 'cone.pairing.offer.v1', offer);
  const participantId = sha256Hex(`${normalizeHandshakeCode(input.code)}:${offer.inboxId}:${offer.nonce}`);

  return { participantId, offer, encryptedOffer };
}

// Finds the peer's offer among the stored offers for a code: skips our own,
// and accepts only an offer that decrypts under the code and belongs to a
// different inbox on the same network.
export async function decryptPeerOffer(
  offers: RendezvousStoredOffer[],
  input: { code: string; participantId: string; identity: ConeIdentity },
): Promise<PairingOffer | null> {
  const key = codeScopedKey(input.code);

  for (const stored of offers) {
    if (stored.participantId === input.participantId) {
      continue;
    }

    try {
      const peer = await decryptJson<PairingOffer>(key, stored.encryptedOffer);
      if (peer.inboxId !== input.identity.inboxId && peer.env === input.identity.env) {
        return peer;
      }
    } catch {
      continue;
    }
  }

  return null;
}
