import { describe, expect, test } from 'bun:test';

import { normalizeRendezvousSecret } from '../src/crypto';
import {
  codeScopedKey,
  createConeClient,
  createEncryptedGroupDescriptor,
  createEncryptedJoinRequest,
  createEncryptedPairingOffer,
  decryptGroupDescriptor,
  decryptJoinRequest,
  decryptJson,
  decryptPeerOffer,
  deriveAccount,
  MemoryStore,
  secretKeyFromHexSeed,
  type ConeConsentState,
  type ConeConversation,
  type ConeGroupMember,
  type ConeIdentity,
  type ConsentFilter,
  type CreateGroupOptions,
  type GroupInviteDescriptor,
  type IncomingMessage,
  type MessageHandler,
  type MessageRetention,
  type RendezvousClient,
  type RendezvousRole,
  type RendezvousStoredOffer,
  type ResolvedIdentity,
  type SentMessage,
  type XmtpAdapter,
} from '../src/index';

const CODE = 'anchor-beacon-cedar-drift-ember';

describe('group invite payloads', () => {
  test('descriptor and join request round-trip under the code and are type-discriminated', async () => {
    const inviter: ConeIdentity = { env: 'dev', inboxId: 'inbox-inviter', address: '0x' + '1'.repeat(40) };
    const joiner: ConeIdentity = { env: 'dev', inboxId: 'inbox-joiner', address: '0x' + '2'.repeat(40) };
    const descriptor = await createEncryptedGroupDescriptor({
      code: CODE,
      identity: inviter,
      conversation: { conversationId: 'group-1', groupName: 'Crew', memberCount: 3 },
    });
    const join = await createEncryptedJoinRequest({ code: CODE, identity: joiner, proposedName: 'Sam' });
    const offers: RendezvousStoredOffer[] = [
      { offerId: 'a', participantId: descriptor.participantId, role: 'descriptor' as const, encryptedOffer: descriptor.encrypted, expiresAt: future() },
      { offerId: 'b', participantId: join.participantId, role: 'join' as const, encryptedOffer: join.encrypted, expiresAt: future() },
    ];

    // Joiner finds the descriptor, inviter finds the join request.
    const foundDescriptor = await decryptGroupDescriptor(offers, { code: CODE, participantId: join.participantId, identity: joiner });
    expect(foundDescriptor?.conversationId).toBe('group-1');
    expect(foundDescriptor?.groupName).toBe('Crew');
    expect(foundDescriptor?.inviterInboxId).toBe('inbox-inviter');

    const foundJoin = await decryptJoinRequest(offers, { code: CODE, participantId: descriptor.participantId, identity: inviter });
    expect(foundJoin?.inboxId).toBe('inbox-joiner');
    expect(foundJoin?.proposedName).toBe('Sam');

    // The types never cross: an inviter polling for join requests skips its
    // own descriptor-shaped payload and vice versa.
    expect(await decryptJoinRequest(offers, { code: CODE, participantId: join.participantId, identity: joiner })).toBeNull();
    expect(await decryptGroupDescriptor(offers, { code: CODE, participantId: descriptor.participantId, identity: inviter })).toBeNull();
  });

  test('wrong code cannot decrypt a group descriptor', async () => {
    const { encrypted } = await createEncryptedGroupDescriptor({
      code: CODE,
      identity: { env: 'dev', inboxId: 'inbox-inviter' },
      conversation: { conversationId: 'group-1', memberCount: 2 },
    });
    await expect(decryptJson<GroupInviteDescriptor>(codeScopedKey('wrong-code-entirely'), encrypted)).rejects.toThrow();
  });

  test('pairing never mistakes a group invite payload for a peer offer — it names the mix-up', async () => {
    const identity: ConeIdentity = { env: 'dev', inboxId: 'inbox-me' };
    const { participantId, encrypted } = await createEncryptedGroupDescriptor({
      code: CODE,
      identity: { env: 'dev', inboxId: 'inbox-inviter' },
      conversation: { conversationId: 'group-1', memberCount: 2 },
    });
    const offers: RendezvousStoredOffer[] = [
      { offerId: 'a', participantId, role: 'descriptor' as const, encryptedOffer: encrypted, expiresAt: future() },
    ];
    // Waiting cannot fix a flow mix-up, so this fails fast with a pointer to
    // the group-join flow instead of decaying into a silent timeout.
    await expect(decryptPeerOffer(offers, { code: CODE, participantId: 'someone-else', identity }))
      .rejects.toThrow(/group invite, not a pairing code/);
  });

  test('mismatched network fails fast with the two env names', async () => {
    const descriptor = await createEncryptedGroupDescriptor({
      code: CODE,
      identity: { env: 'production', inboxId: 'inbox-inviter' },
      conversation: { conversationId: 'group-1', memberCount: 2 },
    });
    const devJoiner: ConeIdentity = { env: 'dev', inboxId: 'inbox-joiner' };

    // The joiner learns the inviter is on another network — waiting longer can
    // never succeed, so this is an error, not a null.
    await expect(decryptGroupDescriptor(
      [{ offerId: 'a', participantId: descriptor.participantId, role: 'descriptor' as const, encryptedOffer: descriptor.encrypted, expiresAt: future() }],
      { code: CODE, participantId: 'joiner', identity: devJoiner },
    )).rejects.toThrow(/"production" XMTP network.*"dev"/);

    // The inviter side stays lenient (shared with link servicing, which must
    // never wedge): a cross-network join request is simply not serviced.
    const join = await createEncryptedJoinRequest({ code: CODE, identity: { env: 'production', inboxId: 'inbox-joiner' } });
    const devInviter: ConeIdentity = { env: 'dev', inboxId: 'inbox-inviter' };
    expect(await decryptJoinRequest(
      [{ offerId: 'b', participantId: join.participantId, role: 'join' as const, encryptedOffer: join.encrypted, expiresAt: future() }],
      { code: CODE, participantId: 'inviter', identity: devInviter },
    )).toBeNull();
  });

  test('an offer schema from a newer Cone raises an update error, not a timeout', async () => {
    const identity: ConeIdentity = { env: 'dev', inboxId: 'inbox-me' };
    const futureOffer = await createEncryptedPairingOffer({ code: CODE, identity: { env: 'dev', inboxId: 'inbox-future' } });
    const offers: RendezvousStoredOffer[] = [{
      offerId: 'a',
      participantId: 'future-peer',
      role: 'pair' as const,
      encryptedOffer: { ...futureOffer.encryptedOffer, schema: 'cone.pairing.offer.v2' },
      expiresAt: future(),
    }];

    await expect(decryptPeerOffer(offers, { code: CODE, participantId: 'someone-else', identity }))
      .rejects.toThrow(/newer Cone/);
    await expect(decryptGroupDescriptor(offers, { code: CODE, participantId: 'someone-else', identity }))
      .rejects.toThrow(/newer Cone/);
    await expect(decryptJoinRequest(offers, { code: CODE, participantId: 'someone-else', identity }))
      .rejects.toThrow(/newer Cone/);
  });

  test('unrecognized invite-token versions are rejected with an update error', () => {
    expect(() => normalizeRendezvousSecret('cone_gi_v2_abcdef')).toThrow(/newer version of Cone/);
    // A spoken handshake code is untouched.
    expect(normalizeRendezvousSecret('Anchor Beacon')).toBe('anchor-beacon');
  });
});

