import { Client, IdentifierKind, type ClientOptions, type DecodedMessage, type Dm, type Identifier, type XmtpEnv as SdkXmtpEnv } from '@xmtp/node-sdk';
import { hexToBytes, isEvmAddress, type ConeConversation, type DerivedAccount, type IdentityRef, type IncomingMessage, type MessageHandler, type MessageListOptions, type ResolvedIdentity, type SentMessage, type Unsubscribe, type XmtpAdapter, type XmtpEnv, type XmtpSyncResult } from '@cone/core';
import { privateKeyToAccount } from 'viem/accounts';

export interface NodeXmtpAdapterOptions {
  account: DerivedAccount;
  dbPath?: string;
}

export async function createNodeXmtpAdapter(options: NodeXmtpAdapterOptions): Promise<XmtpAdapter> {
  const { address, client } = await createClient(options);
  return new NodeXmtpAdapter(client, options.account.env, address);
}

class NodeXmtpAdapter implements XmtpAdapter {
  constructor(
    private readonly client: Client<unknown>,
    private readonly env: XmtpEnv,
    private readonly address: string,
  ) {}

  identity() {
    return Promise.resolve({
      inboxId: String(this.client.inboxId),
      address: this.address,
      env: this.env,
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
      const inboxId = await this.client.fetchInboxIdByIdentifier(evmIdentifier(ref.address));
      return inboxId ? { inboxId, address: ref.address, source: 'address' } : null;
    }
    return null;
  }

  async canMessage(identity: ResolvedIdentity): Promise<boolean> {
    if (!identity.address) {
      return true;
    }

    const address = identity.address.toLowerCase();
    const result = await this.client.canMessage([evmIdentifier(address)]);
    return result.get(address) === true;
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
    const stream = await this.client.conversations.streamAllMessages({
      onValue: (message: unknown) => {
        void handler(toIncomingMessage(message));
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
    const dms = this.client.conversations.listDms();
    const conversations = dms.map((conversation) => toConeConversation(conversation));
    const messages = (await Promise.all(dms.map((conversation) => listConversationMessages(conversation))))
      .flat()
      .map(toIncomingMessage);
    return { conversations, messages };
  }

  async listConversations(): Promise<ConeConversation[]> {
    const raw = this.client.conversations.listDms();

    return raw.map((conversation) => toConeConversation(conversation));
  }

  async listMessages(conversationId: string, options?: MessageListOptions): Promise<IncomingMessage[]> {
    const conversation = await this.client.conversations.getConversationById(conversationId);
    if (!conversation) {
      return [];
    }
    const messages = await listConversationMessages(conversation, options);
    return messages.map(toIncomingMessage);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function toConeConversation(conversation: Dm<unknown>): ConeConversation {
  return {
    conversationId: conversation.id,
    peerInboxId: conversation.peerInboxId,
    title: conversation.peerInboxId,
    updatedAt: conversation.createdAt?.toISOString(),
  };
}

async function createClient(options: NodeXmtpAdapterOptions): Promise<{ address: string; client: Client<unknown> }> {
  const account = privateKeyToAccount(options.account.walletPrivateKey);
  const address = account.address.toLowerCase();
  const signer = {
    type: 'EOA' as const,
    getIdentifier: () => evmIdentifier(address),
    signMessage: async (message: string) => hexToBytes(await account.signMessage({ message })),
  };

  const clientOptions: ClientOptions = {
    dbEncryptionKey: hexToBytes(options.account.xmtpDbEncryptionKey),
    dbPath: options.dbPath,
    env: options.account.env as SdkXmtpEnv,
  };
  const client = await Client.create(signer, clientOptions);

  return { address, client };
}

function evmIdentifier(address: string): Identifier {
  return {
    identifier: address.toLowerCase(),
    identifierKind: IdentifierKind.Ethereum,
  };
}

async function findOrCreateDm(client: Client<unknown>, identity: ResolvedIdentity): Promise<Dm<unknown>> {
  if (identity.address) {
    const identifier = evmIdentifier(identity.address);
    const existing = await client.conversations.fetchDmByIdentifier(identifier);
    return existing ?? await client.conversations.createDmWithIdentifier(identifier);
  }

  return client.conversations.getDmByInboxId(identity.inboxId) ?? await client.conversations.createDm(identity.inboxId);
}

async function sendConversationText(conversation: Dm<unknown>, text: string): Promise<string> {
  return conversation.sendText(text);
}

async function listConversationMessages(
  conversation: { messages: (options?: Record<string, unknown>) => Promise<Array<DecodedMessage | unknown>> },
  options: MessageListOptions = {},
): Promise<Array<DecodedMessage | unknown>> {
  return conversation.messages(toSdkMessageOptions(options));
}

function toIncomingMessage(message: DecodedMessage | unknown): IncomingMessage {
  const record = message as Partial<DecodedMessage> & Record<string, unknown>;
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
