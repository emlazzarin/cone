import { base64UrlDecode, base64UrlEncode, bytesToUtf8, utf8ToBytes } from './encoding';
import {
  assertSupportedRendezvousSecret,
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
  generateGroupInviteToken,
  isGroupInviteToken,
  normalizeHandshakeCode,
  randomId,
  secretRoomId,
} from './crypto';
import { laterIso } from './display';
import {
  APP_JSON_TYPE,
  BACKUP_TYPE,
  isAppJsonEnvelope,
  PAIR_CONFIRM_TYPE,
  READ_RECEIPT_TYPE,
  UNSUPPORTED_MESSAGE_TYPE,
  isControlEnvelope,
} from './envelope';
import { PAIRING_TTL_MS, createEncryptedPairingOffer, createHandshakeCode as createCode, decryptPeerOffer } from './pairing';
import {
  GROUP_INVITE_LINK_MAX_USES,
  GROUP_INVITE_LINK_TTL_MS,
  GROUP_INVITE_TTL_MS,
  PENDING_GROUP_JOIN_TTL_MS,
  createEncryptedGroupDescriptor,
  createEncryptedJoinRequest,
  decryptGroupDescriptor,
  decryptJoinRequest,
  decryptJoinRequests,
  type GroupInviteDescriptor,
  type GroupJoinRequest,
} from './invites';
import { ConeError } from './errors';
import { isVisibleChatMessage } from './display';
import { isExpiredMessage, messageExpiresAt } from './retention';
import type {
  ConeClient,
  ConeConsentState,
  ConeConversation,
  ConeGroupMember,
  ConeIdentity,
  ConeMessage,
  ConsentFilter,
  Contact,
  CreateConeClientOptions,
  CreateGroupInput,
  GroupInviteLink,
  GroupInviteResult,
  GroupJoinResult,
  GroupMemberLevel,
  IdentityRef,
  PendingGroupJoin,
  IncomingMessage,
  PairingOffer,
  PairingResult,
  ResolvedIdentity,
  SaveContactInput,
  SendOptions,
  SentMessage,
  StoredMessage,
  SyncResult,
  Unsubscribe,
} from './types';
import { assertValidContactInput, isLikelyInboxId, normalizeContactName, normalizeIdentityRef } from './validation';

export async function createConeClient(options: CreateConeClientOptions): Promise<ConeClient> {
  const client = new ConeClientImpl(options);
  await client.removeSelfArtifacts();
  return client;
}

class ConeClientImpl implements ConeClient {
  constructor(private readonly options: CreateConeClientOptions) {}

  identity(): Promise<ConeIdentity> {
    return this.options.xmtp.identity();
  }

  async resolveIdentity(ref: IdentityRef): Promise<ResolvedIdentity> {
    const normalized = normalizeIdentityRef(ref);

    if (typeof normalized === 'string') {
      throw new Error('identity reference normalization failed');
    }

    if (normalized.contactId) {
      const contact = await this.options.store.getContactById(normalized.contactId);
      if (!contact) {
        throw new Error(`contact not found: ${normalized.contactId}`);
      }
      return contactToResolved(contact);
    }

    if (normalized.contactName) {
      const contact = await this.options.store.getContactByName(normalized.contactName);
      if (contact) {
        return contactToResolved(contact);
      }
      if (isLikelyInboxId(normalized.contactName)) {
        const resolved = await this.options.xmtp.resolveIdentity({ inboxId: normalized.contactName });
        if (resolved) {
          return resolved;
        }
      }
      throw new Error(`contact or identity not found: ${normalized.contactName}`);
    }

    const resolved = await this.options.xmtp.resolveIdentity(normalized);
    if (!resolved) {
      throw new Error('identity is not XMTP-reachable');
    }
    return resolved;
  }

  async canMessage(ref: IdentityRef): Promise<boolean> {
    try {
      const resolved = await this.resolveIdentity(ref);
      return await this.options.xmtp.canMessage(resolved);
    } catch {
      return false;
    }
  }

  async sendText(to: IdentityRef, text: string, options: SendOptions = {}): Promise<SentMessage> {
    if (text.trim().length === 0) {
      throw new Error('message text is required');
    }
    const resolved = await this.resolveIdentity(to);
    const recalled = await this.claimIdempotentSend(options.idempotencyKey, resolved.inboxId);
    if (recalled) {
      return recalled;
    }
    try {
      if (!(await this.options.xmtp.canMessage(resolved))) {
        throw new ConeError('NOT_MESSAGEABLE', 'identity is not XMTP-reachable');
      }

      const sent = await this.options.xmtp.sendText(resolved, text);
      await this.persistOutbound(sent, resolved, 'text', text);
      // Sending implies consent: the recipient leaves "unknown" so a reply never
      // lands in Requests. persistOutbound already stamped the local mirror
      // allowed; this propagates it to the network (best-effort).
      await this.setConsentSafe(resolved.inboxId, 'allowed');
      await this.settleIdempotentSend(options.idempotencyKey, sent);
      return sent;
    } catch (error) {
      // A definite failure releases the claim so the caller may retry; only a
      // crash (nothing runs) leaves it pending — the honest at-most-once case.
      await this.releaseIdempotentSend(options.idempotencyKey);
      throw error;
    }
  }

  // App JSON rides the Cone envelope content type (with a human-readable
  // fallback for clients without the codec) — same reachability and
  // implied-consent semantics as sendText. replyTo (correlation for
  // request/response over async messaging) is an additive envelope field.
  async sendJson(to: IdentityRef, value: unknown, options: SendOptions = {}): Promise<SentMessage> {
    const resolved = await this.resolveIdentity(to);
    const recalled = await this.claimIdempotentSend(options.idempotencyKey, resolved.inboxId);
    if (recalled) {
      return recalled;
    }
    try {
      if (!(await this.options.xmtp.canMessage(resolved))) {
        throw new ConeError('NOT_MESSAGEABLE', 'identity is not XMTP-reachable');
      }

      const envelope = { type: APP_JSON_TYPE, value, ...(options.replyTo ? { replyTo: options.replyTo } : {}) };
      const sent = await this.options.xmtp.sendEnvelope(resolved, envelope);
      await this.persistOutbound(sent, resolved, 'json', envelope);
      await this.setConsentSafe(resolved.inboxId, 'allowed');
      await this.settleIdempotentSend(options.idempotencyKey, sent);
      return sent;
    } catch (error) {
      await this.releaseIdempotentSend(options.idempotencyKey);
      throw error;
    }
  }

