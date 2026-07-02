import {
  filterMatchSnippet,
  formatConnectionStatus,
  formatGroupUpdate,
  formatRetention,
  formatTranscriptTime,
  groupHistoryNotice,
  isGroupUpdateEnvelope,
  isGroupUpdateMessage,
  isVisibleChatMessage,
  latestReadOutboundId,
  matchConversationFilter,
  matchesPendingSend,
  messageBody,
  relativeTime,
  type ConeConnectionStatus,
  type ConeConversation,
} from '@cone/core';

import { activeContact, composerKey, conversationActivityAt, groupInfoMembers, isContactsMode, memberDisplayName, requestCount, scopedConversations, selectedContact, selectedConversation, visibleConversations } from './state';
import { box, columns, fitRows, spread } from './layout';
import type { ChatMode, ChatState } from './types';
import { CSI, accent, bold, chip, danger, dim, ellipsize, highlight, inputField, inverse, matchMark, pad, shortId, stripAnsi, success, wrapText } from './text';

// An unnamed peer's conversation title is its raw XMTP inbox ID (60+ chars),
// which is unreadable in a list. Show a short form until the peer is named
// (via a contact). Named conversations keep their contact name.
function convTitle(conversation: Pick<ConeConversation, 'title' | 'peerInboxId'>): string {
  return conversation.title === conversation.peerInboxId ? shortId(conversation.peerInboxId) : conversation.title;
}

// Layout tiers: two-pane above NARROW_WIDTH, single column (the mode decides
// which pane shows) below it — the same collapse the PWA does on mobile.
const NARROW_WIDTH = 84;
// Below this body height, chat rows collapse from two lines to one and the
// talk composer folds into the bottom line instead of its own boxed row.
const SHORT_BODY = 12;

export function renderChat(state: ChatState, width: number, height: number): string {
  if (width < 44 || height < 9) {
    return `${CSI}2J${CSI}H${inverse(' Cone '.slice(0, Math.max(1, width)))}\nterminal too small for cone chat\n`;
  }

  const safeWidth = Math.max(1, width);
  const bodyHeight = Math.max(3, height - 4);
  const lines: string[] = [];

  lines.push(`${CSI}2J${CSI}H${CSI}?25l`);
  lines.push(headerLine(state, safeWidth));
  for (const line of fitRows(renderBody(state, safeWidth, bodyHeight), bodyHeight)) {
    lines.push(pad(line, safeWidth));
  }
  lines.push(bottomLine(state, safeWidth, bodyHeight));
  lines.push(footerLine(state, safeWidth));
  return `${lines.join('\n')}\n`;
}

// ── Header: brand chip, highlighted section tabs, status on the right ────
function headerLine(state: ChatState, width: number): string {
  const contacts = isContactsMode(state);
  const brand = chip(` Cone ·${state.identity.env} `);
  const chatsTab = contacts ? dim(' 1 Chats ') : chip(' 1 Chats ');
  const contactsTab = contacts ? chip(' 2 Contacts ') : dim(' 2 Contacts ');
  const left = `${brand} ${chatsTab}${contactsTab}`;

  // The active chat/contact is named by its pane title in every layout, so
  // the header carries only account-level state: connection, unread,
  // requests, receipts, identity.
  const unread = Object.values(state.unreadByConversation).reduce((sum, count) => sum + count, 0);
  const connection = formatConnectionStatus(connectionStatusForState(state));
  const connectionLabel = state.streamState === 'online' && state.syncState !== 'stale'
    ? success(connection)
    : state.streamState === 'offline' || state.syncState === 'stale'
      ? danger(connection)
      : dim(connection);
  const requests = requestCount(state);
  const parts = [
    unread > 0 ? `${connectionLabel}${dim(' · ')}${accent(`${unread} new`)}` : connectionLabel,
    ...(requests > 0 ? [accent(`${requests} request${requests === 1 ? '' : 's'}`)] : []),
    ...(state.readReceipts ? [] : [dim('receipts off')]),
    dim(`you ${shortId(state.identity.inboxId)}`),
  ];
  return spread(left, `${parts.join(dim(' · '))} `, width);
}

