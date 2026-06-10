import {
  formatConversationPreview,
  isVisibleChatMessage,
  type ConeClient,
  type ConeConversation,
  type ConeIdentity,
  type ConeMessage,
  type Contact,
  type IdentityRef,
} from '@cone/core';

import type { ChatState, ContactEditForm } from './types';

export function createChatState(
  identity: ConeIdentity,
  conversations: ConeConversation[] = [],
  contacts: Contact[] = [],
): ChatState {
  const state: ChatState = {
    contacts,
    conversations,
    draftsByConversation: {},
    editForm: null,
    filter: '',
    filterActive: false,
    helpVisible: false,
    identity,
    input: '',
    lastAckedByConversation: {},
    lastMessageAtByConversation: {},
    messages: [],
    mode: 'chat-select',
    pendingMessages: [],
    previewByConversation: {},
    readReceipts: true,
    selectedContactIndex: 0,
    selectedIndex: 0,
    status: conversations.length === 0 ? 'waiting for messages' : 'live',
    streamState: 'connecting',
    syncState: 'idle',
    transcriptScroll: 0,
    unreadByConversation: {},
  };
  sortConversations(state);
  return state;
}

// Builds last-message previews and activity times from the full local message
// list, then keeps conversations sorted by most recent activity (same order
// and preview format as the PWA).
export function applyConversationMeta(state: ChatState, messages: ConeMessage[]): void {
  const previews: Record<string, string> = {};
  const lastAt: Record<string, string> = {};
  for (const message of messages) {
    if (!isVisibleChatMessage(message)) {
      continue;
    }
    const current = lastAt[message.conversationId];
    if (!current || message.sentAt > current) {
      lastAt[message.conversationId] = message.sentAt;
      previews[message.conversationId] = formatConversationPreview(message);
    }
  }
  state.previewByConversation = previews;
  state.lastMessageAtByConversation = lastAt;
  sortConversations(state);
}

export function conversationActivityAt(state: ChatState, conversation: ConeConversation): string {
  const lastMessageAt = state.lastMessageAtByConversation[conversation.conversationId];
  const updatedAt = conversation.updatedAt ?? '';
  return lastMessageAt && lastMessageAt > updatedAt ? lastMessageAt : updatedAt;
}

export function visibleConversations(state: ChatState): ConeConversation[] {
  const query = state.filter.trim().toLocaleLowerCase();
  if (!query) {
    return state.conversations;
  }
  return state.conversations.filter(
    (conversation) =>
      conversation.title.toLocaleLowerCase().includes(query) ||
      conversation.peerInboxId.toLocaleLowerCase().includes(query),
  );
}

function sortConversations(state: ChatState): void {
  state.conversations.sort((left, right) => {
    const leftAt = conversationActivityAt(state, left);
    const rightAt = conversationActivityAt(state, right);
    return leftAt < rightAt ? 1 : leftAt > rightAt ? -1 : 0;
  });
}

export function enterChatSelect(state: ChatState): void {
  saveDraft(state);
  state.activeContactId = undefined;
  state.editForm = null;
  state.helpVisible = false;
  state.mode = 'chat-select';
  state.status = 'select conversation';
}

export function enterChatTalk(state: ChatState): void {
  state.editForm = null;
  state.helpVisible = false;
  state.mode = 'chat-talk';
  loadDraft(state);
  state.status = `talking to ${activeContact(state)?.name ?? selectedConversation(state)?.title ?? 'chat'}`;
}

export function startChatCompose(state: ChatState, form: ContactEditForm): void {
  saveDraft(state);
  state.activeContactId = undefined;
  state.editForm = form;
  state.helpVisible = false;
  state.mode = 'chat-compose';
  state.status = form.title;
}

export function enterContactsSelect(state: ChatState): void {
  saveDraft(state);
  state.editForm = null;
  state.helpVisible = false;
  state.mode = 'contacts-select';
  state.status = 'contacts';
}

export function startContactsEdit(state: ChatState, form: ContactEditForm): void {
  state.editForm = form;
  state.helpVisible = false;
  state.mode = 'contacts-edit';
  state.status = form.title;
}

export function enterChatForSelectedContact(state: ChatState): void {
  const contact = selectedContact(state);
  if (!contact) {
    state.status = 'no contact selected';
    return;
  }
  clearFilter(state);
  const conversationIndex = visibleConversations(state).findIndex((conversation) => conversation.peerInboxId === contact.inboxId);
  if (conversationIndex >= 0) {
    state.selectedIndex = conversationIndex;
    state.activeContactId = undefined;
  } else {
    state.activeContactId = contact.contactId;
    state.messages = [];
  }
  enterChatTalk(state);
}

export function clearFilter(state: ChatState): void {
  const selectedId = selectedConversation(state)?.conversationId;
  state.filter = '';
  state.filterActive = false;
  if (selectedId) {
    preserveSelection(state, selectedId, undefined);
  }
  clampSelections(state);
}

