import type { EncryptedJson } from './crypto';

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SecretKey = Brand<string, 'SecretKey'>;
export type XmtpEnv = 'local' | 'dev' | 'production';
// A contact is created only by an explicit act: adding one, pairing, or
// accepting a request. `self` is the account's own entry. Unknown inbound
// senders never become contacts — they stay as Request conversations.
export type ContactSource = 'manual' | 'paired' | 'self';

// XMTP consent is the trust boundary. `unknown` is an inbound sender we have
// not decided on (a Request); `allowed` is in the main inbox; `denied` is
// blocked and hidden from normal lists and streams. Maps 1:1 to the XMTP SDK
// ConsentState enum (Unknown/Allowed/Denied) at the adapter boundary.
export type ConeConsentState = 'unknown' | 'allowed' | 'denied';
export const CONSENT_STATES: readonly ConeConsentState[] = ['unknown', 'allowed', 'denied'];

export interface DerivedAccount {
  accountId: string;
  env: XmtpEnv;
  walletPrivateKey: `0x${string}`;
  xmtpDbEncryptionKey: string;
  coneStorageKey: Uint8Array;
  backupArchiveKey: Uint8Array;
}

export interface ConeIdentity {
  inboxId: string;
  address?: string;
  env: XmtpEnv;
}

export interface IdentityRefObject {
  inboxId?: string;
  address?: string;
  contactId?: string;
  contactName?: string;
}

export type IdentityRef = string | IdentityRefObject;

export interface ResolvedIdentity {
  inboxId: string;
  address?: string;
  source: 'inboxId' | 'address' | 'contact';
  displayName?: string;
}

export interface Contact {
  contactId: string;
  name: string;
  inboxId: string;
  address?: string;
  source: ContactSource;
  createdAt: string;
  updatedAt: string;
}

export interface SaveContactInput {
  name: string;
  inboxId?: string;
  address?: string;
  source?: ContactSource;
}

// Disappearing-messages timer for a conversation: messages sent at or after
// `fromAt` expire `durationMs` after their send time. Mirrors XMTP's native
// MessageDisappearingSettings ({ fromNs, inNs }) in ms/ISO form; either DM
// participant can change it. Expiry is always derived from the *current*
// settings — turning the timer off stops pending expirations, matching XMTP.
export interface MessageRetention {
  durationMs: number;
  fromAt: string;
}

export type ConversationKind = 'dm' | 'group';

// XMTP group roles. The group creator is the (sole) super admin; under the
// default permission policy any member may add members, admins may remove
// them, and only super admins manage admins.
export type GroupMemberLevel = 'member' | 'admin' | 'superAdmin';

export interface ConeGroupMember {
  inboxId: string;
  level: GroupMemberLevel;
  // The member's *inbox* consent state from our point of view — lets UIs badge
  // blocked members and lets the read model drop their in-group messages.
  consentState: ConeConsentState;
}

export interface ConeConversation {
  conversationId: string;
  // Rows stored before groups existed lack `kind`; readers treat undefined as
  // 'dm' (all pre-group conversations are DMs), so branches test `=== 'group'`.
  kind: ConversationKind;
  // DM-only: the single peer. Groups have members instead.
  peerInboxId?: string;
  peerAddress?: string;
  contactId?: string;
  title: string;
  updatedAt?: string;
  unreadCount?: number;
  lastReadAt?: string;
  // Group-only fields. groupName is shared network state (any member may
  // rename under the default policy), unlike local contact aliases. The member
  // mirror is cached at sync time for offline info panels; addedByInboxId is
  // who added us — the consent policy hook.
  groupName?: string;
  groupDescription?: string;
  memberCount?: number;
  addedByInboxId?: string;
  members?: ConeGroupMember[];
  // Local mirror of the conversation's XMTP consent state (the peer inbox for
  // DMs, the group id for groups). Stamped on every persisted conversation
  // (from the network on sync, or 'allowed'/'unknown' when created locally)
  // and reconciled by the next sync.
  consentState: ConeConsentState;
  // Local mirror of the conversation's disappearing-messages settings, absent
  // when the timer is off. Same lifecycle as consentState: mirror-first writes,
  // reconciled from the network on sync.
  retention?: MessageRetention;
}

