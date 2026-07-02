// Synchronous group invite codes: the pairing machinery reused asymmetrically.
// The inviter (already in the group) posts an encrypted *group descriptor* to
// the rendezvous room; the joiner posts a *join request*. The inviter's client
// decrypts the request and calls addMembers — auto-add is correct here because
// the code was created seconds ago, so intent is unambiguous. Every payload
// sharing the rendezvous keyspace carries an explicit `type` field (pairing
// offers included): decryptJson does not authenticate the schema label, so the
// type inside the ciphertext is the authoritative discriminator.
import { decryptJson, encryptJson, inviteScopedKey, normalizeRendezvousSecret, sha256Hex } from './crypto';
import { PAIRING_TTL_MS, isKnownOfferSchema, networkMismatchError, unknownVersionError } from './pairing';
import type { ConeConversation, ConeIdentity, RendezvousStoredOffer, XmtpEnv } from './types';
import type { EncryptedJson } from './crypto';

export const GROUP_INVITE_TTL_MS = PAIRING_TTL_MS;
// A pending join outlives the code: the inviter adds within seconds, but the
// joiner's next sync (which delivers the welcome) may be much later.
export const PENDING_GROUP_JOIN_TTL_MS = 24 * 60 * 60 * 1000;
// Async links default to one use and a week: a link is a capability, so the
// conservative default is closest to a code; both are caller-adjustable.
export const GROUP_INVITE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const GROUP_INVITE_LINK_MAX_USES = 1;

export const GROUP_INVITE_DESCRIPTOR_TYPE = 'cone.group.invite.descriptor.v1';
export const GROUP_JOIN_REQUEST_TYPE = 'cone.group.invite.join.v1';

export interface GroupInviteDescriptor {
  type: typeof GROUP_INVITE_DESCRIPTOR_TYPE;
  env: XmtpEnv;
  conversationId: string;
  groupName?: string;
  memberCount: number;
  inviterInboxId: string;
  inviterAddress?: string;
  nonce: string;
  createdAt: string;
}

export interface GroupJoinRequest {
  type: typeof GROUP_JOIN_REQUEST_TYPE;
  env: XmtpEnv;
  inboxId: string;
  address?: string;
  proposedName?: string;
  nonce: string;
  createdAt: string;
}

export async function createEncryptedGroupDescriptor(input: {
  code: string;
  identity: ConeIdentity;
  conversation: Pick<ConeConversation, 'conversationId' | 'groupName' | 'memberCount'>;
  // Link servicing re-posts the descriptor on every pass; a stable nonce keeps
  // the participant id stable so the re-post replaces instead of duplicating.
  nonce?: string;
  now?: Date;
}): Promise<{ participantId: string; descriptor: GroupInviteDescriptor; encrypted: EncryptedJson<GroupInviteDescriptor> }> {
  const now = input.now ?? new Date();
  const descriptor: GroupInviteDescriptor = {
    type: GROUP_INVITE_DESCRIPTOR_TYPE,
    env: input.identity.env,
    conversationId: input.conversation.conversationId,
    groupName: input.conversation.groupName,
    memberCount: input.conversation.memberCount ?? 0,
    inviterInboxId: input.identity.inboxId,
    inviterAddress: input.identity.address,
    nonce: input.nonce ?? crypto.randomUUID(),
    createdAt: now.toISOString(),
  };
  const encrypted = await encryptJson<GroupInviteDescriptor>(inviteScopedKey(input.code), GROUP_INVITE_DESCRIPTOR_TYPE, descriptor);
  const participantId = participantIdFor(input.code, input.identity.inboxId, descriptor.nonce);
  return { participantId, descriptor, encrypted };
}

