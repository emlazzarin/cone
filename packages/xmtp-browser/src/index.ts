import { hexToBytes, type ConeConversation, type DerivedAccount, type IdentityRef, type IncomingMessage, type MessageHandler, type ResolvedIdentity, type SentMessage, type Unsubscribe, type XmtpAdapter, type XmtpEnv } from '@cone/core';
import { privateKeyToAccount } from 'viem/accounts';

export { IndexedDbStore } from './store';

export interface BrowserXmtpAdapterOptions {
  account: DerivedAccount;
}

export async function createBrowserXmtpAdapter(options: BrowserXmtpAdapterOptions): Promise<XmtpAdapter> {
  const sdk = await import('@xmtp/browser-sdk');
  const client = await createClient(sdk, options);
  return new BrowserXmtpAdapter(client, options.account.env);
}

class BrowserXmtpAdapter implements XmtpAdapter {
  constructor(
    private readonly client: BrowserClientLike,
    private readonly env: XmtpEnv,
  ) {}

  identity() {
    return Promise.resolve({
      inboxId: String(this.client.inboxId),
      address: typeof this.client.address === 'string' ? this.client.address : undefined,
      env: this.env,
    });
  }

  async resolveIdentity(ref: IdentityRef): Promise<ResolvedIdentity | null> {
    if (typeof ref === 'string') {
      return { inboxId: ref, source: 'inboxId' };
    }
    if (ref.inboxId) {
      return { inboxId: ref.inboxId, address: ref.address, source: 'inboxId' };
    }
    if (ref.address) {
      const inboxId = await findInboxIdForAddress(this.client, ref.address);
      return inboxId ? { inboxId, address: ref.address, source: 'address' } : null;
    }
    return null;
  }

  async canMessage(identity: ResolvedIdentity): Promise<boolean> {
    if (typeof this.client.canMessage !== 'function') {
      return true;
    }
    if (!identity.address) {
      return true;
    }

    try {
      const result = await this.client.canMessage([{ identifier: identity.address.toLowerCase(), identifierKind: 'Ethereum' }]);
      if (typeof result === 'boolean') {
        return result;
      }
      if (result && typeof result === 'object') {
        return Boolean((result as Record<string, unknown>)[identity.address.toLowerCase()] ?? true);
      }
    } catch {
      return false;
    }

    return true;
  }

  async sendText(identity: ResolvedIdentity, text: string): Promise<SentMessage> {
    const dm = await findOrCreateDm(this.client, identity);
    const messageId = await sendConversationText(dm, text);
    return {
      messageId,
      conversationId: String(dm.id ?? dm.topic ?? `dm:${identity.inboxId}`),
      sentAt: new Date().toISOString(),
    };
  }

  async streamMessages(handler: MessageHandler): Promise<Unsubscribe> {
    const conversations = this.client.conversations;
    if (!conversations || typeof conversations.streamAllMessages !== 'function') {
      throw new Error('XMTP client does not support message streaming');
    }

    const stream = await conversations.streamAllMessages({
      onValue: (message: unknown) => {
        void handler(toIncomingMessage(message));
      },
      onError: (error: unknown) => {
        console.error(error);
      },
    }) as StreamLike;

    const returnStream = stream.return;
    if (typeof returnStream === 'function') {
      return () => {
        void returnStream.call(stream);
      };
    }
    const unsubscribe = stream.unsubscribe;
    if (typeof unsubscribe === 'function') {
      return () => {
        void unsubscribe.call(stream);
      };
    }
    return () => undefined;
  }

  async listConversations(): Promise<ConeConversation[]> {
    const conversations = this.client.conversations;
    if (!conversations) {
      return [];
    }

    const raw = typeof conversations.listDms === 'function'
      ? await conversations.listDms()
      : typeof conversations.list === 'function'
        ? await conversations.list()
        : [];

    return (Array.isArray(raw) ? raw : []).map((conversation: ConversationLike) => {
      const peerInboxId = String(
        conversation.peerInboxId ?? conversation.dmPeerInboxId ?? conversation.memberInboxIds?.[0] ?? 'unknown',
      );
      return {
        conversationId: String(conversation.id ?? conversation.topic ?? `dm:${peerInboxId}`),
        peerInboxId,
        title: peerInboxId,
        updatedAt: typeof conversation.updatedAt === 'string' ? conversation.updatedAt : undefined,
      };
    });
  }

  async exportArchive(key: Uint8Array): Promise<Uint8Array> {
    if (typeof this.client.createArchive !== 'function') {
      throw new Error('XMTP client does not support archive export');
    }
    return this.client.createArchive(key);
  }