export interface ConeStoreMetadata {
  lastStreamStartedAt?: string;
  lastSyncedAt?: string;
  // Inboxes this account has denied, maintained by Cone-side consent writes.
  // XMTP gates group delivery at the conversation level only, so this is what
  // lets the read model drop a denied sender's messages inside allowed groups.
  deniedInboxIds?: string[];
}

export interface StoredMessage {
  messageId: string;
  conversationId: string;
  senderInboxId: string;
  recipientInboxId?: string;
  sentAt: string;
  kind: 'text' | 'json' | 'control';
  encryptedPayload: EncryptedJson;
}

export interface ConeMessage {
  messageId: string;
  conversationId: string;
  senderInboxId: string;
  recipientInboxId?: string;
  sentAt: string;
  kind: StoredMessage['kind'];
  direction: 'inbound' | 'outbound';
  text?: string;
  json?: unknown;
  // When the message will disappear, derived at read time from the
  // conversation's current retention (never stored). Absent = does not expire.
  expiresAt?: string;
}

// XMTP is decentralized, so there is no per-recipient "delivered" ack. The
// authoritative signal is whether a message published to the network; a send
// that cannot publish surfaces as a rejection. "unpublished" only appears for
// our own messages that never made it out.
export type MessageDeliveryStatus = 'published' | 'unpublished' | 'failed';

export interface SentMessage {
  messageId: string;
  conversationId?: string;
  sentAt: string;
  deliveryStatus?: MessageDeliveryStatus;
}

export interface IncomingMessage {
  messageId: string;
  conversationId: string;
  // Which kind of conversation the message belongs to. Optional because
  // pre-group emitters never set it; readers treat undefined as 'dm'.
  conversationKind?: ConversationKind;
  senderInboxId: string;
  senderAddress?: string;
  sentAt: string;
  text?: string;
  json?: unknown;
  raw: unknown;
}

export type MessageHandler = (message: IncomingMessage) => void | Promise<void>;
export type Unsubscribe = () => void | Promise<void>;

export interface MessageListOptions {
  after?: string;
  before?: string;
  limit?: number;
}

// Filter network reads/streams by consent. Omitting it means allowed-only —
// the strict default that backs the agent trust boundary.
export interface ConsentFilter {
  consentStates?: ConeConsentState[];
}

export interface XmtpSyncResult {
  conversations: ConeConversation[];
  messages: IncomingMessage[];
}

export interface SyncResult {
  completedAt: string;
  conversationsSynced: number;
  errors: string[];
  messagesSynced: number;
  ok: boolean;
  startedAt: string;
}

export interface HandshakeCode {
  code: string;
  expiresAt: string;
}

export interface PairingResult {
  contact: Contact;
  peer: ConeIdentity;
  sentConfirmation: boolean;
}

export interface PairingOffer {
  offerId: string;
  env: XmtpEnv;
  inboxId: string;
  address?: string;
  nonce: string;
  capabilities: string[];
  proposedName?: string;
  createdAt: string;
}

export interface RendezvousStoredOffer {
  offerId: string;
  participantId: string;
  encryptedOffer: EncryptedJson<PairingOffer>;
  expiresAt: string;
}

export interface RendezvousClient {
  exchangeOffer(input: {
    code: string;
    participantId: string;
    encryptedOffer: EncryptedJson<PairingOffer>;
    expiresAt: string;
  }): Promise<RendezvousStoredOffer[]>;
}

