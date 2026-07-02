import { humanizeAppJsonValue } from './content-type';
import {
  GROUP_UPDATE_TYPE,
  PAIR_CONFIRM_TYPE,
  READ_RECEIPT_TYPE,
  UNSUPPORTED_MESSAGE_TYPE,
  envelopeType,
  isAppJsonEnvelope,
  isControlEnvelope,
  isGroupUpdateEnvelope,
  type GroupUpdateEnvelope,
} from './envelope';
import { formatRetention } from './retention';
import type { ConeConsentState, ConeConversation, ConeMessage, MessageDeliveryStatus, SyncResult } from './types';

export type ConeConnectionStatus = 'catching-up' | 'connecting' | 'live' | 'offline' | 'stale';

export interface TranscriptLineInput {
  body: string;
  sender: string;
  sentAt: string;
}

interface MessagePayload {
  json?: unknown;
  text?: string;
}

export function messageBody(message: MessagePayload): string {
  return payloadBody(message.text, message.json);
}

export function formatTranscriptTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function formatTranscriptLine(input: TranscriptLineInput): string {
  return `${formatTranscriptTime(input.sentAt)} - ${input.sender}: ${input.body}`;
}

export function formatMessageLine(message: MessagePayload & { sentAt: string }, sender: string): string {
  return formatTranscriptLine({
    body: messageBody(message),
    sender,
    sentAt: message.sentAt,
  });
}

export function formatConversationPreview(message: ConeMessage): string {
  const body = messageBody(message);
  return message.direction === 'outbound' ? `you: ${body}` : body;
}

export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) {
    return '';
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return '';
  }
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 45) {
    return 'now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(then));
}

export function laterIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left > right ? left : right;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isVisibleChatMessage(message: Pick<ConeMessage, 'json' | 'kind'>): boolean {
  return message.kind !== 'control' && !isControlEnvelope(message.json);
}

// Main inbox: allowed conversations. Requests: unknown inbound conversations.
// Denied is excluded from both — only a managed blocked list surfaces it.
export function isAllowedConversation(conversation: Pick<ConeConversation, 'consentState'>): boolean {
  return conversation.consentState === 'allowed';
}

export function isRequestConversation(conversation: Pick<ConeConversation, 'consentState'>): boolean {
  return conversation.consentState === 'unknown';
}

export function isDeniedConversation(conversation: Pick<ConeConversation, 'consentState'>): boolean {
  return conversation.consentState === 'denied';
}

// The chat-list filter matches two strings per conversation: the title (a
// contact name, a group name, or — for an unnamed peer — the raw inbox ID
// itself) and the DM peer's full XMTP inbox ID. Returning WHERE the query
// matched lets surfaces show the matched characters, so a row kept by a match
// on a string that isn't displayed (the middle of a 64-char inbox ID) can
// reveal why it's still in the list.
export interface ConversationFilterMatch {
  // 'title' when a visible name matched; 'inboxId' when the peer's full inbox
  // ID matched (including unnamed peers, whose title IS the inbox ID).
  field: 'title' | 'inboxId';
  // The string the query was found in: the title, or the full inbox ID.
  value: string;
  index: number;
  length: number;
}

export function matchConversationFilter(
  conversation: Pick<ConeConversation, 'title' | 'peerInboxId'>,
  filter: string,
): ConversationFilterMatch | null {
  const query = filter.trim().toLocaleLowerCase();
  if (!query) {
    return null;
  }
  if (conversation.title !== conversation.peerInboxId) {
    const index = conversation.title.toLocaleLowerCase().indexOf(query);
    if (index >= 0) {
      return { field: 'title', value: conversation.title, index, length: query.length };
    }
  }
  const inboxId = conversation.peerInboxId ?? '';
  const index = inboxId.toLocaleLowerCase().indexOf(query);
  if (index >= 0) {
    return { field: 'inboxId', value: inboxId, index, length: query.length };
  }
  return null;
}

// A short window around the matched characters, for showing an inbox-ID (or
// truncated-title) match without printing the whole string. `before`/`after`
// carry their own ellipses, so callers just concatenate before + hit + after
// and style `hit`.
export interface FilterMatchSnippet {
  before: string;
  hit: string;
  after: string;
}

export function filterMatchSnippet(match: ConversationFilterMatch, context = 6): FilterMatchSnippet {
  const start = match.index;
  const end = match.index + match.length;
  return {
    before: `${start - context > 0 ? '…' : ''}${match.value.slice(Math.max(0, start - context), start)}`,
    hit: match.value.slice(start, end),
    after: `${match.value.slice(end, end + context)}${end + context < match.value.length ? '…' : ''}`,
  };
}

