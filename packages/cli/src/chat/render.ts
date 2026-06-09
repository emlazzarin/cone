import { formatConnectionStatus, type ConeConnectionStatus, type ConeConversation, type ConeMessage } from '@cone/core';

import { activeContact, isContactsMode, selectedContact, selectedConversation } from './state';
import type { ChatMode, ChatState } from './types';
import { accent, dim, ESC, formatTime, highlight, inputField, inverse, messageBody, pad, shortId, stripAnsi, tailLine, wrapText } from './text';

export function renderChat(state: ChatState, width: number, height: number): string {
  if (width < 50 || height < 10) {
    return `${ESC}2J${ESC}H${inverse(' Cone of Silence '.slice(0, Math.max(1, width)))}\nterminal too small for cos chat\n`;
  }

  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const leftWidth = Math.min(32, Math.max(22, Math.floor(safeWidth * 0.25)));
  const mainWidth = safeWidth - leftWidth - 1;
  const bodyHeight = safeHeight - 4;
  const lines: string[] = [];

  lines.push(`${ESC}2J${ESC}H${ESC}?25l`);
  lines.push(topBar(state, safeWidth));
  for (let row = 0; row < bodyHeight; row += 1) {
    const left = isContactsMode(state)
      ? renderContactRow(state, row, leftWidth, bodyHeight)
      : renderConversationRow(state, row, leftWidth, bodyHeight);
    const right = renderMainRow(state, row, mainWidth, bodyHeight);
    lines.push(`${left}|${right}`);
  }
  lines.push(inputLine(state, safeWidth));
  lines.push(footerLine(state, safeWidth));
  return `${lines.join('\n')}\n`;
}

function topBar(state: ChatState, width: number): string {
  const selected = isContactsMode(state)
    ? selectedContact(state)?.name ?? 'contacts'
    : state.mode === 'chat-compose'
      ? 'new message'
      : activeContact(state)?.name ?? selectedConversation(state)?.title ?? 'inbox';
  const unread = Object.values(state.unreadByConversation).reduce((sum, count) => sum + count, 0);
  const connection = formatConnectionStatus(connectionStatusForState(state));
  const unreadLabel = unread > 0 ? `${unread} unread` : '0 unread';
  const parts = [
    'Cone of Silence',
    '1 Chats',
    '2 Contacts',
    modeLabel(state.mode),
    `acct ${shortId(state.identity.inboxId)}`,
    state.identity.env,
    connection,
    unreadLabel,
    selected,
  ];
  return inverse(` ${parts.join(' | ')} `.slice(0, width));
}

function renderConversationRow(state: ChatState, row: number, width: number, bodyHeight: number): string {
  if (row === 0) {
    return pad('[conversations]', width);
  }
  if (state.conversations.length === 0) {
    const empty = ['no chats yet', 'n new message', '2 contacts + pairing'];
    return pad(dim(empty[row - 1] ?? ''), width);
  }
  const start = visibleStart(state.selectedIndex, state.conversations.length, bodyHeight - 1);
  const conversationIndex = start + row - 1;
  const conversation = state.conversations[conversationIndex];
  if (!conversation) {
    return pad('', width);
  }
  const unread = (state.unreadByConversation[conversation.conversationId] ?? 0) + (conversation.unreadCount ?? 0);
  const marker = conversationIndex === state.selectedIndex ? '>' : ' ';
  const label = `${marker} ${unread > 0 ? `!${unread} ` : ''}${conversation.title}`;
  return pad(conversationIndex === state.selectedIndex ? highlight(label) : label, width);
}

function renderContactRow(state: ChatState, row: number, width: number, bodyHeight: number): string {
  if (row === 0) {
    return pad('[contacts]', width);
  }
  if (state.contacts.length === 0) {
    const empty = ['no contacts yet', 'a add contact', 'c create code', 'p join code'];
    return pad(dim(empty[row - 1] ?? ''), width);
  }
  const start = visibleStart(state.selectedContactIndex, state.contacts.length, bodyHeight - 1);
  const contactIndex = start + row - 1;
  const contact = state.contacts[contactIndex];
  if (!contact) {
    return pad('', width);
  }
  const marker = contactIndex === state.selectedContactIndex ? '>' : ' ';
  const label = `${marker} ${contact.name}`;
  return pad(contactIndex === state.selectedContactIndex ? highlight(label) : label, width);
}

function renderMainRow(state: ChatState, row: number, width: number, bodyHeight: number): string {
  if (state.helpVisible) {
    return renderHelpRow(state, row, width);
  }
  if (state.mode === 'contacts-select') {
    return renderContactDetailRow(state, row, width);
  }
  if (state.mode === 'contacts-edit' || state.mode === 'chat-compose') {
    return renderEditFormRow(state, row, width);
  }
  return renderThreadRow(state, row, width, bodyHeight);
}

