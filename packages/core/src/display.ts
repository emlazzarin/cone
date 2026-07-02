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

function payloadBody(text: string | undefined, json: unknown): string {
  if (text !== undefined) {
    const parsed = parseJson(text);
    if (isAppJsonEnvelope(parsed)) {
      return humanizeValue(parsed.value);
    }
    if (isControlEnvelope(parsed)) {
      return humanizeControl(envelopeType(parsed)!, parsed);
    }
    return text;
  }
  if (isAppJsonEnvelope(json)) {
    return humanizeValue(json.value);
  }
  if (isControlEnvelope(json)) {
    return humanizeControl(envelopeType(json)!, json);
  }
  return humanizeValue(json);
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

function humanizeValue(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'message', 'content', 'body']) {
      if (typeof record[key] === 'string') {
        return record[key];
      }
    }
    const keys = Object.keys(record).slice(0, 4).join(', ');
    return keys ? `[structured message: ${keys}]` : '[structured message]';
  }
  return String(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
