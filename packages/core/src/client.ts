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
import type {
  ConeClient,
  ConeConversation,
  ConeIdentity,
  ConeMessage,
  Contact,
  CreateConeClientOptions,
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
    return sent;
  }

  sendJson(to: IdentityRef, value: unknown): Promise<SentMessage> {
    return this.sendText(to, JSON.stringify({ type: APP_JSON_TYPE, value }));
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

  async streamMessages(handler: (message: IncomingMessage) => void | Promise<void>): Promise<Unsubscribe> {
    await this.options.store.putMetadata({ lastStreamStartedAt: this.nowIso() });
    return this.options.xmtp.streamMessages(async (message) => {
      const isNew = await this.options.store.markMessageProcessed(message.messageId);
      if (!isNew) {
        return;
      }

      await this.persistNetworkMessage(message);
      await handler(message);
    });
  }

  async sync(): Promise<SyncResult> {
    const startedAt = this.nowIso();
    let conversationsSynced = 0;
    let messagesSynced = 0;
    const errors: string[] = [];

    try {
      const result = await this.options.xmtp.sync();
      for (const conversation of result.conversations) {
        await this.options.store.putConversation(conversation);
        conversationsSynced += 1;
      }
      for (const message of result.messages) {
        const isNew = await this.options.store.markMessageProcessed(message.messageId);
        await this.persistNetworkMessage(message);
        if (isNew) {
          messagesSynced += 1;
        }
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

  async listConversations(): Promise<ConeConversation[]> {
    const [conversations, contacts] = await Promise.all([
      this.options.store.listConversations(),
      this.options.store.listContacts(),
    ]);
    const contactsByInbox = new Map(contacts.map((contact) => [contact.inboxId, contact]));

    return conversations.map((conversation) => {
      const contact = contactsByInbox.get(conversation.peerInboxId);
      return {
        ...conversation,
        contactId: contact?.contactId ?? conversation.contactId,
        title: contact?.name ?? conversation.title,
      };
    });
  }

  async listMessages(conversationId?: string): Promise<ConeMessage[]> {
    const [identity, messages] = await Promise.all([
      this.identity(),
      this.options.store.listMessages(conversationId),
    ]);

    return Promise.all(messages.map(async (message) => {
      const payload = await decryptJson<unknown>(this.options.account.coneStorageKey, message.encryptedPayload);
      const kind = message.kind === 'json' && isControlEnvelope(payload) ? 'control' : message.kind;
      return {
        conversationId: message.conversationId,
        direction: message.senderInboxId === identity.inboxId ? 'outbound' as const : 'inbound' as const,
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
    return contact;
  }

  deleteContact(contactId: string): Promise<void> {
    return this.options.store.deleteContact(contactId);
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

  private async maybeCreateInboundContact(message: IncomingMessage): Promise<void> {
    const identity = await this.identity();
    if (message.senderInboxId === identity.inboxId) {
      return;
    }
    const existing = await this.options.store.getContactByInboxId(message.senderInboxId);
    if (existing) {
      return;
    }
    await this.saveContact({
      name: message.senderAddress ?? message.senderInboxId,
      inboxId: message.senderInboxId,
      address: message.senderAddress,
      source: 'inbound',
    });
  }

  private async persistOutbound(sent: SentMessage, resolved: ResolvedIdentity, kind: StoredMessage['kind'], payload: unknown) {
    const identity = await this.identity();
    const conversationId = sent.conversationId ?? `dm:${resolved.inboxId}`;
    await this.options.store.putConversation({
      conversationId,
      peerAddress: resolved.address,
      peerInboxId: resolved.inboxId,
      title: resolved.displayName ?? resolved.address ?? resolved.inboxId,
      updatedAt: sent.sentAt,
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
    await this.maybeCreateInboundContact(message);
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
    const peerInboxId = existing?.peerInboxId ?? message.senderInboxId;
    const contact = await this.options.store.getContactByInboxId(peerInboxId);
    await this.options.store.putConversation({
      conversationId: message.conversationId,
      contactId: contact?.contactId ?? existing?.contactId,
      peerAddress: contact?.address ?? message.senderAddress ?? existing?.peerAddress,
      peerInboxId,
      title: contact?.name ?? existing?.title ?? message.senderAddress ?? peerInboxId,
      updatedAt: laterIso(existing?.updatedAt, message.sentAt),
      unreadCount: existing?.unreadCount,
      lastReadAt: existing?.lastReadAt,
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
