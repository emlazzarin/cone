import { ConeError } from './errors';
import { codeScopedKey, decryptJson, encryptJson, normalizeHandshakeCode, randomHandshakeCode, randomId, sha256Hex } from './crypto';
import type { ConeIdentity, HandshakeCode, PairingOffer, RendezvousStoredOffer } from './types';

// Thirty minutes: long enough for the slow side of a human↔agent handshake
// (installing Cone from scratch mid-pair is the common case), short enough
// that a leaked code goes stale within the hour.
export const PAIRING_TTL_MS = 30 * 60 * 1000;

export const PAIRING_OFFER_TYPE = 'cone.pairing.offer.v1';

// Every schema label this build knows how to read out of a rendezvous room.
// The label rides in cleartext on the stored offer, so an unfamiliar one is
// detectable before (and without) decryption — that is what turns "silently
// time out against a newer peer" into an actionable error.
const KNOWN_OFFER_SCHEMAS = new Set([
  'cone.pairing.offer.v1',
  'cone.group.invite.descriptor.v1',
  'cone.group.invite.join.v1',
]);

export function isKnownOfferSchema(schema: string): boolean {
  return KNOWN_OFFER_SCHEMAS.has(schema);
}

export function unknownVersionError(schema: string): Error {
  return new Error(
    `the other side posted a payload this version of Cone cannot read (${schema}) — ` +
    'one of you is on a newer Cone; update and try again',
  );
}

export function networkMismatchError(peerEnv: string, ourEnv: string): Error {
  return new Error(
    `the other side is on the "${peerEnv}" XMTP network and this app is on "${ourEnv}" — ` +
    'both sides must use the same network',
  );
}

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
    type: PAIRING_OFFER_TYPE,
    offerId: randomId('offer'),
    env: input.identity.env,
    inboxId: input.identity.inboxId,
    address: input.identity.address,
    nonce: crypto.randomUUID(),
    capabilities: ['text', 'json'],
    proposedName: input.proposedName,
    createdAt: now.toISOString(),
  };
  const encryptedOffer = await encryptJson<PairingOffer>(codeScopedKey(input.code), PAIRING_OFFER_TYPE, offer);
  const participantId = sha256Hex(`${normalizeHandshakeCode(input.code)}:${offer.inboxId}:${offer.nonce}`);

  return { participantId, offer, encryptedOffer };
}

// Finds the peer's offer among the stored offers for a code, failing loudly on
// every condition that waiting cannot fix: an offer schema from a newer Cone,
// an offer that will not decrypt under this code, a peer on a different XMTP
// network, or our own account on the other side.
export async function decryptPeerOffer(
  offers: RendezvousStoredOffer[],
  input: { code: string; participantId: string; identity: ConeIdentity },
): Promise<PairingOffer | null> {
  const key = codeScopedKey(input.code);

  for (const stored of offers) {
    if (stored.participantId === input.participantId) {
      continue;
    }
    if (!isKnownOfferSchema(stored.encryptedOffer.schema)) {
      throw unknownVersionError(stored.encryptedOffer.schema);
    }

    let peer: PairingOffer;
    try {
      peer = await decryptJson<PairingOffer>(key, stored.encryptedOffer);
    } catch {
      // Same room implies the same normalized code, so a failed decrypt is
      // corruption or a client bug — retrying the loop cannot help.
      throw new Error(
        "could not decrypt the other side's offer — check that both sides entered exactly the same code, then mint a fresh one",
      );
    }
    if (peer?.type !== PAIRING_OFFER_TYPE || typeof peer.inboxId !== 'string') {
      // A group-invite payload under a pairing wait: the code belongs to the
      // other flow. (The rendezvous worker rejects mixed rooms, so this is
      // belt-and-braces.)
      throw new Error('this code is a group invite, not a pairing code — join it with the group-join flow');
    }
    // The other participant is this same account from another app. Waiting
    // longer can never succeed — fail fast instead of timing out silently.
    if (peer.inboxId === input.identity.inboxId) {
      throw new ConeError(
        'SELF_PAIRING',
        'the other side of this code is this same account — pairing connects two different accounts. ' +
        'Two apps unlocked with the same SECRET KEY already share an identity (and their conversations sync); there is nothing to pair.',
      );
    }
    if (peer.env !== input.identity.env) {
      throw networkMismatchError(peer.env, input.identity.env);
    }
    return peer;
  }

  return null;
}
