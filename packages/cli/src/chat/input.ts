import {
  RETENTION_PRESETS_MS,
  errorMessage,
  formatRetention,
  parseRetention,
  type ConeClient,
  type Contact,
} from '@cone/core';

import { KEY, isChatsShortcut, isContactsShortcut, isEnter } from './keys';
import {
  createAddContactForm,
  createDeleteContactForm,
  createDeleteConversationForm,
  createNamePeerForm,
  createNewMessageForm,
  createPairCreateResultForm,
  createPairJoinForm,
  createRenameContactForm,
  createTimerForm,
  formValue,
} from './forms';
import {
  activeContact,
  clampSelections,
  clearFilter,
  composerKey,
  enterChatForSelectedContact,
  enterChatSelect,
  enterChatTalk,
  enterContactsSelect,
  refreshMessages,
  saveDraft,
  selectContact,
  selectConversation,
  selectedContact,
  selectedConversation,
  sendTargetForState,
  startChatCompose,
  startContactsEdit,
  toggleScope,
  visibleConversations,
} from './state';
import type { ChatState, ContactEditForm, PendingMessage, RefreshChat, SyncNow } from './types';
import { deleteLastWord, isPrintableInput, shortId } from './text';

export async function handleInput(
  input: string,
  client: ConeClient,
  state: ChatState,
  refresh: RefreshChat,
  syncNow: SyncNow,
  quit: () => Promise<void>,
): Promise<void> {
  if (input === KEY.ctrlC) {
    await quit();
    return;
  }
  if (state.helpVisible) {
    if (input === KEY.esc || input === '?') {
      state.helpVisible = false;
      state.status = 'help closed';
    }
    return;
  }
  const canUsePaneNumber = state.mode === 'chat-select' || state.mode === 'contacts-select';
  if (isChatsShortcut(input, canUsePaneNumber)) {
    enterChatSelect(state);
    return;
  }
  if (isContactsShortcut(input, canUsePaneNumber)) {
    enterContactsSelect(state);
    return;
  }
  if ((state.mode === 'chat-select' || state.mode === 'chat-talk') && (input === KEY.pageUp || input === KEY.ctrlB)) {
    state.transcriptScroll += 5;
    state.status = `scroll +${state.transcriptScroll}`;
    return;
  }
  if ((state.mode === 'chat-select' || state.mode === 'chat-talk') && (input === KEY.pageDown || input === KEY.ctrlF)) {
    state.transcriptScroll = Math.max(0, state.transcriptScroll - 5);
    state.status = state.transcriptScroll === 0 ? 'bottom' : `scroll +${state.transcriptScroll}`;
    return;
  }

  if (state.mode === 'chat-select') {
    await handleChatSelectInput(input, client, state, refresh, syncNow, quit);
    return;
  }
  if (state.mode === 'chat-talk') {
    await handleChatTalkInput(input, client, state, refresh);
    return;
  }
  if (state.mode === 'chat-compose') {
    await handleChatComposeInput(input, client, state, refresh);
    return;
  }
  if (state.mode === 'contacts-select') {
    await handleContactsSelectInput(input, client, state, quit);
    return;
  }
  await handleContactsEditInput(input, client, state, refresh);
}