describe('group invite flow', () => {
  test('inviter adds the joiner and the joiner records a pending join', async () => {
    const rendezvous = new MemoryRendezvous();
    const inviterAdapter = new GroupAdapter('inbox-inviter');
    const joinerAdapter = new GroupAdapter('inbox-joiner');
    const inviter = await createClient(inviterAdapter, rendezvous);
    const joiner = await createClient(joinerAdapter, rendezvous);
    const group = await inviter.createGroup({ members: [{ inboxId: 'inbox-friend' }], name: 'Crew' });

    const [inviteResult, joinResult] = await Promise.all([
      inviter.inviteToGroupWithCode(CODE, group.conversationId, { timeoutMs: 2_000 }),
      joiner.joinGroupWithCode(CODE, { proposedName: 'Sam', timeoutMs: 2_000 }),
    ]);

    expect(inviteResult.joiner.inboxId).toBe('inbox-joiner');
    expect(inviteResult.joiner.proposedName).toBe('Sam');
    expect(inviterAdapter.memberAdds).toEqual([{ conversationId: group.conversationId, added: ['inbox-joiner'] }]);

    expect(joinResult.conversationId).toBe(group.conversationId);
    expect(joinResult.groupName).toBe('Crew');
    expect(joinResult.inviter.inboxId).toBe('inbox-inviter');
    const pending = await joiner.listPendingGroupJoins();
    expect(pending.map((join) => join.conversationId)).toEqual([group.conversationId]);

    // No auto-contacts from any invite flow, on either side.
    expect((await inviter.listContacts()).some((contact) => contact.inboxId === 'inbox-joiner')).toBe(false);
    expect((await joiner.listContacts()).some((contact) => contact.inboxId === 'inbox-inviter')).toBe(false);
  });

  test('a pending join auto-allows the welcome instead of creating a Request', async () => {
    const rendezvous = new MemoryRendezvous();
    const inviterAdapter = new GroupAdapter('inbox-inviter');
    const joinerAdapter = new GroupAdapter('inbox-joiner');
    const inviter = await createClient(inviterAdapter, rendezvous);
    const joiner = await createClient(joinerAdapter, rendezvous);
    const group = await inviter.createGroup({ members: [], name: 'Crew' });

    await Promise.all([
      inviter.inviteToGroupWithCode(CODE, group.conversationId, { timeoutMs: 2_000 }),
      joiner.joinGroupWithCode(CODE, { timeoutMs: 2_000 }),
    ]);

    // The welcome arrives on the joiner's next sync as an unknown group added
    // by the inviter — a stranger, so without the pending join it would be a
    // Request (the inviter is not a contact and no toggle applies).
    joinerAdapter.conversations = [welcomeRow(group.conversationId, 'inbox-inviter')];
    await joiner.sync();

    const conversations = await joiner.listConversations();
    expect(conversations.find((row) => row.conversationId === group.conversationId)?.consentState).toBe('allowed');
    expect(joinerAdapter.groupConsent.get(group.conversationId)).toBe('allowed');
    // The pending entry is consumed by the welcome.
    expect(await joiner.listPendingGroupJoins()).toEqual([]);
  });

  test('an expired pending join falls through to the normal Request path', async () => {
    const adapter = new GroupAdapter('inbox-joiner');
    const store = new MemoryStore();
    await store.putMetadata({
      pendingGroupJoins: [{
        conversationId: 'group-late',
        inviterInboxId: 'inbox-inviter',
        requestedAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }],
    });
    const client = await createConeClient({
      account: deriveAccount(secretKeyFromHexSeed('05'.repeat(32)), { env: 'dev' }),
      store,
      xmtp: adapter,
    });

    adapter.conversations = [welcomeRow('group-late', 'inbox-inviter')];
    await client.sync();

    const row = (await client.listConversations()).find((entry) => entry.conversationId === 'group-late');
    expect(row?.consentState).toBe('unknown');
    expect(await client.listPendingGroupJoins()).toEqual([]);
  });

  test('cancelGroupJoin drops the pending entry', async () => {
    const rendezvous = new MemoryRendezvous();
    const inviterAdapter = new GroupAdapter('inbox-inviter');
    const joinerAdapter = new GroupAdapter('inbox-joiner');
    const inviter = await createClient(inviterAdapter, rendezvous);
    const joiner = await createClient(joinerAdapter, rendezvous);
    const group = await inviter.createGroup({ members: [], name: 'Crew' });

    const [, joinResult] = await Promise.all([
      inviter.inviteToGroupWithCode(CODE, group.conversationId, { timeoutMs: 2_000 }),
      joiner.joinGroupWithCode(CODE, { timeoutMs: 2_000 }),
    ]);
    await joiner.cancelGroupJoin(joinResult.conversationId);

    expect(await joiner.listPendingGroupJoins()).toEqual([]);
    // The welcome now goes through the normal policy: stranger add → Request.
    joinerAdapter.conversations = [welcomeRow(group.conversationId, 'inbox-inviter')];
    await joiner.sync();
    const row = (await joiner.listConversations()).find((entry) => entry.conversationId === group.conversationId);
    expect(row?.consentState).toBe('unknown');
  });

  test('inviting requires an active group membership', async () => {
    const rendezvous = new MemoryRendezvous();
    const adapter = new GroupAdapter('inbox-inviter');
    const client = await createClient(adapter, rendezvous);
    const group = await client.createGroup({ members: [], name: 'Crew' });
    await client.leaveGroup(group.conversationId);

    await expect(client.inviteToGroupWithCode(CODE, group.conversationId, { timeoutMs: 500 })).rejects.toThrow(/no longer a member/);
    await expect(client.inviteToGroupWithCode(CODE, 'dm:someone', { timeoutMs: 500 })).rejects.toThrow(/group not found/);
  });

  test('the reachability gate rejects an unreachable joiner before membership changes', async () => {
    const rendezvous = new MemoryRendezvous();
    const inviterAdapter = new GroupAdapter('inbox-inviter', { blockedInboxIds: ['inbox-joiner'] });
    const joinerAdapter = new GroupAdapter('inbox-joiner');
    const inviter = await createClient(inviterAdapter, rendezvous);
    const joiner = await createClient(joinerAdapter, rendezvous);
    const group = await inviter.createGroup({ members: [], name: 'Crew' });

    const [inviteOutcome] = await Promise.allSettled([
      inviter.inviteToGroupWithCode(CODE, group.conversationId, { timeoutMs: 2_000 }),
      joiner.joinGroupWithCode(CODE, { timeoutMs: 2_000 }),
    ]);

    expect(inviteOutcome.status).toBe('rejected');
    expect((inviteOutcome as PromiseRejectedResult).reason.message).toMatch(/not reachable/);
    expect(inviterAdapter.memberAdds).toEqual([]);
  });
});