// Attributed system lines for a group update ("Alice added Bob", "Carol
// renamed the group to Crew"). `resolveName` maps inbox IDs to display names
// (contacts-first); pass-through by default.
export function formatGroupUpdate(
  update: GroupUpdateEnvelope,
  resolveName: (inboxId: string) => string = (inboxId) => inboxId,
): string[] {
  const actor = resolveName(update.initiatedByInboxId);
  const names = (inboxIds: string[] | undefined) => (inboxIds ?? []).map(resolveName).join(', ');
  const lines: string[] = [];
  if (update.added.length > 0) {
    lines.push(`${actor} added ${names(update.added)}`);
  }
  if (update.removed.length > 0) {
    lines.push(`${actor} removed ${names(update.removed)}`);
  }
  if (update.left.length > 0) {
    lines.push(`${names(update.left)} left`);
  }
  if (update.adminsAdded?.length) {
    lines.push(`${actor} made ${names(update.adminsAdded)} an admin`);
  }
  if (update.adminsRemoved?.length) {
    lines.push(`${actor} removed ${names(update.adminsRemoved)} as admin`);
  }
  if (update.superAdminsAdded?.length) {
    lines.push(`${actor} made ${names(update.superAdminsAdded)} an owner`);
  }
  if (update.superAdminsRemoved?.length) {
    lines.push(`${actor} removed ${names(update.superAdminsRemoved)} as owner`);
  }
  let disappearingHandled = false;
  for (const change of update.metadataChanges) {
    if (change.field === 'group_name') {
      lines.push(change.newValue ? `${actor} renamed the group to ${change.newValue}` : `${actor} cleared the group name`);
    } else if (change.field === 'description') {
      lines.push(`${actor} updated the group description`);
    } else if (change.field === 'group_image_url_square') {
      lines.push(`${actor} updated the group image`);
    } else if (change.field === 'message_disappear_in_ns' || change.field === 'message_disappear_from_ns') {
      // One timer change arrives as two field changes (from_ns + in_ns);
      // render them as a single line carrying the duration, not two blank ones.
      if (disappearingHandled) {
        continue;
      }
      disappearingHandled = true;
      const duration = update.metadataChanges.find((candidate) => candidate.field === 'message_disappear_in_ns');
      const durationNs = Number(duration?.newValue ?? '0');
      lines.push(Number.isFinite(durationNs) && durationNs > 0
        ? `${actor} set disappearing messages to ${formatRetention(durationNs / 1_000_000)}`
        : `${actor} turned disappearing messages off`);
    }
  }
  return lines.length > 0 ? lines : [`${actor} updated the group`];
}

// Group updates are control messages (hidden by isVisibleChatMessage) that
// surfaces nonetheless render as system lines in group transcripts.
export function isGroupUpdateMessage(message: Pick<ConeMessage, 'json'>): boolean {
  return isGroupUpdateEnvelope(message.json);
}

// The mention convention: XMTP has no native mention content type, so Cone
// uses plain "@alias" text, matched case-insensitively at token boundaries.
// An agent in a group that responds only when addressed cannot be pulled into
// reply loops with other agents — the guard that makes shared rooms safe.
export function isAddressedTo(text: string | undefined, aliases: Array<string | undefined>): boolean {
  if (!text) {
    return false;
  }
  const lower = text.toLocaleLowerCase();
  return aliases.some((alias) => {
    const trimmed = alias?.trim().toLocaleLowerCase();
    if (!trimmed) {
      return false;
    }
    const needle = `@${trimmed}`;
    let index = lower.indexOf(needle);
    while (index !== -1) {
      const after = lower[index + needle.length];
      if (after === undefined || !/[\p{L}\p{N}_-]/u.test(after)) {
        return true;
      }
      index = lower.indexOf(needle, index + 1);
    }
    return false;
  });
}

// The honest MLS caveat, shown once at the top of a group transcript: a new
// member's view starts at their join (forward secrecy), and the creator's
// starts at creation. Undefined for DMs.
export function groupHistoryNotice(
  conversation: Pick<ConeConversation, 'kind' | 'addedByInboxId'>,
  selfInboxId: string,
): string | undefined {
  if (conversation.kind !== 'group') {
    return undefined;
  }
  return conversation.addedByInboxId === selfInboxId || !conversation.addedByInboxId
    ? 'you created this group'
    : 'you joined — earlier messages aren\'t visible';
}

