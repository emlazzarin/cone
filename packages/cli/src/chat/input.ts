import type { ConeClient, Contact } from '@cone/core';

import {
  createAddContactForm,
  createDeleteContactForm,
  createDeleteConversationForm,
  createNewMessageForm,
  createPairCreateResultForm,
  createPairJoinForm,
  createRenameContactForm,
  formValue,
} from './forms';
import {
  activeContact,
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
} from './state';
import type { ChatState, ContactEditForm, RefreshChat, SyncNow } from './types';
import { deleteLastWord, errorMessage, isChatsShortcut, isContactsShortcut, isPrintableInput, shortId } from './text';

export async function handleInput(
  input: string,
  client: ConeClient,
  state: ChatState,
  refresh: RefreshChat,
  syncNow: SyncNow,
  quit: () => Promise<void>,
): Promise<void> {
  if (input === '\u0003') {
    await quit();
    return;
  }
  if (state.helpVisible) {
    if (input === '\u001b' || input === '?') {
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
  if ((state.mode === 'chat-select' || state.mode === 'chat-talk') && (input === '\u001b[5~' || input === '\u0002')) {
    state.transcriptScroll += 5;
    state.status = `scroll +${state.transcriptScroll}`;
    return;
  }
  if ((state.mode === 'chat-select' || state.mode === 'chat-talk') && (input === '\u001b[6~' || input === '\u0006')) {
    state.transcriptScroll = Math.max(0, state.transcriptScroll - 5);
    state.status = state.transcriptScroll === 0 ? 'bottom' : `scroll +${state.transcriptScroll}`;
    return;
  }

  if (state.mode === 'chat-select') {
    await handleChatSelectInput(input, client, state, syncNow, quit);
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
  syncNow: SyncNow,
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
  if (input === '\u001b[A' || input === 'k') {
    selectConversation(state, -1);
    await refreshMessages(client, state);
    return;
  }
  if (input === '\u001b[B' || input === 'j') {
    selectConversation(state, 1);
    await refreshMessages(client, state);
    return;
  }
  if (input === '\r' || input === '\n') {
    if (!selectedConversation(state)) {
      state.status = 'no chat selected';
      return;
    }
    enterChatTalk(state);
  }
}

function canRetrySync(state: ChatState): boolean {
  return state.syncState === 'stale' || state.streamState === 'offline';
}

async function handleChatTalkInput(
  input: string,
  client: ConeClient,
  state: ChatState,
  refresh: RefreshChat,
): Promise<void> {
  if (input === '\u001b') {
    enterChatSelect(state);
    return;
  }
  if (input === '\t' || input === '\u001b[Z') {
    state.status = 'composer focused';
    return;
  }
  if (input === '\u0015') {
    state.input = '';
    saveDraft(state);
    return;
  }
  if (input === '\u0017') {
    state.input = deleteLastWord(state.input);
    saveDraft(state);
    return;
  }
  if (input === '\u007f') {
    state.input = state.input.slice(0, -1);
    saveDraft(state);
    return;
  }
  if (input === '\r' || input === '\n') {
    const text = state.input.trim();
    const target = sendTargetForState(state);
    if (!text || !target) {
      return;
    }
    state.input = '';
    saveDraft(state);
    state.status = `sending to ${selectedConversation(state)?.title ?? activeContact(state)?.name}`;
    void client.sendText(target, text)
      .then(async () => {
        state.status = `sent to ${selectedConversation(state)?.title ?? activeContact(state)?.name}`;
        await refresh();
      })
      .catch(async (error: unknown) => {
        state.input = text;
        saveDraft(state);
        state.status = `send failed: ${errorMessage(error)}`;
        await refresh({ preserveScroll: true });
      });
    return;
  }
  if (isPrintableInput(input)) {
    state.input += input;
    saveDraft(state);
  }
}

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
  if (input === '\u001b') {
    enterChatSelect(state);
    state.status = 'cancelled';
    return;
  }
  if (input === '\u001b[A' || input === '\u001b[B') {
    applyMessageTargetSuggestion(form, state, input === '\u001b[A' ? -1 : 1);
    return;
  }
  if (input === '\r' || input === '\n') {
    if (form.kind === 'conversation-delete') {
      await submitDeleteConversation(client, state, refresh);
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
  if (input === '\u001b[A' || input === 'k') {
    selectContact(state, -1);
    return;
  }
  if (input === '\u001b[B' || input === 'j') {
    selectContact(state, 1);
    return;
  }
  if (input === '\r' || input === '\n') {
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
  if (input === '\u001b') {
    enterContactsSelect(state);
    state.status = 'cancelled';
    return;
  }
  if (input === '\r' || input === '\n') {
    await submitContactEditForm(client, state, refresh);
    return;
  }
  if (form.resultLines && form.resultLines.length > 0) {
    return;
  }
  editFormField(input, form);
}

function editFormField(input: string, form: ContactEditForm): void {
  if (input === '\t') {
    if (form.fields.length > 0) {
      form.activeField = (form.activeField + 1) % form.fields.length;
    }
    form.error = undefined;
    return;
  }
  if (input === '\u001b[Z') {
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
  if (input === '\u0015') {
    field.value = '';
    form.error = undefined;
    return;
  }
  if (input === '\u0017') {
    field.value = deleteLastWord(field.value);
    form.error = undefined;
    return;
  }
  if (input === '\u007f') {
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
  await submitPairJoin(client, state, refresh);
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
  await refresh();
  if (sent.conversationId) {
    const conversationIndex = state.conversations.findIndex((conversation) => conversation.conversationId === sent.conversationId);
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

async function submitPairJoin(client: ConeClient, state: ChatState, refresh: RefreshChat): Promise<void> {
  const form = state.editForm;
  if (!form) {
    return;
  }

  const code = formValue(form, 'code');
  if (!code) {
    form.error = 'Handshake code is required.';
    return;
  }

  const result = await client.pairWithCode(code, { proposedName: formValue(form, 'shareName') || undefined });
  const saveAs = formValue(form, 'saveAs');
  const contact = saveAs
    ? await client.saveContact({
        address: result.contact.address,
        inboxId: result.contact.inboxId,
        name: saveAs,
        source: 'paired',
      })
    : result.contact;

  form.resultLines = [
    `Paired with ${contact.name}.`,
    `Inbox ${shortId(contact.inboxId)}`,
    `Confirmation sent: ${result.sentConfirmation ? 'yes' : 'no'}`,
  ];
  state.status = `paired with ${contact.name}`;
  await refresh();
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
