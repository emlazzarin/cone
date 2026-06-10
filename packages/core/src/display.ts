import {
  PAIR_CONFIRM_TYPE,
  READ_RECEIPT_TYPE,
  UNSUPPORTED_MESSAGE_TYPE,
  envelopeType,
  isAppJsonEnvelope,
  isControlEnvelope,
} from './envelope';
import type { ConeMessage, MessageDeliveryStatus, SyncResult } from './types';

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
      return humanizeControl(envelopeType(parsed)!);
    }
    return text;
  }
  if (isAppJsonEnvelope(json)) {
    return humanizeValue(json.value);
  }
  if (isControlEnvelope(json)) {
    return humanizeControl(envelopeType(json)!);
  }
  return humanizeValue(json);
}

function humanizeControl(type: string): string {
  if (type === PAIR_CONFIRM_TYPE) {
    return '[pair confirmed]';
  }
  if (type === READ_RECEIPT_TYPE) {
    return '[read]';
  }
  if (type === UNSUPPORTED_MESSAGE_TYPE) {
    return '[unsupported message]';
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
