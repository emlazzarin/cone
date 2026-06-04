import {
  decryptJson,
  encryptJson,
  MemoryStore,
  type ConeStore,
  type ConeStoreSnapshot,
  type Contact,
  type StoredMessage,
} from '@cone/core';

const STORE_NAME = 'encrypted-state';
const SNAPSHOT_KEY = 'snapshot';

export class IndexedDbStore implements ConeStore {
  private readonly memory = new MemoryStore();
  private loaded = false;

  constructor(
    private readonly dbName: string,
    private readonly storageKey: Uint8Array,
  ) {}

  async putContact(contact: Contact): Promise<void> {
    await this.load();
    await this.memory.putContact(contact);
    await this.save();
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    await this.load();
    return this.memory.getContactById(contactId);
  }

  async getContactByInboxId(inboxId: string): Promise<Contact | null> {
    await this.load();
    return this.memory.getContactByInboxId(inboxId);
  }

  async getContactByName(name: string): Promise<Contact | null> {
    await this.load();
    return this.memory.getContactByName(name);
  }

  async listContacts(): Promise<Contact[]> {
    await this.load();
    return this.memory.listContacts();
  }

  async deleteContact(contactId: string): Promise<void> {
    await this.load();
    await this.memory.deleteContact(contactId);
    await this.save();
  }

  async putMessage(message: StoredMessage): Promise<void> {
    await this.load();
    await this.memory.putMessage(message);
    await this.save();
  }

  async listMessages(conversationId?: string): Promise<StoredMessage[]> {
    await this.load();
    return this.memory.listMessages(conversationId);
  }

  async markMessageProcessed(messageId: string): Promise<boolean> {
    await this.load();
    const isNew = await this.memory.markMessageProcessed(messageId);
    if (isNew) {
      await this.save();
    }
    return isNew;
  }

  async exportSnapshot(): Promise<ConeStoreSnapshot> {
    await this.load();
    return this.memory.exportSnapshot();
  }

  async importSnapshot(snapshot: ConeStoreSnapshot): Promise<void> {
    await this.load();
    await this.memory.importSnapshot(snapshot);
    await this.save();
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const db = await openDb(this.dbName);
    const record = await idbGet<unknown>(db, SNAPSHOT_KEY);
    if (record) {
      const snapshot = await decryptJson<ConeStoreSnapshot>(this.storageKey, record as never);
      await this.memory.importSnapshot(snapshot);
    }
    db.close();
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const snapshot = await this.memory.exportSnapshot();
    const encrypted = await encryptJson(this.storageKey, 'cone.indexeddb.snapshot.v1', snapshot);
    const db = await openDb(this.dbName);
    await idbPut(db, SNAPSHOT_KEY, encrypted);
    db.close();
  }
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve();
    tx.objectStore(STORE_NAME).put(value, key);
  });
}
