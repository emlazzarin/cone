import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  ConeConversation,
  ConeStore,
  ConeStoreMetadata,
  ConeStoreSnapshot,
  Contact,
  StoredMessage,
} from '@cone/core';

export class BunSQLiteStore implements ConeStore {
  private readonly db: Database;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath, { create: true });
    this.migrate();
  }

  putConversation(conversation: ConeConversation): Promise<void> {
    this.db
      .query(
        `insert into conversations (conversation_id, peer_inbox_id, title, updated_at, data)
         values (?, ?, ?, ?, ?)
         on conflict(conversation_id) do update set
           peer_inbox_id = excluded.peer_inbox_id,
           title = excluded.title,
           updated_at = excluded.updated_at,
           data = excluded.data`,
      )
      .run(
        conversation.conversationId,
        conversation.peerInboxId,
        conversation.title,
        conversation.updatedAt ?? null,
        JSON.stringify(conversation),
      );
    return Promise.resolve();
  }

  getConversationById(conversationId: string): Promise<ConeConversation | null> {
    const row = this.db.query(`select data from conversations where conversation_id = ? limit 1`).get(conversationId) as DataRow | null;
    return Promise.resolve(row ? parseDataRow<ConeConversation>(row) : null);
  }

  listConversations(): Promise<ConeConversation[]> {
    const rows = this.db
      .query(`select data from conversations order by coalesce(updated_at, '') desc, lower(title) asc`)
      .all() as DataRow[];
    return Promise.resolve(rows.map(parseDataRow<ConeConversation>));
  }

  deleteConversation(conversationId: string): Promise<void> {
    this.db.transaction((target: string) => {
      this.db.query(`delete from messages where conversation_id = ?`).run(target);
      this.db.query(`delete from conversations where conversation_id = ?`).run(target);
    })(conversationId);
    return Promise.resolve();
  }

  putContact(contact: Contact): Promise<void> {
    this.db
      .query(
        `insert into contacts (contact_id, inbox_id, name, address, source, created_at, updated_at, data)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(contact_id) do update set
           inbox_id = excluded.inbox_id,
           name = excluded.name,
           address = excluded.address,
           source = excluded.source,
           updated_at = excluded.updated_at,
           data = excluded.data`,
      )
      .run(
        contact.contactId,
        contact.inboxId,
        contact.name,
        contact.address ?? null,
        contact.source,
        contact.createdAt,
        contact.updatedAt,
        JSON.stringify(contact),
      );
    return Promise.resolve();
  }

  getContactById(contactId: string): Promise<Contact | null> {
    return Promise.resolve(this.readContact('contact_id = ?', contactId));
  }

  getContactByInboxId(inboxId: string): Promise<Contact | null> {
    return Promise.resolve(this.readContact('inbox_id = ?', inboxId));
  }

  getContactByName(name: string): Promise<Contact | null> {
    return Promise.resolve(this.readContact('lower(name) = lower(?)', name.trim()));
  }

  listContacts(): Promise<Contact[]> {
    const rows = this.db.query(`select data from contacts order by lower(name) asc`).all() as DataRow[];
    return Promise.resolve(rows.map(parseDataRow<Contact>));
  }

  deleteContact(contactId: string): Promise<void> {
    this.db.query(`delete from contacts where contact_id = $contactId`).run({ contactId });
    return Promise.resolve();
  }

  putMessage(message: StoredMessage): Promise<void> {
    this.db
      .query(
        `insert into messages (message_id, conversation_id, sender_inbox_id, sent_at, kind, data)
         values (?, ?, ?, ?, ?, ?)
         on conflict(message_id) do update set data = excluded.data`,
      )
      .run(
        message.messageId,
        message.conversationId,
        message.senderInboxId,
        message.sentAt,
        message.kind,
        JSON.stringify(message),
      );
    return Promise.resolve();
  }

  listMessages(conversationId?: string): Promise<StoredMessage[]> {
    const rows = conversationId
      ? this.db.query(`select data from messages where conversation_id = ? order by sent_at asc`).all(conversationId)
      : this.db.query(`select data from messages order by sent_at asc`).all();
    return Promise.resolve((rows as DataRow[]).map(parseDataRow<StoredMessage>));
  }

  markMessageProcessed(messageId: string): Promise<boolean> {
    const result = this.db
      .query(`insert or ignore into processed_messages (message_id, processed_at) values (?, ?)`)
      .run(messageId, new Date().toISOString());
    return Promise.resolve(result.changes > 0);
  }

  getMetadata(): Promise<ConeStoreMetadata> {
    const rows = this.db.query(`select key, value from metadata`).all() as Array<{ key: string; value: string }>;
    const metadata: ConeStoreMetadata = {};
    for (const row of rows) {
      if (row.key === 'lastSyncedAt') {
        metadata.lastSyncedAt = row.value;
      } else if (row.key === 'lastStreamStartedAt') {
        metadata.lastStreamStartedAt = row.value;
      }
    }
    return Promise.resolve(metadata);
  }

  async putMetadata(metadata: ConeStoreMetadata): Promise<void> {
    for (const [key, value] of Object.entries(metadata)) {
      if (value === undefined) {
        continue;
      }
      this.db
        .query(`insert into metadata (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`)
        .run(key, String(value));
    }
  }

  async exportSnapshot(): Promise<ConeStoreSnapshot> {
    const [contacts, conversations, messages, metadata] = await Promise.all([
      this.listContacts(),
      this.listConversations(),
      this.listMessages(),
      this.getMetadata(),
    ]);
    const processedRows = this.db.query(`select message_id from processed_messages order by processed_at asc`).all() as Array<{
      message_id: string;
    }>;
    return {
      contacts,
      conversations,
      metadata,
      messages,
      processedMessageIds: processedRows.map((row) => row.message_id),
    };
  }

  // Snapshots come from user-supplied backups, so every collection is treated
  // as optional even though the type says otherwise.
  async importSnapshot(snapshot: ConeStoreSnapshot): Promise<void> {
    for (const contact of snapshot.contacts ?? []) {
      await this.putContact(contact);
    }
    for (const conversation of snapshot.conversations ?? []) {
      await this.putConversation(conversation);
    }
    await this.putMetadata(snapshot.metadata ?? {});
    for (const message of snapshot.messages ?? []) {
      await this.putMessage(message);
    }
    for (const messageId of snapshot.processedMessageIds ?? []) {
      await this.markMessageProcessed(messageId);
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists contacts (
        contact_id text primary key,
        inbox_id text not null unique,
        name text not null,
        address text,
        source text not null,
        created_at text not null,
        updated_at text not null,
        data text not null
      );

      create table if not exists conversations (
        conversation_id text primary key,
        peer_inbox_id text not null,
        title text not null,
        updated_at text,
        data text not null
      );

      create table if not exists messages (
        message_id text primary key,
        conversation_id text not null,
        sender_inbox_id text not null,
        sent_at text not null,
        kind text not null,
        data text not null
      );

      create table if not exists processed_messages (
        message_id text primary key,
        processed_at text not null
      );

      create table if not exists metadata (
        key text primary key,
        value text not null
      );
    `);
  }

  private readContact(whereClause: string, value: string): Contact | null {
    const row = this.db.query(`select data from contacts where ${whereClause} limit 1`).get(value) as DataRow | null;
    return row ? parseDataRow<Contact>(row) : null;
  }
}

interface DataRow {
  data: string;
}

function parseDataRow<T>(row: DataRow): T {
  return JSON.parse(row.data) as T;
}
