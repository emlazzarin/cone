import {
  formatConversationPreview,
  isAllowedConversation,
  isRequestConversation,
  isVisibleChatMessage,
  latestInboundAt,
  matchConversationFilter,
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
    groupInfoIndex: 0,
    helpVisible: false,
    identity,
    input: '',
    lastAckedByConversation: {},
    lastMessageAtByConversation: {},
    messages: [],
    mode: 'chat-select',
    scope: 'chats',
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

// Conversations for the current scope: the allowed inbox, or the unknown-sender
// Requests sub-surface. Denied conversations appear in neither.
export function scopedConversations(state: ChatState): ConeConversation[] {
  return state.conversations.filter(state.scope === 'requests' ? isRequestConversation : isAllowedConversation);
}

// scopedConversations narrowed by the live text filter. Matching lives in
// @cone/core (matchConversationFilter) so the list and the rendered match
// highlights can never disagree about why a row is visible.
export function visibleConversations(state: ChatState): ConeConversation[] {
  const inScope = scopedConversations(state);
  if (!state.filter.trim()) {
    return inScope;
  }
  return inScope.filter((conversation) => matchConversationFilter(conversation, state.filter) !== null);
}

export function requestCount(state: ChatState): number {
  return state.conversations.filter(isRequestConversation).length;
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

// The group-info pane operates on the selected conversation (which must be a
// group). Selection and members are read live so refreshes reconcile the view.
export function enterGroupInfo(state: ChatState): void {
  saveDraft(state);
  state.activeContactId = undefined;
  state.editForm = null;
  state.helpVisible = false;
  state.mode = 'group-info';
  state.groupInfoIndex = 0;
  state.pendingGroupAction = undefined;
  state.status = `group info — ${selectedConversation(state)?.title ?? 'group'}`;
}

export function groupInfoMembers(state: ChatState): NonNullable<ConeConversation['members']> {
  return selectedConversation(state)?.members ?? [];
}

export function selectGroupMember(state: ChatState, delta: number): void {
  state.pendingGroupAction = undefined;
  state.groupInfoIndex = clampIndex(state.groupInfoIndex + delta, groupInfoMembers(state).length);
}

// Contacts-first display name for a group member; the raw ID stays available
// in the info pane itself.
export function memberDisplayName(state: ChatState, inboxId: string): string {
  if (inboxId === state.identity.inboxId) {
    return 'you';
  }
  return state.contacts.find((contact) => contact.inboxId === inboxId && contact.source !== 'self')?.name ?? inboxId;
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

// Toggle the Chats pane between the allowed inbox and the Requests sub-surface.
export function toggleScope(state: ChatState): void {
  state.scope = state.scope === 'requests' ? 'chats' : 'requests';
  state.pendingBlockId = undefined;
  clearFilter(state);
  state.selectedIndex = 0;
  state.activeContactId = undefined;
  clampSelections(state);
  state.status = state.scope === 'requests' ? 'requests' : 'chats';
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
  // Never acknowledge a Request: previewing an unknown (or denied) sender must
  // not tell them you read it. Receipts are only for allowed conversations,
  // and DM-only — in a group they would broadcast to every member.
  if (!state.readReceipts || !isAllowedConversation(conversation) || conversation.kind === 'group' || !conversation.peerInboxId) {
    return;
  }
  const newestInbound = latestInboundAt(state.messages);
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
