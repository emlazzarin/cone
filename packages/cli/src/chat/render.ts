import {
  formatConnectionStatus,
  formatTranscriptTime,
  isVisibleChatMessage,
  latestReadOutboundId,
  matchesPendingSend,
  messageBody,
  relativeTime,
  type ConeConnectionStatus,
  type ConeConversation,
} from '@cone/core';

import { activeContact, composerKey, conversationActivityAt, isContactsMode, selectedContact, selectedConversation, visibleConversations } from './state';
import type { ChatMode, ChatState } from './types';
import { CSI, accent, danger, dim, ellipsize, highlight, inputField, inverse, pad, shortId, stripAnsi, success, tailLine, wrapText } from './text';

export function renderChat(state: ChatState, width: number, height: number): string {
  if (width < 50 || height < 10) {
    return `${CSI}2J${CSI}H${inverse(' Cone of Silence '.slice(0, Math.max(1, width)))}\nterminal too small for cos chat\n`;
  }

  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const leftWidth = Math.min(32, Math.max(22, Math.floor(safeWidth * 0.25)));
  const mainWidth = safeWidth - leftWidth - 1;
  const bodyHeight = safeHeight - 4;
  const lines: string[] = [];

  lines.push(`${CSI}2J${CSI}H${CSI}?25l`);
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

// Mirrors the PWA top bar: brand·env, tabs, connection (+ new count when
// non-zero), current context, own identity last so narrow terminals lose the
// least important cell first. Modes are expressed by the footer and input
// line, not a dedicated label.
function topBar(state: ChatState, width: number): string {
  const context = isContactsMode(state)
    ? selectedContact(state)?.name ?? 'contacts'
    : state.mode === 'chat-compose'
      ? state.editForm?.title ?? 'New message'
      : activeContact(state)?.name ?? selectedConversation(state)?.title ?? 'chats';
  const unread = Object.values(state.unreadByConversation).reduce((sum, count) => sum + count, 0);
  const connection = formatConnectionStatus(connectionStatusForState(state));
  const parts = [
    `Cone of Silence ·${state.identity.env}`,
    '1 Chats',
    '2 Contacts',
    unread > 0 ? `${connection} · ${unread} new` : connection,
    ...(state.readReceipts ? [] : ['receipts off']),
    context,
    `you ${shortId(state.identity.inboxId)}`,
  ];
  return inverse(` ${parts.join(' | ')} `.slice(0, width));
}

// Two rows per chat, like the PWA list: name + relative time, then the last
// message preview + unread count.
function renderConversationRow(state: ChatState, row: number, width: number, bodyHeight: number): string {
  const conversations = visibleConversations(state);
  if (row === 0) {
    const heading = state.filter || state.filterActive
      ? `[chats /${state.filter} ${conversations.length}/${state.conversations.length}]`
      : '[chats]';
    return pad(heading, width);
  }
  if (conversations.length === 0) {
    const empty = state.filter
      ? ['no chats match', 'Esc clears the filter']
      : ['no chats yet', 'n new message', '2 contacts + pairing'];
    return pad(dim(empty[row - 1] ?? ''), width);
  }

  const visiblePairs = Math.max(1, Math.floor((bodyHeight - 1) / 2));
  const start = visibleStart(state.selectedIndex, conversations.length, visiblePairs);
  const conversationIndex = start + Math.floor((row - 1) / 2);
  const conversation = conversations[conversationIndex];
  if (!conversation || conversationIndex >= start + visiblePairs) {
    return pad('', width);
  }
  const selected = conversationIndex === state.selectedIndex;

  if ((row - 1) % 2 === 0) {
    const time = relativeTime(conversationActivityAt(state, conversation) || undefined);
    const nameWidth = Math.max(1, width - time.length - 3);
    const name = ellipsize(conversation.title, nameWidth).padEnd(nameWidth);
    const marker = selected ? '>' : ' ';
    if (selected) {
      return highlight(pad(`${marker} ${name} ${time}`, width));
    }
    return pad(`${marker} ${name} ${dim(time)}`, width);
  }

  const unread = (state.unreadByConversation[conversation.conversationId] ?? 0) + (conversation.unreadCount ?? 0);
  const badge = unread > 0 ? `●${unread}` : '';
  const previewWidth = Math.max(1, width - badge.length - 3);
  const preview = ellipsize(state.previewByConversation[conversation.conversationId] ?? '', previewWidth).padEnd(previewWidth);
  if (selected) {
    return highlight(pad(`  ${preview} ${badge}`, width));
  }
  return pad(`  ${dim(preview)} ${accent(badge)}`, width);
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

  const rows = transcriptRows(state, conversation, contact ? `contact:${contact.contactId}` : undefined, width);
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
    `XMTP inbox ID: ${contact.inboxId}`,
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
    return inputBox('Message: ', state.input, width);
  }
  if (state.mode === 'chat-select' && state.filterActive) {
    return inputBox('Filter: ', state.filter, width);
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
  // Pane switching (1/2) lives in the top bar only, so footers stay focused
  // on the keys unique to the current mode.
  const retrySync = state.syncState === 'stale' || state.streamState === 'offline';
  const filterHint = state.filter ? '/ edit filter | Esc clear filter' : '/ filter';
  const failedHere = state.pendingMessages.some((entry) => entry.status === 'failed' && entry.key === composerKey(state));
  const text = state.mode === 'chat-select'
    ? state.filterActive
      ? ' type to filter | Up/Down move | Enter keep | Esc clear '
      : ` j/k move | Enter talk | n new message | ${filterHint} | d delete${failedHere ? ' | Ctrl+X delete failed' : ''}${retrySync ? ' | s retry sync' : ''} | ? help | q quit `
    : state.mode === 'chat-talk'
      ? failedHere
        ? ' Enter retry | Ctrl+X delete failed | Esc back | Ctrl+U clear '
        : ' Enter send | Esc back | Ctrl+U clear | Ctrl+W delete word '
    : state.mode === 'chat-compose'
        ? chatComposeFooter(state)
        : state.mode === 'contacts-select'
          ? ' j/k move | Enter talk | a add | r rename | d delete | c code | p join code | ? help | q quit '
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

function transcriptRows(
  state: ChatState,
  conversation: ConeConversation | undefined,
  contactKey: string | undefined,
  width: number,
): string[] {
  const key = conversation?.conversationId ?? contactKey;
  const allMessages = conversation ? state.messages : [];
  // Control messages (read receipts, pair confirmations) never appear in the
  // transcript; the read receipt instead places a single "Read" marker.
  const messages = allMessages.filter(isVisibleChatMessage);
  const readMarkerId = state.readReceipts ? latestReadOutboundId(allMessages) : undefined;
  // Optimistic rows render identically to delivered ones; only failures are
  // marked. A pending row hides once its delivered copy is in the store.
  const pending = key
    ? state.pendingMessages.filter((entry) =>
        entry.key === key &&
        (entry.status === 'failed' || !messages.some((message) => matchesPendingSend(message, entry))),
      )
    : [];

  if (messages.length === 0 && pending.length === 0) {
    return [
      conversation
        ? 'No local messages yet. New messages stream in automatically.'
        : 'No messages yet. Press Enter to talk, type Message, then Enter to send.',
    ];
  }

  const rows: string[] = [];
  const pushEntry = (sentAt: string, sender: string, body: string, failed: boolean) => {
    const marker = failed ? `${danger('✗')} ` : '';
    const prefix = `${marker}${formatTranscriptTime(sentAt)} - ${sender}: `;
    const indent = stripAnsi(prefix).length;
    const wrapped = wrapText(body, Math.max(10, width - indent));
    rows.push(`${prefix}${failed ? danger(wrapped[0] ?? '') : wrapped[0] ?? ''}`);
    for (const continuation of wrapped.slice(1)) {
      rows.push(`${' '.repeat(indent)}${failed ? danger(continuation) : continuation}`);
    }
  };
  for (const message of messages) {
    pushEntry(message.sentAt, message.direction === 'outbound' ? 'me' : conversation?.title ?? 'peer', messageBody(message), false);
    if (message.messageId === readMarkerId) {
      const label = '✓✓ Read';
      rows.push(`${' '.repeat(Math.max(0, width - label.length - 1))}${success(label)}`);
    }
  }
  for (const entry of pending) {
    pushEntry(entry.sentAt, 'me', entry.text, entry.status === 'failed');
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
    '/ filters chats as you type; Enter keeps the filter, Esc clears it.',
    'PgUp/PgDn (or Ctrl+B/Ctrl+F) scroll the transcript.',
    'R toggles read receipts. When on, peers see when you read them and you',
    '  see ✓✓ Read on your last message they read; off sends and shows neither.',
    'Messages send instantly; a successful send is silent. A send that fails to',
    '  publish shows ✗ — Enter retries, Ctrl+X deletes it.',
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

function inputBox(label: string, rawValue: string, width: number): string {
  const boxWidth = Math.max(4, width - label.length - 4);
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
