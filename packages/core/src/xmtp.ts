// Shared XmtpAdapter implementation for the XMTP node and browser SDKs.
// The two SDKs expose the same conversation/message surface with small
// differences (sync vs async methods, peerInboxId as property vs method),
// so each adapter package supplies a created SDK client plus a tiny bridge
// and everything else lives here, SDK-agnostic.
//
// Imported as `@cone/core/xmtp` by adapter packages only; apps use the main
// `@cone/core` entry.

import { encodeConeEnvelope, isConeEnvelopeContentType, type ConeEncodedContent } from './content-type';
import { normalizeDeliveryStatus } from './display';
import { GROUP_UPDATE_TYPE, isAcceptableInboundEnvelope, type ConeEnvelope, type GroupUpdateEnvelope } from './envelope';
import { isEvmAddress } from './validation';
import type {
  ConeConsentState,
  ConeConversation,
  ConeGroupMember,
  ConeIdentity,
  ConsentFilter,
  ConversationKind,
  CreateGroupOptions,
  GroupMemberLevel,
  IdentityRef,
  IncomingMessage,
  MessageHandler,
  MessageListOptions,
  MessageRetention,
  ResolvedIdentity,
  SentMessage,
  Unsubscribe,
  XmtpAdapter,
  XmtpEnv,
  XmtpSyncResult,
} from './types';

type MaybePromise<T> = T | Promise<T>;

export interface SdkIdentifier {
  identifier: string;
  identifierKind: unknown;
}

// One XMTP consent record, identical in shape across both SDK bindings.
export interface SdkConsentRecord {
  entityType: unknown;
  state: unknown;
  entity: string;
}

// The SDK's MessageDisappearingSettings: fromNs is the epoch-ns timestamp the
// rule starts, inNs the retention duration. Fields typed unknown because the
// bindings hand back bigint (node) and have used number elsewhere; nsToIso/
// nsToMs normalize both.
export interface SdkDisappearingSettings {
  fromNs: unknown;
  inNs: unknown;
}

// Structural view of the conversation surface shared by SDK DMs and groups.
// consentState and messageDisappearingSettings are sync on node, async on
// browser.
export interface SdkConversation {
  id: string;
  topic?: string;
  createdAt?: Date;
  sendText(text: string): Promise<string>;
  // Sends pre-encoded content (the Cone envelope content type). Identical
  // signature in both bindings: send(encodedContent, opts?).
  send(encodedContent: ConeEncodedContent): Promise<string>;
  messages(options?: Record<string, unknown>): Promise<unknown[]>;
  consentState(): MaybePromise<unknown>;
  messageDisappearingSettings(): MaybePromise<SdkDisappearingSettings | null | undefined>;
  updateMessageDisappearingSettings(fromNs: bigint, inNs: bigint): Promise<void>;
  removeMessageDisappearingSettings(): Promise<void>;
}

// Structural view of an SDK DM conversation. peerInboxId is intentionally
// absent: it is a property on node DMs and an async method on browser DMs,
// so the bridge resolves it.
export interface SdkDm extends SdkConversation {}

// One group member as both bindings shape it ({ inboxId, permissionLevel,
// consentState, installationIds }); enum values stay unknown and are mapped
// via injected values.
export interface SdkGroupMember {
  inboxId: string;
  permissionLevel: unknown;
  consentState: unknown;
}

// Structural view of an SDK group. The metadata accessors are sync getter
// properties on both SDKs (browser reads a cached snapshot and may yield
// undefined until a sync). addMembers/removeMembers take canonical inbox IDs;
// requestRemoval is "leave". isActive is intentionally absent: it is a getter
// on node and an async method on browser, so the groupIsActive bridge resolves
// it (same split as peerInboxId on DMs).
export interface SdkGroup extends SdkConversation {
  readonly name?: string;
  readonly description?: string;
  readonly addedByInboxId?: string;
  members(): Promise<SdkGroupMember[]>;
  addMembers(inboxIds: string[]): Promise<void>;
  removeMembers(inboxIds: string[]): Promise<void>;
  requestRemoval(): Promise<void>;
  updateName(name: string): Promise<void>;
  updateDescription(description: string): Promise<void>;
  addAdmin(inboxId: string): Promise<void>;
  removeAdmin(inboxId: string): Promise<void>;
  addSuperAdmin(inboxId: string): Promise<void>;
  removeSuperAdmin(inboxId: string): Promise<void>;
}