export interface CreateGroupOptions {
  name?: string;
  description?: string;
  // Maps to XMTP's AdminOnly permission preset: only admins add/remove members
  // and edit metadata. Default (unset) is the All_Members preset.
  locked?: boolean;
}

export interface XmtpAdapter {
  identity(): Promise<ConeIdentity>;
  resolveIdentity(ref: IdentityRef): Promise<ResolvedIdentity | null>;
  canMessage(identity: ResolvedIdentity): Promise<boolean>;
  sendText(identity: ResolvedIdentity, text: string): Promise<SentMessage>;
  // Send into an existing conversation by id — works for DMs and groups.
  sendToConversation(conversationId: string, text: string): Promise<SentMessage>;
  sync(filter?: ConsentFilter): Promise<XmtpSyncResult>;
  streamMessages(handler: MessageHandler, filter?: ConsentFilter): Promise<Unsubscribe>;
  listConversations(filter?: ConsentFilter): Promise<ConeConversation[]>;
  listMessages(conversationId: string, options?: MessageListOptions): Promise<IncomingMessage[]>;
  // Inbox-level consent: blocking targets the peer's inbox so a denied sender
  // cannot reappear by opening a fresh conversation.
  setConsent(inboxId: string, state: ConeConsentState): Promise<void>;
  getConsent(inboxId: string): Promise<ConeConsentState>;
  // Group (conversation-id-level) consent — XMTP's ConsentEntityType.GroupId.
  setGroupConsent(conversationId: string, state: ConeConsentState): Promise<void>;
  // Groups. Members are canonical inbox IDs; identity resolution is the
  // client's job. getGroupInfo returns the group as a ConeConversation (or
  // null for unknown/non-group ids) so a streamed message from a group the
  // store has never seen can be given a proper group-shaped row.
  createGroup(memberInboxIds: string[], options?: CreateGroupOptions): Promise<ConeConversation>;
  getGroupInfo(conversationId: string): Promise<ConeConversation | null>;
  listGroupMembers(conversationId: string): Promise<ConeGroupMember[]>;
  addGroupMembers(conversationId: string, memberInboxIds: string[]): Promise<void>;
  removeGroupMembers(conversationId: string, memberInboxIds: string[]): Promise<void>;
  leaveGroup(conversationId: string): Promise<void>;
  // Conversation-level disappearing-messages settings; null = timer off.
  setRetention(conversationId: string, retention: MessageRetention | null): Promise<void>;
  getRetention(conversationId: string): Promise<MessageRetention | null>;
  close?(): Promise<void>;
}

export interface ConeStoreSnapshot {
  contacts: Contact[];
  conversations: ConeConversation[];
  metadata: ConeStoreMetadata;
  messages: StoredMessage[];
  processedMessageIds: string[];
}

export interface ConeStore {
  putConversation(conversation: ConeConversation): Promise<void>;
  getConversationById(conversationId: string): Promise<ConeConversation | null>;
  listConversations(): Promise<ConeConversation[]>;
  deleteConversation(conversationId: string): Promise<void>;

  putContact(contact: Contact): Promise<void>;
  getContactById(contactId: string): Promise<Contact | null>;
  getContactByInboxId(inboxId: string): Promise<Contact | null>;
  getContactByName(name: string): Promise<Contact | null>;
  listContacts(): Promise<Contact[]>;
  deleteContact(contactId: string): Promise<void>;

  putMessage(message: StoredMessage): Promise<void>;
  listMessages(conversationId?: string): Promise<StoredMessage[]>;
  deleteMessage(messageId: string): Promise<void>;
  markMessageProcessed(messageId: string): Promise<boolean>;

  getMetadata(): Promise<ConeStoreMetadata>;
  putMetadata(metadata: ConeStoreMetadata): Promise<void>;

  exportSnapshot(): Promise<ConeStoreSnapshot>;
  importSnapshot(snapshot: ConeStoreSnapshot): Promise<void>;
  close?(): void | Promise<void>;
}

