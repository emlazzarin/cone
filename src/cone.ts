import type { Agent, MessageContext } from '@xmtp/agent-sdk';

import { decodeToken, encodeToken } from './token';
import type {
  Cone,
  ConeStore,
  Connection,
  ConnectionRef,
  CosAcceptV1,
  CosAppJsonV1,
  CosConfirmV1,
  CreateInviteOptions,
  Invite,
  JsonMessageEvent,
  LocalIdentity,
  SentMessage,
  StoredConnection,
  StoredInvite,
  TextMessageEvent,
  Unsubscribe,
} from './types';

type ConeEventMap = {
  'connection:active': [connection: Connection];
  'message:text': [event: TextMessageEvent];
  'message:json': [event: JsonMessageEvent<unknown>];
};

type ConeListener<T extends keyof ConeEventMap> = (...args: ConeEventMap[T]) => void;

export class ConeImpl implements Cone {
  private readonly listeners: { [K in keyof ConeEventMap]: Set<ConeListener<K>> } = {
    'connection:active': new Set(),
    'message:text': new Set(),
    'message:json': new Set(),
  };

  constructor(
    private readonly agent: Agent,
    private readonly store: ConeStore,
    private readonly inviteExpiryMs: number,
    private readonly handshakeTimeoutMs: number,
  ) {}

  get self(): LocalIdentity {
    return {
      inboxId: this.agent.client.inboxId,
      address: this.agent.address,
    };
  }