async function handleChatSelectInput(
  input: string,
  client: ConeClient,
  state: ChatState,
  refresh: RefreshChat,
  syncNow: SyncNow,
  quit: () => Promise<void>,
): Promise<void> {
  if (state.filterActive) {
    await handleFilterInput(input, client, state);
    return;
  }
  if (input === '/') {
    state.filterActive = true;
    state.status = 'type to filter chats';
    return;
  }
  if (input === KEY.esc && state.filter) {
    clearFilter(state);
    state.status = 'filter cleared';
    await refreshMessages(client, state);
    return;
  }
  if (input === 'q') {
    await quit();
    return;
  }
  if (input === '?') {
    state.helpVisible = true;
    state.status = 'help';
    return;
  }
  if (input === 'R') {
    toggleReadReceipts(state);
    return;
  }
  // 't' toggles the Requests sub-surface; 'a'/'b' accept/block the selected
  // request (block is a two-press confirm). These belong to the Requests scope.
  if (input === 't') {
    toggleScope(state);
    await refreshMessages(client, state);
    return;
  }
  if (state.scope === 'requests' && (input === 'a' || input === 'b')) {
    await handleRequestDecision(input, client, state, refresh);
    return;
  }
  // Chats-scope actions: name the selected peer, or reach pairing (parity with
  // the PWA's Pair tab) without first hunting through Contacts.
  if (state.scope === 'chats' && input === 'r') {
    const conversation = selectedConversation(state);
    if (!conversation) {
      state.status = 'no chat selected';
      return;
    }
    if (conversation.kind === 'group') {
      state.status = 'groups have no single peer to name';
      return;
    }
    const existing = state.contacts.find((contact) => contact.inboxId === conversation.peerInboxId && contact.source !== 'self');
    startChatCompose(state, createNamePeerForm(conversation, existing?.name ?? ''));
    return;
  }
  // 'e' sets the selected chat's disappearing-messages timer (expiry).
  if (state.scope === 'chats' && input === 'e') {
    const conversation = selectedConversation(state);
    if (!conversation) {
      state.status = 'no chat selected';
      return;
    }
    startChatCompose(state, createTimerForm(conversation));
    return;
  }
  if (state.scope === 'chats' && input === 'c') {
    const created = await client.createHandshakeCode();
    startContactsEdit(state, createPairCreateResultForm(created.code, created.expiresAt));
    state.status = 'created pairing code';
    return;
  }
  if (state.scope === 'chats' && input === 'p') {
    startContactsEdit(state, createPairJoinForm());
    return;
  }
  if (input === KEY.ctrlX) {
    discardFailed(state);
    return;
  }
  if (input === 'n') {
    startChatCompose(state, createNewMessageForm());
    return;
  }
  if (input === 'd') {
    const conversation = selectedConversation(state);
    if (!conversation) {
      state.status = 'no chat selected';
      return;
    }
    startChatCompose(state, createDeleteConversationForm(conversation));
    return;
  }
  if (input === 's' && canRetrySync(state)) {
    await syncNow();
    return;
  }
  if (input === KEY.up || input === 'k') {
    state.pendingBlockId = undefined;
    selectConversation(state, -1);
    await refreshMessages(client, state);
    return;
  }
  if (input === KEY.down || input === 'j') {
    state.pendingBlockId = undefined;
    selectConversation(state, 1);
    await refreshMessages(client, state);
    return;
  }
  if (isEnter(input)) {
    if (!selectedConversation(state)) {
      state.status = 'no chat selected';
      return;
    }
    enterChatTalk(state);
  }
}

// Accept (allowed) or block (denied) the selected Request. Accept moves it to
// the inbox; block is confirmed by pressing 'b' a second time so spam can't be
// un-blocked by a stray keypress and a real block isn't accidental.
async function handleRequestDecision(input: string, client: ConeClient, state: ChatState, refresh: RefreshChat): Promise<void> {
  const conversation = selectedConversation(state);
  if (!conversation) {
    state.status = 'no request selected';
    return;
  }
  if (input === 'a') {
    state.pendingBlockId = undefined;
    // Conversation-scoped: DMs allow the peer's inbox, groups allow the group.
    await client.setConversationConsent(conversation.conversationId, 'allowed');
    state.status = `accepted ${conversation.title}`;
    await refresh();
    return;
  }
  if (state.pendingBlockId !== conversation.conversationId) {
    state.pendingBlockId = conversation.conversationId;
    state.status = `press b again to block ${conversation.title}`;
    return;
  }
  state.pendingBlockId = undefined;
  await client.setConversationConsent(conversation.conversationId, 'denied');
  state.status = `blocked ${conversation.title}`;
  await refresh();
}

