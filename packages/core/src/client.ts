import { bytesToUtf8, utf8ToBytes } from './encoding';
import { decryptBytes, decryptJson, encryptBytes, encryptJson, normalizeHandshakeCode, randomId } from './crypto';
import { laterIso } from './display';
import {
  APP_JSON_TYPE,
  BACKUP_TYPE,
  PAIR_CONFIRM_TYPE,
  READ_RECEIPT_TYPE,
  UNSUPPORTED_MESSAGE_TYPE,
  isControlEnvelope,
} from './envelope';
import { PAIRING_TTL_MS, createEncryptedPairingOffer, createHandshakeCode as createCode, decryptPeerOffer } from './pairing';
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
  IdentityRef,
  IncomingMessage,
  PairingOffer,
  PairingResult,
  ResolvedIdentity,
  SaveContactInput,
  SentMessage,
  StoredMessage,
  SyncResult,
  Unsubscribe,
} from './types';
import { assertValidContactInput, isLikelyInboxId, normalizeContactName, normalizeIdentityRef } from './validation';

export async function createConeClient(options: CreateConeClientOptions): Promise<ConeClient> {
  const client = new ConeClientImpl(options);
  await client.ensureSelfContact();
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

  async sendText(to: IdentityRef, text: string): Promise<SentMessage> {
    if (text.trim().length === 0) {
      throw new Error('message text is required');
    }

    const resolved = await this.resolveIdentity(to);
    if (!(await this.options.xmtp.canMessage(resolved))) {
      throw new Error('identity is not XMTP-reachable');
    }

    const sent = await this.options.xmtp.sendText(resolved, text);
    await this.persistOutbound(sent, resolved, 'text', text);
    // Sending implies consent: the recipient leaves "unknown" so a reply never
    // lands in Requests. persistOutbound already stamped the local mirror
    // allowed; this propagates it to the network (best-effort).
    await this.setConsentSafe(resolved.inboxId, 'allowed');
    return sent;
  }

  sendJson(to: IdentityRef, value: unknown): Promise<SentMessage> {
    return this.sendText(to, JSON.stringify({ type: APP_JSON_TYPE, value }));
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

  // Best-effort read receipt: a `cos.read.v1` control message sent into the
  // conversation. Never throws and is not persisted locally — we only need the
  // peer's receipts (which arrive over the stream) to show "Read" on our own
  // messages.
  async sendReadReceipt(to: IdentityRef): Promise<void> {
    try {
      const resolved = await this.resolveIdentity(to);
      await this.options.xmtp.sendText(resolved, JSON.stringify({ type: READ_RECEIPT_TYPE }));
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
        }
      }
      // The retention mirrors are freshly reconciled; drop expired messages.
      await this.purgeExpiredMessages();
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

  async listConversations(): Promise<ConeConversation[]> {
    const [conversations, contacts] = await Promise.all([
      this.options.store.listConversations(),
      this.options.store.listContacts(),
    ]);
    const contactsByInbox = new Map(contacts.map((contact) => [contact.inboxId, contact]));

    return conversations.map((conversation) => {
      // Rows stored before groups existed lack `kind`; they are all DMs.
      const kind = conversation.kind ?? 'dm';
      if (kind === 'group') {
        return { ...conversation, kind, title: conversation.groupName ?? conversation.title };
      }
      const contact = conversation.peerInboxId ? contactsByInbox.get(conversation.peerInboxId) : undefined;
      return {
        ...conversation,
        kind,
        contactId: contact?.contactId ?? conversation.contactId,
        title: contact?.name ?? conversation.title,
      };
    });
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
      return {
        conversationId: message.conversationId,
        direction: message.senderInboxId === identity.inboxId ? 'outbound' as const : 'inbound' as const,
        expiresAt: messageExpiresAt(message.sentAt, retentionByConversation.get(message.conversationId)),
        json: typeof payload === 'string' ? undefined : payload,
        kind,
        messageId: message.messageId,
        recipientInboxId: message.recipientInboxId,
        senderInboxId: message.senderInboxId,
        sentAt: message.sentAt,
        text: typeof payload === 'string' ? payload : undefined,
      };
    }));
  }

  deleteConversation(conversationId: string): Promise<void> {
    return this.options.store.deleteConversation(conversationId);
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
    if (conversation.kind !== 'group' || conversation.consentState !== 'unknown' || !conversation.addedByInboxId) {
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

  async pairWithCode(code: string, options: { proposedName?: string; timeoutMs?: number } = {}): Promise<PairingResult> {
    if (!this.options.rendezvous) {
      throw new Error('rendezvous client is required for code pairing');
    }

    // Both the rendezvous room and the offer encryption are keyed by the
    // normalized code, so "anchor beacon" and "Anchor-Beacon" pair up.
    const normalizedCode = normalizeHandshakeCode(code);
    const identity = await this.identity();
    const deadline = this.now().getTime() + (options.timeoutMs ?? 60_000);
    const localOffer = await createEncryptedPairingOffer({
      code: normalizedCode,
      identity,
      proposedName: options.proposedName,
      now: this.now(),
    });
    let peer: PairingOffer | null = null;

    while (this.now().getTime() < deadline) {
      const offers = await this.options.rendezvous.exchangeOffer({
        code: normalizedCode,
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
      throw new Error('pairing timed out');
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
      await this.options.xmtp.sendText(
        resolved,
        JSON.stringify({
          type: PAIR_CONFIRM_TYPE,
          inboxId: identity.inboxId,
          address: identity.address,
          codeAcceptedAt: this.nowIso(),
        }),
      );
      sentConfirmation = true;
    }

    return {
      contact,
      peer: { inboxId: peer.inboxId, address: peer.address, env: peer.env },
      sentConfirmation,
    };
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

  async ensureSelfContact(): Promise<void> {
    const identity = await this.identity();
    const existing = await this.options.store.getContactByInboxId(identity.inboxId);
    if (existing) {
      return;
    }
    await this.saveContact({
      name: 'Me',
      inboxId: identity.inboxId,
      address: identity.address,
      source: 'self',
    });
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