// Structural view of the SDK client surface this adapter uses. Methods that
// are synchronous in one SDK and async in the other are typed MaybePromise;
// `await` normalizes them.
export interface SdkClient {
  inboxId: string | undefined;
  conversations: {
    streamAllMessages(handlers: {
      onValue: (message: unknown) => void;
      onError: (error: unknown) => void;
      consentStates?: unknown[];
      conversationType?: unknown;
    }): Promise<{ return(): unknown }>;
    syncAll(consentStates?: unknown[]): Promise<unknown>;
    listDms(options?: { consentStates?: unknown[]; includeDuplicateDms?: boolean }): MaybePromise<SdkDm[]>;
    listGroups(options?: { consentStates?: unknown[] }): MaybePromise<SdkGroup[]>;
    createGroup(inboxIds: string[], options?: Record<string, unknown>): Promise<SdkGroup>;
    getConversationById(conversationId: string): MaybePromise<SdkConversation | null | undefined>;
    fetchDmByIdentifier(identifier: SdkIdentifier): MaybePromise<SdkDm | null | undefined>;
    createDmWithIdentifier(identifier: SdkIdentifier): Promise<SdkDm>;
    getDmByInboxId(inboxId: string): MaybePromise<SdkDm | null | undefined>;
    createDm(inboxId: string): Promise<SdkDm>;
  };
  preferences: {
    setConsentStates(records: SdkConsentRecord[]): Promise<void>;
    getConsentState(entityType: unknown, entity: string): Promise<unknown>;
  };
  fetchInboxIdByIdentifier(identifier: SdkIdentifier): MaybePromise<string | null | undefined>;
  canMessage(identifiers: SdkIdentifier[]): Promise<Map<string, boolean>>;
  close(): MaybePromise<unknown>;
}

// The SDK's ConsentState enum values keyed by our union, plus its
// ConsentEntityType values for inbox- and group-level consent. Injected by the
// adapter packages (like ethereumIdentifierKind) so core never imports a
// specific SDK build. The values are XMTP protocol integers
// (Unknown=0/Allowed=1/Denied=2; GroupId=0/InboxId=1) that the native layer
// reads and returns directly.
export interface SdkConsent {
  unknown: unknown;
  allowed: unknown;
  denied: unknown;
  inboxEntityType: unknown;
  groupEntityType: unknown;
}

// The SDK's PermissionLevel enum values (Member=0/Admin=1/SuperAdmin=2).
export interface SdkPermissionLevels {
  member: unknown;
  admin: unknown;
  superAdmin: unknown;
}

export interface SdkXmtpAdapterOptions {
  client: SdkClient;
  env: XmtpEnv;
  /** Lowercase EVM address of this account. */
  address: string;
  /** The SDK's IdentifierKind.Ethereum value. */
  ethereumIdentifierKind: unknown;
  /** The SDK's ConsentState enum values + ConsentEntityType values. */
  consent: SdkConsent;
  /** The SDK's GroupMember PermissionLevel enum values. */
  permissionLevels: SdkPermissionLevels;
  /** The SDK's GroupPermissionsOptions.AdminOnly value (the "locked" preset). */
  adminOnlyPermissions: unknown;
  /**
   * The SDK's ConversationType.Dm and ConversationType.Group values. The
   * message stream is opened once per type so every delivered message is
   * tagged with its conversation kind — a group message must never be
   * mistaken for a DM (it would be persisted as a DM-shaped conversation
   * keyed to whoever spoke first).
   */
  dmConversationType: unknown;
  groupConversationType: unknown;
  /** Resolves a DM's peer inbox ID (property on node, async method on browser). */
  peerInboxId(dm: SdkDm): MaybePromise<string>;
  /** Resolves whether this account is still a group member (getter on node, async method on browser). */
  groupIsActive(group: SdkGroup): MaybePromise<boolean>;
}