// Live chat filter: printable keys narrow the list, arrows move within the
// matches, Enter keeps the filter, Esc clears it.
async function handleFilterInput(input: string, client: ConeClient, state: ChatState): Promise<void> {
  if (input === KEY.esc) {
    clearFilter(state);
    state.status = 'filter cleared';
    await refreshMessages(client, state);
    return;
  }
  if (isEnter(input)) {
    state.filterActive = false;
    const matches = visibleConversations(state).length;
    state.status = state.filter ? `filter: ${state.filter} (${matches} match${matches === 1 ? '' : 'es'})` : 'filter cleared';
    return;
  }
  if (input === KEY.up) {
    selectConversation(state, -1);
    await refreshMessages(client, state);
    return;
  }
  if (input === KEY.down) {
    selectConversation(state, 1);
    await refreshMessages(client, state);
    return;
  }
  if (input === KEY.ctrlU) {
    state.filter = '';
    state.selectedIndex = 0;
    clampSelections(state);
    await refreshMessages(client, state);
    return;
  }
  if (input === KEY.backspace) {
    state.filter = state.filter.slice(0, -1);
    state.selectedIndex = 0;
    clampSelections(state);
    await refreshMessages(client, state);
    return;
  }
  if (isPrintableInput(input)) {
    state.filter += input;
    state.selectedIndex = 0;
    clampSelections(state);
    await refreshMessages(client, state);
  }
}

function canRetrySync(state: ChatState): boolean {
  return state.syncState === 'stale' || state.streamState === 'offline';
}

// Symmetric toggle: turning receipts off stops sending them and hides peer read
// state. runChat persists the new value to CLI config.
function toggleReadReceipts(state: ChatState): void {
  state.readReceipts = !state.readReceipts;
  if (!state.readReceipts) {
    state.lastAckedByConversation = {};
  }
  state.status = `read receipts ${state.readReceipts ? 'on' : 'off'}`;
}

// Drops the failed (undelivered) optimistic rows for the active conversation —
// the "delete" half of the failed-message choice (Enter is "retry").
function discardFailed(state: ChatState): void {
  const key = composerKey(state);
  const before = state.pendingMessages.length;
  state.pendingMessages = state.pendingMessages.filter((entry) => !(entry.key === key && entry.status === 'failed'));
  state.status = state.pendingMessages.length < before ? 'discarded failed message' : 'nothing to discard';
}

async function handleChatTalkInput(
  input: string,
  client: ConeClient,
  state: ChatState,
  refresh: RefreshChat,
): Promise<void> {
  if (input === KEY.esc) {
    enterChatSelect(state);
    return;
  }
  if (input === KEY.tab || input === KEY.shiftTab) {
    state.status = 'composer focused';
    return;
  }
  if (input === KEY.ctrlU) {
    state.input = '';
    saveDraft(state);
    return;
  }
  if (input === KEY.ctrlW) {
    state.input = deleteLastWord(state.input);
    saveDraft(state);
    return;
  }
  if (input === KEY.ctrlX) {
    discardFailed(state);
    return;
  }
  if (input === KEY.backspace) {
    state.input = state.input.slice(0, -1);
    saveDraft(state);
    return;
  }
  if (isEnter(input)) {
    const text = state.input.trim();
    const conversation = selectedConversation(state);
    const group = conversation?.kind === 'group' ? conversation : undefined;
    const target = sendTargetForState(state);
    const key = composerKey(state);
    if (!text || !key || (!target && !group)) {
      return;
    }
    state.input = '';
    saveDraft(state);
    // Optimistic: the message lands in the transcript immediately. A retried
    // send supersedes any earlier failed row for the same target.
    const pending: PendingMessage = {
      id: `pending-${Date.now()}-${(pendingSequence += 1)}`,
      key,
      sentAt: new Date().toISOString(),
      status: 'sending',
      text,
    };
    state.pendingMessages = [...state.pendingMessages.filter((entry) => !(entry.key === key && entry.status === 'failed')), pending];
    state.status = `sending to ${selectedConversation(state)?.title ?? activeContact(state)?.name}`;
    // Groups are addressed by conversation, not identity.
    void (group ? client.sendToConversation(group.conversationId, text) : client.sendText(target!, text))
      .then(async () => {
        state.pendingMessages = state.pendingMessages.filter((entry) => entry.id !== pending.id);
        state.status = `sent to ${selectedConversation(state)?.title ?? activeContact(state)?.name}`;
        await refresh();
      })
      .catch(async (error: unknown) => {
        state.pendingMessages = state.pendingMessages.map((entry) =>
          entry.id === pending.id ? { ...entry, status: 'failed' as const } : entry,
        );
        // Restore for retry only if the composer is still empty and pointed
        // at the same chat — never clobber newer typing.
        if (!state.input && composerKey(state) === key) {
          state.input = text;
          saveDraft(state);
        }
        state.status = `send failed: ${errorMessage(error)} — Enter retries`;
        await refresh({ preserveScroll: true });
      });
    return;
  }
  if (isPrintableInput(input)) {
    state.input += input;
    saveDraft(state);
  }
}