// ── Body composition per mode and width tier ──────────────────────────────
function renderBody(state: ChatState, width: number, bodyHeight: number): string[] {
  if (state.helpVisible) {
    return box(helpRows(state), { width, height: bodyHeight, title: bold(`help — ${modeLabel(state.mode)}`), active: true });
  }

  const narrow = width < NARROW_WIDTH;
  const listWidth = Math.min(36, Math.max(24, Math.floor(width * 0.3)));
  const mainWidth = width - listWidth - 1;

  if (isContactsMode(state)) {
    const listActive = state.mode === 'contacts-select';
    if (narrow) {
      return state.mode === 'contacts-edit'
        ? formBox(state, width, bodyHeight)
        : contactsListBox(state, width, bodyHeight, true);
    }
    const right = state.mode === 'contacts-edit'
      ? formBox(state, mainWidth, bodyHeight)
      : contactDetailBox(state, mainWidth, bodyHeight);
    return columns([contactsListBox(state, listWidth, bodyHeight, listActive), right], [listWidth, mainWidth]);
  }

  const listActive = state.mode === 'chat-select';
  if (narrow) {
    if (state.mode === 'chat-compose') {
      return formBox(state, width, bodyHeight);
    }
    if (state.mode === 'group-info') {
      return groupInfoBox(state, width, bodyHeight);
    }
    if (state.mode === 'chat-talk') {
      return threadColumn(state, width, bodyHeight, true);
    }
    return chatListBox(state, width, bodyHeight, true);
  }

  const right = state.mode === 'chat-compose'
    ? formBox(state, mainWidth, bodyHeight)
    : state.mode === 'group-info'
      ? groupInfoBox(state, mainWidth, bodyHeight)
      : threadColumn(state, mainWidth, bodyHeight);
  return columns([chatListBox(state, listWidth, bodyHeight, listActive), right], [listWidth, mainWidth]);
}

