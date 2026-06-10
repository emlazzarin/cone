import type { ConeMessage, IncomingMessage, SyncResult } from './types';

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

export function messageBody<T extends MessagePayload>(message: T): string {
  return payloadBody(message.text, message.json);
}

export function incomingMessageBody(message: IncomingMessage): string {
  return messageBody(message);
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

export function formatConeMessageLine(message: ConeMessage, sender: string): string {
  return formatTranscriptLine({
    body: messageBody(message),
    sender,
    sentAt: message.sentAt,
  });
}

export function formatIncomingMessageLine(message: IncomingMessage, sender: string): string {
  return formatTranscriptLine({
    body: incomingMessageBody(message),
    sender,
    sentAt: message.sentAt,
  });
}

export function isVisibleChatMessage(message: Pick<ConeMessage, 'json' | 'kind'>): boolean {
  if (message.kind === 'control') {
    return false;
  }
  if (typeof message.json === 'object' && message.json !== null && 'type' in message.json) {
    const type = message.json.type;
    return !(typeof type === 'string' && type.startsWith('cos.') && type !== 'cos.app.json.v1');
  }
  return true;
}

// Cone read receipts ride the same control-envelope channel as pairing
// confirmations: a `cos.read.v1` message sent into a conversation means "I have
// read everything up to this message's sentAt". They are hidden from the
// transcript and only interoperate between Cone clients.
export const READ_RECEIPT_TYPE = 'cos.read.v1';

export function isReadReceipt(message: Pick<ConeMessage, 'json'>): boolean {
  const json = message.json;
  return (
    typeof json === 'object' &&
    json !== null &&
    'type' in json &&
    (json as { type?: unknown }).type === READ_RECEIPT_TYPE
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
      return humanizeControl(parsed);
    }
    return text;
  }
  if (isAppJsonEnvelope(json)) {
    return humanizeValue(json.value);
  }
  if (isControlEnvelope(json)) {
    return humanizeControl(json);
  }
  return humanizeValue(json);
}

function humanizeControl(value: { type?: string }): string {
  if (value.type === 'cos.pair.confirm.v1') {
    return '[pair confirmed]';
  }
  if (value.type === READ_RECEIPT_TYPE) {
    return '[read]';
  }
  if (value.type === 'cos.unsupported-message.v1') {
    return '[unsupported message]';
  }
  return `[${value.type ?? 'control message'}]`;
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

function isAppJsonEnvelope(value: unknown): value is { type: 'cos.app.json.v1'; value: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'cos.app.json.v1' &&
    'value' in value
  );
}

function isControlEnvelope(value: unknown): value is { type?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    value.type.startsWith('cos.')
  );
}
