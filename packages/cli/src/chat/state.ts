import type { ConeClient, ConeConversation, ConeIdentity, Contact, IdentityRef } from '@cone/core';

import type { ChatState, ContactEditForm } from './types';

export function createChatState(
  identity: ConeIdentity,
  conversations: ConeConversation[] = [],
  contacts: Contact[] = [],
): ChatState {
  return {
    contacts,
    conversations,
    draftsByConversation: {},
    editForm: null,
    helpVisible: false,
    identity,
    input: '',
    messages: [],
    mode: 'chat-select',
    selectedContactIndex: 0,
    selectedIndex: 0,
    status: conversations.length === 0 ? 'waiting for messages' : 'live',
    streamState: 'connecting',
    syncState: 'idle',
    transcriptScroll: 0,
    unreadByConversation: {},
  };
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
  const conversationIndex = state.conversations.findIndex((conversation) => conversation.peerInboxId === contact.inboxId);
  if (conversationIndex >= 0) {
    state.selectedIndex = conversationIndex;
    state.activeContactId = undefined;
  } else {
    state.activeContactId = contact.contactId;
    state.messages = [];
  }
  enterChatTalk(state);
}

export async function refreshMessages(client: ConeClient, state: ChatState): Promise<void> {
  const conversation = selectedConversation(state);
  state.messages = conversation && !state.activeContactId ? await client.listMessages(conversation.conversationId) : [];
  if (conversation && state.transcriptScroll === 0) {
    delete state.unreadByConversation[conversation.conversationId];
  }
}

export function selectedConversation(state: ChatState): ConeConversation | undefined {
  return state.activeContactId ? undefined : state.conversations[state.selectedIndex];
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
  state.selectedIndex = clampIndex(state.selectedIndex + delta, state.conversations.length);
  state.transcriptScroll = 0;
  loadDraft(state);
}

export function selectContact(state: ChatState, delta: number): void {
  state.selectedContactIndex = clampIndex(state.selectedContactIndex + delta, state.contacts.length);
}

export function clampSelections(state: ChatState): void {
  state.selectedIndex = clampIndex(state.selectedIndex, state.conversations.length);
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
    const index = state.conversations.findIndex((conversation) => conversation.conversationId === conversationId);
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
  const index = state.conversations.findIndex((conversation) => conversation.peerInboxId === contact.inboxId);
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

function draftKey(state: ChatState): string | undefined {
  const contact = activeContact(state);
  const conversation = selectedConversation(state);
  if (contact) {
    return `contact:${contact.contactId}`;
  }
  return conversation?.conversationId;
}

function clampIndex(index: number, count: number): number {
  return Math.min(Math.max(0, count - 1), Math.max(0, index));
}