// ── Chat list ─────────────────────────────────────────────────────────────
function chatListBox(state: ChatState, width: number, height: number, active: boolean): string[] {
  const conversations = visibleConversations(state);
  const label = state.scope === 'requests' ? 'requests' : 'chats';
  const title = state.filter || state.filterActive
    ? `${label} ${accent(`/${state.filter}`)} ${dim(`${conversations.length}/${scopedConversations(state).length}`)}`
    : state.scope === 'requests' ? accent(label) : label;
  const requests = requestCount(state);
  const right = state.scope === 'chats' && requests > 0 ? accent(`t ${requests} req`) : undefined;

  const innerWidth = width - 4;
  const innerHeight = height - 2;
  const rows: string[] = [];

  if (conversations.length === 0) {
    const empty = state.filter
      ? [`no ${label} match`, 'Esc clears the filter']
      : state.scope === 'requests'
        ? ['no requests', 't back to chats']
        : ['no chats yet', 'n new message', '2 contacts + pairing'];
    rows.push(...empty.map((line) => dim(line)));
    return box(rows, { width, height, title, right, active });
  }

  // Two rows per chat normally; one row when the terminal is short.
  const compact = innerHeight < SHORT_BODY;
  const rowsPerEntry = compact ? 1 : 2;
  const visibleEntries = Math.max(1, Math.floor(innerHeight / rowsPerEntry));
  const start = visibleStart(state.selectedIndex, conversations.length, visibleEntries);

  for (let index = start; index < Math.min(conversations.length, start + visibleEntries); index += 1) {
    const conversation = conversations[index]!;
    const selected = index === state.selectedIndex;
    const time = relativeTime(conversationActivityAt(state, conversation) || undefined);
    const unread = (state.unreadByConversation[conversation.conversationId] ?? 0) + (conversation.unreadCount ?? 0);
    const badge = unread > 0 ? `●${unread}` : '';
    const marker = selected ? '▸' : ' ';
    // While filtering, mark the matched characters in the name so the filter
    // is self-explanatory. A match the name doesn't show (the peer's full
    // inbox ID, or a title truncated past the match) is revealed on the
    // preview line instead — see below.
    const match = state.filter.trim() ? matchConversationFilter(conversation, state.filter) : null;
    const fullName = convTitle(conversation);
    const plainName = ellipsize(fullName, Math.max(1, innerWidth - time.length - badge.length - 4));
    const nameShown = plainName === fullName ? plainName.length : plainName.length - 1;
    const nameMatchVisible = match?.field === 'title' && fullName === match.value && match.index + match.length <= nameShown;
    const name = match && nameMatchVisible
      ? `${plainName.slice(0, match.index)}${matchMark(plainName.slice(match.index, match.index + match.length), { colored: !selected })}${plainName.slice(match.index + match.length)}`
      : plainName;
    const timeLabel = compact && badge ? `${badge} ${time}` : time;
    if (selected) {
      rows.push(highlight(spread(`${marker} ${name}${conversation.kind === 'group' ? ' ⚇' : ''}`, timeLabel, innerWidth)));
    } else {
      rows.push(spread(`${marker} ${name}${conversation.kind === 'group' ? dim(' ⚇') : ''}`, dim(timeLabel), innerWidth));
    }
    if (!compact) {
      const snippet = match && !nameMatchVisible ? filterMatchSnippet(match) : null;
      if (snippet) {
        // The match isn't in the displayed name: show the matched fragment in
        // place of the preview while the filter is live.
        const label = match?.field === 'inboxId' ? 'id ' : '';
        rows.push(selected
          ? highlight(spread(`  ${label}${snippet.before}${matchMark(snippet.hit, { colored: false })}${snippet.after}`, badge, innerWidth))
          : spread(`  ${dim(`${label}${snippet.before}`)}${matchMark(snippet.hit)}${dim(snippet.after)}`, accent(badge), innerWidth));
      } else {
        const preview = ellipsize(state.previewByConversation[conversation.conversationId] ?? '', Math.max(1, innerWidth - badge.length - 3));
        const previewLine = spread(`  ${preview}`, badge, innerWidth);
        rows.push(selected ? highlight(previewLine) : spread(`  ${dim(preview)}`, accent(badge), innerWidth));
      }
    }
  }
  return box(rows, { width, height, title, right, active });
}

// ── Contacts ──────────────────────────────────────────────────────────────
function contactsListBox(state: ChatState, width: number, height: number, active: boolean): string[] {
  const innerWidth = width - 4;
  const innerHeight = height - 2;
  const rows: string[] = [];
  if (state.contacts.length === 0) {
    rows.push(...['no contacts yet', 'a add contact', 'c create code', 'p join code'].map((line) => dim(line)));
    return box(rows, { width, height, title: 'contacts', active });
  }
  const start = visibleStart(state.selectedContactIndex, state.contacts.length, innerHeight);
  for (let index = start; index < Math.min(state.contacts.length, start + innerHeight); index += 1) {
    const contact = state.contacts[index]!;
    const selected = index === state.selectedContactIndex;
    const line = pad(`${selected ? '▸' : ' '} ${ellipsize(contact.name, innerWidth - 2)}`, innerWidth);
    rows.push(selected ? highlight(line) : line);
  }
  return box(rows, { width, height, title: 'contacts', active });
}

function contactDetailBox(state: ChatState, width: number, height: number): string[] {
  const contact = selectedContact(state);
  const rows = contact
    ? [
        bold(contact.name),
        `XMTP inbox ID: ${contact.inboxId}`,
        `EVM address: ${contact.address ?? 'unknown'}`,
        dim(`Source: ${contact.source}`),
        dim(`Created: ${contact.createdAt}`),
        dim(`Updated: ${contact.updatedAt}`),
      ]
    : ['No contacts yet.', dim('a add contact'), dim('c create pairing code'), dim('p join pairing code')];
  return box(rows, { width, height, title: 'contact' });
}