  // At-most-once idempotency: the key is CLAIMED (recorded scoped to the
  // resolved recipient) before publishing and settled with the messageId
  // after. A retry that finds a settled record gets the original back; one
  // that finds an unsettled claim gets IDEMPOTENCY_IN_FLIGHT — the previous
  // attempt may or may not have published, and guessing would double-send.
  // The ledger is capped: it protects crash-retry loops, not forever-uniqueness.
  private async claimIdempotentSend(key: string | undefined, scope: string): Promise<SentMessage | null> {
    if (!key) {
      return null;
    }
    const records = (await this.options.store.getMetadata()).idempotencySends ?? [];
    const match = records.find((record) => record.key === key);
    if (match) {
      if (match.scope !== scope) {
        throw new ConeError('IDEMPOTENCY_CONFLICT', `idempotency key ${key} was already used for a different recipient`);
      }
      if (!match.messageId || !match.sentAt) {
        throw new ConeError('IDEMPOTENCY_IN_FLIGHT', `a previous send with idempotency key ${key} may or may not have published — verify before retrying`);
      }
      return { messageId: match.messageId, conversationId: match.conversationId, sentAt: match.sentAt, deduplicated: true };
    }
    await this.options.store.putMetadata({ idempotencySends: [...records, { key, scope }].slice(-IDEMPOTENCY_CAP) });
    return null;
  }

  private async settleIdempotentSend(key: string | undefined, sent: SentMessage): Promise<void> {
    if (!key) {
      return;
    }
    const records = (await this.options.store.getMetadata()).idempotencySends ?? [];
    await this.options.store.putMetadata({
      idempotencySends: records.map((record) =>
        record.key === key
          ? { ...record, messageId: sent.messageId, conversationId: sent.conversationId, sentAt: sent.sentAt }
          : record),
    });
  }

  private async releaseIdempotentSend(key: string | undefined): Promise<void> {
    if (!key) {
      return;
    }
    const records = (await this.options.store.getMetadata()).idempotencySends ?? [];
    await this.options.store.putMetadata({
      idempotencySends: records.filter((record) => !(record.key === key && !record.messageId)),
    });
  }

  // Send into an existing conversation. DMs route through the identity path so
  // reachability checks and implied peer consent behave exactly like sendText;
  // groups publish to the group, and sending implies group consent.
  async sendToConversation(conversationId: string, text: string): Promise<SentMessage> {
    const conversation = await this.options.store.getConversationById(conversationId);
    if (!conversation) {
      throw new Error(`conversation not found: ${conversationId}`);
    }
    if (conversation.kind !== 'group') {
      if (!conversation.peerInboxId) {
        throw new Error(`conversation has no peer: ${conversationId}`);
      }
      return this.sendText({ inboxId: conversation.peerInboxId }, text);
    }
    if (conversation.active === false) {
      throw new ConeError('NOT_A_MEMBER', 'you are no longer a member of this group');
    }
    if (text.trim().length === 0) {
      throw new Error('message text is required');
    }

    const identity = await this.identity();
    const sent = await this.options.xmtp.sendToConversation(conversationId, text);
    await this.options.store.putConversation({
      ...conversation,
      updatedAt: sent.sentAt,
      consentState: 'allowed',
    });
    await this.options.store.putMessage({
      messageId: sent.messageId,
      conversationId,
      senderInboxId: identity.inboxId,
      sentAt: sent.sentAt,
      kind: 'text',
      encryptedPayload: await encryptJson(this.options.account.coneStorageKey, 'cone.message.v1', text),
    });
    // Sending implies consent, same as DMs; the mirror is already stamped.
    await this.setGroupConsentSafe(conversationId, 'allowed');
    // Sending into a locally deleted chat brings it back.
    await this.unhideConversation(conversationId, sent.sentAt);
    return sent;
  }

  // Create a group. The creator is added (and made super admin) by XMTP
  // itself; members resolve through contacts/identities but are never
  // auto-saved as contacts.
  async createGroup(input: CreateGroupInput): Promise<ConeConversation> {
    const identity = await this.identity();
    const resolved = await Promise.all(input.members.map((member) => this.resolveIdentity(member)));
    const memberInboxIds = [...new Set(resolved.map((member) => member.inboxId))]
      .filter((inboxId) => inboxId !== identity.inboxId);
    const conversation = await this.options.xmtp.createGroup(memberInboxIds, {
      name: input.name,
      description: input.description,
      locked: input.locked,
    });
    // Creating a conversation is consent (the SDK marks it allowed network-side).
    await this.options.store.putConversation({ ...conversation, consentState: 'allowed' });
    return conversation;
  }

  async listGroupMembers(conversationId: string): Promise<ConeGroupMember[]> {
    return this.options.xmtp.listGroupMembers(conversationId);
  }

  async addGroupMembers(conversationId: string, members: IdentityRef[]): Promise<void> {
    const resolved = await Promise.all(members.map((member) => this.resolveIdentity(member)));
    // Reachability gate: fail with a clear error before mutating membership.
    for (const member of resolved) {
      if (!(await this.options.xmtp.canMessage(member))) {
        throw new Error(`not reachable on XMTP: ${member.displayName ?? member.inboxId}`);
      }
    }
    await this.options.xmtp.addGroupMembers(conversationId, [...new Set(resolved.map((member) => member.inboxId))]);
    await this.refreshGroupMembers(conversationId);
  }

  async removeGroupMembers(conversationId: string, members: IdentityRef[]): Promise<void> {
    const resolved = await Promise.all(members.map((member) => this.resolveIdentity(member)));
    await this.options.xmtp.removeGroupMembers(conversationId, [...new Set(resolved.map((member) => member.inboxId))]);
    await this.refreshGroupMembers(conversationId);
  }

  async leaveGroup(conversationId: string): Promise<void> {
    await this.options.xmtp.leaveGroup(conversationId);
    // Mark the row inactive immediately; the network state reconciles on sync.
    // The row (and its history) is kept — leaving is not deleting.
    const conversation = await this.options.store.getConversationById(conversationId);
    if (conversation) {
      await this.options.store.putConversation({ ...conversation, active: false });
    }
  }