export function createSdkXmtpAdapter(options: SdkXmtpAdapterOptions): XmtpAdapter {
  return new SdkXmtpAdapter(options);
}

class SdkXmtpAdapter implements XmtpAdapter {
  private readonly client: SdkClient;

  constructor(private readonly options: SdkXmtpAdapterOptions) {
    this.client = options.client;
  }

  identity(): Promise<ConeIdentity> {
    return Promise.resolve({
      inboxId: String(this.client.inboxId),
      address: this.options.address,
      env: this.options.env,
    });
  }

  async resolveIdentity(ref: IdentityRef): Promise<ResolvedIdentity | null> {
    if (typeof ref === 'string') {
      if (isEvmAddress(ref)) {
        return this.resolveIdentity({ address: ref });
      }
      return { inboxId: ref, source: 'inboxId' };
    }
    if (ref.inboxId) {
      return { inboxId: ref.inboxId, address: ref.address, source: 'inboxId' };
    }
    if (ref.address) {
      const inboxId = await this.client.fetchInboxIdByIdentifier(this.evmIdentifier(ref.address));
      return inboxId ? { inboxId, address: ref.address, source: 'address' } : null;
    }
    return null;
  }

  async canMessage(identity: ResolvedIdentity): Promise<boolean> {
    if (!identity.address) {
      return true;
    }

    const address = identity.address.toLowerCase();
    const result = await this.client.canMessage([this.evmIdentifier(address)]);
    return result.get(address) === true;
  }

  async sendText(identity: ResolvedIdentity, text: string): Promise<SentMessage> {
    const dm = await this.findOrCreateDm(identity);
    // conversation.sendText publishes synchronously and rejects if the message
    // cannot reach the network, so a resolved send is published. (We avoid the
    // optimistic send + publishMessages split because a failed-then-retried
    // optimistic message can later flush and duplicate.)
    const messageId = await dm.sendText(text);
    return {
      messageId,
      conversationId: String(dm.id ?? dm.topic ?? `dm:${identity.inboxId}`),
      sentAt: new Date().toISOString(),
      deliveryStatus: 'published',
    };
  }

  // Cone envelopes ride the Cone envelope content type. Same synchronous
  // publish semantics as sendText.
  async sendEnvelope(identity: ResolvedIdentity, envelope: ConeEnvelope): Promise<SentMessage> {
    const dm = await this.findOrCreateDm(identity);
    const messageId = await dm.send(encodeConeEnvelope(envelope));
    return {
      messageId,
      conversationId: String(dm.id ?? dm.topic ?? `dm:${identity.inboxId}`),
      sentAt: new Date().toISOString(),
      deliveryStatus: 'published',
    };
  }

  // One SDK stream per conversation type, so every message is tagged with its
  // kind. The unsubscribe closes both.
  async streamMessages(handler: MessageHandler, filter?: ConsentFilter): Promise<Unsubscribe> {
    const consentStates = this.consentFilter(filter);
    const open = (conversationType: unknown, kind: ConversationKind) =>
      this.client.conversations.streamAllMessages({
        onValue: (message: unknown) => {
          if (isDelivered(message)) {
            void handler(toIncomingMessage(message, kind));
          }
        },
        onError: (error: unknown) => {
          console.error(error);
        },
        conversationType,
        ...(consentStates ? { consentStates } : {}),
      });

    const [dmStream, groupStream] = await Promise.all([
      open(this.options.dmConversationType, 'dm'),
      open(this.options.groupConversationType, 'group'),
    ]);

    return () => {
      void dmStream.return();
      void groupStream.return();
    };
  }