// ── Thread + composer ─────────────────────────────────────────────────────
function threadColumn(state: ChatState, width: number, height: number, narrow = false): string[] {
  // The composer is its own boxed row (droid-style) unless the terminal is
  // too short — then it folds into the bottom chrome line instead.
  const composerHeight = height >= SHORT_BODY ? 3 : 0;
  const thread = threadBox(state, width, height - composerHeight, narrow);
  if (composerHeight === 0) {
    return thread;
  }
  return [...thread, ...composerBox(state, width)];
}

function threadBox(state: ChatState, width: number, height: number, narrow = false): string[] {
  const conversation = selectedConversation(state);
  const contact = activeContact(state);
  const active = state.mode === 'chat-talk';

  // In the narrow single-column tier the list is hidden; the `‹` signals
  // that Esc goes back to it.
  const back = narrow ? dim('‹ ') : '';
  const title = conversation
    ? `${back}${bold(ellipsize(convTitle(conversation), Math.max(6, width - 30)))}`
    : contact
      ? `${back}${bold(contact.name)} ${dim('new chat')}`
      : dim('no chat selected');
  const unread = conversation ? state.unreadByConversation[conversation.conversationId] ?? 0 : 0;
  const metaParts = [
    ...(conversation?.kind === 'group'
      ? [`${dim(conversation.memberCount ? `group · ${conversation.memberCount}` : 'group')}${conversation.active === false ? ` ${danger('left')}` : ''}`]
      : conversation?.peerInboxId && conversation.title !== conversation.peerInboxId
        ? [dim(shortId(conversation.peerInboxId))]
        : []),
    ...(conversation?.retention ? [accent(`timer ${formatRetention(conversation.retention.durationMs)}`)] : []),
    ...(state.transcriptScroll > 0 ? [dim(`scroll +${state.transcriptScroll}`)] : []),
    ...(unread > 0 ? [accent(`${unread} new`)] : []),
  ];

  const innerWidth = width - 4;
  const innerHeight = height - 2;
  if (!conversation && !contact) {
    return box([
      'No selected chat.',
      dim('n starts a structured message to a contact, inbox ID, or EVM address.'),
      dim('2 opens contacts for address-book edits and pairing.'),
    ], { width, height, title, active });
  }

  const rows = transcriptRows(state, conversation, contact ? `contact:${contact.contactId}` : undefined, innerWidth);
  const scroll = Math.min(state.transcriptScroll, Math.max(0, rows.length - innerHeight));
  const bottom = Math.max(0, rows.length - scroll);
  const start = Math.max(0, bottom - innerHeight);
  return box(rows.slice(start, bottom), { width, height, title, right: metaParts.length > 0 ? metaParts.join(dim(' · ')) : undefined, active });
}

function composerBox(state: ChatState, width: number): string[] {
  const active = state.mode === 'chat-talk';
  const innerWidth = width - 4;
  if (!active) {
    const conversation = selectedConversation(state);
    // A request is previewed, not replied to — accepting is the gate.
    const hint = conversation?.consentState === 'unknown'
      ? 'a accept · b block — accept before writing'
      : conversation
        ? `Enter to write to ${ellipsize(convTitle(conversation), Math.max(4, innerWidth - 22))}`
        : 'Enter to write';
    return box([dim(`› ${hint}`)], { width, height: 3 });
  }
  const available = Math.max(4, innerWidth - 3);
  const value = state.input.length > available ? state.input.slice(state.input.length - available) : state.input;
  return box([`${accent('›')} ${value}${accent('█')}`], { width, height: 3, active: true });
}