function renderThreadRow(state: ChatState, row: number, width: number, bodyHeight: number): string {
  const conversation = selectedConversation(state);
  const contact = activeContact(state);
  if (row === 0) {
    const unread = conversation ? state.unreadByConversation[conversation.conversationId] ?? 0 : 0;
    const title = conversation
      ? `${conversation.title} ${dim(shortId(conversation.peerInboxId))}`
      : contact
        ? `${contact.name} ${dim('new chat')}`
        : 'no chat selected';
    const scroll = state.transcriptScroll > 0 ? ` ${dim(`scroll +${state.transcriptScroll}`)}` : '';
    const newBelow = unread > 0 ? ` ${accent(`${unread} new`)}` : '';
    return pad(`[${title}]${scroll}${newBelow}`, width);
  }
  if (!conversation && !contact) {
    const emptyLines = [
      'No selected chat.',
      'n starts a structured message to a contact, inbox ID, or EVM address.',
      '2 opens contacts for address-book edits and pairing.',
    ];
    return pad(emptyLines[row - 1] ?? '', width);
  }

  const rows = conversation
    ? transcriptRows(state.messages, conversation, width)
    : ['No messages yet. Press Enter to talk, type Message, then Enter to send.'];
  const available = bodyHeight - 1;
  const scroll = Math.min(state.transcriptScroll, Math.max(0, rows.length - available));
  const bottom = Math.max(0, rows.length - scroll);
  const start = Math.max(0, bottom - available);
  return pad(rows.slice(start, bottom)[row - 1] ?? '', width);
}

function renderContactDetailRow(state: ChatState, row: number, width: number): string {
  const contact = selectedContact(state);
  if (row === 0) {
    return pad('[contact]', width);
  }
  if (!contact) {
    const empty = [
      'No contacts yet.',
      'a add contact',
      'c create pairing code',
      'p join pairing code',
    ];
    return pad(empty[row - 1] ?? '', width);
  }
  const lines = [
    contact.name,
    `Inbox ID: ${contact.inboxId}`,
    `EVM address: ${contact.address ?? 'unknown'}`,
    `Source: ${contact.source}`,
    `Created: ${contact.createdAt}`,
    `Updated: ${contact.updatedAt}`,
  ];
  return pad(lines[row - 1] ?? '', width);
}

function renderEditFormRow(state: ChatState, row: number, width: number): string {
  const form = state.editForm;
  if (!form) {
    return pad('', width);
  }
  if (row === 0) {
    return pad(`[${form.title}]`, width);
  }
  if (form.resultLines && row <= form.resultLines.length) {
    return pad(form.resultLines[row - 1] ?? '', width);
  }
  const field = form.fields[row - 1];
  if (field) {
    const active = row - 1 === form.activeField ? '>' : ' ';
    return pad(`${active} ${field.label}: ${field.value}`, width);
  }

  const suggestions = form.kind === 'message' ? messageTargetSuggestions(state) : [];
  const suggestionsStart = form.fields.length + 1;
  if (suggestions.length > 0 && row === suggestionsStart) {
    return pad(dim('Suggestions from contacts and conversations:'), width);
  }
  if (suggestions.length > 0) {
    const suggestion = suggestions[row - suggestionsStart - 1];
    if (suggestion) {
      return pad(`  ${suggestion}`, width);
    }
  }

  const errorRow = form.fields.length + (suggestions.length > 0 ? suggestions.length + 2 : 2);
  if (form.error && row === errorRow) {
    return pad(`Error: ${form.error}`, width);
  }
  return pad('', width);
}

function inputLine(state: ChatState, width: number): string {
  if (state.mode === 'chat-talk') {
    return composerLine(state, width);
  }
  if (state.mode === 'contacts-edit' || state.mode === 'chat-compose') {
    const field = state.editForm?.fields[state.editForm.activeField];
    if (!field) {
      return `status: ${state.status}`.slice(0, width);
    }
    return tailLine(`${field.label}: ${field.value}`, width);
  }
  return `status: ${state.status}`.slice(0, width);
}

function footerLine(state: ChatState, width: number): string {
  if (state.helpVisible) {
    return inverse(' Esc close help | ? close help '.slice(0, width));
  }
  const retrySync = state.syncState === 'stale' || state.streamState === 'offline';
  const text = state.mode === 'chat-select'
    ? ` j/k move | Enter talk | n new message | d delete local chat | 2 contacts${retrySync ? ' | s retry sync' : ''} | ? help | q quit `
    : state.mode === 'chat-talk'
      ? ' Enter send | Esc chat list | 2 contacts | Ctrl+U clear | Ctrl+W delete word '
    : state.mode === 'chat-compose'
        ? chatComposeFooter(state)
        : state.mode === 'contacts-select'
          ? ' j/k move | Enter talk | a add | r rename | d delete | c code | p join code | 1 chats | ? help | q quit '
          : state.editForm?.resultLines?.length
            ? ' Enter done | Esc done '
            : ` Tab next field | Shift+Tab previous | Enter ${state.editForm?.submitLabel ?? 'save'} | Esc cancel `;
  return inverse(text.slice(0, width));
}