export async function refreshMessages(client: ConeClient, state: ChatState): Promise<void> {
  const conversation = selectedConversation(state);
  state.messages = conversation && !state.activeContactId ? await client.listMessages(conversation.conversationId) : [];
  if (conversation && state.transcriptScroll === 0) {
    delete state.unreadByConversation[conversation.conversationId];
    maybeSendReadReceipt(client, state, conversation);
  }
}

// Viewing the latest of a conversation = reading it. When read receipts are on,
// acknowledge the newest inbound message to the peer, deduped so we only send
// when something new has actually arrived.
function maybeSendReadReceipt(client: ConeClient, state: ChatState, conversation: ConeConversation): void {
  if (!state.readReceipts) {
    return;
  }
  let newestInbound = '';
  for (const message of state.messages) {
    if (message.direction === 'inbound' && isVisibleChatMessage(message) && message.sentAt > newestInbound) {
      newestInbound = message.sentAt;
    }
  }
  if (!newestInbound || (state.lastAckedByConversation[conversation.conversationId] ?? '') >= newestInbound) {
    return;
  }
  state.lastAckedByConversation[conversation.conversationId] = newestInbound;
  void client.sendReadReceipt(conversation.peerInboxId);
}

export function selectedConversation(state: ChatState): ConeConversation | undefined {
  return state.activeContactId ? undefined : visibleConversations(state)[state.selectedIndex];
}

export function selectedContact(state: ChatState): Contact | undefined {
  return state.contacts[state.selectedContactIndex];
}

export function activeContact(state: ChatState): Contact | undefined {
  return state.activeContactId
    ? state.contacts.find((contact) => contact.contactId === state.activeContactId)
    : undefined;
}

export function selectConversation(state: ChatState, delta: number): void {
  state.activeContactId = undefined;
  state.selectedIndex = clampIndex(state.selectedIndex + delta, visibleConversations(state).length);
  state.transcriptScroll = 0;
  loadDraft(state);
}

export function selectContact(state: ChatState, delta: number): void {
  state.selectedContactIndex = clampIndex(state.selectedContactIndex + delta, state.contacts.length);
}

export function clampSelections(state: ChatState): void {
  state.selectedIndex = clampIndex(state.selectedIndex, visibleConversations(state).length);
  state.selectedContactIndex = clampIndex(state.selectedContactIndex, state.contacts.length);
}

export function saveDraft(state: ChatState): void {
  const key = draftKey(state);
  if (key) {
    state.draftsByConversation[key] = state.input;
  }
}

export function loadDraft(state: ChatState): void {
  const key = draftKey(state);
  state.input = key ? state.draftsByConversation[key] ?? '' : '';
}

export function preserveSelection(state: ChatState, conversationId: string | undefined, contactId: string | undefined): void {
  if (conversationId) {
    const index = visibleConversations(state).findIndex((conversation) => conversation.conversationId === conversationId);
    if (index >= 0) {
      state.selectedIndex = index;
    }
  }
  if (contactId) {
    const index = state.contacts.findIndex((contact) => contact.contactId === contactId);
    if (index >= 0) {
      state.selectedContactIndex = index;
    }
  }
  if (state.activeContactId && !activeContact(state)) {
    state.activeContactId = undefined;
  }
}

export function promoteActiveContactConversation(state: ChatState): void {
  const contact = activeContact(state);
  if (!contact) {
    return;
  }
  const index = visibleConversations(state).findIndex((conversation) => conversation.peerInboxId === contact.inboxId);
  if (index >= 0) {
    state.selectedIndex = index;
    state.activeContactId = undefined;
  }
}

export function sendTargetForState(state: ChatState): IdentityRef | undefined {
  const conversation = selectedConversation(state);
  if (conversation) {
    return conversation.contactId ? { contactId: conversation.contactId } : conversation.peerInboxId;
  }
  const contact = activeContact(state);
  if (contact) {
    return contact.contactId ? { contactId: contact.contactId } : contact.inboxId;
  }
  return undefined;
}

export function isContactsMode(state: ChatState): boolean {
  return state.mode === 'contacts-select' || state.mode === 'contacts-edit';
}

// Shared by drafts and optimistic sends: the stable key for "what the
// composer is pointed at" — a conversation, or a contact with no chat yet.
export function composerKey(state: ChatState): string | undefined {
  const contact = activeContact(state);
  const conversation = selectedConversation(state);
  if (contact) {
    return `contact:${contact.contactId}`;
  }
  return conversation?.conversationId;
}

function draftKey(state: ChatState): string | undefined {
  return composerKey(state);
}

function clampIndex(index: number, count: number): number {
  return Math.min(Math.max(0, count - 1), Math.max(0, index));
}