// ── Group info ────────────────────────────────────────────────────────────
function groupInfoBox(state: ChatState, width: number, height: number): string[] {
  const conversation = selectedConversation(state);
  if (!conversation || conversation.kind !== 'group') {
    return box([], { width, height, title: 'group info', active: true });
  }
  const innerWidth = width - 4;
  const title = `group info — ${bold(ellipsize(conversation.title, Math.max(6, innerWidth - 30)))}`;
  const right = conversation.active === false ? danger('no longer a member') : undefined;

  const rows: string[] = [];
  if (conversation.groupDescription) {
    rows.push(dim(ellipsize(conversation.groupDescription, innerWidth)));
  }
  const timer = conversation.retention ? ` · timer ${formatRetention(conversation.retention.durationMs)}` : '';
  rows.push(dim(`${conversation.memberCount ?? groupInfoMembers(state).length} members · consent ${conversation.consentState}${timer}`));
  rows.push('');

  const members = groupInfoMembers(state);
  if (members.length === 0) {
    rows.push(dim('no member list yet — syncing'));
    return box(rows, { width, height, title, right, active: true });
  }
  const visibleRows = Math.max(1, height - 2 - rows.length);
  const start = visibleStart(state.groupInfoIndex, members.length, visibleRows);
  for (let index = start; index < Math.min(members.length, start + visibleRows); index += 1) {
    const member = members[index]!;
    const selected = index === state.groupInfoIndex;
    const role = member.level === 'superAdmin' ? ' [owner]' : member.level === 'admin' ? ' [admin]' : '';
    const rawName = memberDisplayName(state, member.inboxId);
    const unnamed = rawName === member.inboxId;
    const name = unnamed ? shortId(member.inboxId) : rawName;
    const idSuffix = unnamed ? '' : ` ${dim(shortId(member.inboxId))}`;
    const blocked = member.consentState === 'denied' ? ` ${danger('[blocked]')}` : '';
    const line = `${selected ? '▸' : ' '} ${name}${role}${idSuffix}${blocked}`;
    rows.push(selected ? highlight(pad(line, innerWidth)) : line);
  }
  return box(rows, { width, height, title, right, active: true });
}

// ── Forms ─────────────────────────────────────────────────────────────────
function formBox(state: ChatState, width: number, height: number): string[] {
  const form = state.editForm;
  if (!form) {
    return box([], { width, height, active: true });
  }
  const innerWidth = width - 4;
  const rows: string[] = [];

  if (form.pending) {
    // A pending invite keeps its result lines (the code) on screen — that is
    // what gets read out to the other side while we wait.
    rows.push(...(form.resultLines ?? []));
    const waiting = form.kind === 'group-invite'
      ? ['Waiting for someone to join with this code (up to 60s)…', 'Esc to leave — the invite keeps running in the background.']
      : form.kind === 'group-join'
        ? ['Waiting for the inviter to share the group (up to 60s)…', 'Esc to leave — the join keeps running in the background.']
        : ['Waiting for the other side to enter the same code (up to 60s)…', 'Esc to leave — pairing keeps running in the background.'];
    rows.push(...waiting.map((line) => dim(line)));
    return box(rows, { width, height, title: bold(form.title), active: true });
  }

  if (form.resultLines && form.resultLines.length > 0) {
    rows.push(...form.resultLines);
    return box(rows, { width, height, title: bold(form.title), active: true });
  }

  form.fields.forEach((field, index) => {
    const isActive = index === form.activeField;
    const label = `${isActive ? '▸' : ' '} ${field.label}: `;
    if (!isActive) {
      rows.push(`${label}${field.value}`);
      return;
    }
    // Cursor sits in the selected field. Long values (e.g. an inbox ID) scroll
    // so the caret stays visible instead of overflowing the pane.
    const avail = Math.max(4, innerWidth - stripAnsi(label).length - 2);
    const shown = field.value.length > avail ? field.value.slice(field.value.length - avail) : field.value;
    rows.push(`${label}${shown}${accent('█')}`);
  });

  if (form.kind === 'pair-join') {
    rows.push(dim('No code yet? Esc, then press c to create one to share.'));
  }

  const suggestions = form.kind === 'message' ? messageTargetSuggestions(state) : [];
  if (suggestions.length > 0) {
    rows.push(dim('Suggestions from contacts and conversations:'));
    rows.push(...suggestions.map((suggestion) => `  ${suggestion}`));
  }

  if (form.error) {
    rows.push('');
    rows.push(danger(`Error: ${form.error}`));
  }
  return box(rows, { width, height, title: bold(form.title), active: true });
}