describe('async invite links', () => {
  test('a minted link admits its joiner on the next service pass, then retires', async () => {
    const rendezvous = new MemoryRendezvous();
    const minterAdapter = new GroupAdapter('inbox-minter');
    const joinerAdapter = new GroupAdapter('inbox-joiner');
    const minter = await createClient(minterAdapter, rendezvous);
    const joiner = await createClient(joinerAdapter, rendezvous);
    const group = await minter.createGroup({ members: [], name: 'Crew' });

    const link = await minter.createGroupInviteLink(group.conversationId);
    expect(link.token.startsWith('cone_gi_v1_')).toBe(true);
    expect(link.maxUses).toBe(1);

    // The descriptor is already in the room — no waiting on the joiner side.
    const joinResult = await joiner.joinGroupWithCode(link.token, { proposedName: 'Sam', timeoutMs: 2_000 });
    expect(joinResult.conversationId).toBe(group.conversationId);
    expect(joinResult.groupName).toBe('Crew');
    expect((await joiner.listPendingGroupJoins()).map((join) => join.conversationId)).toEqual([group.conversationId]);

    // Nothing happens until the minter's client services its links.
    expect(minterAdapter.memberAdds).toEqual([]);
    const admitted = await minter.serviceGroupInviteLinks();
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.joiner.inboxId).toBe('inbox-joiner');
    expect(admitted[0]?.joiner.proposedName).toBe('Sam');
    expect(minterAdapter.memberAdds).toEqual([{ conversationId: group.conversationId, added: ['inbox-joiner'] }]);

    // Single use: exhausted, so the link retires and re-servicing is a no-op.
    expect(await minter.listGroupInviteLinks()).toEqual([]);
    expect(await minter.serviceGroupInviteLinks()).toEqual([]);
    expect(minterAdapter.memberAdds).toHaveLength(1);
  });

  test('sync services live links automatically', async () => {
    const rendezvous = new MemoryRendezvous();
    const minterAdapter = new GroupAdapter('inbox-minter');
    const joinerAdapter = new GroupAdapter('inbox-joiner');
    const minter = await createClient(minterAdapter, rendezvous);
    const joiner = await createClient(joinerAdapter, rendezvous);
    const group = await minter.createGroup({ members: [], name: 'Crew' });

    const link = await minter.createGroupInviteLink(group.conversationId, { maxUses: 5 });
    await joiner.joinGroupWithCode(link.token, { timeoutMs: 2_000 });

    await minter.sync();
    expect(minterAdapter.memberAdds).toEqual([{ conversationId: group.conversationId, added: ['inbox-joiner'] }]);
    // Multi-use: the link survives with a use consumed.
    const remaining = await minter.listGroupInviteLinks();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.uses).toBe(1);

    // Servicing is idempotent: the same join request is never admitted twice.
    await minter.sync();
    expect(minterAdapter.memberAdds).toHaveLength(1);
  });

  test('a revoked link admits nobody', async () => {
    const rendezvous = new MemoryRendezvous();
    const minterAdapter = new GroupAdapter('inbox-minter');
    const joinerAdapter = new GroupAdapter('inbox-joiner');
    const minter = await createClient(minterAdapter, rendezvous);
    const joiner = await createClient(joinerAdapter, rendezvous);
    const group = await minter.createGroup({ members: [], name: 'Crew' });

    const link = await minter.createGroupInviteLink(group.conversationId);
    await minter.revokeGroupInviteLink(link.linkId);

    expect(await minter.listGroupInviteLinks()).toEqual([]);
    // The room is gone: a join finds no descriptor and times out.
    await expect(joiner.joinGroupWithCode(link.token, { timeoutMs: 700 })).rejects.toThrow(/timed out/);
    await minter.serviceGroupInviteLinks();
    expect(minterAdapter.memberAdds).toEqual([]);
  });

  test('a link dies with the membership that minted it', async () => {
    const rendezvous = new MemoryRendezvous();
    const minterAdapter = new GroupAdapter('inbox-minter');
    const joinerAdapter = new GroupAdapter('inbox-joiner');
    const minter = await createClient(minterAdapter, rendezvous);
    const joiner = await createClient(joinerAdapter, rendezvous);
    const group = await minter.createGroup({ members: [], name: 'Crew' });

    const link = await minter.createGroupInviteLink(group.conversationId);
    await joiner.joinGroupWithCode(link.token, { timeoutMs: 2_000 });
    await minter.leaveGroup(group.conversationId);

    expect(await minter.serviceGroupInviteLinks()).toEqual([]);
    expect(minterAdapter.memberAdds).toEqual([]);
    expect(await minter.listGroupInviteLinks()).toEqual([]);
  });

  test('tokens are case-sensitive, unlike spoken codes', async () => {
    const identity: ConeIdentity = { env: 'dev', inboxId: 'inbox-minter' };
    const token = 'cone_gi_v1_CaseSensitiveSecret';
    const descriptor = await createEncryptedGroupDescriptor({
      code: token,
      identity,
      conversation: { conversationId: 'group-1', memberCount: 2 },
    });
    const offers: RendezvousStoredOffer[] = [
      { offerId: 'a', participantId: descriptor.participantId, role: 'descriptor' as const, encryptedOffer: descriptor.encrypted, expiresAt: future() },
    ];

    const joiner: ConeIdentity = { env: 'dev', inboxId: 'inbox-joiner' };
    expect(await decryptGroupDescriptor(offers, { code: token, participantId: 'joiner', identity: joiner })).not.toBeNull();
    expect(await decryptGroupDescriptor(offers, { code: token.toLowerCase(), participantId: 'joiner', identity: joiner })).toBeNull();
  });
});