  // Rename the group. Mirror-first like consent: the local row updates
  // immediately, the network metadata write is best-effort, sync reconciles.
  // Group names are shared state — every member sees the change.
  async renameGroup(conversationId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new Error('group name is required');
    }
    const conversation = await this.requireGroup(conversationId);
    await this.options.store.putConversation({ ...conversation, groupName: trimmed, title: trimmed });
    try {
      await this.options.xmtp.updateGroupName(conversationId, trimmed);
    } catch {
      // Best-effort like consent; local-only until a later write or sync.
    }
  }

  async setGroupDescription(conversationId: string, description: string): Promise<void> {
    const conversation = await this.requireGroup(conversationId);
    const trimmed = description.trim();
    await this.options.store.putConversation({ ...conversation, groupDescription: trimmed || undefined });
    try {
      await this.options.xmtp.updateGroupDescription(conversationId, trimmed);
    } catch {
      // Best-effort like consent; local-only until a later write or sync.
    }
  }

  // Set a member's role by diffing their current level against the target and
  // adjusting XMTP's separate admin/super-admin lists. Promoting someone else
  // to superAdmin is the transfer-ownership move (additive; XMTP forbids the
  // last super admin leaving, so promote first, then demote/leave).
  async setGroupMemberLevel(conversationId: string, member: IdentityRef, level: GroupMemberLevel): Promise<void> {
    await this.requireGroup(conversationId);
    const resolved = await this.resolveIdentity(member);
    const members = await this.options.xmtp.listGroupMembers(conversationId);
    const current = members.find((candidate) => candidate.inboxId === resolved.inboxId)?.level;
    if (!current) {
      throw new Error(`not a group member: ${resolved.inboxId}`);
    }
    if (current === level) {
      return;
    }
    if (level === 'superAdmin') {
      await this.options.xmtp.addGroupSuperAdmin(conversationId, resolved.inboxId);
    } else if (current === 'superAdmin') {
      await this.options.xmtp.removeGroupSuperAdmin(conversationId, resolved.inboxId);
    }
    if (level === 'admin') {
      await this.options.xmtp.addGroupAdmin(conversationId, resolved.inboxId);
    } else if (current === 'admin') {
      await this.options.xmtp.removeGroupAdmin(conversationId, resolved.inboxId);
    }
    await this.refreshGroupMembers(conversationId);
  }

  private async requireGroup(conversationId: string): Promise<ConeConversation> {
    const conversation = await this.options.store.getConversationById(conversationId);
    if (!conversation || conversation.kind !== 'group') {
      throw new ConeError('NOT_FOUND', `group not found: ${conversationId}`);
    }
    return conversation;
  }

  private async refreshGroupMembers(conversationId: string): Promise<void> {
    const conversation = await this.options.store.getConversationById(conversationId);
    if (!conversation || conversation.kind !== 'group') {
      return;
    }
    try {
      const members = await this.options.xmtp.listGroupMembers(conversationId);
      await this.options.store.putConversation({ ...conversation, members, memberCount: members.length });
    } catch {
      // The membership change already happened network-side; the cached member
      // mirror reconciles on the next sync.
    }
  }

  // Best-effort read receipt: a `cone.read.v1` control message sent into the
  // conversation. Never throws and is not persisted locally — we only need the
  // peer's receipts (which arrive over the stream) to show "Read" on our own
  // messages.
  async sendReadReceipt(to: IdentityRef): Promise<void> {
    try {
      const resolved = await this.resolveIdentity(to);
      await this.options.xmtp.sendEnvelope(resolved, { type: READ_RECEIPT_TYPE });
    } catch {
      // Read receipts are advisory; a failure must never disrupt the session.
    }
  }

  // Defaults to allowed-only — the agent trust boundary. An unknown sender's
  // message never reaches the handler (and so never triggers agent workflows)
  // unless the caller explicitly opts in to 'unknown'. Human surfaces pass
  // { consentStates: ['allowed', 'unknown'] } so Requests update live.
  async streamMessages(
    handler: (message: IncomingMessage) => void | Promise<void>,
    filter: ConsentFilter = { consentStates: ['allowed'] },
  ): Promise<Unsubscribe> {
    await this.options.store.putMetadata({ lastStreamStartedAt: this.nowIso() });
    return this.options.xmtp.streamMessages(async (message) => {
      // XMTP gates group delivery per conversation, not per sender, so an
      // allowed group still delivers messages from inboxes this account has
      // denied. Drop them before the handler — the block list follows you
      // into groups, and a denied sender must never reach an agent loop.
      if (message.conversationKind === 'group' && (await this.deniedInboxIds()).has(message.senderInboxId)) {
        return;
      }
      const isNew = await this.options.store.markMessageProcessed(message.messageId);
      if (!isNew) {
        return;
      }

      await this.persistNetworkMessage(message);
      await handler(message);
    }, filter);
  }

  async sync(): Promise<SyncResult> {
    const startedAt = this.nowIso();
    let conversationsSynced = 0;
    let messagesSynced = 0;
    const errors: string[] = [];

    try {
      // Sync allowed + unknown (so Requests populate) but never denied —
      // blocked senders stay out of the local read model. Views filter further.
      const result = await this.options.xmtp.sync({ consentStates: ['allowed', 'unknown'] });
      for (const conversation of result.conversations) {
        await this.options.store.putConversation(await this.applyGroupAddPolicy(conversation));
        conversationsSynced += 1;
      }
      for (const message of result.messages) {
        const isNew = await this.options.store.markMessageProcessed(message.messageId);
        await this.persistNetworkMessage(message);
        if (isNew) {
          messagesSynced += 1;
          await this.unhideConversation(message.conversationId, message.sentAt);
        }
      }
      await this.collapseDuplicateDms(result.conversations);
      // The retention mirrors are freshly reconciled; drop expired messages.
      await this.purgeExpiredMessages();
      // Admit joiners waiting on this account's invite links. Best-effort:
      // rendezvous trouble never fails a sync; servicing retries next pass.
      try {
        await this.serviceGroupInviteLinks();
      } catch {
        // Ignored; retried on the next sync.
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    const completedAt = this.nowIso();
    if (errors.length === 0) {
      await this.options.store.putMetadata({ lastSyncedAt: completedAt });
    }

    return {
      completedAt,
      conversationsSynced,
      errors,
      messagesSynced,
      ok: errors.length === 0,
      startedAt,
    };
  }

  // XMTP can hold several MLS DMs for one peer pair (both sides initiated a
  // conversation). The adapter lists only the canonical one, but duplicate
  // rows persisted earlier — or created mid-session by a streamed message in
  // a duplicate DM — linger locally. Fold their history into the canonical
  // thread on every sync so one peer is always exactly one thread.
  private async collapseDuplicateDms(networkConversations: ConeConversation[]): Promise<void> {
    const canonicalByPeer = new Map<string, string>();
    for (const conversation of networkConversations) {
      if (conversation.kind === 'dm' && conversation.peerInboxId) {
        canonicalByPeer.set(conversation.peerInboxId, conversation.conversationId);
      }
    }

    for (const row of await this.options.store.listConversations()) {
      if (row.kind !== 'dm' || !row.peerInboxId) {
        continue;
      }
      const canonical = canonicalByPeer.get(row.peerInboxId);
      if (!canonical || canonical === row.conversationId) {
        continue;
      }
      for (const message of await this.options.store.listMessages(row.conversationId)) {
        await this.options.store.putMessage({ ...message, conversationId: canonical });
      }
      await this.options.store.deleteConversation(row.conversationId);
    }
  }

  async listConversations(): Promise<ConeConversation[]> {
    const [conversations, contacts, identity, metadata] = await Promise.all([
      this.options.store.listConversations(),
      this.options.store.listContacts(),
      this.identity(),
      this.options.store.getMetadata(),
    ]);
    const contactsByInbox = new Map(contacts.map((contact) => [contact.inboxId, contact]));
    const hidden = metadata.hiddenConversations ?? {};

    return conversations
      // Self-DMs are hidden: Cone has no notes-to-self surface yet, and XMTP
      // models messaging your own inbox awkwardly (duplicate threads).
      .filter((conversation) => !(conversation.kind === 'dm' && conversation.peerInboxId === identity.inboxId))
      // Locally deleted chats stay gone until new activity clears the
      // tombstone (see deleteConversation/unhideConversation).
      .filter((conversation) => !(conversation.conversationId in hidden))
      .map((conversation) => {
      if (conversation.kind === 'group') {
        return { ...conversation, title: conversation.groupName ?? conversation.title };
      }
      const contact = conversation.peerInboxId ? contactsByInbox.get(conversation.peerInboxId) : undefined;
      return {
        ...conversation,
        contactId: contact?.contactId ?? conversation.contactId,
        title: contact?.name ?? conversation.title,
      };
    });
  }

  // The poll-shaped read model for turn-based agents (wake → check → respond
  // → sleep): everything inbound and chat-visible from allowed conversations
  // since the named cursor. The cursor is the store-stamped ingestion
  // sequence (StoredMessage.seq) — never sender-supplied sentAt, which can
  // arrive out of order and would silently skip late-synced mail. It advances
  // past everything scanned unless the caller peeks. Callers sync() first to
  // drain what arrived while asleep.
  async pollMessages(options: { cursorName?: string; advance?: boolean } = {}): Promise<{ messages: ConeMessage[]; cursor: string }> {
    const cursorName = options.cursorName ?? 'default';
    const advance = options.advance ?? true;
    const metadata = await this.options.store.getMetadata();
    const stored = metadata.pollCursors?.[cursorName];
    const afterSeq = decodePollCursor(stored);

    const conversations = await this.listConversations();
    const allowed = new Set(
      conversations.filter((conversation) => conversation.consentState === 'allowed').map((conversation) => conversation.conversationId),
    );
    const all = await this.listMessages();
    // The agent boundary again: inbound, allowed, and chat-visible only — a
    // control envelope (receipt, group update) never wakes an agent loop.
    const fresh = all
      .filter((message) =>
        (message.seq ?? 0) > afterSeq &&
        message.direction === 'inbound' &&
        allowed.has(message.conversationId) &&
        isVisibleChatMessage(message))
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    const maxSeq = all.reduce((max, message) => Math.max(max, message.seq ?? 0), afterSeq);
    const cursor = encodePollCursor(maxSeq);

    if (advance && cursor !== stored) {
      await this.options.store.putMetadata({
        pollCursors: { ...(metadata.pollCursors ?? {}), [cursorName]: cursor },
      });
    }
    return { messages: fresh, cursor };
  }

  async listMessages(conversationId?: string): Promise<ConeMessage[]> {
    const [identity, messages, conversations, denied] = await Promise.all([
      this.identity(),
      this.options.store.listMessages(conversationId),
      this.options.store.listConversations(),
      this.deniedInboxIds(),
    ]);
    const retentionByConversation = new Map(
      conversations.map((conversation) => [conversation.conversationId, conversation.retention]),
    );
    const kindByConversation = new Map(conversations.map((conversation) => [conversation.conversationId, conversation.kind]));
    const groupConversationIds = new Set(
      conversations.filter((conversation) => conversation.kind === 'group').map((conversation) => conversation.conversationId),
    );

    // Expired messages are hidden here even before a purge deletes them, so
    // the read model never shows a message past its timer. Denied senders'
    // messages inside allowed groups are hidden the same way (XMTP only gates
    // groups per conversation; the sender-level drop is Cone's).
    const now = this.now().getTime();
    const visible = messages.filter(
      (message) =>
        !isExpiredMessage(message, retentionByConversation.get(message.conversationId), now) &&
        !(groupConversationIds.has(message.conversationId) && denied.has(message.senderInboxId)),
    );

    return Promise.all(visible.map(async (message) => {
      const payload = await decryptJson<unknown>(this.options.account.coneStorageKey, message.encryptedPayload);
      const kind = message.kind === 'json' && isControlEnvelope(payload) ? 'control' : message.kind;
      const json = typeof payload === 'string' ? undefined : payload;
      // The app-JSON envelope is transport plumbing: readers get the sender's
      // payload as `json` and the correlation id as `replyTo`, first-class.
      // Control envelopes stay wrapped — their type IS their meaning.
      const unwrapped = isAppJsonEnvelope(json) ? json.value : json;
      const envelopeReplyTo = isAppJsonEnvelope(json) ? (json as unknown as { replyTo?: unknown }).replyTo : undefined;
      const replyTo = typeof envelopeReplyTo === 'string' ? envelopeReplyTo : undefined;
      return {
        conversationId: message.conversationId,
        conversationKind: kindByConversation.get(message.conversationId),
        direction: message.senderInboxId === identity.inboxId ? 'outbound' as const : 'inbound' as const,
        expiresAt: messageExpiresAt(message.sentAt, retentionByConversation.get(message.conversationId)),
        json: unwrapped,
        kind,
        messageId: message.messageId,
        recipientInboxId: message.recipientInboxId,
        replyTo,
        senderInboxId: message.senderInboxId,
        sentAt: message.sentAt,
        seq: message.seq,
        text: typeof payload === 'string' ? payload : undefined,
      };
    }));
  }

  async deleteConversation(conversationId: string): Promise<void> {
    // Deleting is local: the XMTP conversation still exists and sync keeps
    // mirroring it, so a bare row delete resurrects within one poll. The
    // tombstone keeps it out of views until a message newer than the deletion
    // arrives — which legitimately brings the chat back.
    const metadata = await this.options.store.getMetadata();
    await this.options.store.putMetadata({
      hiddenConversations: { ...metadata.hiddenConversations, [conversationId]: this.nowIso() },
    });
    await this.options.store.deleteConversation(conversationId);
  }

  // Clear a deletion tombstone when the conversation shows new life: a synced
  // message newer than the tombstone, or a local send into it.
  private async unhideConversation(conversationId: string, activityAt?: string): Promise<void> {
    const metadata = await this.options.store.getMetadata();
    const hiddenAt = metadata.hiddenConversations?.[conversationId];
    if (!hiddenAt) {
      return;
    }
    if (activityAt && Date.parse(activityAt) <= Date.parse(hiddenAt)) {
      return;
    }
    const { [conversationId]: _cleared, ...rest } = metadata.hiddenConversations!;
    await this.options.store.putMetadata({ hiddenConversations: rest });
  }

  listContacts(): Promise<Contact[]> {
    return this.options.store.listContacts();
  }

  async saveContact(input: SaveContactInput): Promise<Contact> {
    assertValidContactInput(input);
    const now = this.nowIso();
    const normalizedName = normalizeContactName(input.name);
    const resolved = input.inboxId
      ? { inboxId: input.inboxId, address: input.address, source: 'inboxId' as const }
      : await this.resolveIdentity({ address: input.address });
    const [existing, existingByName] = await Promise.all([
      this.options.store.getContactByInboxId(resolved.inboxId),
      this.options.store.getContactByName(normalizedName),
    ]);
    if (existingByName && existingByName.inboxId !== resolved.inboxId) {
      throw new Error(`contact name already exists: ${normalizedName}`);
    }
    const contact: Contact = {
      contactId: existing?.contactId ?? randomId('contact'),
      name: normalizedName,
      inboxId: resolved.inboxId,
      address: input.address ?? resolved.address,
      source: input.source ?? existing?.source ?? 'manual',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.options.store.putContact(contact);
    // Adding someone to your address book — manually or via pairing — is a
    // trust signal, so it implies consent. (self/inbound contacts do not.)
    if (contact.source === 'manual' || contact.source === 'paired') {
      await this.setConsentSafe(contact.inboxId, 'allowed');
    }
    return contact;
  }

  deleteContact(contactId: string): Promise<void> {
    return this.options.store.deleteContact(contactId);
  }

  // Accept (allowed) / block (denied) a peer. Mirror-first: the local store is
  // updated immediately (so the UI and the local-only fallback are correct even
  // offline), then the XMTP network consent is written best-effort and a later
  // sync reconciles. Consent targets the peer inbox, so a denied sender cannot
  // reappear via a fresh conversation.
  async setConsent(to: IdentityRef, state: ConeConsentState): Promise<void> {
    const resolved = await this.resolveIdentity(to);
    const conversations = await this.options.store.listConversations();
    for (const conversation of conversations) {
      if (conversation.peerInboxId === resolved.inboxId && conversation.consentState !== state) {
        await this.options.store.putConversation({ ...conversation, consentState: state });
      }
    }
    await this.updateDeniedInboxIds(resolved.inboxId, state);
    await this.setConsentSafe(resolved.inboxId, state);
  }

  // Consent for a conversation row — the uniform Requests accept/block entry
  // point. DMs target the peer's inbox (so a blocked sender cannot return via
  // a fresh conversation); groups target the group id.
  async setConversationConsent(conversationId: string, state: ConeConsentState): Promise<void> {
    const conversation = await this.options.store.getConversationById(conversationId);
    if (!conversation) {
      throw new Error(`conversation not found: ${conversationId}`);
    }
    if (conversation.kind === 'group') {
      await this.options.store.putConversation({ ...conversation, consentState: state });
      await this.setGroupConsentSafe(conversationId, state);
      return;
    }
    if (!conversation.peerInboxId) {
      throw new Error(`conversation has no peer: ${conversationId}`);
    }
    await this.setConsent({ inboxId: conversation.peerInboxId }, state);
    // Also stamp the conversation-level record (consent is dual-keyed in
    // XMTP); without it, other installations of this account — and the next
    // sync's mirror — can still read this DM as "unknown". Best-effort, same
    // as the inbox-level network write.
    await this.setGroupConsentSafe(conversationId, state);
  }

  private async setConsentSafe(inboxId: string, state: ConeConsentState): Promise<void> {
    try {
      await this.options.xmtp.setConsent(inboxId, state);
    } catch {
      // Network consent is best-effort: the local mirror already reflects the
      // decision and a later sync reconciles. Treated as local-only until then.
    }
  }

  private async setGroupConsentSafe(conversationId: string, state: ConeConsentState): Promise<void> {
    try {
      await this.options.xmtp.setGroupConsent(conversationId, state);
    } catch {
      // Best-effort like inbox consent; local-only until it propagates.
    }
  }

  // The local denied-inbox set backs the in-group sender filter (stream drop +
  // view filter). Maintained on every Cone-side inbox consent write; denials
  // made on other devices reconcile through the adapter's consent reads in the
  // group-add policy, and a future consent stream can tighten this further.
  private async deniedInboxIds(): Promise<Set<string>> {
    return new Set((await this.options.store.getMetadata()).deniedInboxIds ?? []);
  }

  private async updateDeniedInboxIds(inboxId: string, state: ConeConsentState): Promise<void> {
    const denied = await this.deniedInboxIds();
    if (state === 'denied') {
      denied.add(inboxId);
    } else {
      denied.delete(inboxId);
    }
    await this.options.store.putMetadata({ deniedInboxIds: [...denied].sort() });
  }

  // The "allow contacts to add you to groups" policy, applied to group rows
  // arriving from the network while undecided (consent unknown):
  //   - added by a denied inbox        -> denied, silently (no Request row in
  //     any view, no signal back — we do not auto-leave, because leaving is
  //     visible to the group while blocking must not be)
  //   - added by an address-book contact -> allowed, when the toggle is on
  //     (the default; agent processes pass autoAllowGroupsFromContacts: false)
  //   - anyone else                     -> stays unknown, i.e. a Request
  // Idempotent: it re-applies on every sync until a decision propagates.
  private async applyGroupAddPolicy(conversation: ConeConversation): Promise<ConeConversation> {
    if (conversation.kind !== 'group' || conversation.consentState !== 'unknown') {
      return conversation;
    }
    // A welcome for a group this account asked to join via an invite code:
    // requesting to join is implied consent, so it skips Requests entirely.
    const pending = await this.pendingGroupJoins();
    if (pending.some((join) => join.conversationId === conversation.conversationId)) {
      await this.options.store.putMetadata({
        pendingGroupJoins: pending.filter((join) => join.conversationId !== conversation.conversationId),
      });
      await this.setGroupConsentSafe(conversation.conversationId, 'allowed');
      return { ...conversation, consentState: 'allowed' };
    }
    if (!conversation.addedByInboxId) {
      return conversation;
    }
    const addedBy = conversation.addedByInboxId;
    if ((await this.deniedInboxIds()).has(addedBy) || (await this.getConsentSafe(addedBy)) === 'denied') {
      await this.setGroupConsentSafe(conversation.conversationId, 'denied');
      return { ...conversation, consentState: 'denied' };
    }
    if (this.options.autoAllowGroupsFromContacts ?? true) {
      const contact = await this.options.store.getContactByInboxId(addedBy);
      if (contact && contact.source !== 'self') {
        await this.setGroupConsentSafe(conversation.conversationId, 'allowed');
        return { ...conversation, consentState: 'allowed' };
      }
    }
    return conversation;
  }

  private async getConsentSafe(inboxId: string): Promise<ConeConsentState> {
    try {
      return await this.options.xmtp.getConsent(inboxId);
    } catch {
      return 'unknown';
    }
  }

  // Set the disappearing-messages timer. Mirror-first like consent: the local
  // conversation updates immediately, the XMTP settings write (which is what
  // tells the peer) is best-effort and reconciled on the next sync.
  async setRetention(conversationId: string, durationMs: number | null): Promise<void> {
    const conversation = await this.options.store.getConversationById(conversationId);
    if (!conversation) {
      throw new Error(`conversation not found: ${conversationId}`);
    }
    // Purge under the old settings first: a message that already hit its timer
    // is gone for good and must not reappear because the timer was relaxed.
    await this.purgeExpiredMessages();
    const retention = durationMs !== null && durationMs > 0
      ? { durationMs, fromAt: this.nowIso() }
      : undefined;
    await this.options.store.putConversation({ ...conversation, retention });
    try {
      await this.options.xmtp.setRetention(conversationId, retention ?? null);
    } catch {
      // Best-effort like consent; local-only until a later write or sync.
    }
  }

  // Delete expired messages from Cone storage. XMTP's cleanup worker only
  // covers the XMTP-level DB — without this, "disappeared" messages would
  // live forever in Cone's encrypted snapshots and backups. Processed-message
  // IDs are kept so a not-yet-cleaned XMTP copy cannot resurrect a purged row.
  async purgeExpiredMessages(): Promise<number> {
    const now = this.now().getTime();
    let purged = 0;
    for (const conversation of await this.options.store.listConversations()) {
      if (!conversation.retention) {
        continue;
      }
      for (const message of await this.options.store.listMessages(conversation.conversationId)) {
        if (isExpiredMessage(message, conversation.retention, now)) {
          await this.options.store.deleteMessage(message.messageId);
          purged += 1;
        }
      }
    }
    return purged;
  }

  async createHandshakeCode() {
    return createCode(this.now());
  }

  async pairWithCode(code: string, options: { proposedName?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PairingResult> {
    if (!this.options.rendezvous) {
      throw new Error('rendezvous client is required for code pairing');
    }

    // Both the rendezvous room and the offer encryption are keyed by the
    // normalized code, so "anchor beacon" and "Anchor-Beacon" pair up.
    const normalizedCode = normalizeHandshakeCode(code);
    const identity = await this.identity();
    // Default to the full code window — "waits until they enter it or the
    // window closes" is the documented promise on every surface.
    const deadline = this.now().getTime() + (options.timeoutMs ?? PAIRING_TTL_MS);
    const localOffer = await createEncryptedPairingOffer({
      code: normalizedCode,
      identity,
      proposedName: options.proposedName,
      now: this.now(),
    });
    let peer: PairingOffer | null = null;

    while (this.now().getTime() < deadline && !options.signal?.aborted) {
      const offers = await this.options.rendezvous.exchangeOffer({
        roomId: secretRoomId(normalizedCode),
        role: 'pair',
        encryptedOffer: localOffer.encryptedOffer,
        expiresAt: new Date(this.now().getTime() + PAIRING_TTL_MS).toISOString(),
        participantId: localOffer.participantId,
      });
      peer = await decryptPeerOffer(offers, {
        code: normalizedCode,
        identity,
        participantId: localOffer.participantId,
      });
      if (peer) {
        break;
      }

      await sleep(500);
    }

    if (!peer) {
      throw new ConeError('TIMEOUT', options.signal?.aborted ? 'pairing canceled' : 'pairing timed out');
    }

    const contact = await this.saveContact({
      name: peer.proposedName ?? peer.address ?? peer.inboxId,
      inboxId: peer.inboxId,
      address: peer.address,
      source: 'paired',
    });
    let sentConfirmation = false;
    const resolved = contactToResolved(contact);
    if (await this.options.xmtp.canMessage(resolved)) {
      await this.options.xmtp.sendEnvelope(resolved, {
        type: PAIR_CONFIRM_TYPE,
        inboxId: identity.inboxId,
        address: identity.address,
        codeAcceptedAt: this.nowIso(),
      });
      sentConfirmation = true;
    }

    return {
      contact,
      peer: { inboxId: peer.inboxId, address: peer.address, env: peer.env },
      sentConfirmation,
    };
  }

  // Synchronous group invite, inviter side. Same room mechanics as pairing —
  // both participants post encrypted payloads under the code — but asymmetric:
  // we post the group descriptor and wait for a join request, then add the
  // joiner directly. Auto-add is correct here: the code was created seconds
  // ago and handed over person-to-person, so intent is unambiguous. The joiner
  // is never auto-saved as a contact; their proposedName is a UI suggestion.
  async inviteToGroupWithCode(code: string, conversationId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<GroupInviteResult> {
    if (!this.options.rendezvous) {
      throw new Error('rendezvous client is required for group invite codes');
    }
    const conversation = await this.requireGroup(conversationId);
    if (conversation.active === false) {
      throw new ConeError('NOT_A_MEMBER', 'cannot invite: no longer a member of this group');
    }
    const normalizedCode = normalizeHandshakeCode(code);
    const identity = await this.identity();
    const deadline = this.now().getTime() + (options.timeoutMs ?? GROUP_INVITE_TTL_MS);
    const local = await createEncryptedGroupDescriptor({
      code: normalizedCode,
      identity,
      conversation,
      now: this.now(),
    });

    let request: GroupJoinRequest | null = null;
    while (this.now().getTime() < deadline && !options.signal?.aborted) {
      const offers = await this.options.rendezvous.exchangeOffer({
        roomId: secretRoomId(normalizedCode),
        role: 'descriptor',
        encryptedOffer: local.encrypted,
        expiresAt: new Date(this.now().getTime() + GROUP_INVITE_TTL_MS).toISOString(),
        participantId: local.participantId,
      });
      request = await decryptJoinRequest(offers, {
        code: normalizedCode,
        identity,
        participantId: local.participantId,
      });
      if (request) {
        break;
      }
      await sleep(500);
    }

    if (!request) {
      throw new ConeError('TIMEOUT', options.signal?.aborted ? 'group invite canceled' : 'group invite timed out');
    }

    await this.addGroupMembers(conversationId, [{ inboxId: request.inboxId }]);
    return {
      conversationId,
      joiner: { inboxId: request.inboxId, address: request.address, proposedName: request.proposedName },
    };
  }

  // Joiner side: post a join request and wait for the inviter's descriptor.
  // The membership change itself arrives later as an XMTP welcome; recording
  // the join as pending is what lets the welcome auto-allow (requesting to
  // join is implied consent) instead of landing in Requests. Accepts a spoken
  // handshake code (case-insensitive) or a pasted invite-link token; a token's
  // join offer outlives the session so the minter's next sync can admit it.
  async joinGroupWithCode(code: string, options: { proposedName?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<GroupJoinResult> {
    if (!this.options.rendezvous) {
      throw new Error('rendezvous client is required for group invite codes');
    }
    // A cone_gi_* value that is not a valid v1 token fails here with an
    // "update Cone" error, before it can be lowercased into a bogus handshake
    // code that would wait out the full timeout on an empty room.
    assertSupportedRendezvousSecret(code);
    const isToken = isGroupInviteToken(code);
    const normalizedCode = isToken ? code.trim() : normalizeHandshakeCode(code);
    const identity = await this.identity();
    const deadline = this.now().getTime() + (options.timeoutMs ?? GROUP_INVITE_TTL_MS);
    const local = await createEncryptedJoinRequest({
      code: normalizedCode,
      identity,
      proposedName: options.proposedName,
      now: this.now(),
    });

    let descriptor: GroupInviteDescriptor | null = null;
    while (this.now().getTime() < deadline && !options.signal?.aborted) {
      const offers = await this.options.rendezvous.exchangeOffer({
        roomId: secretRoomId(normalizedCode),
        role: 'join',
        encryptedOffer: local.encrypted,
        expiresAt: new Date(this.now().getTime() + (isToken ? PENDING_GROUP_JOIN_TTL_MS : GROUP_INVITE_TTL_MS)).toISOString(),
        participantId: local.participantId,
      });
      descriptor = await decryptGroupDescriptor(offers, {
        code: normalizedCode,
        identity,
        participantId: local.participantId,
      });
      if (descriptor) {
        break;
      }
      await sleep(500);
    }

    if (!descriptor) {
      throw new ConeError('TIMEOUT', options.signal?.aborted ? 'group join canceled' : 'group join timed out');
    }

    const pending = await this.pendingGroupJoins();
    const entry: PendingGroupJoin = {
      conversationId: descriptor.conversationId,
      inviterInboxId: descriptor.inviterInboxId,
      groupName: descriptor.groupName,
      requestedAt: this.nowIso(),
      expiresAt: new Date(this.now().getTime() + PENDING_GROUP_JOIN_TTL_MS).toISOString(),
    };
    await this.options.store.putMetadata({
      pendingGroupJoins: [...pending.filter((join) => join.conversationId !== entry.conversationId), entry],
    });

    return {
      conversationId: descriptor.conversationId,
      groupName: descriptor.groupName,
      memberCount: descriptor.memberCount,
      inviter: { inboxId: descriptor.inviterInboxId, address: descriptor.inviterAddress },
    };
  }

  async listPendingGroupJoins(): Promise<PendingGroupJoin[]> {
    return this.pendingGroupJoins();
  }

  async cancelGroupJoin(conversationId: string): Promise<void> {
    const pending = await this.pendingGroupJoins();
    await this.options.store.putMetadata({
      pendingGroupJoins: pending.filter((join) => join.conversationId !== conversationId),
    });
  }

  // Expired entries are filtered on read: a welcome that arrives after the
  // pending window falls through to the normal group-add policy (a Request).
  private async pendingGroupJoins(): Promise<PendingGroupJoin[]> {
    const now = this.now().getTime();
    return ((await this.options.store.getMetadata()).pendingGroupJoins ?? []).filter(
      (join) => Date.parse(join.expiresAt) > now,
    );
  }

  // Mint an async invite link: post the group descriptor into the token's
  // room with a long TTL. The token is a capability — holding it is admission
  // — so links default to a single use. Only this client services the link;
  // no group member (and no agent) is assumed present or online.
  async createGroupInviteLink(conversationId: string, options: { ttlMs?: number; maxUses?: number } = {}): Promise<GroupInviteLink> {
    if (!this.options.rendezvous) {
      throw new Error('rendezvous client is required for group invite links');
    }
    const conversation = await this.requireGroup(conversationId);
    if (conversation.active === false) {
      throw new ConeError('NOT_A_MEMBER', 'cannot invite: no longer a member of this group');
    }
    const identity = await this.identity();
    const token = generateGroupInviteToken();
    const expiresAt = new Date(this.now().getTime() + (options.ttlMs ?? GROUP_INVITE_LINK_TTL_MS)).toISOString();
    const descriptor = await createEncryptedGroupDescriptor({
      code: token,
      identity,
      conversation,
      now: this.now(),
    });
    await this.options.rendezvous.exchangeOffer({
      roomId: secretRoomId(token),
      role: 'descriptor',
      encryptedOffer: descriptor.encrypted,
      expiresAt,
      participantId: descriptor.participantId,
    });

    const link: GroupInviteLink = {
      linkId: randomId('link'),
      conversationId,
      token,
      nonce: descriptor.descriptor.nonce,
      createdAt: this.nowIso(),
      expiresAt,
      maxUses: options.maxUses ?? GROUP_INVITE_LINK_MAX_USES,
      uses: 0,
      servicedParticipantIds: [],
    };
    await this.options.store.putMetadata({ groupInviteLinks: [...(await this.groupInviteLinks()), link] });
    return link;
  }

  async listGroupInviteLinks(conversationId?: string): Promise<GroupInviteLink[]> {
    const links = await this.groupInviteLinks();
    return conversationId ? links.filter((link) => link.conversationId === conversationId) : links;
  }

  async revokeGroupInviteLink(linkId: string): Promise<void> {
    const links = await this.groupInviteLinks();
    const link = links.find((candidate) => candidate.linkId === linkId);
    await this.options.store.putMetadata({ groupInviteLinks: links.filter((candidate) => candidate.linkId !== linkId) });
    if (link && this.options.rendezvous) {
      try {
        await this.options.rendezvous.deleteRoom(secretRoomId(link.token));
      } catch {
        // Best-effort: without the room the link still dies locally, and the
        // descriptor expires from the room on its own TTL.
      }
    }
  }

  // Poll this account's live links and admit new joiners. Runs on every
  // sync(); a failure on one link never blocks the others, and a failed add
  // (unreachable joiner, revoked permissions) is marked serviced so a single
  // bad request cannot wedge the link — but it does not consume a use.
  async serviceGroupInviteLinks(): Promise<GroupInviteResult[]> {
    if (!this.options.rendezvous) {
      return [];
    }
    const links = await this.groupInviteLinks();
    const identity = await this.identity();
    const results: GroupInviteResult[] = [];
    const kept: GroupInviteLink[] = [];

    for (const link of links) {
      const conversation = await this.options.store.getConversationById(link.conversationId);
      if (!conversation || conversation.kind !== 'group' || conversation.active === false) {
        // The group is gone or we left it; the link cannot be honored.
        try {
          await this.options.rendezvous.deleteRoom(secretRoomId(link.token));
        } catch {
          // Best-effort.
        }
        continue;
      }

      let updated = link;
      try {
        const descriptor = await createEncryptedGroupDescriptor({
          code: link.token,
          identity,
          conversation,
          nonce: link.nonce,
          now: this.now(),
        });
        const offers = await this.options.rendezvous.exchangeOffer({
          roomId: secretRoomId(link.token),
          role: 'descriptor',
          encryptedOffer: descriptor.encrypted,
          expiresAt: link.expiresAt,
          participantId: descriptor.participantId,
        });
        const joins = await decryptJoinRequests(offers, {
          code: link.token,
          identity,
          participantId: descriptor.participantId,
        });

        for (const join of joins) {
          if (updated.uses >= updated.maxUses) {
            break;
          }
          if (updated.servicedParticipantIds.includes(join.participantId)) {
            continue;
          }
          try {
            await this.addGroupMembers(link.conversationId, [{ inboxId: join.request.inboxId }]);
            results.push({
              conversationId: link.conversationId,
              joiner: {
                inboxId: join.request.inboxId,
                address: join.request.address,
                proposedName: join.request.proposedName,
              },
            });
            updated = {
              ...updated,
              uses: updated.uses + 1,
              servicedParticipantIds: [...updated.servicedParticipantIds, join.participantId],
            };
          } catch {
            updated = {
              ...updated,
              servicedParticipantIds: [...updated.servicedParticipantIds, join.participantId],
            };
          }
        }
      } catch {
        // Rendezvous unreachable: keep the link untouched and retry next sync.
        kept.push(updated);
        continue;
      }

      if (updated.uses >= updated.maxUses) {
        // Exhausted: retire the link and tear the room down.
        try {
          await this.options.rendezvous.deleteRoom(secretRoomId(link.token));
        } catch {
          // Best-effort.
        }
        continue;
      }
      kept.push(updated);
    }

    await this.options.store.putMetadata({ groupInviteLinks: kept });
    return results;
  }

  private async groupInviteLinks(): Promise<GroupInviteLink[]> {
    const now = this.now().getTime();
    return ((await this.options.store.getMetadata()).groupInviteLinks ?? []).filter(
      (link) => Date.parse(link.expiresAt) > now,
    );
  }

  async exportBackup(): Promise<Uint8Array> {
    // A backup must not smuggle out messages that have already disappeared.
    await this.purgeExpiredMessages();
    const snapshot = await this.options.store.exportSnapshot();
    const encrypted = await encryptBytes(this.options.account.backupArchiveKey, utf8ToBytes(JSON.stringify(snapshot)));
    return utf8ToBytes(JSON.stringify({ type: BACKUP_TYPE, encrypted }));
  }

  async importBackup(data: Uint8Array): Promise<void> {
    const parsed = JSON.parse(bytesToUtf8(data)) as { type?: string; encrypted?: unknown };
    if (parsed.type !== BACKUP_TYPE || !parsed.encrypted) {
      throw new Error('invalid Cone backup');
    }
    const plaintext = await decryptBytes(this.options.account.backupArchiveKey, parsed.encrypted as never);
    await this.options.store.importSnapshot(JSON.parse(bytesToUtf8(plaintext)));
  }

  async close(): Promise<void> {
    await this.options.xmtp.close?.();
    await this.options.store.close?.();
  }

  // Cone has no notes-to-self surface (yet). The auto-created "Me" contact
  // invited self-DMs, which XMTP models awkwardly (duplicate threads), so it
  // is no longer created — and one created by an earlier build is removed.
  async removeSelfArtifacts(): Promise<void> {
    for (const contact of await this.options.store.listContacts()) {
      if (contact.source === 'self') {
        await this.options.store.deleteContact(contact.contactId);
      }
    }
  }

  private async persistOutbound(sent: SentMessage, resolved: ResolvedIdentity, kind: StoredMessage['kind'], payload: unknown) {
    const identity = await this.identity();
    const conversationId = sent.conversationId ?? `dm:${resolved.inboxId}`;
    const existing = await this.options.store.getConversationById(conversationId);
    await this.options.store.putConversation({
      conversationId,
      kind: 'dm',
      peerAddress: resolved.address,
      peerInboxId: resolved.inboxId,
      title: resolved.displayName ?? resolved.address ?? resolved.inboxId,
      updatedAt: sent.sentAt,
      contactId: existing?.contactId,
      unreadCount: existing?.unreadCount,
      lastReadAt: existing?.lastReadAt,
      retention: existing?.retention,
      // Sending implies consent.
      consentState: 'allowed',
    });
    await this.options.store.putMessage({
      messageId: sent.messageId,
      conversationId,
      senderInboxId: identity.inboxId,
      recipientInboxId: resolved.inboxId,
      sentAt: sent.sentAt,
      kind,
      encryptedPayload: await encryptJson(this.options.account.coneStorageKey, 'cone.message.v1', payload),
    });
    // Sending into a locally deleted chat brings it back.
    await this.unhideConversation(conversationId, sent.sentAt);
  }

  private async persistNetworkMessage(message: IncomingMessage): Promise<void> {
    // No inbound auto-contact: an unknown sender creates a Request conversation,
    // not an address-book entry. A contact is created only when you accept (and
    // optionally name) them, so the address book never fills with spam.
    await this.maybeCreateConversation(message);
    const payload = storedNetworkPayload(message);
    await this.options.store.putMessage({
      messageId: message.messageId,
      conversationId: message.conversationId,
      senderInboxId: message.senderInboxId,
      sentAt: message.sentAt,
      kind: payload.kind,
      encryptedPayload: await encryptJson(
        this.options.account.coneStorageKey,
        'cone.message.v1',
        payload.value,
      ),
    });
  }

  private async maybeCreateConversation(message: IncomingMessage): Promise<void> {
    const existing = await this.options.store.getConversationById(message.conversationId);
    if (message.conversationKind === 'group' || existing?.kind === 'group') {
      await this.ensureGroupConversation(message, existing);
      return;
    }
    const peerInboxId = existing?.peerInboxId ?? message.senderInboxId;
    const contact = await this.options.store.getContactByInboxId(peerInboxId);
    // Consent mirror for a conversation created from a streamed message: keep an
    // existing value; otherwise a known contact (paired/manually added) is
    // already allowed, and a truly unknown sender starts as a Request. A sync
    // later reconciles to the authoritative network consent.
    const consentState = existing?.consentState ?? (contact ? 'allowed' : 'unknown');
    await this.options.store.putConversation({
      conversationId: message.conversationId,
      kind: 'dm',
      contactId: contact?.contactId ?? existing?.contactId,
      peerAddress: contact?.address ?? message.senderAddress ?? existing?.peerAddress,
      peerInboxId,
      title: contact?.name ?? existing?.title ?? message.senderAddress ?? peerInboxId,
      updatedAt: laterIso(existing?.updatedAt, message.sentAt),
      unreadCount: existing?.unreadCount,
      lastReadAt: existing?.lastReadAt,
      retention: existing?.retention,
      consentState,
    });
  }

  // A group message can arrive over the stream before any sync has stored the
  // group (and a group row must never be fabricated from the sender — that
  // would be DM-shaped). Fetch the real group; if that fails (offline), store
  // a minimal placeholder row that the next sync reconciles.
  private async ensureGroupConversation(message: IncomingMessage, existing: ConeConversation | null): Promise<void> {
    if (existing) {
      await this.options.store.putConversation({
        ...existing,
        kind: 'group',
        updatedAt: laterIso(existing.updatedAt, message.sentAt),
      });
      return;
    }
    let info: ConeConversation | null = null;
    try {
      info = await this.options.xmtp.getGroupInfo(message.conversationId);
    } catch {
      info = null;
    }
    const conversation = info ?? {
      conversationId: message.conversationId,
      kind: 'group' as const,
      title: 'Group',
      consentState: 'unknown' as const,
    };
    await this.options.store.putConversation({
      ...(await this.applyGroupAddPolicy(conversation)),
      updatedAt: laterIso(conversation.updatedAt, message.sentAt),
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function storedNetworkPayload(message: IncomingMessage): Pick<StoredMessage, 'kind'> & { value: unknown } {
  if (message.json !== undefined) {
    return {
      kind: isControlEnvelope(message.json) ? 'control' : 'json',
      value: jsonSafe(message.json),
    };
  }

  if (message.text !== undefined) {
    return { kind: 'text', value: message.text };
  }

  return {
    kind: 'json',
    value: {
      type: UNSUPPORTED_MESSAGE_TYPE,
      messageId: message.messageId,
      senderInboxId: message.senderInboxId,
    },
  };
}

function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return { type: 'bytes', length: value.byteLength };
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonSafe(item, seen));
  }
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, jsonSafe(child, seen)]),
    );
  }
  return value;
}

function contactToResolved(contact: Contact): ResolvedIdentity {
  return {
    inboxId: contact.inboxId,
    address: contact.address,
    source: 'contact',
    displayName: contact.name,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The idempotency ledger protects crash-retry loops, not forever-uniqueness.
const IDEMPOTENCY_CAP = 200;

// Poll cursors are opaque to callers: base64url JSON holding the highest
// ingestion sequence already scanned.
function decodePollCursor(stored: string | undefined): number {
  if (!stored) {
    return 0;
  }
  try {
    const parsed = JSON.parse(bytesToUtf8(base64UrlDecode(stored))) as { q?: unknown };
    return typeof parsed.q === 'number' && Number.isFinite(parsed.q) ? parsed.q : 0;
  } catch {
    // An unreadable cursor restarts from the beginning rather than erroring —
    // agents can handle replays; silently losing their place is worse.
    return 0;
  }
}

function encodePollCursor(seq: number): string {
  return base64UrlEncode(utf8ToBytes(JSON.stringify({ q: seq })));
}