let pendingSequence = 0;

async function handleChatComposeInput(
  input: string,
  client: ConeClient,
  state: ChatState,
  refresh: RefreshChat,
): Promise<void> {
  const form = state.editForm;
  if (!form) {
    enterChatSelect(state);
    return;
  }
  if (input === KEY.esc) {
    enterChatSelect(state);
    state.status = 'cancelled';
    return;
  }
  if (input === KEY.up || input === KEY.down) {
    if (form.kind === 'timer') {
      cycleTimerChoice(form, input === KEY.up ? -1 : 1);
      return;
    }
    applyMessageTargetSuggestion(form, state, input === KEY.up ? -1 : 1);
    return;
  }
  if (isEnter(input)) {
    if (form.kind === 'conversation-delete') {
      await submitDeleteConversation(client, state, refresh);
      return;
    }
    if (form.kind === 'name-peer') {
      await submitNamePeer(client, state, refresh);
      return;
    }
    if (form.kind === 'timer') {
      await submitTimer(client, state, refresh);
      return;
    }
    if (form.kind === 'message' && form.fields[form.activeField]?.key === 'to') {
      acceptMessageTargetSuggestion(form, state);
      form.activeField = Math.min(1, form.fields.length - 1);
      return;
    }
    await submitNewMessage(client, state, refresh);
    return;
  }
  editFormField(input, form);
}

// 'off' plus the shared presets, cycled with Up/Down in the timer form. Typed
// free text that matches a choice stays in the cycle; anything else restarts it.
const TIMER_CHOICES = ['off', ...RETENTION_PRESETS_MS.map((durationMs) => formatRetention(durationMs))];

function cycleTimerChoice(form: ContactEditForm, delta: number): void {
  const field = form.fields[form.activeField];
  if (!field) {
    return;
  }
  const currentIndex = TIMER_CHOICES.indexOf(field.value.trim().toLowerCase());
  const nextIndex = currentIndex === -1
    ? (delta > 0 ? 0 : TIMER_CHOICES.length - 1)
    : (currentIndex + delta + TIMER_CHOICES.length) % TIMER_CHOICES.length;
  field.value = TIMER_CHOICES[nextIndex]!;
  form.error = undefined;
}

// Apply the timer to both sides via XMTP settings (mirror-first in the client).
async function submitTimer(client: ConeClient, state: ChatState, refresh: RefreshChat): Promise<void> {
  const form = state.editForm;
  if (!form || !form.targetConversationId) {
    return;
  }
  let durationMs: number | null;
  try {
    durationMs = parseRetention(formValue(form, 'duration') || 'off');
  } catch (error) {
    form.error = errorMessage(error);
    return;
  }
  await client.setRetention(form.targetConversationId, durationMs);
  enterChatSelect(state);
  state.status = durationMs === null ? 'disappearing messages off' : `disappearing messages: ${formatRetention(durationMs)}`;
  await refresh();
}