// ── Bottom chrome: filter/short-composer input, or the status line ────────
function bottomLine(state: ChatState, width: number, bodyHeight: number): string {
  if (state.mode === 'chat-select' && state.filterActive) {
    return inputPrompt('Filter: ', state.filter, width);
  }
  if (state.mode === 'chat-talk' && bodyHeight < SHORT_BODY) {
    return inputPrompt('Message: ', state.input, width);
  }
  return pad(dim(`status: ${state.status}`), width);
}

function footerLine(state: ChatState, width: number): string {
  if (state.helpVisible) {
    return `${chip(' HELP ')}${inverse(pad(' Esc close help · ? close help ', Math.max(0, width - 6)))}`;
  }
  const label = modeChip(state);
  const hints = footerSegments(state);
  return `${chip(label)}${inverse(pad(fitSegments(hints, Math.max(0, width - stripAnsi(label).length)), Math.max(0, width - stripAnsi(label).length)))}`;
}

// Footer hints as whole segments, most important first. When width runs out,
// entire hints drop from the tail (never a mid-hint clip) and `? help` is
// always kept — discoverability survives exactly when screens get small.
function footerSegments(state: ChatState): string[] {
  const retrySync = state.syncState === 'stale' || state.streamState === 'offline';
  const filterHint = state.filter ? '/ edit filter · Esc clear filter' : '/ filter';
  const failedHere = state.pendingMessages.some((entry) => entry.status === 'failed' && entry.key === composerKey(state));
  const requests = requestCount(state);
  if (state.mode === 'chat-select') {
    if (state.filterActive) {
      return ['type to filter', 'Up/Down move', 'Enter keep', 'Esc clear'];
    }
    if (state.scope === 'requests') {
      return [
        'j/k move', 'Enter preview', 'a accept', `b block${state.pendingBlockId ? ' (again to confirm)' : ''}`,
        filterHint, 't chats', '? help', 'q quit',
      ];
    }
    return [
      'j/k move', 'Enter talk', 'n new',
      selectedConversation(state)?.kind === 'group' ? 'i info' : 'r name',
      'e timer', 'c/p pair',
      ...(failedHere ? ['Ctrl+X delete failed'] : []),
      ...(retrySync ? ['s retry sync'] : []),
      ...(requests > 0 ? [`t requests (${requests})`] : []),
      filterHint, 'd delete', '? help', 'q quit', 'g join group',
    ];
  }
  if (state.mode === 'group-info') {
    return ['j/k move', 'a add', 'v invite', 'l link', 'r rename', '+/- role', 'd remove', 'e timer', 'x leave', 'b block', 'Esc back', '? help'];
  }
  if (state.mode === 'chat-talk') {
    return failedHere
      ? ['Enter retry', 'Ctrl+X delete failed', 'Esc back', 'Ctrl+U clear']
      : ['Enter send', 'Esc back', 'Ctrl+U clear', 'Ctrl+W delete word'];
  }
  if (state.mode === 'chat-compose') {
    return chatComposeFooter(state);
  }
  if (state.mode === 'contacts-select') {
    return ['j/k move', 'Enter talk', 'a add', 'r rename', 'd delete', 'c create code', 'p join code', '? help', 'q quit'];
  }
  return state.editForm?.resultLines?.length
    ? ['Enter done', 'Esc done']
    : ['Tab next field', 'Shift+Tab previous', `Enter ${state.editForm?.submitLabel ?? 'save'}`, 'Esc cancel'];
}