function future(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function welcomeRow(conversationId: string, addedByInboxId: string): ConeConversation {
  return {
    conversationId,
    kind: 'group',
    title: 'Crew',
    groupName: 'Crew',
    memberCount: 2,
    addedByInboxId,
    consentState: 'unknown',
    updatedAt: new Date().toISOString(),
  };
}

async function createClient(adapter: XmtpAdapter, rendezvous?: RendezvousClient) {
  return createConeClient({
    account: deriveAccount(secretKeyFromHexSeed('04'.repeat(32)), { env: 'dev' }),
    rendezvous,
    store: new MemoryStore(),
    xmtp: adapter,
  });
}

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
    // Joiners never see each other — only the descriptor and themselves.
    return input.role === 'join'
      ? active.filter((stored) => stored.role === 'descriptor' || stored.participantId === input.participantId)
      : active;
  }

  async deleteRoom(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
  }
}

// The minimal group-capable adapter: create/add/leave plus sync, enough to
// drive the invite flow. Unused surface throws so a test failure is loud.
class GroupAdapter implements XmtpAdapter {
  conversations: ConeConversation[] = [];
  groupConsent = new Map<string, ConeConsentState>();
  memberAdds: Array<{ conversationId: string; added: string[] }> = [];
  private groupCount = 0;