// Save the active conversation's peer as a (named) contact. saveContact dedupes
// by inbox, so this creates a contact or renames the existing one; the chat then
// shows the name instead of the raw inbox ID.
async function submitNamePeer(client: ConeClient, state: ChatState, refresh: RefreshChat): Promise<void> {
  const form = state.editForm;
  if (!form || !form.targetConversationId) {
    return;
  }
  const conversation = state.conversations.find((candidate) => candidate.conversationId === form.targetConversationId);
  if (!conversation) {
    form.error = 'Chat no longer exists.';
    return;
  }
  const name = formValue(form, 'name');
  if (!name) {
    form.error = 'Name is required.';
    return;
  }
  await client.saveContact({ name, inboxId: conversation.peerInboxId, address: conversation.peerAddress, source: 'manual' });
  state.status = `named ${name}`;
  enterChatSelect(state);
  await refresh();
}

async function handleContactsSelectInput(
  input: string,
  client: ConeClient,
  state: ChatState,
  quit: () => Promise<void>,
): Promise<void> {
  if (input === 'q') {
    await quit();
    return;
  }
  if (input === '?') {
    state.helpVisible = true;
    state.status = 'help';
    return;
  }
  if (input === 'R') {
    toggleReadReceipts(state);
    return;
  }
  if (input === 'a') {
    startContactsEdit(state, createAddContactForm());
    return;
  }
  if (input === 'c') {
    const created = await client.createHandshakeCode();
    startContactsEdit(state, createPairCreateResultForm(created.code, created.expiresAt));
    state.status = 'created pairing code';
    return;
  }
  if (input === 'p') {
    startContactsEdit(state, createPairJoinForm());
    return;
  }
  if (input === 'r') {
    const contact = selectedContact(state);
    if (!contact) {
      state.status = 'no contact selected';
      return;
    }
    startContactsEdit(state, createRenameContactForm(contact));
    return;
  }
  if (input === 'd') {
    const contact = selectedContact(state);
    if (!contact) {
      state.status = 'no contact selected';
      return;
    }
    startContactsEdit(state, createDeleteContactForm(contact));
    return;
  }
  if (input === KEY.up || input === 'k') {
    selectContact(state, -1);
    return;
  }
  if (input === KEY.down || input === 'j') {
    selectContact(state, 1);
    return;
  }
  if (isEnter(input)) {
    enterChatForSelectedContact(state);
    await refreshMessages(client, state);
    return;
  }
}

async function handleContactsEditInput(
  input: string,
  client: ConeClient,
  state: ChatState,
  refresh: RefreshChat,
): Promise<void> {
  const form = state.editForm;
  if (!form) {
    enterContactsSelect(state);
    return;
  }
  if (input === KEY.esc) {
    enterContactsSelect(state);
    state.status = 'cancelled';
    return;
  }
  // While pairing runs in the background, the only useful key is Esc (leave);
  // ignore everything else so a stray Enter can't re-submit.
  if (form.pending) {
    return;
  }
  if (isEnter(input)) {
    await submitContactEditForm(client, state, refresh);
    return;
  }
  if (form.resultLines && form.resultLines.length > 0) {
    return;
  }
  editFormField(input, form);
}

function editFormField(input: string, form: ContactEditForm): void {
  if (input === KEY.tab) {
    if (form.fields.length > 0) {
      form.activeField = (form.activeField + 1) % form.fields.length;
    }
    form.error = undefined;
    return;
  }
  if (input === KEY.shiftTab) {
    if (form.fields.length > 0) {
      form.activeField = (form.activeField - 1 + form.fields.length) % form.fields.length;
    }
    form.error = undefined;
    return;
  }

  const field = form.fields[form.activeField];
  if (!field) {
    return;
  }
  if (input === KEY.ctrlU) {
    field.value = '';
    form.error = undefined;
    return;
  }
  if (input === KEY.ctrlW) {
    field.value = deleteLastWord(field.value);
    form.error = undefined;
    return;
  }
  if (input === KEY.backspace) {
    field.value = field.value.slice(0, -1);
    form.error = undefined;
    return;
  }
  if (isPrintableInput(input)) {
    field.value += input;
    form.error = undefined;
  }
}