  async importArchive(data: Uint8Array, key: Uint8Array): Promise<void> {
    if (typeof this.client.importArchive !== 'function') {
      throw new Error('XMTP client does not support archive import');
    }
    await this.client.importArchive(data, key);
  }
}

async function createClient(sdk: Record<string, unknown>, options: BrowserXmtpAdapterOptions): Promise<BrowserClientLike> {
  const Client = sdk.Client as { create?: (signer: unknown, options: Record<string, unknown>) => Promise<BrowserClientLike> };
  if (!Client?.create) {
    throw new Error('@xmtp/browser-sdk Client.create is unavailable');
  }

  const account = privateKeyToAccount(options.account.walletPrivateKey);
  const IdentifierKind = (sdk.IdentifierKind as Record<string, string> | undefined) ?? { Ethereum: 'Ethereum' };
  const signer = {
    type: 'EOA',
    getIdentifier: () => ({
      identifier: account.address.toLowerCase(),
      identifierKind: IdentifierKind.Ethereum ?? 'Ethereum',
    }),
    signMessage: async (message: string) => hexToBytes(await account.signMessage({ message })),
  };

  return Client.create(signer, {
    env: options.account.env,
  });
}

async function findInboxIdForAddress(client: BrowserClientLike, address: string): Promise<string | null> {
  if (typeof client.findInboxIdFromAddress === 'function') {
    return (await client.findInboxIdFromAddress(address.toLowerCase())) ?? null;
  }
  if (typeof client.findInboxIdFromIdentity === 'function') {
    return (await client.findInboxIdFromIdentity({
      identifier: address.toLowerCase(),
      identifierKind: 'Ethereum',
    })) ?? null;
  }
  return null;
}

async function findOrCreateDm(client: BrowserClientLike, identity: ResolvedIdentity): Promise<ConversationLike> {
  const conversations = client.conversations;
  if (!conversations) {
    throw new Error('XMTP client does not expose conversations');
  }

  if (identity.address && typeof conversations.getDmByIdentifier === 'function') {
    return await conversations.getDmByIdentifier({ identifier: identity.address.toLowerCase(), identifierKind: 'Ethereum' }) as ConversationLike;
  }
  if (identity.address && typeof conversations.newDmWithIdentifier === 'function') {
    return await conversations.newDmWithIdentifier({ identifier: identity.address.toLowerCase(), identifierKind: 'Ethereum' }) as ConversationLike;
  }
  if (typeof conversations.createDm === 'function') {
    return await conversations.createDm(identity.inboxId) as ConversationLike;
  }
  if (typeof conversations.findOrCreateDm === 'function') {
    return await conversations.findOrCreateDm(identity.inboxId) as ConversationLike;
  }
  throw new Error('XMTP client cannot create DMs');
}

async function sendConversationText(conversation: ConversationLike, text: string): Promise<string> {
  if (typeof conversation.sendText === 'function') {
    return String(await conversation.sendText(text));
  }
  if (typeof conversation.send === 'function') {
    return String(await conversation.send(text));
  }
  throw new Error('XMTP conversation cannot send text');
}

function toIncomingMessage(message: unknown): IncomingMessage {
  const record = (message ?? {}) as Record<string, unknown>;
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
    sentAt: nsToIso(record.sentAtNs) ?? new Date().toISOString(),
    text: typeof content === 'string' ? content : undefined,
    json,
    raw: message,
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

type BrowserClientLike = {
  address?: string;
  inboxId?: string;
  conversations?: Record<string, (...args: unknown[]) => unknown>;
  canMessage?: (value: unknown) => Promise<unknown>;
  createArchive?: (key: Uint8Array) => Promise<Uint8Array>;
  importArchive?: (data: Uint8Array, key: Uint8Array) => Promise<void>;
  findInboxIdFromAddress?: (address: string) => Promise<string | undefined>;
  findInboxIdFromIdentity?: (identity: { identifier: string; identifierKind: string }) => Promise<string | undefined>;
};

type StreamLike = {
  return?: () => unknown;
  unsubscribe?: () => unknown;
};

type ConversationLike = Record<string, unknown> & {
  id?: string;
  topic?: string;
  peerInboxId?: string;
  dmPeerInboxId?: string;
  memberInboxIds?: string[];
  updatedAt?: string;
  sendText?: (text: string) => Promise<unknown>;
  send?: (text: string) => Promise<unknown>;
};