export function isReadReceipt(message: Pick<ConeMessage, 'json'>): boolean {
  return envelopeType(message.json) === READ_RECEIPT_TYPE;
}

// The sentAt of the newest visible inbound message, or undefined if none.
// Both surfaces use this to decide whether a conversation has anything new
// worth acknowledging with a read receipt.
export function latestInboundAt(messages: ConeMessage[]): string | undefined {
  let newest: string | undefined;
  for (const message of messages) {
    if (message.direction === 'inbound' && isVisibleChatMessage(message) && (!newest || message.sentAt > newest)) {
      newest = message.sentAt;
    }
  }
  return newest;
}

// An optimistic (locally rendered, not yet stored) send is considered
// delivered once a matching outbound message appears in the read model:
// same trimmed body, sent within this window. Both surfaces use this to hide
// the optimistic row in favor of the stored copy.
const PENDING_SEND_MATCH_WINDOW_MS = 5 * 60_000;

export function matchesPendingSend(message: ConeMessage, pending: { sentAt: string; text: string }): boolean {
  return (
    message.direction === 'outbound' &&
    messageBody(message).trim() === pending.text &&
    Math.abs(Date.parse(message.sentAt) - Date.parse(pending.sentAt)) < PENDING_SEND_MATCH_WINDOW_MS
  );
}

// The id of the most recent outbound message the peer has read (i.e. sent at or
// before their latest read receipt), or undefined if none. "Read" is shown only
// on this single message so the indicator never clutters the transcript.
export function latestReadOutboundId(messages: ConeMessage[]): string | undefined {
  let readThroughMs = 0;
  for (const message of messages) {
    if (message.direction === 'inbound' && isReadReceipt(message)) {
      const at = Date.parse(message.sentAt);
      if (!Number.isNaN(at) && at > readThroughMs) {
        readThroughMs = at;
      }
    }
  }
  if (readThroughMs === 0) {
    return undefined;
  }
  let bestId: string | undefined;
  let bestAt = -1;
  for (const message of messages) {
    if (message.direction !== 'outbound' || !isVisibleChatMessage(message)) {
      continue;
    }
    const at = Date.parse(message.sentAt);
    if (!Number.isNaN(at) && at <= readThroughMs && at > bestAt) {
      bestAt = at;
      bestId = message.messageId;
    }
  }
  return bestId;
}

// XMTP's DecodedMessage.deliveryStatus is the numeric enum
// (Unpublished=0, Published=1, Failed=2); older/browser builds have used the
// string form. Normalize both, defaulting unknown values to published so we
// never hide a real message.
export function normalizeDeliveryStatus(raw: unknown): MessageDeliveryStatus {
  if (raw === 2 || raw === 'failed' || raw === 'Failed') {
    return 'failed';
  }
  if (raw === 0 || raw === 'unpublished' || raw === 'Unpublished') {
    return 'unpublished';
  }
  return 'published';
}

export function formatSyncStatus(result: SyncResult): string {
  const summary = `${result.conversationsSynced} conversations, ${result.messagesSynced} messages`;
  return result.ok ? `synced ${summary}` : `offline/stale: ${result.errors.join('; ')}`;
}

export function formatConnectionStatus(status: ConeConnectionStatus): string {
  switch (status) {
    case 'catching-up':
      return 'catching up';
    case 'connecting':
      return 'connecting';
    case 'live':
      return 'live';
    case 'offline':
      return 'offline';
    case 'stale':
      return 'offline/stale';
  }
}

// Text is always rendered verbatim: envelopes arrive via their own content
// type and land in `json`, never in `text` — a typed message that *looks*
// like an envelope is just text someone typed.
function payloadBody(text: string | undefined, json: unknown): string {
  if (text !== undefined) {
    return text;
  }
  if (isAppJsonEnvelope(json)) {
    return humanizeAppJsonValue(json.value);
  }
  if (isControlEnvelope(json)) {
    return humanizeControl(envelopeType(json)!, json);
  }
  return humanizeAppJsonValue(json);
}

function humanizeControl(type: string, value?: unknown): string {
  if (type === PAIR_CONFIRM_TYPE) {
    return '[pair confirmed]';
  }
  if (type === READ_RECEIPT_TYPE) {
    return '[read]';
  }
  if (type === UNSUPPORTED_MESSAGE_TYPE) {
    return '[unsupported message]';
  }
  if (type === GROUP_UPDATE_TYPE && isGroupUpdateEnvelope(value)) {
    return `[${formatGroupUpdate(value).join('; ')}]`;
  }
  return `[${type}]`;
}