async function submitContactEditForm(client: ConeClient, state: ChatState, refresh: RefreshChat): Promise<void> {
  const form = state.editForm;
  if (!form) {
    return;
  }
  if (form.resultLines && form.resultLines.length > 0) {
    enterContactsSelect(state);
    return;
  }

  if (form.kind === 'add') {
    await submitAddContact(client, state, refresh);
    return;
  }
  if (form.kind === 'conversation-delete') {
    await submitDeleteConversation(client, state, refresh);
    return;
  }
  if (form.kind === 'rename') {
    await submitRenameContact(client, state, refresh);
    return;
  }
  if (form.kind === 'delete') {
    await submitDeleteContact(client, state, refresh);
    return;
  }
  if (form.kind === 'pair-create') {
    enterContactsSelect(state);
    return;
  }
  submitPairJoin(client, state, refresh);
}

async function submitNewMessage(client: ConeClient, state: ChatState, refresh: RefreshChat): Promise<void> {
  const form = state.editForm;
  if (!form) {
    return;
  }
  const to = formValue(form, 'to');
  const text = formValue(form, 'message');
  if (!to || !text) {
    form.error = 'To and message are required.';
    return;
  }

  const sent = await client.sendText(to, text);
  state.status = `sent to ${to}`;
  enterChatSelect(state);
  clearFilter(state);
  await refresh();
  if (sent.conversationId) {
    const conversationIndex = visibleConversations(state).findIndex((conversation) => conversation.conversationId === sent.conversationId);
    if (conversationIndex >= 0) {
      state.selectedIndex = conversationIndex;
      await refreshMessages(client, state);
    }
  }
}

async function submitDeleteConversation(client: ConeClient, state: ChatState, refresh: RefreshChat): Promise<void> {
  const form = state.editForm;
  if (!form || !form.targetConversationId) {
    return;
  }
  const conversation = state.conversations.find((candidate) => candidate.conversationId === form.targetConversationId);
  if (!conversation) {
    form.error = 'Chat no longer exists.';
    return;
  }
  if (formValue(form, 'confirm') !== 'DELETE') {
    form.error = 'Type DELETE to confirm.';
    return;
  }

  await client.deleteConversation(conversation.conversationId);
  enterChatSelect(state);
  state.status = `deleted local chat ${conversation.title}`;
  await refresh();
}

async function submitAddContact(client: ConeClient, state: ChatState, refresh: RefreshChat): Promise<void> {
  const form = state.editForm;
  if (!form) {
    return;
  }
  const name = formValue(form, 'name');
  const identity = formValue(form, 'identity');
  if (!name || !identity) {
    form.error = 'Name and identity are required.';
    return;
  }
  const resolved = await client.resolveIdentity(identity);
  await client.saveContact({ address: resolved.address, inboxId: resolved.inboxId, name });
  state.status = `saved ${name}`;
  enterContactsSelect(state);
  await refresh();
}

async function submitRenameContact(client: ConeClient, state: ChatState, refresh: RefreshChat): Promise<void> {
  const form = state.editForm;
  if (!form) {
    return;
  }
  const contact = formContact(state, form.targetContactId);
  const name = formValue(form, 'name');
  if (!contact || !name) {
    form.error = contact ? 'Name is required.' : 'Contact no longer exists.';
    return;
  }
  await client.saveContact({ address: contact.address, inboxId: contact.inboxId, name, source: contact.source });
  state.status = `renamed to ${name}`;
  enterContactsSelect(state);
  await refresh();
}

async function submitDeleteContact(client: ConeClient, state: ChatState, refresh: RefreshChat): Promise<void> {
  const form = state.editForm;
  if (!form) {
    return;
  }
  const contact = formContact(state, form.targetContactId);
  if (!contact) {
    form.error = 'Contact no longer exists.';
    return;
  }
  if (formValue(form, 'confirm') !== 'DELETE') {
    form.error = 'Type DELETE to confirm.';
    return;
  }
  await client.deleteContact(contact.contactId);
  state.status = `deleted ${contact.name}`;
  enterContactsSelect(state);
  await refresh();
}