function fitSegments(segments: string[], width: number): string {
  const pinned = segments.includes('? help') ? '? help' : undefined;
  const kept: string[] = [];
  const reserve = pinned ? pinned.length + 3 : 0;
  let used = 2; // leading + trailing space
  for (const segment of segments) {
    if (segment === pinned) {
      continue;
    }
    const cost = (kept.length > 0 ? 3 : 0) + segment.length;
    if (used + cost + reserve > width) {
      break;
    }
    kept.push(segment);
    used += cost;
  }
  if (pinned) {
    kept.push(pinned);
  }
  return ` ${kept.join(' · ')} `;
}


// The explicit current-state chip: the mode is always visible at a glance.
function modeChip(state: ChatState): string {
  if (state.mode === 'chat-select') {
    return state.scope === 'requests' ? ' REQUESTS ' : state.filterActive ? ' FILTER ' : ' CHATS ';
  }
  if (state.mode === 'chat-talk') {
    return ' TALK ';
  }
  if (state.mode === 'chat-compose') {
    return ' COMPOSE ';
  }
  if (state.mode === 'contacts-select') {
    return ' CONTACTS ';
  }
  if (state.mode === 'group-info') {
    return ' GROUP ';
  }
  return ' EDIT ';
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
  // transcript; the read receipt instead places a single "Read" marker. Group
  // updates are the exception — they render as attributed system lines.
  const messages = allMessages.filter((message) => isVisibleChatMessage(message) || isGroupUpdateMessage(message));
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
    const notice = conversation?.kind === 'group' ? groupHistoryNotice(conversation, state.identity.inboxId) : undefined;
    return [
      ...(notice ? [dim(`· ${notice}`)] : []),
      conversation
        ? dim('No local messages yet. New messages stream in automatically.')
        : dim('No messages yet. Press Enter to talk, type Message, then Enter to send.'),
    ];
  }

  const rows: string[] = [];
  const readLabel = '✓✓ Read';
  // Outbound rows reserve a right gutter (when receipts are on) so the read
  // marker sits in a fixed column on the message's last row — it never spawns a
  // separate line that reflows the transcript, and never crowds wrapping text.
  const gutter = state.readReceipts ? readLabel.length + 1 : 0;
  const pushEntry = (sentAt: string, sender: string, body: string, options: { failed?: boolean; outbound?: boolean; read?: boolean }) => {
    const failed = options.failed ?? false;
    const marker = failed ? `${danger('✗')} ` : '';
    const senderLabel = options.outbound ? dim(sender) : accent(sender);
    const prefix = `${marker}${formatTranscriptTime(sentAt)} - ${sender}: `;
    const styledPrefix = `${marker}${dim(formatTranscriptTime(sentAt))} ${dim('-')} ${senderLabel}${dim(':')} `;
    const indent = stripAnsi(prefix).length;
    const reserve = options.outbound ? gutter : 0;
    const wrapped = wrapText(body, Math.max(10, width - indent - reserve));
    const built = [`${styledPrefix}${failed ? danger(wrapped[0] ?? '') : wrapped[0] ?? ''}`];
    for (const continuation of wrapped.slice(1)) {
      built.push(`${' '.repeat(indent)}${failed ? danger(continuation) : continuation}`);
    }
    if (options.read) {
      const last = built.length - 1;
      const lastRow = built[last] ?? '';
      const gap = Math.max(1, width - stripAnsi(lastRow).length - readLabel.length);
      built[last] = `${lastRow}${' '.repeat(gap)}${success(readLabel)}`;
    }
    for (const row of built) {
      rows.push(row);
    }
  };
  // Group transcripts open with the honest MLS note: your view starts where
  // you joined (or where you created the group).
  if (conversation?.kind === 'group') {
    const notice = groupHistoryNotice(conversation, state.identity.inboxId);
    if (notice) {
      rows.push(dim(`· ${notice}`));
    }
  }
  const resolveName = (inboxId: string) => memberDisplayName(state, inboxId);
  const peerLabel = conversation ? convTitle(conversation) : 'peer';
  for (const message of messages) {
    // Group updates render as dim system lines, not chat bubbles.
    if (isGroupUpdateEnvelope(message.json)) {
      for (const line of formatGroupUpdate(message.json, resolveName)) {
        rows.push(dim(`${formatTranscriptTime(message.sentAt)} · ${ellipsize(line, Math.max(10, width - 8))}`));
      }
      continue;
    }
    const outbound = message.direction === 'outbound';
    // In groups, label inbound rows by their actual sender (contacts-first);
    // in DMs the peer label is the conversation title as before.
    const sender = outbound ? 'me' : conversation?.kind === 'group' ? shortSender(resolveName(message.senderInboxId)) : peerLabel;
    pushEntry(message.sentAt, sender, messageBody(message), {
      outbound,
      read: message.messageId === readMarkerId,
    });
  }
  for (const entry of pending) {
    pushEntry(entry.sentAt, 'me', entry.text, { failed: entry.status === 'failed', outbound: true });
  }
  return rows;
}