  async createInvite(options?: CreateInviteOptions): Promise<Invite> {
    const inviteId = crypto.randomUUID();
    const pairId = crypto.randomUUID();
    const inviteSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
    const secretHash = await sha256Hex(inviteSecret);
    const expiresAt = new Date(Date.now() + (options?.expiresInMs ?? this.inviteExpiryMs)).toISOString();
    const env = this.agent.client.options && 'env' in this.agent.client.options
      ? this.agent.client.options.env ?? 'dev'
      : this.agent.client.env;

    const storedInvite: StoredInvite = {
      inviteId,
      pairId,
      label: options?.label,
      inviterInboxId: this.agent.client.inboxId,
      inviterAddress: this.agent.address,
      env,
      expiresAt,
      secretHash,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await this.store.putInvite(storedInvite);

    const token = encodeToken({
      inviteId,
      pairId,
      inviterInboxId: storedInvite.inviterInboxId,
      inviterAddress: storedInvite.inviterAddress,
      env: storedInvite.env,
      expiresAt,
      secret: inviteSecret,
    });

    return {
      inviteId,
      token,
      expiresAt,
      inviter: this.self,
    };
  }

  async acceptInvite(token: string): Promise<Connection> {
    const payload = decodeToken(token);
    const dm = await this.agent.client.conversations.createDm(payload.inviterInboxId);
    const nonce = crypto.randomUUID();

    const acceptMsg: CosAcceptV1 = {
      type: 'cos.accept.v1',
      inviteId: payload.inviteId,
      inviteSecret: payload.secret,
      fromInboxId: this.agent.client.inboxId,
      fromAddress: this.agent.address,
      nonce,
    };

    await dm.sendText(JSON.stringify(acceptMsg));

    const deadline = Date.now() + this.handshakeTimeoutMs;
    const sentAtNs = BigInt(Date.now()) * 1_000_000n;

    while (Date.now() < deadline) {
      const messages = await dm.messages({ sentAfterNs: sentAtNs });

      for (const msg of messages) {
        if (typeof msg.content !== 'string') {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(msg.content);
        } catch {
          continue;
        }

        if (!isRecord(parsed) || parsed.type !== 'cos.confirm.v1') {
          continue;
        }

        if (!isCosConfirmV1(parsed)) {
          continue;
        }

        const confirm = parsed;
        if (confirm.inviteId !== payload.inviteId) {
          continue;
        }
        if (confirm.replyToNonce !== nonce) {
          continue;
        }
        if (msg.senderInboxId !== payload.inviterInboxId) {
          continue;
        }

        const now = new Date().toISOString();
        const connection: StoredConnection = {
          connectionId: confirm.connectionId,
          pairId: confirm.pairId,
          status: 'active',
          peerInboxId: msg.senderInboxId,
          peerAddress: confirm.fromAddress,
          conversationId: dm.id,
          createdAt: now,
          activatedAt: now,
        };

        await this.store.putConnection(connection);
        return toPublicConnection(connection);
      }

      await sleep(500);
    }

    throw new Error('handshake timeout');
  }

  async handleMessage(ctx: MessageContext): Promise<boolean> {
    const isNew = await this.store.markMessageProcessed(ctx.message.id);
    if (!isNew) {
      return true;
    }

    if (!ctx.isText()) {
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(ctx.message.content);
    } catch {
      parsed = undefined;
    }

    if (isRecord(parsed) && parsed.type === 'cos.accept.v1') {
      if (!isCosAcceptV1(parsed)) {
        return false;
      }

      const accept = parsed;
      const invite = await this.store.getInvite(accept.inviteId);

      if (!invite) {
        return false;
      }
      if (invite.status !== 'pending') {
        return true;
      }
      if (Date.parse(invite.expiresAt) < Date.now()) {
        return false;
      }

      const secretHash = await sha256Hex(accept.inviteSecret);
      if (secretHash !== invite.secretHash) {
        return false;
      }

      const connectionId = crypto.randomUUID();
      const now = new Date().toISOString();
      const connection: StoredConnection = {
        connectionId,
        pairId: invite.pairId,
        status: 'active',
        peerInboxId: ctx.message.senderInboxId,
        peerAddress: accept.fromAddress,
        conversationId: ctx.conversation.id,
        createdAt: now,
        activatedAt: now,
      };

      await this.store.putConnection(connection);
      await this.store.consumeInvite(invite.inviteId, {
        inboxId: ctx.message.senderInboxId,
        address: accept.fromAddress,
      });

      const confirm: CosConfirmV1 = {
        type: 'cos.confirm.v1',
        inviteId: accept.inviteId,
        connectionId,
        pairId: invite.pairId,
        fromInboxId: this.agent.client.inboxId,
        fromAddress: this.agent.address,
        replyToNonce: accept.nonce,
      };

      await ctx.conversation.sendText(JSON.stringify(confirm));
      this.emit('connection:active', toPublicConnection(connection));
      return true;
    }

    if (isRecord(parsed) && parsed.type === 'cos.confirm.v1') {
      return true;
    }

    if (isRecord(parsed) && parsed.type === 'cos.app.json.v1') {
      const stored = await this.store.getConnectionByInboxId(ctx.message.senderInboxId);
      if (!stored || stored.status !== 'active') {
        return false;
      }

      if (!isCosAppJsonV1(parsed)) {
        return false;
      }

      const wrapped = parsed;
      this.emit('message:json', {
        connection: toPublicConnection(stored),
        value: wrapped.value,
        messageId: ctx.message.id,
        sentAt: nsToIso(ctx.message.sentAtNs),
      });
      return true;
    }

    const stored = await this.store.getConnectionByInboxId(ctx.message.senderInboxId);
    if (!stored || stored.status !== 'active') {
      return false;
    }

    this.emit('message:text', {
      connection: toPublicConnection(stored),
      text: ctx.message.content,
      messageId: ctx.message.id,
      sentAt: nsToIso(ctx.message.sentAtNs),
    });
    return true;
  }

  extractInviteToken(text: string): string | null {
    const match = /cos:invite:v1:[A-Za-z0-9_-]+/.exec(text);
    return match?.[0] ?? null;
  }

  renderInviteInstructions(invite: Invite): string {
    return `Cone of Silence invite\nToken: ${invite.token}\nExpires: ${invite.expiresAt}\n\nTo accept, tell your agent:\n  accept this invite: ${invite.token}`;
  }

  async listConnections(): Promise<Connection[]> {
    const stored = await this.store.listConnections();
    return stored.map(toPublicConnection);
  }

  async getConnection(ref: ConnectionRef): Promise<Connection | null> {
    let stored: StoredConnection | null;
    if ('connectionId' in ref) {
      stored = await this.store.getConnectionById(ref.connectionId);
    } else {
      stored = await this.store.getConnectionByInboxId(ref.peerInboxId);
    }

    return stored ? toPublicConnection(stored) : null;
  }

  async sendText(ref: ConnectionRef, text: string): Promise<SentMessage> {
    const connection = await this.getConnection(ref);
    if (!connection || connection.status !== 'active') {
      throw new Error('connection not found or inactive');
    }

    const dm = await this.agent.client.conversations.createDm(connection.peerInboxId);
    const messageId = await dm.sendText(text);
    return { id: messageId, sentAt: new Date().toISOString() };
  }

  async sendJson<T>(ref: ConnectionRef, value: T): Promise<SentMessage> {
    const connection = await this.getConnection(ref);
    if (!connection || connection.status !== 'active') {
      throw new Error('connection not found or inactive');
    }

    const dm = await this.agent.client.conversations.createDm(connection.peerInboxId);
    const wrapper: CosAppJsonV1<T> = { type: 'cos.app.json.v1', value };
    const messageId = await dm.sendText(JSON.stringify(wrapper));
    return { id: messageId, sentAt: new Date().toISOString() };
  }

  on(event: 'connection:active', listener: (c: Connection) => void): Unsubscribe;
  on(event: 'message:text', listener: (e: TextMessageEvent) => void): Unsubscribe;
  on(event: 'message:json', listener: (e: JsonMessageEvent<unknown>) => void): Unsubscribe;
  on<T extends keyof ConeEventMap>(event: T, listener: ConeListener<T>): Unsubscribe {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  private emit<T extends keyof ConeEventMap>(event: T, ...args: ConeEventMap[T]): void {
    for (const listener of this.listeners[event]) {
      listener(...args);
    }
  }
}

function toPublicConnection(s: StoredConnection): Connection {
  return {
    connectionId: s.connectionId,
    pairId: s.pairId,
    status: s.status,
    peerInboxId: s.peerInboxId,
    peerAddress: s.peerAddress,
    alias: s.alias,
    conversationId: s.conversationId,
    createdAt: s.createdAt,
    activatedAt: s.activatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCosAcceptV1(value: unknown): value is CosAcceptV1 {
  return isRecord(value)
    && value.type === 'cos.accept.v1'
    && typeof value.inviteId === 'string'
    && typeof value.inviteSecret === 'string'
    && typeof value.fromInboxId === 'string'
    && (value.fromAddress === undefined || typeof value.fromAddress === 'string')
    && typeof value.nonce === 'string';
}

function isCosConfirmV1(value: unknown): value is CosConfirmV1 {
  return isRecord(value)
    && value.type === 'cos.confirm.v1'
    && typeof value.inviteId === 'string'
    && typeof value.connectionId === 'string'
    && typeof value.pairId === 'string'
    && typeof value.fromInboxId === 'string'
    && (value.fromAddress === undefined || typeof value.fromAddress === 'string')
    && typeof value.replyToNonce === 'string';
}

function isCosAppJsonV1(value: unknown): value is CosAppJsonV1<unknown> {
  return isRecord(value) && value.type === 'cos.app.json.v1' && 'value' in value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function nsToIso(sentAtNs: bigint): string {
  return new Date(Number(sentAtNs / 1_000_000n)).toISOString();
}