  async sync(filter?: ConsentFilter): Promise<XmtpSyncResult> {
    const consentStates = this.consentFilter(filter);
    await this.client.conversations.syncAll(consentStates);
    // XMTP can hold several MLS DMs for one peer pair (both sides initiated);
    // the SDK stitches them, and listing must ask for the canonical one only —
    // otherwise every duplicate becomes its own thread in the read model.
    const dms = await this.client.conversations.listDms({ ...(consentStates ? { consentStates } : {}), includeDuplicateDms: false });
    const groups = await this.client.conversations.listGroups(consentStates ? { consentStates } : undefined);
    const conversations = await Promise.all([
      ...dms.map((dm) => this.toDmConversation(dm)),
      ...groups.map((group) => this.toGroupConversation(group)),
    ]);
    const messagesOf = async (conversation: SdkConversation, kind: ConversationKind) =>
      (await conversation.messages()).filter(isDelivered).map((message) => toIncomingMessage(message, kind));
    const messages = (await Promise.all([
      ...dms.map((dm) => messagesOf(dm, 'dm')),
      ...groups.map((group) => messagesOf(group, 'group')),
    ])).flat();
    return { conversations, messages };
  }

  async listConversations(filter?: ConsentFilter): Promise<ConeConversation[]> {
    const consentStates = this.consentFilter(filter);
    const dms = await this.client.conversations.listDms({ ...(consentStates ? { consentStates } : {}), includeDuplicateDms: false });
    const groups = await this.client.conversations.listGroups(consentStates ? { consentStates } : undefined);
    return Promise.all([
      ...dms.map((dm) => this.toDmConversation(dm)),
      ...groups.map((group) => this.toGroupConversation(group)),
    ]);
  }

  async setConsent(inboxId: string, state: ConeConsentState): Promise<void> {
    await this.client.preferences.setConsentStates([{
      entityType: this.options.consent.inboxEntityType,
      state: this.options.consent[state],
      entity: inboxId,
    }]);
  }

  async getConsent(inboxId: string): Promise<ConeConsentState> {
    return this.fromSdkConsent(await this.client.preferences.getConsentState(this.options.consent.inboxEntityType, inboxId));
  }

  // Group consent is keyed by the conversation id (XMTP ConsentEntityType.GroupId).
  async setGroupConsent(conversationId: string, state: ConeConsentState): Promise<void> {
    await this.client.preferences.setConsentStates([{
      entityType: this.options.consent.groupEntityType,
      state: this.options.consent[state],
      entity: conversationId,
    }]);
  }

  async createGroup(memberInboxIds: string[], options: CreateGroupOptions = {}): Promise<ConeConversation> {
    const group = await this.client.conversations.createGroup(memberInboxIds, {
      ...(options.name ? { groupName: options.name } : {}),
      ...(options.description ? { groupDescription: options.description } : {}),
      ...(options.locked ? { permissions: this.options.adminOnlyPermissions } : {}),
    });
    return this.toGroupConversation(group);
  }

  async getGroupInfo(conversationId: string): Promise<ConeConversation | null> {
    const conversation = await this.client.conversations.getConversationById(conversationId);
    if (!conversation || !isSdkGroup(conversation)) {
      return null;
    }
    return this.toGroupConversation(conversation);
  }

  async listGroupMembers(conversationId: string): Promise<ConeGroupMember[]> {
    return this.groupMembers(await this.getGroup(conversationId));
  }

  async addGroupMembers(conversationId: string, memberInboxIds: string[]): Promise<void> {
    await (await this.getGroup(conversationId)).addMembers(memberInboxIds);
  }

  async removeGroupMembers(conversationId: string, memberInboxIds: string[]): Promise<void> {
    await (await this.getGroup(conversationId)).removeMembers(memberInboxIds);
  }

  async leaveGroup(conversationId: string): Promise<void> {
    await (await this.getGroup(conversationId)).requestRemoval();
  }

  async updateGroupName(conversationId: string, name: string): Promise<void> {
    await (await this.getGroup(conversationId)).updateName(name);
  }

  async updateGroupDescription(conversationId: string, description: string): Promise<void> {
    await (await this.getGroup(conversationId)).updateDescription(description);
  }

  async addGroupAdmin(conversationId: string, inboxId: string): Promise<void> {
    await (await this.getGroup(conversationId)).addAdmin(inboxId);
  }

