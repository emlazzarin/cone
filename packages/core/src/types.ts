import type { EncryptedJson } from './crypto';

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SecretKey = Brand<string, 'SecretKey'>;
export type XmtpEnv = 'local' | 'dev' | 'production';
export type ContactSource = 'manual' | 'paired' | 'inbound' | 'self';

export interface DerivedAccount {
  accountId: string;
  env: XmtpEnv;
  walletPrivateKey: `0x${string}`;
  xmtpDbEncryptionKey: string;
  coneStorageKey: Uint8Array;
  backupArchiveKey: Uint8Array;
  pairingKey: Uint8Array;
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

export interface ConeConversation {
  conversationId: string;
  peerInboxId: string;
  peerAddress?: string;
  contactId?: string;
  title: string;
  updatedAt?: string;
  unreadCount?: number;
  lastReadAt?: string;
}

export interface ConeStoreMetadata {
  lastStreamStartedAt?: string;
  lastSyncedAt?: string;
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
}

export interface SentMessage {
  messageId: string;
  conversationId?: string;
  sentAt: string;
}

export interface IncomingMessage {
  messageId: string;
  conversationId: string;
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

export interface XmtpAdapter {
  identity(): Promise<ConeIdentity>;
  resolveIdentity(ref: IdentityRef): Promise<ResolvedIdentity | null>;
  canMessage(identity: ResolvedIdentity): Promise<boolean>;
  sendText(identity: ResolvedIdentity, text: string): Promise<SentMessage>;
  sync(): Promise<XmtpSyncResult>;
  streamMessages(handler: MessageHandler): Promise<Unsubscribe>;
  listConversations(): Promise<ConeConversation[]>;
  listMessages(conversationId: string, options?: MessageListOptions): Promise<IncomingMessage[]>;
  exportArchive?(key: Uint8Array): Promise<Uint8Array>;
  importArchive?(data: Uint8Array, key: Uint8Array): Promise<void>;
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
  markMessageProcessed(messageId: string): Promise<boolean>;

  getMetadata(): Promise<ConeStoreMetadata>;
  putMetadata(metadata: ConeStoreMetadata): Promise<void>;

  exportSnapshot(): Promise<ConeStoreSnapshot>;
  importSnapshot(snapshot: ConeStoreSnapshot): Promise<void>;
  close?(): void | Promise<void>;
}

export interface ConeClient {
  identity(): Promise<ConeIdentity>;
  resolveIdentity(ref: IdentityRef): Promise<ResolvedIdentity>;
  canMessage(ref: IdentityRef): Promise<boolean>;
  sendText(to: IdentityRef, text: string): Promise<SentMessage>;
  sendJson(to: IdentityRef, value: unknown): Promise<SentMessage>;
  sendReadReceipt(to: IdentityRef): Promise<void>;
  sync(): Promise<SyncResult>;
  streamMessages(handler: MessageHandler): Promise<Unsubscribe>;
  listConversations(): Promise<ConeConversation[]>;
  listMessages(conversationId?: string): Promise<ConeMessage[]>;
  deleteConversation(conversationId: string): Promise<void>;
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
  now?: () => Date;
}