function visibleStart(selectedIndex: number, count: number, visibleRows: number): number {
  if (count <= visibleRows) {
    return 0;
  }
  return Math.min(Math.max(0, selectedIndex - visibleRows + 1), count - visibleRows);
}

function transcriptRows(messages: ConeMessage[], conversation: ConeConversation, width: number): string[] {
  if (messages.length === 0) {
    return ['No local messages yet. New messages stream in automatically.'];
  }

  const rows: string[] = [];
  for (const message of messages) {
    const sender = message.direction === 'outbound' ? 'me' : conversation.title;
    const prefix = `${formatTime(message.sentAt)} - ${sender}: `;
    const body = messageBody(message);
    const wrapped = wrapText(body, Math.max(10, width - stripAnsi(prefix).length));
    rows.push(`${prefix}${wrapped[0] ?? ''}`);
    for (const continuation of wrapped.slice(1)) {
      rows.push(`${' '.repeat(stripAnsi(prefix).length)}${continuation}`);
    }
  }
  return rows;
}

function renderHelpRow(state: ChatState, row: number, width: number): string {
  const title = modeLabel(state.mode);
  const lines = [
    `[help: ${title}]`,
    'j/k or arrows move selection in list modes.',
    'Enter talks to the selected chat/contact or submits the current form.',
    'Esc leaves writing/form modes and closes this help.',
    '1 opens chats. 2 opens contacts. Ctrl+1/Ctrl+2 also work when your terminal emits them.',
    'n starts a structured new message from Chats.',
    'Chats: d deletes the local cached chat after confirmation.',
    'Contacts: a add, r rename, d delete, c create code, p join code.',
    'Realtime stream stays on; s only appears when sync/stream needs retry.',
  ];
  return pad(lines[row] ?? '', width);
}

function chatComposeFooter(state: ChatState): string {
  const activeField = state.editForm?.fields[state.editForm.activeField];
  if (state.editForm?.kind === 'message' && activeField?.key === 'to') {
    return ' Up/Down choose target | Enter accept target | Tab message | Esc cancel ';
  }
  if (state.editForm?.kind === 'message') {
    return ' Enter send | Tab target | Shift+Tab target | Esc cancel ';
  }
  return ` Enter ${state.editForm?.submitLabel ?? 'save'} | Esc cancel `;
}

function modeLabel(mode: ChatMode): string {
  if (mode === 'chat-select') {
    return 'Chats select';
  }
  if (mode === 'chat-talk') {
    return 'Chat talk';
  }
  if (mode === 'chat-compose') {
    return 'New message';
  }
  if (mode === 'contacts-select') {
    return 'Contacts';
  }
  return 'Editing';
}

function composerLine(state: ChatState, width: number): string {
  const label = 'Message: ';
  const boxWidth = Math.max(4, width - label.length - 4);
  const rawValue = state.input;
  const visibleValue = rawValue.length >= boxWidth ? rawValue.slice(rawValue.length - boxWidth + 1) : rawValue;
  const cursor = '█';
  const content = `${visibleValue}${cursor}`;
  const paddedContent = ` ${content}${' '.repeat(Math.max(0, boxWidth - content.length))} `;
  return pad(`${label}${accent('[')}${inputField(paddedContent)}${accent(']')}`, width);
}

function connectionStatusForState(state: ChatState): ConeConnectionStatus {
  if (state.syncState === 'syncing') {
    return 'catching-up';
  }
  if (state.syncState === 'stale') {
    return 'stale';
  }
  if (state.streamState === 'offline') {
    return 'offline';
  }
  if (state.streamState === 'online') {
    return 'live';
  }
  return 'connecting';
}

function messageTargetSuggestions(state: ChatState): string[] {
  const query = formFieldValue(state, 'to').toLocaleLowerCase();
  const entries = new Map<string, string>();
  for (const contact of state.contacts) {
    entries.set(contact.name.toLocaleLowerCase(), `${contact.name} ${dim(`contact ${shortId(contact.inboxId)}`)}`);
  }
  for (const conversation of state.conversations) {
    entries.set(conversation.title.toLocaleLowerCase(), `${conversation.title} ${dim(`chat ${shortId(conversation.peerInboxId)}`)}`);
  }
  return Array.from(entries.entries())
    .filter(([key]) => !query || key.includes(query))
    .slice(0, 5)
    .map(([key, label]) => {
      const marker = key === query ? '>' : ' ';
      return `${marker} ${label}`;
    });
}

function formFieldValue(state: ChatState, key: string): string {
  return state.editForm?.fields.find((field) => field.key === key)?.value.trim() ?? '';
}
