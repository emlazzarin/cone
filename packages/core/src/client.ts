import { bytesToUtf8, utf8ToBytes } from './encoding';
import { codeScopedKey, decryptBytes, decryptJson, encryptBytes, encryptJson, randomId } from './crypto';
import { createEncryptedPairingOffer, createHandshakeCode as createCode } from './pairing';
import type {
  ConeClient,
  ConeConversation,
  ConeIdentity,
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

  async sendJson(to: IdentityRef, value: unknown): Promise<SentMessage> {
    const envelope = { type: 'cos.app.json.v1', value };
    const sent = await this.sendText(to, JSON.stringify(envelope));
    return sent;
  }

  async streamMessages(handler: (message: IncomingMessage) => void | Promise<void>): Promise<Unsubscribe> {
    return this.options.xmtp.streamMessages(async (message) => {
      const isNew = await this.options.store.markMessageProcessed(message.messageId);
      if (!isNew) {
        return;
      }

      await this.maybeCreateInboundContact(message);
      await this.persistInbound(message);
      await handler(message);
    });
  }

  async listConversations(): Promise<ConeConversation[]> {
    const [conversations, contacts] = await Promise.all([
      this.options.xmtp.listConversations(),
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

  listContacts(): Promise<Contact[]> {
    return this.options.store.listContacts();
  }

  async saveContact(input: SaveContactInput): Promise<Contact> {
    assertValidContactInput(input);
    const now = this.nowIso();
    const resolved = input.inboxId
      ? { inboxId: input.inboxId, address: input.address, source: 'inboxId' as const }
      : await this.resolveIdentity({ address: input.address });
    const existing = await this.options.store.getContactByInboxId(resolved.inboxId);
    const contact: Contact = {
      contactId: existing?.contactId ?? randomId('contact'),
      name: normalizeContactName(input.name),
      inboxId: resolved.inboxId,
      address: input.address ?? resolved.address,
      notes: input.notes,
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

    const identity = await this.identity();
    const deadline = this.now().getTime() + (options.timeoutMs ?? 60_000);
    const localOffer = await createEncryptedPairingOffer({
      account: this.options.account,
      code,
      identity,
      proposedName: options.proposedName,
      now: this.now(),
    });
    let peer = null;

    while (this.now().getTime() < deadline) {
      const offers = await this.options.rendezvous.exchangeOffer({
          code,
          encryptedOffer: localOffer.encryptedOffer,
          expiresAt: new Date(this.now().getTime() + 10 * 60 * 1000).toISOString(),
          participantId: localOffer.participantId,
        });

      for (const offer of offers) {
        if (offer.participantId === localOffer.participantId) {
          continue;
        }
        try {
          const candidate = await decryptJson<PairingOffer>(
            codeScopedKey(this.options.account.pairingKey, code),
            offer.encryptedOffer,
          );
          if (candidate.env === identity.env && candidate.inboxId !== identity.inboxId) {
            peer = candidate;
            break;
          }
        } catch {
          continue;
        }
      }

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
          type: 'cos.pair.confirm.v1',
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
    return utf8ToBytes(JSON.stringify({ type: 'cos.backup.v1', encrypted }));
  }

  async importBackup(data: Uint8Array): Promise<void> {
    const parsed = JSON.parse(bytesToUtf8(data)) as { type?: string; encrypted?: unknown };
    if (parsed.type !== 'cos.backup.v1' || !parsed.encrypted) {
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
    await this.options.store.putMessage({
      messageId: sent.messageId,
      conversationId: sent.conversationId ?? `dm:${resolved.inboxId}`,
      senderInboxId: identity.inboxId,
      recipientInboxId: resolved.inboxId,
      sentAt: sent.sentAt,
      kind,
      encryptedPayload: await encryptJson(this.options.account.coneStorageKey, 'cone.message.v1', payload),
    });
  }

  private async persistInbound(message: IncomingMessage): Promise<void> {
    const kind = message.json === undefined ? 'text' : 'json';
    await this.options.store.putMessage({
      messageId: message.messageId,
      conversationId: message.conversationId,
      senderInboxId: message.senderInboxId,
      sentAt: message.sentAt,
      kind,
      encryptedPayload: await encryptJson(
        this.options.account.coneStorageKey,
        'cone.message.v1',
        message.json ?? message.text ?? message.raw,
      ),
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
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