// Pairing blocks on the rendezvous for up to a minute. We must NOT await it in
// the input handler — that would freeze the whole TUI. Instead we kick it off
// in the background, show a waiting line, and reconcile when it settles.
function submitPairJoin(client: ConeClient, state: ChatState, refresh: RefreshChat): void {
  const form = state.editForm;
  if (!form || form.pending) {
    return;
  }

  const code = formValue(form, 'code');
  if (!code) {
    form.error = 'Handshake code is required.';
    return;
  }

  const shareName = formValue(form, 'shareName') || undefined;
  const saveAs = formValue(form, 'saveAs');
  form.pending = true;
  form.error = undefined;
  state.status = 'pairing… waiting for the other side (up to 60s)';

  void client.pairWithCode(code, { proposedName: shareName })
    .then(async (result) => {
      const contact = saveAs
        ? await client.saveContact({
            address: result.contact.address,
            inboxId: result.contact.inboxId,
            name: saveAs,
            source: 'paired',
          })
        : result.contact;
      // The user may have left the form while we waited; only touch it if it's
      // still the same one. The pairing (and saved contact) stands regardless.
      if (state.editForm === form) {
        form.pending = false;
        form.resultLines = [
          `Paired with ${contact.name}.`,
          `Inbox ${shortId(contact.inboxId)}`,
          `Confirmation sent: ${result.sentConfirmation ? 'yes' : 'no'}`,
        ];
      }
      state.status = `paired with ${contact.name}`;
      await refresh();
    })
    .catch(async (error: unknown) => {
      if (state.editForm === form) {
        form.pending = false;
        form.error = `Pairing failed: ${errorMessage(error)}`;
      }
      state.status = `pairing failed: ${errorMessage(error)}`;
      await refresh();
    });
}

function formContact(state: ChatState, contactId: string | undefined): Contact | undefined {
  return contactId ? state.contacts.find((candidate) => candidate.contactId === contactId) : undefined;
}

function applyMessageTargetSuggestion(form: ContactEditForm, state: ChatState, delta: number): void {
  const field = form.fields[form.activeField];
  if (form.kind !== 'message' || field?.key !== 'to') {
    return;
  }
  const suggestions = messageTargetValues(state, field.value);
  if (suggestions.length === 0) {
    return;
  }
  const currentIndex = Math.max(0, suggestions.findIndex((suggestion) => suggestion.value === field.value));
  const nextIndex = (currentIndex + delta + suggestions.length) % suggestions.length;
  field.value = suggestions[nextIndex]!.value;
  form.error = undefined;
}

function acceptMessageTargetSuggestion(form: ContactEditForm, state: ChatState): void {
  const field = form.fields[form.activeField];
  if (form.kind !== 'message' || field?.key !== 'to') {
    return;
  }
  const [suggestion] = messageTargetValues(state, field.value);
  if (suggestion && !exactMessageTargetMatch(state, field.value)) {
    field.value = suggestion.value;
  }
  form.error = undefined;
}

function messageTargetValues(state: ChatState, query: string): Array<{ label: string; value: string }> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const values = new Map<string, { label: string; value: string }>();
  for (const contact of state.contacts) {
    values.set(contact.name.toLocaleLowerCase(), { label: contact.name, value: contact.name });
  }
  for (const conversation of state.conversations) {
    values.set(conversation.title.toLocaleLowerCase(), { label: conversation.title, value: conversation.title });
  }
  return Array.from(values.values())
    .filter((suggestion) => !normalizedQuery || suggestion.label.toLocaleLowerCase().includes(normalizedQuery))
    .slice(0, 5);
}

function exactMessageTargetMatch(state: ChatState, value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase();
  return state.contacts.some((contact) => contact.name.toLocaleLowerCase() === normalized) ||
    state.conversations.some((conversation) => conversation.title.toLocaleLowerCase() === normalized);
}
