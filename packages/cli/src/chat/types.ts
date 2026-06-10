import type { ConeConversation, ConeIdentity, ConeMessage, Contact } from '@cone/core';

export interface ChatOptions {
  plainLog?: boolean;
  syncOnOpen?: boolean;
  readReceipts?: boolean;
  onReadReceiptsChange?: (value: boolean) => void;
}

export type ChatMode = 'chat-compose' | 'chat-select' | 'chat-talk' | 'contacts-select' | 'contacts-edit';
export type ContactEditKind =
  | 'add'
  | 'conversation-delete'
  | 'delete'
  | 'message'
  | 'pair-create'
  | 'pair-join'
  | 'rename';
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