export interface CreateGroupInput {
  name?: string;
  description?: string;
  members: IdentityRef[];
  locked?: boolean;
}

export interface ConeClient {
  identity(): Promise<ConeIdentity>;
  resolveIdentity(ref: IdentityRef): Promise<ResolvedIdentity>;
  canMessage(ref: IdentityRef): Promise<boolean>;
  sendText(to: IdentityRef, text: string): Promise<SentMessage>;
  sendJson(to: IdentityRef, value: unknown): Promise<SentMessage>;
  // Send into an existing conversation by id. DMs route through the identity
  // path (same reachability/consent semantics as sendText); groups publish to
  // the group and imply group consent.
  sendToConversation(conversationId: string, text: string): Promise<SentMessage>;
  sendReadReceipt(to: IdentityRef): Promise<void>;
  // Create a group with the given members (the creator joins automatically and
  // is the super admin). Members are not auto-saved as contacts.
  createGroup(input: CreateGroupInput): Promise<ConeConversation>;
  listGroupMembers(conversationId: string): Promise<ConeGroupMember[]>;
  addGroupMembers(conversationId: string, members: IdentityRef[]): Promise<void>;
  removeGroupMembers(conversationId: string, members: IdentityRef[]): Promise<void>;
  leaveGroup(conversationId: string): Promise<void>;
  sync(): Promise<SyncResult>;
  // Streams default to allowed-only — this is the agent trust boundary. Human
  // surfaces pass { consentStates: ['allowed', 'unknown'] } so Requests update
  // live; denied is never streamed.
  streamMessages(handler: MessageHandler, filter?: ConsentFilter): Promise<Unsubscribe>;
  listConversations(): Promise<ConeConversation[]>;
  listMessages(conversationId?: string): Promise<ConeMessage[]>;
  deleteConversation(conversationId: string): Promise<void>;
  // Set the peer's consent (allowed = accept/main inbox, denied = block).
  // Writes XMTP network consent and updates the local mirror. Resolves a
  // contact/inbox/address ref to the canonical inbox first.
  setConsent(to: IdentityRef, state: ConeConsentState): Promise<void>;
  // Consent for a conversation row: DMs target the peer's inbox, groups target
  // the group id. The uniform accept/block entry point for Requests surfaces.
  setConversationConsent(conversationId: string, state: ConeConsentState): Promise<void>;
  // Set the conversation's disappearing-messages timer (null = off). Mirror-
  // first like consent: local state updates immediately, the XMTP settings
  // write is best-effort and reconciled on the next sync.
  setRetention(conversationId: string, durationMs: number | null): Promise<void>;
  // Delete expired messages from Cone storage (XMTP's own cleanup worker only
  // covers the XMTP-level DB). Runs automatically on sync() and before
  // exportBackup(); surfaces may also call it on a timer. Returns the count.
  purgeExpiredMessages(): Promise<number>;
  listContacts(): Promise<Contact[]>;
  saveContact(input: SaveContactInput): Promise<Contact>;
  deleteContact(contactId: string): Promise<void>;
  createHandshakeCode(): Promise<HandshakeCode>;
  pairWithCode(code: string, options?: { proposedName?: string; timeoutMs?: number }): Promise<PairingResult>;
  exportBackup(): Promise<Uint8Array>;
  importBackup(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface CreateConeClientOptions {
  xmtp: XmtpAdapter;
  store: ConeStore;
  account: DerivedAccount;
  rendezvous?: RendezvousClient;
  // "Allow contacts to add you to groups" (default true): a group add from an
  // address-book contact is auto-allowed at sync time; with it off, every
  // group add lands in Requests. Either way, adds from denied inboxes are
  // silently discarded, and adds from unknown senders become Requests. Agent
  // processes should pass false — the agent boundary is explicit accept only.
  autoAllowGroupsFromContacts?: boolean;
  now?: () => Date;
}
