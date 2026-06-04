import type { ConeStore, ConeStoreSnapshot, Contact, StoredMessage } from './types';
import { contactMatchesName } from './validation';

export class MemoryStore implements ConeStore {
  private readonly contactsById = new Map<string, Contact>();
  private readonly messagesById = new Map<string, StoredMessage>();
  private readonly processedMessageIds = new Set<string>();

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

  exportSnapshot(): Promise<ConeStoreSnapshot> {
    return Promise.resolve({
      contacts: [...this.contactsById.values()],
      messages: [...this.messagesById.values()],
      processedMessageIds: [...this.processedMessageIds],
    });
  }

  importSnapshot(snapshot: ConeStoreSnapshot): Promise<void> {
    for (const contact of snapshot.contacts) {
      this.contactsById.set(contact.contactId, contact);
    }
    for (const message of snapshot.messages) {
      this.messagesById.set(message.messageId, message);
    }
    for (const messageId of snapshot.processedMessageIds) {
      this.processedMessageIds.add(messageId);
    }
    return Promise.resolve();
  }
}