  constructor(
    private readonly inboxId: string,
    private readonly options: { blockedInboxIds?: string[] } = {},
  ) {}

  identity(): Promise<ConeIdentity> {
    return Promise.resolve({ env: 'dev', inboxId: this.inboxId, address: `0x${'a'.repeat(40)}` });
  }

  resolveIdentity(ref: unknown): Promise<ResolvedIdentity | null> {
    const value = ref as { inboxId?: string };
    return Promise.resolve(value.inboxId ? { inboxId: value.inboxId, source: 'inboxId' } : null);
  }

  canMessage(identity: ResolvedIdentity): Promise<boolean> {
    return Promise.resolve(!this.options.blockedInboxIds?.includes(identity.inboxId));
  }

  createGroup(memberInboxIds: string[], options?: CreateGroupOptions): Promise<ConeConversation> {
    this.groupCount += 1;
    const conversation: ConeConversation = {
      conversationId: `group-${this.groupCount}`,
      kind: 'group',
      title: options?.name ?? 'group',
      groupName: options?.name,
      memberCount: memberInboxIds.length + 1,
      consentState: 'allowed',
      updatedAt: new Date().toISOString(),
    };
    return Promise.resolve(conversation);
  }

  addGroupMembers(conversationId: string, memberInboxIds: string[]): Promise<void> {
    this.memberAdds.push({ conversationId, added: memberInboxIds });
    return Promise.resolve();
  }

