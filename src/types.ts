import type { Agent, MessageContext } from '@xmtp/agent-sdk';

export type ConnectionStatus = 'pending' | 'active';

export interface ConeOptions {
  agent: Agent;
  store: ConeStore;
  inviteExpiryMs?: number;
  handshakeTimeoutMs?: number;
}

export interface Cone {
  readonly self: LocalIdentity;

  createInvite(options?: CreateInviteOptions): Promise<Invite>;
  acceptInvite(token: string): Promise<Connection>;

  handleMessage(ctx: MessageContext): Promise<boolean>;

  extractInviteToken(text: string): string | null;
  renderInviteInstructions(invite: Invite): string;

  listConnections(): Promise<Connection[]>;
  getConnection(ref: ConnectionRef): Promise<Connection | null>;

  sendText(ref: ConnectionRef, text: string): Promise<SentMessage>;
  sendJson<T>(ref: ConnectionRef, value: T): Promise<SentMessage>;

  on(event: 'connection:active', listener: (c: Connection) => void): Unsubscribe;
  on(event: 'message:text', listener: (e: TextMessageEvent) => void): Unsubscribe;
  on(event: 'message:json', listener: (e: JsonMessageEvent<unknown>) => void): Unsubscribe;
}

export interface LocalIdentity {
  inboxId: string;
  address?: string;
}

export interface CreateInviteOptions {
  label?: string;
  expiresInMs?: number;
}

export interface Invite {
  inviteId: string;
  token: string;
  expiresAt: string;
  inviter: LocalIdentity;
}

export interface Connection {
  connectionId: string;
  pairId: string;
  status: ConnectionStatus;
  peerInboxId: string;
  peerAddress?: string;
  alias?: string;
  conversationId?: string;
  createdAt: string;
  activatedAt?: string;
}

export interface SentMessage {
  id: string;
  sentAt: string;
}

export type ConnectionRef = { connectionId: string } | { peerInboxId: string };

export interface TextMessageEvent {
  connection: Connection;
  text: string;
  messageId: string;
  sentAt: string;
}

export interface JsonMessageEvent<T> {
  connection: Connection;
  value: T;
  messageId: string;
  sentAt: string;
}

export type Unsubscribe = () => void;

export interface StoredInvite {
  inviteId: string;
  pairId: string;
  label?: string;
  inviterInboxId: string;
  inviterAddress?: string;
  env: string;
  expiresAt: string;
  secretHash: string;
  status: 'pending' | 'consumed';
  createdAt: string;
  consumedBy?: PeerSnapshot;
}

export interface PeerSnapshot {
  inboxId: string;
  address?: string;
}

export interface StoredConnection {
  connectionId: string;
  pairId: string;
  status: ConnectionStatus;
  peerInboxId: string;
  peerAddress?: string;
  alias?: string;
  conversationId?: string;
  createdAt: string;
  activatedAt?: string;
}

export interface ConeStore {
  putInvite(invite: StoredInvite): Promise<void>;
  getInvite(inviteId: string): Promise<StoredInvite | null>;
  consumeInvite(inviteId: string, peer: PeerSnapshot): Promise<void>;

  putConnection(connection: StoredConnection): Promise<void>;
  getConnectionById(connectionId: string): Promise<StoredConnection | null>;
  getConnectionByInboxId(peerInboxId: string): Promise<StoredConnection | null>;
  listConnections(): Promise<StoredConnection[]>;

  markMessageProcessed(messageId: string): Promise<boolean>;
}

interface TokenPayload {
  inviteId: string;
  pairId: string;
  inviterInboxId: string;
  inviterAddress?: string;
  env: string;
  expiresAt: string;
  secret: string;
}

type _TokenPayload = TokenPayload;

export interface CosAcceptV1 {
  type: 'cos.accept.v1';
  inviteId: string;
  inviteSecret: string;
  fromInboxId: string;
  fromAddress?: string;
  nonce: string;
}

export interface CosConfirmV1 {
  type: 'cos.confirm.v1';
  inviteId: string;
  connectionId: string;
  pairId: string;
  fromInboxId: string;
  fromAddress?: string;
  replyToNonce: string;
}

export interface CosAppJsonV1<T = unknown> {
  type: 'cos.app.json.v1';
  value: T;
}
