import type { ConeConversation, ConeStore, ConeStoreMetadata, ConeStoreSnapshot, Contact, StoredMessage, OutboxEntry, PendingMessageOptions, SentMessage } from './types';
import { contactMatchesName } from './validation';

export class MemoryStore implements ConeStore {
  private readonly conversationsById = new Map<string, ConeConversation>();
  private readonly contactsById = new Map<string, Contact>();
  private readonly messagesById = new Map<string, StoredMessage>();
  private readonly processedMessageIds = new Set<string>();
  private metadata: ConeStoreMetadata = {};
  private readonly acknowledgements = new Map<string, Set<string>>();
  private readonly outbox = new Map<string, OutboxEntry>();

  listPendingMessages(options: PendingMessageOptions): Promise<StoredMessage[]> {
    const acknowledged = this.acknowledgements.get(options.consumer);
    return Promise.resolve([...this.messagesById.values()]
      .filter(message => !acknowledged?.has(message.messageId) &&
        options.conversationIds.includes(message.conversationId) &&
        !options.excludeConversationIds?.includes(message.networkConversationId ?? message.conversationId) &&
        !options.excludeSenderInboxIds.includes(message.senderInboxId) &&
        (message.seq ?? 0) > (options.afterSeq ?? 0))
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).slice(0, options.limit));
  }

  acknowledgeMessages(consumer: string, messageIds: string[]): Promise<void> {
    const ids = this.acknowledgements.get(consumer) ?? new Set<string>();
    for (const id of messageIds) ids.add(id);
    this.acknowledgements.set(consumer, ids);
    return Promise.resolve();
  }

  prepareSend(entry: OutboxEntry): Promise<OutboxEntry> {
    if (!this.outbox.has(entry.key)) this.outbox.set(entry.key, entry);
    return Promise.resolve(this.outbox.get(entry.key)!);
  }

  settleSend(key: string, sent: SentMessage): Promise<void> {
    const entry = this.outbox.get(key);
    if (!entry) throw new Error('outbox entry not found');
    this.outbox.set(key, { ...entry, encryptedPayload: undefined, sent });
    return Promise.resolve();
  }

  listPendingSends(): Promise<OutboxEntry[]> {
    return Promise.resolve([...this.outbox.values()].filter(entry => !entry.sent));
  }

  putConversation(conversation: ConeConversation): Promise<void> {
    this.conversationsById.set(conversation.conversationId, conversation);
    return Promise.resolve();
  }

  getConversationById(conversationId: string): Promise<ConeConversation | null> {
    return Promise.resolve(this.conversationsById.get(conversationId) ?? null);
  }

  listConversations(): Promise<ConeConversation[]> {
    return Promise.resolve(
      [...this.conversationsById.values()].sort((a, b) => {
        return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.title.localeCompare(b.title);
      }),
    );
  }

  deleteConversation(conversationId: string): Promise<void> {
    this.conversationsById.delete(conversationId);
    for (const [messageId, message] of this.messagesById) {
      if (message.conversationId === conversationId) {
        this.messagesById.delete(messageId);
      }
    }
    return Promise.resolve();
  }

  putContact(contact: Contact): Promise<void> {
    this.contactsById.set(contact.contactId, contact);
    return Promise.resolve();
  }

  getContactById(contactId: string): Promise<Contact | null> {
    return Promise.resolve(this.contactsById.get(contactId) ?? null);
  }

  getContactByInboxId(inboxId: string): Promise<Contact | null> {
    for (const contact of this.contactsById.values()) {
      if (contact.inboxId === inboxId) {
        return Promise.resolve(contact);
      }
    }
    return Promise.resolve(null);
  }

  getContactByName(name: string): Promise<Contact | null> {
    for (const contact of this.contactsById.values()) {
      if (contactMatchesName(contact, name)) {
        return Promise.resolve(contact);
      }
    }
    return Promise.resolve(null);
  }

  listContacts(): Promise<Contact[]> {
    return Promise.resolve([...this.contactsById.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }

  deleteContact(contactId: string): Promise<void> {
    this.contactsById.delete(contactId);
    return Promise.resolve();
  }

  private nextSeq = 1;

  putMessage(message: StoredMessage): Promise<void> {
    // Ingestion order is store-assigned and survives updates (re-keying a
    // message during duplicate-DM collapse must not make it "new" again).
    const seq = this.messagesById.get(message.messageId)?.seq ?? this.nextSeq++;
    this.messagesById.set(message.messageId, { ...message, seq });
    return Promise.resolve();
  }

  listMessages(conversationId?: string): Promise<StoredMessage[]> {
    const messages = [...this.messagesById.values()];
    return Promise.resolve(
      messages
        .filter((message) => conversationId === undefined || message.conversationId === conversationId)
        .sort((a, b) => a.sentAt.localeCompare(b.sentAt)),
    );
  }

  // Deletes the stored payload only; the processed-message marker is kept so
  // the message cannot be re-ingested (e.g. an expired message still present
  // in the XMTP-level DB on the next sync).
  deleteMessage(messageId: string): Promise<void> {
    this.messagesById.delete(messageId);
    return Promise.resolve();
  }

  markMessageProcessed(messageId: string): Promise<boolean> {
    if (this.processedMessageIds.has(messageId)) {
      return Promise.resolve(false);
    }

    this.processedMessageIds.add(messageId);
    return Promise.resolve(true);
  }

  getMetadata(): Promise<ConeStoreMetadata> {
    return Promise.resolve({ ...this.metadata });
  }

  updateDeniedInboxId(inboxId: string, denied: boolean): Promise<void> {
    const ids = new Set(this.metadata.deniedInboxIds ?? []);
    if (denied) ids.add(inboxId); else ids.delete(inboxId);
    this.metadata = { ...this.metadata, deniedInboxIds: [...ids].sort() };
    return Promise.resolve();
  }

  putMetadata(metadata: ConeStoreMetadata): Promise<void> {
    this.metadata = { ...this.metadata, ...metadata };
    return Promise.resolve();
  }

  exportSnapshot(): Promise<ConeStoreSnapshot> {
    return Promise.resolve({
      contacts: [...this.contactsById.values()],
      conversations: [...this.conversationsById.values()],
      metadata: { ...this.metadata },
      messages: [...this.messagesById.values()],
      processedMessageIds: [...this.processedMessageIds],
      acknowledgements: [...this.acknowledgements].flatMap(([consumer, ids]) => [...ids].map(messageId => ({ consumer, messageId }))),
      outbox: [...this.outbox.values()],
    });
  }

  // Snapshots come from user-supplied backups, so every collection is treated
  // as optional even though the type says otherwise.
  importSnapshot(snapshot: ConeStoreSnapshot): Promise<void> {
    for (const contact of snapshot.contacts ?? []) {
      this.contactsById.set(contact.contactId, contact);
    }
    for (const conversation of snapshot.conversations ?? []) {
      this.conversationsById.set(conversation.conversationId, conversation);
    }
    this.metadata = { ...this.metadata, ...snapshot.metadata };
    for (const message of snapshot.messages ?? []) {
      const seq = this.messagesById.get(message.messageId)?.seq ?? this.nextSeq++;
      this.messagesById.set(message.messageId, { ...message, seq });
    }
    for (const messageId of snapshot.processedMessageIds ?? []) {
      this.processedMessageIds.add(messageId);
    }
    for (const ack of snapshot.acknowledgements ?? []) this.acknowledgeMessages(ack.consumer, [ack.messageId]);
    for (const entry of snapshot.outbox ?? []) if (!this.outbox.has(entry.key)) this.outbox.set(entry.key, entry);
    return Promise.resolve();
  }
}
