import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  ConeConversation,
  ConeStore,
  ConeStoreMetadata,
  ConeStoreSnapshot,
  Contact,
  StoredMessage,
  OutboxEntry,
  PendingMessageOptions,
  SentMessage,
} from '@cone/core';

export class BunSQLiteStore implements ConeStore {
  private readonly db: Database;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath, { create: true });
    chmodSync(filePath, 0o600);
    // Agents run `cone listen` and `cone send` concurrently against one
    // CONE_HOME. WAL lets a reader and a writer coexist, and the busy timeout
    // makes brief write overlaps queue instead of throwing SQLITE_BUSY.
    this.db.exec('pragma journal_mode = WAL; pragma busy_timeout = 5000;');
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
        conversation.peerInboxId ?? null,
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
         on conflict(message_id) do update set
           conversation_id = excluded.conversation_id,
           sender_inbox_id = excluded.sender_inbox_id,
           sent_at = excluded.sent_at,
           kind = excluded.kind,
           data = excluded.data`,
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
    // rowid is the ingestion sequence: assigned on insert, preserved by the
    // upsert's on-conflict update. Poll cursors ride it (StoredMessage.seq).
    const rows = conversationId
      ? this.db.query(`select rowid as seq, data from messages where conversation_id = ? order by sent_at asc`).all(conversationId)
      : this.db.query(`select rowid as seq, data from messages order by sent_at asc`).all();
    return Promise.resolve((rows as Array<DataRow & { seq: number }>).map((row) => ({
      ...parseDataRow<StoredMessage>(row),
      seq: row.seq,
    })));
  }

  // Deletes the stored payload only; the processed_messages marker is kept so
  // the message cannot be re-ingested on a later sync.
  deleteMessage(messageId: string): Promise<void> {
    this.db.query(`delete from messages where message_id = ?`).run(messageId);
    return Promise.resolve();
  }

  markMessageProcessed(messageId: string): Promise<boolean> {
    const result = this.db
      .query(`insert or ignore into processed_messages (message_id, processed_at) values (?, ?)`)
      .run(messageId, new Date().toISOString());
    return Promise.resolve(result.changes > 0);
  }

  listPendingMessages(options: PendingMessageOptions): Promise<StoredMessage[]> {
    // JSON arrays keep the parameter count fixed even for a large address book.
    const rows = this.db.query(`
      select m.rowid as seq, m.data from messages m
      where m.conversation_id in (select value from json_each(?))
        and m.sender_inbox_id not in (select value from json_each(?))
        and coalesce(json_extract(m.data, '$.networkConversationId'), m.conversation_id) not in (select value from json_each(?))
        and m.rowid > ?
        and not exists (select 1 from acknowledgements a where a.consumer = ? and a.message_id = m.message_id)
      order by m.rowid limit ?
    `).all(JSON.stringify(options.conversationIds), JSON.stringify(options.excludeSenderInboxIds), JSON.stringify(options.excludeConversationIds ?? []),
      options.afterSeq ?? 0, options.consumer, options.limit) as Array<DataRow & { seq: number }>;
    return Promise.resolve(rows.map(row => ({ ...parseDataRow<StoredMessage>(row), seq: row.seq })));
  }

  acknowledgeMessages(consumer: string, messageIds: string[]): Promise<void> {
    const insert = this.db.query('insert or ignore into acknowledgements (consumer, message_id) values (?, ?)');
    this.db.transaction(() => { for (const id of messageIds) insert.run(consumer, id); })();
    return Promise.resolve();
  }

  prepareSend(entry: OutboxEntry): Promise<OutboxEntry> {
    return Promise.resolve(this.db.transaction(() => {
      this.db.query('insert or ignore into outbox (key, data) values (?, ?)').run(entry.key, JSON.stringify(entry));
      return parseDataRow<OutboxEntry>(this.db.query('select data from outbox where key = ?').get(entry.key) as DataRow);
    })());
  }

  settleSend(key: string, sent: SentMessage): Promise<void> {
    const row = this.db.query('select data from outbox where key = ?').get(key) as DataRow | null;
    if (!row) throw new Error('outbox entry not found');
    const entry = parseDataRow<OutboxEntry>(row);
    this.db.query('update outbox set data = ? where key = ?')
      .run(JSON.stringify({ ...entry, encryptedPayload: undefined, sent }), key);
    return Promise.resolve();
  }

  listPendingSends(): Promise<OutboxEntry[]> {
    return Promise.resolve((this.db.query("select data from outbox where json_extract(data, '$.sent') is null").all() as DataRow[])
      .map(parseDataRow<OutboxEntry>));
  }

  getMetadata(): Promise<ConeStoreMetadata> {
    const rows = this.db.query(`select key, value from metadata`).all() as Array<{ key: string; value: string }>;
    const metadata: ConeStoreMetadata = {};
    for (const row of rows) {
      if (row.key === 'lastSyncedAt') {
        metadata.lastSyncedAt = row.value;
      } else if (row.key === 'lastXmtpSyncStartedAt') {
        metadata.lastXmtpSyncStartedAt = row.value;
      } else if (row.key === 'lastStreamStartedAt') {
        metadata.lastStreamStartedAt = row.value;
      } else if (row.key === 'deniedInboxIds') {
        metadata.deniedInboxIds = parseStringArray(row.value);
      } else if (row.key === 'pendingGroupJoins') {
        metadata.pendingGroupJoins = parseJsonArray(row.value);
      } else if (row.key === 'groupInviteLinks') {
        metadata.groupInviteLinks = parseJsonArray(row.value);
      } else if (row.key === 'pollCursors') {
        metadata.pollCursors = parseJsonRecord(row.value);
      } else if (row.key === 'idempotencySends') {
        metadata.idempotencySends = parseJsonArray(row.value);
      } else if (row.key === 'hiddenConversations') {
        metadata.hiddenConversations = parseJsonRecord(row.value);
      }
    }
    return Promise.resolve(metadata);
  }

  updateDeniedInboxId(inboxId: string, denied: boolean): Promise<void> {
    this.db.transaction(() => {
      const row = this.db.query("select value from metadata where key = 'deniedInboxIds'").get() as { value: string } | null;
      const ids = new Set(row ? parseStringArray(row.value) : []);
      if (denied) ids.add(inboxId); else ids.delete(inboxId);
      this.db.query("insert into metadata (key, value) values ('deniedInboxIds', ?) on conflict(key) do update set value = excluded.value")
        .run(JSON.stringify([...ids].sort()));
    })();
    return Promise.resolve();
  }

  async putMetadata(metadata: ConeStoreMetadata): Promise<void> {
    for (const [key, value] of Object.entries(metadata)) {
      if (value === undefined) {
        continue;
      }
      // Non-string values (the denied-inbox list) are stored as JSON.
      const stored = typeof value === 'string' ? value : JSON.stringify(value);
      this.db
        .query(`insert into metadata (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`)
        .run(key, stored);
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
      acknowledgements: this.db.query('select consumer, message_id as messageId from acknowledgements').all() as Array<{ consumer: string; messageId: string }>,
      outbox: (this.db.query('select data from outbox').all() as DataRow[]).map(parseDataRow<OutboxEntry>),
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
    for (const ack of snapshot.acknowledgements ?? []) await this.acknowledgeMessages(ack.consumer, [ack.messageId]);
    for (const entry of snapshot.outbox ?? []) await this.prepareSend(entry);
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
        peer_inbox_id text,
        title text not null,
        updated_at text,
        data text not null
      );

      create table if not exists messages (
        seq integer primary key autoincrement,
        message_id text not null unique,
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

      create table if not exists acknowledgements (
        consumer text not null,
        message_id text not null,
        primary key (consumer, message_id)
      );
      create table if not exists outbox (key text primary key, data text not null);
    `);
    const columns = this.db.query('pragma table_info(messages)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'seq')) {
      // Preserve existing cursor positions while preventing SQLite from reusing
      // the highest rowid after retention or deletion removes its message.
      this.db.transaction(() => this.db.exec(`
        alter table messages rename to messages_before_sequence;
        create table messages (
          seq integer primary key autoincrement, message_id text not null unique,
          conversation_id text not null, sender_inbox_id text not null,
          sent_at text not null, kind text not null, data text not null
        );
        insert into messages select rowid, * from messages_before_sequence;
        drop table messages_before_sequence;
      `))();
    }
    this.db.exec('create index if not exists messages_by_conversation on messages (conversation_id, seq);');
    this.db.exec("create index if not exists outbox_pending on outbox (key) where json_extract(data, '$.sent') is null;");
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

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord<T>(value: string): Record<string, T> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}