  leaveGroup(): Promise<void> {
    return Promise.resolve();
  }

  listGroupMembers(): Promise<ConeGroupMember[]> {
    return Promise.resolve([]);
  }

  sync(_filter?: ConsentFilter) {
    return Promise.resolve({ conversations: this.conversations, messages: [] as IncomingMessage[] });
  }

  setGroupConsent(conversationId: string, state: ConeConsentState): Promise<void> {
    this.groupConsent.set(conversationId, state);
    return Promise.resolve();
  }

  getConsent(): Promise<ConeConsentState> {
    return Promise.resolve('unknown');
  }

  setConsent(): Promise<void> {
    return Promise.resolve();
  }

  streamMessages(_handler: MessageHandler, _filter?: ConsentFilter) {
    return Promise.resolve(() => {});
  }

  listConversations(): Promise<ConeConversation[]> {
    return Promise.resolve(this.conversations);
  }

  listMessages(): Promise<IncomingMessage[]> {
    return Promise.resolve([]);
  }

  sendText(): Promise<SentMessage> {
    throw new Error('not used in invite tests');
  }

  sendEnvelope(): Promise<SentMessage> {
    throw new Error('not used in invite tests');
  }

  sendToConversation(): Promise<SentMessage> {
    throw new Error('not used in invite tests');
  }

  getGroupInfo(): Promise<ConeConversation | null> {
    return Promise.resolve(null);
  }

  removeGroupMembers(): Promise<void> {
    throw new Error('not used in invite tests');
  }

  updateGroupName(): Promise<void> {
    throw new Error('not used in invite tests');
  }

  updateGroupDescription(): Promise<void> {
    throw new Error('not used in invite tests');
  }

  addGroupAdmin(): Promise<void> {
    throw new Error('not used in invite tests');
  }

  removeGroupAdmin(): Promise<void> {
    throw new Error('not used in invite tests');
  }

  addGroupSuperAdmin(): Promise<void> {
    throw new Error('not used in invite tests');
  }

  removeGroupSuperAdmin(): Promise<void> {
    throw new Error('not used in invite tests');
  }

  setRetention(): Promise<void> {
    return Promise.resolve();
  }

  getRetention(): Promise<MessageRetention | null> {
    return Promise.resolve(null);
  }
}