  async removeGroupAdmin(conversationId: string, inboxId: string): Promise<void> {
    await (await this.getGroup(conversationId)).removeAdmin(inboxId);
  }

  async addGroupSuperAdmin(conversationId: string, inboxId: string): Promise<void> {
    await (await this.getGroup(conversationId)).addSuperAdmin(inboxId);
  }

  async removeGroupSuperAdmin(conversationId: string, inboxId: string): Promise<void> {
    await (await this.getGroup(conversationId)).removeSuperAdmin(inboxId);
  }

  async sendToConversation(conversationId: string, text: string): Promise<SentMessage> {
    const conversation = await this.client.conversations.getConversationById(conversationId);
    if (!conversation) {
      throw new Error(`conversation not found: ${conversationId}`);
    }
    const messageId = await conversation.sendText(text);
    return {
      messageId,
      conversationId,
      sentAt: new Date().toISOString(),
      deliveryStatus: 'published',
    };
  }

  // Writes the conversation's native XMTP disappearing-messages settings,
  // which propagate to the peer (and other compliant clients) as a metadata
  // update. null removes the settings (timer off).
  async setRetention(conversationId: string, retention: MessageRetention | null): Promise<void> {
    const conversation = await this.client.conversations.getConversationById(conversationId);
    if (!conversation) {
      throw new Error(`conversation not found: ${conversationId}`);
    }
    if (retention) {
      await conversation.updateMessageDisappearingSettings(
        isoToNs(retention.fromAt),
        BigInt(retention.durationMs) * 1_000_000n,
      );
    } else {
      await conversation.removeMessageDisappearingSettings();
    }
  }

  async getRetention(conversationId: string): Promise<MessageRetention | null> {
    const conversation = await this.client.conversations.getConversationById(conversationId);
    if (!conversation) {
      return null;
    }
    return fromSdkRetention(await conversation.messageDisappearingSettings()) ?? null;
  }

