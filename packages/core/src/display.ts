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