export async function createEncryptedJoinRequest(input: {
  code: string;
  identity: ConeIdentity;
  proposedName?: string;
  now?: Date;
}): Promise<{ participantId: string; request: GroupJoinRequest; encrypted: EncryptedJson<GroupJoinRequest> }> {
  const now = input.now ?? new Date();
  const request: GroupJoinRequest = {
    type: GROUP_JOIN_REQUEST_TYPE,
    env: input.identity.env,
    inboxId: input.identity.inboxId,
    address: input.identity.address,
    proposedName: input.proposedName,
    nonce: crypto.randomUUID(),
    createdAt: now.toISOString(),
  };
  const encrypted = await encryptJson<GroupJoinRequest>(inviteScopedKey(input.code), GROUP_JOIN_REQUEST_TYPE, request);
  const participantId = participantIdFor(input.code, input.identity.inboxId, request.nonce);
  return { participantId, request, encrypted };
}

// Inviter side, synchronous code flow: find the joiner's request. Exactly one
// joiner is expected, so anything unreadable fails fast — an unfamiliar
// payload schema means the joiner is on a newer Cone, and waiting cannot fix
// that.
export async function decryptJoinRequest(
  offers: RendezvousStoredOffer[],
  input: { code: string; participantId: string; identity: ConeIdentity },
): Promise<GroupJoinRequest | null> {
  for (const stored of foreignOffers(offers, input.participantId)) {
    if (!isKnownOfferSchema(stored.encryptedOffer.schema)) {
      throw unknownVersionError(stored.encryptedOffer.schema);
    }
  }
  const requests = await decryptJoinRequests(offers, input);
  return requests[0]?.request ?? null;
}

// Link servicing decrypts every valid join request in the room, keyed by
// participant id so servicing stays idempotent across sync passes. Lenient by
// design: one unreadable request (corrupt, or from a newer Cone) must never
// wedge the link for everyone else — it is simply left unserviced.
export async function decryptJoinRequests(
  offers: RendezvousStoredOffer[],
  input: { code: string; participantId: string; identity: ConeIdentity },
): Promise<Array<{ participantId: string; request: GroupJoinRequest }>> {
  const key = inviteScopedKey(input.code);
  const requests: Array<{ participantId: string; request: GroupJoinRequest }> = [];
  for (const stored of foreignOffers(offers, input.participantId)) {
    try {
      const payload = await decryptJson<GroupJoinRequest>(key, stored.encryptedOffer);
      if (payload
        && payload.type === GROUP_JOIN_REQUEST_TYPE
        && typeof payload.inboxId === 'string'
        && payload.inboxId !== input.identity.inboxId
        && payload.env === input.identity.env) {
        requests.push({ participantId: stored.participantId, request: payload });
      }
    } catch {
      continue;
    }
  }
  return requests;
}

// Joiner side: find the inviter's group descriptor. Fails loudly on the
// conditions waiting cannot fix (newer-version schema, wrong network).
export async function decryptGroupDescriptor(
  offers: RendezvousStoredOffer[],
  input: { code: string; participantId: string; identity: ConeIdentity },
): Promise<GroupInviteDescriptor | null> {
  const key = inviteScopedKey(input.code);
  for (const stored of foreignOffers(offers, input.participantId)) {
    if (!isKnownOfferSchema(stored.encryptedOffer.schema)) {
      throw unknownVersionError(stored.encryptedOffer.schema);
    }
    let payload: GroupInviteDescriptor;
    try {
      payload = await decryptJson<GroupInviteDescriptor>(key, stored.encryptedOffer);
    } catch {
      continue;
    }
    if (payload?.type !== GROUP_INVITE_DESCRIPTOR_TYPE
      || typeof payload.conversationId !== 'string'
      || payload.inviterInboxId === input.identity.inboxId) {
      continue;
    }
    if (payload.env !== input.identity.env) {
      throw networkMismatchError(payload.env, input.identity.env);
    }
    return payload;
  }
  return null;
}

function foreignOffers(offers: RendezvousStoredOffer[], participantId: string): RendezvousStoredOffer[] {
  return offers.filter((stored) => stored.participantId !== participantId);
}

function participantIdFor(code: string, inboxId: string, nonce: string): string {
  return sha256Hex(`${normalizeRendezvousSecret(code)}:${inboxId}:${nonce}`);
}