  async listMessages(conversationId: string, options?: MessageListOptions): Promise<IncomingMessage[]> {
    const conversation = await this.client.conversations.getConversationById(conversationId);
    if (!conversation) {
      return [];
    }
    const kind: ConversationKind = isSdkGroup(conversation) ? 'group' : 'dm';
    const messages = await conversation.messages(toSdkMessageOptions(options ?? {}));
    return messages.filter(isDelivered).map((message) => toIncomingMessage(message, kind));
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private evmIdentifier(address: string): SdkIdentifier {
    return {
      identifier: address.toLowerCase(),
      identifierKind: this.options.ethereumIdentifierKind,
    };
  }

  private async findOrCreateDm(identity: ResolvedIdentity): Promise<SdkDm> {
    if (identity.address) {
      const identifier = this.evmIdentifier(identity.address);
      const existing = await this.client.conversations.fetchDmByIdentifier(identifier);
      return existing ?? await this.client.conversations.createDmWithIdentifier(identifier);
    }

    return await this.client.conversations.getDmByInboxId(identity.inboxId) ??
      await this.client.conversations.createDm(identity.inboxId);
  }

  private async getGroup(conversationId: string): Promise<SdkGroup> {
    const conversation = await this.client.conversations.getConversationById(conversationId);
    if (!conversation || !isSdkGroup(conversation)) {
      throw new Error(`group not found: ${conversationId}`);
    }
    return conversation;
  }

  private async toDmConversation(dm: SdkDm): Promise<ConeConversation> {
    const peerInboxId = await this.options.peerInboxId(dm);
    return {
      conversationId: dm.id,
      kind: 'dm',
      peerInboxId,
      title: peerInboxId,
      updatedAt: dm.createdAt?.toISOString(),
      consentState: this.fromSdkConsent(await dm.consentState()),
      retention: fromSdkRetention(await dm.messageDisappearingSettings()),
    };
  }

  private async toGroupConversation(group: SdkGroup): Promise<ConeConversation> {
    const members = await this.groupMembers(group);
    const name = group.name?.trim() || undefined;
    return {
      conversationId: group.id,
      kind: 'group',
      title: name ?? `Group (${members.length})`,
      groupName: name,
      groupDescription: group.description?.trim() || undefined,
      memberCount: members.length,
      addedByInboxId: group.addedByInboxId,
      members,
      active: await this.options.groupIsActive(group),
      updatedAt: group.createdAt?.toISOString(),
      consentState: this.fromSdkConsent(await group.consentState()),
      retention: fromSdkRetention(await group.messageDisappearingSettings()),
    };
  }

  private async groupMembers(group: SdkGroup): Promise<ConeGroupMember[]> {
    const members = await group.members();
    return members.map((member) => ({
      inboxId: member.inboxId,
      level: this.fromSdkPermissionLevel(member.permissionLevel),
      consentState: this.fromSdkConsent(member.consentState),
    }));
  }

  private fromSdkPermissionLevel(value: unknown): GroupMemberLevel {
    if (value === this.options.permissionLevels.superAdmin) {
      return 'superAdmin';
    }
    if (value === this.options.permissionLevels.admin) {
      return 'admin';
    }
    return 'member';
  }

  // No filter => undefined => the SDK returns everything; the ConeClient always
  // passes an explicit filter (allowed-only by default), so policy lives there
  // and the adapter stays mechanism.
  private consentFilter(filter?: ConsentFilter): unknown[] | undefined {
    return filter?.consentStates?.map((state) => this.options.consent[state]);
  }

  private fromSdkConsent(value: unknown): ConeConsentState {
    if (value === this.options.consent.allowed) {
      return 'allowed';
    }
    if (value === this.options.consent.denied) {
      return 'denied';
    }
    return 'unknown';
  }
}

// Keep the local read model to messages that actually published. A send that
// failed to publish lingers in the XMTP DB as unpublished/failed; without this
// it would later sync in and masquerade as delivered.
function isDelivered(message: unknown): boolean {
  return normalizeDeliveryStatus((message as { deliveryStatus?: unknown }).deliveryStatus) === 'published';
}

// Inbound decode discriminates on the message's content type — provenance,
// not parsing. Text is always just text (a typed message can never become a
// control envelope); Cone envelopes come only from the Cone content type;
// group updates come only from XMTP's GroupUpdated system messages. Content
// in a type this build cannot decode renders its self-describing fallback
// when the sender provided one, and stays hidden when they did not — both by
// the content type's own declaration, so a newer client's messages degrade
// the way that client intended instead of vanishing.
function toIncomingMessage(message: unknown, kind: ConversationKind = 'dm'): IncomingMessage {
  const record = message as Record<string, unknown>;
  const content = record.content;
  let json: unknown = decodeGroupUpdate(record);
  let text: string | undefined;
  if (json === undefined && isConeEnvelopeContentType(record.contentType)) {
    // The registered codec already decoded the payload; accept only a valid
    // envelope (isAcceptableInboundEnvelope rejects forged group updates).
    // Anything else falls through as unsupported and stays hidden.
    if (isAcceptableInboundEnvelope(content)) {
      json = content;
    }
  } else if (json === undefined && typeof content === 'string') {
    text = content;
  } else if (json === undefined && typeof record.fallback === 'string' && record.fallback.length > 0) {
    text = record.fallback;
  }

  return {
    messageId: String(record.id ?? crypto.randomUUID()),
    conversationId: String(record.conversationId ?? record.topic ?? 'unknown'),
    conversationKind: kind,
    senderInboxId: String(record.senderInboxId ?? record.sender ?? 'unknown'),
    senderAddress: typeof record.senderAddress === 'string' ? record.senderAddress : undefined,
    sentAt: record.sentAt instanceof Date ? record.sentAt.toISOString() : nsToIso(record.sentAtNs) ?? new Date().toISOString(),
    text,
    json,
    raw: {
      contentType: String(record.contentType ?? 'unknown'),
      conversationId: String(record.conversationId ?? record.topic ?? 'unknown'),
      messageId: String(record.id ?? 'unknown'),
    },
  };
}

// XMTP delivers membership/metadata changes as GroupUpdated system messages
// (contentType typeId 'group_updated', content decoded by the bindings).
// Normalize them into Cone's control envelope so they store and render like
// any other cone.* control message.
function decodeGroupUpdate(record: Record<string, unknown>): GroupUpdateEnvelope | undefined {
  const contentType = record.contentType as { typeId?: unknown } | null | undefined;
  if (contentType?.typeId !== 'group_updated') {
    return undefined;
  }
  const content = (record.content ?? {}) as {
    initiatedByInboxId?: unknown;
    addedInboxes?: unknown;
    removedInboxes?: unknown;
    leftInboxes?: unknown;
    addedAdminInboxes?: unknown;
    removedAdminInboxes?: unknown;
    addedSuperAdminInboxes?: unknown;
    removedSuperAdminInboxes?: unknown;
    metadataFieldChanges?: unknown;
  };
  return {
    type: GROUP_UPDATE_TYPE,
    initiatedByInboxId: String(content.initiatedByInboxId ?? 'unknown'),
    added: inboxIdList(content.addedInboxes),
    removed: inboxIdList(content.removedInboxes),
    left: inboxIdList(content.leftInboxes),
    adminsAdded: inboxIdList(content.addedAdminInboxes),
    adminsRemoved: inboxIdList(content.removedAdminInboxes),
    superAdminsAdded: inboxIdList(content.addedSuperAdminInboxes),
    superAdminsRemoved: inboxIdList(content.removedSuperAdminInboxes),
    metadataChanges: metadataChangeList(content.metadataFieldChanges),
  };
}

function inboxIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (entry as { inboxId?: unknown })?.inboxId)
    .filter((inboxId): inboxId is string => typeof inboxId === 'string');
}

