// Shared XmtpAdapter implementation for the XMTP node and browser SDKs.
// The two SDKs expose the same conversation/message surface with small
// differences (sync vs async methods, peerInboxId as property vs method),
// so each adapter package supplies a created SDK client plus a tiny bridge
// and everything else lives here, SDK-agnostic.
//
// Imported as `@cone/core/xmtp` by adapter packages only; apps use the main
// `@cone/core` entry.

import { normalizeDeliveryStatus } from './display';
import { isEvmAddress } from './validation';
import type {
  ConeConversation,
  ConeIdentity,
  IdentityRef,
  IncomingMessage,
  MessageHandler,
  MessageListOptions,
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

// Structural view of an SDK DM conversation. peerInboxId is intentionally
// absent: it is a property on node DMs and an async method on browser DMs,
// so the bridge resolves it.
export interface SdkDm {
  id: string;
  topic?: string;
  createdAt?: Date;
  sendText(text: string): Promise<string>;
  messages(options?: Record<string, unknown>): Promise<unknown[]>;
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
    }): Promise<{ return(): unknown }>;
    syncAll(): Promise<unknown>;
    listDms(): MaybePromise<SdkDm[]>;
    getConversationById(conversationId: string): MaybePromise<SdkDm | null | undefined>;
    fetchDmByIdentifier(identifier: SdkIdentifier): MaybePromise<SdkDm | null | undefined>;
    createDmWithIdentifier(identifier: SdkIdentifier): Promise<SdkDm>;
    getDmByInboxId(inboxId: string): MaybePromise<SdkDm | null | undefined>;
    createDm(inboxId: string): Promise<SdkDm>;
  };
  fetchInboxIdByIdentifier(identifier: SdkIdentifier): MaybePromise<string | null | undefined>;
  canMessage(identifiers: SdkIdentifier[]): Promise<Map<string, boolean>>;
  close(): MaybePromise<unknown>;
}

export interface SdkXmtpAdapterOptions {
  client: SdkClient;
  env: XmtpEnv;
  /** Lowercase EVM address of this account. */
  address: string;
  /** The SDK's IdentifierKind.Ethereum value. */
  ethereumIdentifierKind: unknown;
  /** Resolves a DM's peer inbox ID (property on node, async method on browser). */
  peerInboxId(dm: SdkDm): MaybePromise<string>;
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

  async streamMessages(handler: MessageHandler): Promise<Unsubscribe> {
    const stream = await this.client.conversations.streamAllMessages({
      onValue: (message: unknown) => {
        if (isDelivered(message)) {
          void handler(toIncomingMessage(message));
        }
      },
      onError: (error: unknown) => {
        console.error(error);
      },
    });

    return () => {
      void stream.return();
    };
  }

  async sync(): Promise<XmtpSyncResult> {
    await this.client.conversations.syncAll();
    const dms = await this.client.conversations.listDms();
    const conversations = await Promise.all(dms.map((dm) => this.toConeConversation(dm)));
    const messages = (await Promise.all(dms.map((dm) => dm.messages())))
      .flat()
      .filter(isDelivered)
      .map(toIncomingMessage);
    return { conversations, messages };
  }

  async listConversations(): Promise<ConeConversation[]> {
    const dms = await this.client.conversations.listDms();
    return Promise.all(dms.map((dm) => this.toConeConversation(dm)));
  }

  async listMessages(conversationId: string, options?: MessageListOptions): Promise<IncomingMessage[]> {
    const conversation = await this.client.conversations.getConversationById(conversationId);
    if (!conversation) {
      return [];
    }
    const messages = await conversation.messages(toSdkMessageOptions(options ?? {}));
    return messages.filter(isDelivered).map(toIncomingMessage);
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

  private async toConeConversation(dm: SdkDm): Promise<ConeConversation> {
    const peerInboxId = await this.options.peerInboxId(dm);
    return {
      conversationId: dm.id,
      peerInboxId,
      title: peerInboxId,
      updatedAt: dm.createdAt?.toISOString(),
    };
  }
}

// Keep the local read model to messages that actually published. A send that
// failed to publish lingers in the XMTP DB as unpublished/failed; without this
// it would later sync in and masquerade as delivered.
function isDelivered(message: unknown): boolean {
  return normalizeDeliveryStatus((message as { deliveryStatus?: unknown }).deliveryStatus) === 'published';
}

function toIncomingMessage(message: unknown): IncomingMessage {
  const record = message as Record<string, unknown>;
  const content = record.content;
  let json: unknown;
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        json = parsed;
      }
    } catch {
      json = undefined;
    }
  }

  return {
    messageId: String(record.id ?? crypto.randomUUID()),
    conversationId: String(record.conversationId ?? record.topic ?? 'unknown'),
    senderInboxId: String(record.senderInboxId ?? record.sender ?? 'unknown'),
    senderAddress: typeof record.senderAddress === 'string' ? record.senderAddress : undefined,
    sentAt: record.sentAt instanceof Date ? record.sentAt.toISOString() : nsToIso(record.sentAtNs) ?? new Date().toISOString(),
    text: typeof content === 'string' ? content : undefined,
    json,
    raw: {
      contentType: String(record.contentType ?? 'unknown'),
      conversationId: String(record.conversationId ?? record.topic ?? 'unknown'),
      messageId: String(record.id ?? 'unknown'),
    },
  };
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
