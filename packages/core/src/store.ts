import type { ConeConversation, ConeStore, ConeStoreMetadata, ConeStoreSnapshot, Contact, StoredMessage } from './types';
import { contactMatchesName } from './validation';

export class MemoryStore implements ConeStore {
  private readonly conversationsById = new Map<string, ConeConversation>();
  private readonly contactsById = new Map<string, Contact>();
  private readonly messagesById = new Map<string, StoredMessage>();
  private readonly processedMessageIds = new Set<string>();
  private metadata: ConeStoreMetadata = {};

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

  putMessage(message: StoredMessage): Promise<void> {
    this.messagesById.set(message.messageId, message);
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
    });
  }

  importSnapshot(snapshot: ConeStoreSnapshot): Promise<void> {
    for (const contact of snapshot.contacts) {
      this.contactsById.set(contact.contactId, contact);
    }
    for (const conversation of snapshot.conversations ?? []) {
      this.conversationsById.set(conversation.conversationId, conversation);
    }
    this.metadata = { ...this.metadata, ...snapshot.metadata };
    for (const message of snapshot.messages) {
      this.messagesById.set(message.messageId, message);
    }
    for (const messageId of snapshot.processedMessageIds) {
      this.processedMessageIds.add(messageId);
    }
    return Promise.resolve();
  }
}
