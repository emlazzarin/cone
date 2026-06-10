import { describe, expect, test } from 'bun:test';

import { isReadReceipt, isVisibleChatMessage, latestReadOutboundId, normalizeDeliveryStatus, type ConeMessage } from '../src/index';

function message(partial: Partial<ConeMessage> & Pick<ConeMessage, 'messageId' | 'direction' | 'sentAt'>): ConeMessage {
  return {
    conversationId: 'dm',
    kind: 'text',
    senderInboxId: 'peer',
    text: 'hi',
    ...partial,
  };
}

const READ = { type: 'cos.read.v1' };

describe('read receipts', () => {
  test('isReadReceipt recognizes only the read-receipt envelope', () => {
    expect(isReadReceipt({ json: READ })).toBe(true);
    expect(isReadReceipt({ json: { type: 'cos.pair.confirm.v1' } })).toBe(false);
    expect(isReadReceipt({ json: undefined })).toBe(false);
    expect(isReadReceipt({ json: { value: 'hi' } })).toBe(false);
  });

  test('read receipts are hidden from the transcript', () => {
    expect(isVisibleChatMessage({ kind: 'control', json: READ })).toBe(false);
  });

  test('marks the most recent outbound message sent at or before the latest receipt', () => {
    const messages: ConeMessage[] = [
      message({ messageId: 'o1', direction: 'outbound', sentAt: '2026-01-01T10:00:00.000Z' }),
      message({ messageId: 'o2', direction: 'outbound', sentAt: '2026-01-01T10:01:00.000Z' }),
      message({ messageId: 'r1', direction: 'inbound', kind: 'control', json: READ, text: undefined, sentAt: '2026-01-01T10:02:00.000Z' }),
      message({ messageId: 'o3', direction: 'outbound', sentAt: '2026-01-01T10:03:00.000Z' }),
    ];
    // o3 was sent after the receipt, so the newest *read* message is o2.
    expect(latestReadOutboundId(messages)).toBe('o2');
  });

  test('uses the latest receipt when several arrive', () => {
    const messages: ConeMessage[] = [
      message({ messageId: 'o1', direction: 'outbound', sentAt: '2026-01-01T10:00:00.000Z' }),
      message({ messageId: 'r1', direction: 'inbound', kind: 'control', json: READ, text: undefined, sentAt: '2026-01-01T10:00:30.000Z' }),
      message({ messageId: 'o2', direction: 'outbound', sentAt: '2026-01-01T10:01:00.000Z' }),
      message({ messageId: 'r2', direction: 'inbound', kind: 'control', json: READ, text: undefined, sentAt: '2026-01-01T10:01:30.000Z' }),
    ];
    expect(latestReadOutboundId(messages)).toBe('o2');
  });

  test('returns undefined with no receipts or no read outbound messages', () => {
    expect(latestReadOutboundId([
      message({ messageId: 'o1', direction: 'outbound', sentAt: '2026-01-01T10:00:00.000Z' }),
    ])).toBeUndefined();
    // A receipt that predates every outbound message marks nothing.
    expect(latestReadOutboundId([
      message({ messageId: 'r1', direction: 'inbound', kind: 'control', json: READ, text: undefined, sentAt: '2026-01-01T09:00:00.000Z' }),
      message({ messageId: 'o1', direction: 'outbound', sentAt: '2026-01-01T10:00:00.000Z' }),
    ])).toBeUndefined();
  });

  test('never marks an inbound message', () => {
    const messages: ConeMessage[] = [
      message({ messageId: 'i1', direction: 'inbound', sentAt: '2026-01-01T10:00:00.000Z' }),
      message({ messageId: 'r1', direction: 'inbound', kind: 'control', json: READ, text: undefined, sentAt: '2026-01-01T10:02:00.000Z' }),
    ];
    expect(latestReadOutboundId(messages)).toBeUndefined();
  });
});

describe('delivery status', () => {
  test('normalizes the SDK numeric enum (Unpublished=0, Published=1, Failed=2)', () => {
    expect(normalizeDeliveryStatus(0)).toBe('unpublished');
    expect(normalizeDeliveryStatus(1)).toBe('published');
    expect(normalizeDeliveryStatus(2)).toBe('failed');
  });

  test('normalizes string forms', () => {
    expect(normalizeDeliveryStatus('failed')).toBe('failed');
    expect(normalizeDeliveryStatus('unpublished')).toBe('unpublished');
    expect(normalizeDeliveryStatus('published')).toBe('published');
  });

  test('defaults unknown/missing values to published so real messages are never hidden', () => {
    expect(normalizeDeliveryStatus(undefined)).toBe('published');
    expect(normalizeDeliveryStatus(null)).toBe('published');
    expect(normalizeDeliveryStatus('weird')).toBe('published');
  });
});