function metadataChangeList(value: unknown): GroupUpdateEnvelope['metadataChanges'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const change = entry as { fieldName?: unknown; oldValue?: unknown; newValue?: unknown } | null;
    if (typeof change?.fieldName !== 'string') {
      return [];
    }
    return [{
      field: change.fieldName,
      oldValue: typeof change.oldValue === 'string' ? change.oldValue : undefined,
      newValue: typeof change.newValue === 'string' ? change.newValue : undefined,
    }];
  });
}

// Groups carry membership methods; DMs do not. This is how the union returned
// by getConversationById is narrowed without importing SDK classes.
function isSdkGroup(conversation: SdkConversation): conversation is SdkGroup {
  return typeof (conversation as { addMembers?: unknown }).addMembers === 'function';
}

function nsToIso(value: unknown): string | null {
  if (typeof value === 'bigint') {
    return new Date(Number(value / 1_000_000n)).toISOString();
  }
  if (typeof value === 'number') {
    return new Date(value / 1_000_000).toISOString();
  }
  return null;
}

function nsToMs(value: unknown): number | null {
  if (typeof value === 'bigint') {
    return Number(value / 1_000_000n);
  }
  if (typeof value === 'number') {
    return value / 1_000_000;
  }
  return null;
}

// Absent settings or a non-positive duration both mean the timer is off.
function fromSdkRetention(settings: SdkDisappearingSettings | null | undefined): MessageRetention | undefined {
  if (!settings) {
    return undefined;
  }
  const fromAt = nsToIso(settings.fromNs);
  const durationMs = nsToMs(settings.inNs);
  if (!fromAt || !durationMs || durationMs <= 0) {
    return undefined;
  }
  return { durationMs, fromAt };
}

function toSdkMessageOptions(options: MessageListOptions): Record<string, unknown> {
  const sdkOptions: Record<string, unknown> = {};
  if (options.limit !== undefined) {
    sdkOptions.limit = options.limit;
  }
  if (options.before) {
    sdkOptions.sentBeforeNs = isoToNs(options.before);
  }
  if (options.after) {
    sdkOptions.sentAfterNs = isoToNs(options.after);
  }
  return sdkOptions;
}

function isoToNs(value: string): bigint {
  return BigInt(new Date(value).getTime()) * 1_000_000n;
}
