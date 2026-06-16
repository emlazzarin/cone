import type { ConeConversation, ConeIdentity, ConeMessage, Contact } from '@cone/core';

export interface ChatOptions {
  plainLog?: boolean;
  syncOnOpen?: boolean;
  readReceipts?: boolean;
  onReadReceiptsChange?: (value: boolean) => void;
}

export type ChatMode = 'chat-compose' | 'chat-select' | 'chat-talk' | 'contacts-select' | 'contacts-edit';
// Within the Chats pane, the list shows either the allowed inbox or the
// unknown-sender Requests sub-surface. Denied conversations appear in neither.
export type ChatScope = 'chats' | 'requests';
export type ContactEditKind =
  | 'add'
  | 'conversation-delete'
  | 'delete'
  | 'message'
  | 'name-peer'
  | 'pair-create'
  | 'pair-join'
  | 'rename'
  | 'timer';
export type StreamState = 'connecting' | 'online' | 'offline';
export type SyncState = 'idle' | 'syncing' | 'stale';

export interface ContactEditField {
  key: string;
  label: string;
  value: string;
}

// Optimistically rendered outbound message. `key` matches the draft key:
// a conversationId, or `contact:<contactId>` before a conversation exists.
export interface PendingMessage {
  id: string;
  key: string;
  sentAt: string;
  status: 'sending' | 'failed';
  text: string;
}

export interface ContactEditForm {
  activeField: number;
  error?: string;
  fields: ContactEditField[];
  kind: ContactEditKind;
  resultLines?: string[];
  // Pairing polls the rendezvous for up to a minute; it runs in the background
  // so the TUI never freezes. While pending, the form shows a waiting line and
  // ignores input except Esc.
  pending?: boolean;
  submitLabel?: string;
  targetConversationId?: string;
  targetContactId?: string;
  title: string;
}

export interface ChatState {
  activeContactId?: string;
  contacts: Contact[];
  conversations: ConeConversation[];
  draftsByConversation: Record<string, string>;
  editForm: ContactEditForm | null;
  filter: string;
  filterActive: boolean;
  helpVisible: boolean;
  identity: ConeIdentity;
  input: string;
  lastAckedByConversation: Record<string, string>;
  lastMessageAtByConversation: Record<string, string>;
  messages: ConeMessage[];
  mode: ChatMode;
  scope: ChatScope;
  // Two-press confirm for blocking a request: holds the conversationId armed
  // for block until a second press (or any other action clears it).
  pendingBlockId?: string;
  pendingMessages: PendingMessage[];
  previewByConversation: Record<string, string>;
  readReceipts: boolean;
  selectedContactIndex: number;
  selectedIndex: number;
  status: string;
  streamState: StreamState;
  syncState: SyncState;
  transcriptScroll: number;
  unreadByConversation: Record<string, number>;
}

export interface RefreshOptions {
  preserveScroll?: boolean;
}

export type RefreshChat = (options?: RefreshOptions) => Promise<void>;
export type SyncNow = (options?: { quiet?: boolean }) => Promise<void>;