// A group sender with no contact name is a raw inbox ID; shorten it so the
// transcript prefix stays readable.
function shortSender(name: string): string {
  return name.length > 20 && /^[0-9a-f]+$/iu.test(name) ? shortId(name) : name;
}

function helpRows(state: ChatState): string[] {
  return [
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
    't toggles Requests (unknown senders). There: a accepts, b blocks (twice to',
    '  confirm). Accepting moves them to your inbox; only allowed chats send receipts.',
    'Chats: r names the selected peer (saves a contact); d deletes the local chat.',
    'i opens group info on a group: members with roles, a add, r rename, +/-',
    '  promote/demote, d remove (twice), x leave (twice, visible), b block (twice,',
    '  silent). Owners must promote a new owner before leaving.',
    'e sets the disappearing-messages timer for the selected chat (off, 5m…30d).',
    '  Both sides see it; messages sent under a timer vanish after it elapses.',
    'c creates a pairing code, p joins one — from Chats or Contacts.',
    'g joins a group by invite code or link token; in group info, v creates a',
    '  code (single use, 10 minutes, adds the joiner directly) and l creates an',
    '  async link token (joiners are admitted when this account syncs).',
    'Contacts: a add, r rename, d delete, c create code, p join code.',
    'Realtime stream stays on; s only appears when sync/stream needs retry.',
  ];
}

function chatComposeFooter(state: ChatState): string[] {
  const activeField = state.editForm?.fields[state.editForm.activeField];
  if (state.editForm?.kind === 'message' && activeField?.key === 'to') {
    return ['Up/Down choose target', 'Enter accept target', 'Tab message', 'Esc cancel'];
  }
  if (state.editForm?.kind === 'message') {
    return ['Enter send', 'Tab target', 'Shift+Tab target', 'Esc cancel'];
  }
  return [`Enter ${state.editForm?.submitLabel ?? 'save'}`, 'Esc cancel'];
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
  if (mode === 'group-info') {
    return 'Group info';
  }
  return 'Editing';
}

function inputPrompt(label: string, rawValue: string, width: number): string {
  const boxWidth = Math.max(4, width - label.length - 4);
  const visibleValue = rawValue.length >= boxWidth ? rawValue.slice(rawValue.length - boxWidth + 1) : rawValue;
  const content = `${visibleValue}█`;
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
    const meta = conversation.kind === 'group' ? 'group' : `chat ${shortId(conversation.peerInboxId ?? conversation.conversationId)}`;
    entries.set(conversation.title.toLocaleLowerCase(), `${conversation.title} ${dim(meta)}`);
  }
  return Array.from(entries.entries())
    .filter(([key]) => !query || key.includes(query))
    .slice(0, 5)
    .map(([key, label]) => {
      const marker = key === query ? '▸' : ' ';
      return `${marker} ${label}`;
    });
}

function formFieldValue(state: ChatState, key: string): string {
  return state.editForm?.fields.find((field) => field.key === key)?.value.trim() ?? '';
}
