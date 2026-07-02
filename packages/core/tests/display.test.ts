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

const READ = { type: 'cone.read.v1' };

describe('read receipts', () => {
  test('isReadReceipt recognizes only the read-receipt envelope', () => {
    expect(isReadReceipt({ json: READ })).toBe(true);
    expect(isReadReceipt({ json: { type: 'cone.pair.confirm.v1' } })).toBe(false);
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

describe('group updates', () => {
  const update = {
    type: 'cone.group.update.v1' as const,
    initiatedByInboxId: 'inbox-alice',
    added: ['inbox-bob'],
    removed: [] as string[],
    left: ['inbox-carol'],
    metadataChanges: [{ field: 'group_name', oldValue: 'Old', newValue: 'Crew' }],
  };

  test('formatGroupUpdate renders attributed system lines', async () => {
    const { formatGroupUpdate } = await import('../src/index');
    const names: Record<string, string> = { 'inbox-alice': 'Alice', 'inbox-bob': 'Bob', 'inbox-carol': 'Carol' };
    expect(formatGroupUpdate(update, (inboxId) => names[inboxId] ?? inboxId)).toEqual([
      'Alice added Bob',
      'Carol left',
      'Alice renamed the group to Crew',
    ]);
  });

  test('isAddressedTo matches @alias at token boundaries, case-insensitively', async () => {
    const { isAddressedTo } = await import('../src/index');
    expect(isAddressedTo('@concierge can you mint a link?', ['concierge'])).toBe(true);
    expect(isAddressedTo('hey @Concierge, ping', ['concierge'])).toBe(true);
    expect(isAddressedTo('ends with @concierge', ['concierge'])).toBe(true);
    // Token boundary: a longer alias must not match a shorter mention query.
    expect(isAddressedTo('@conciergebot hello', ['concierge'])).toBe(false);
    expect(isAddressedTo('mail me at bot@concierge.example', ['concierge'])).toBe(true);
    expect(isAddressedTo('no mention here', ['concierge'])).toBe(false);
    expect(isAddressedTo(undefined, ['concierge'])).toBe(false);
    expect(isAddressedTo('@bot hi', ['concierge', 'bot'])).toBe(true);
    expect(isAddressedTo('@bot hi', [undefined, ''])).toBe(false);
  });

  test('a disappearing-timer change renders once, with the duration', async () => {
    const { formatGroupUpdate } = await import('../src/index');
    // One timer change arrives as two metadata field changes (from_ns + in_ns).
    const timerUpdate = {
      ...update,
      added: [],
      left: [],
      metadataChanges: [
        { field: 'message_disappear_from_ns', oldValue: '0', newValue: '1750000000000000000' },
        { field: 'message_disappear_in_ns', oldValue: '0', newValue: '3600000000000' },
      ],
    };
    expect(formatGroupUpdate(timerUpdate, () => 'Alice')).toEqual([
      'Alice set disappearing messages to 1h',
    ]);

    const offUpdate = {
      ...timerUpdate,
      metadataChanges: [
        { field: 'message_disappear_from_ns', oldValue: '1750000000000000000', newValue: '0' },
        { field: 'message_disappear_in_ns', oldValue: '3600000000000', newValue: '0' },
      ],
    };
    expect(formatGroupUpdate(offUpdate, () => 'Alice')).toEqual([
      'Alice turned disappearing messages off',
    ]);
  });

  test('an empty update still yields an attributed line', async () => {
    const { formatGroupUpdate } = await import('../src/index');
    expect(formatGroupUpdate({ ...update, added: [], left: [], metadataChanges: [] })).toEqual([
      'inbox-alice updated the group',
    ]);
  });

  test('group updates are control messages, hidden from transcripts but humanized in previews', async () => {
    const { messageBody } = await import('../src/index');
    expect(isVisibleChatMessage({ kind: 'control', json: update })).toBe(false);
    expect(messageBody({ json: update })).toBe('[inbox-alice added inbox-bob; inbox-carol left; inbox-alice renamed the group to Crew]');
  });
});

describe('chat-list filter matching', () => {
  const INBOX = '9f2c4d7b1a3e6f8c0d2b4a6e8f1c3d5b7a9e0c2d4f6b8a1c3e5d7f9b0a2c4e6d';
  const named = { title: 'Alice', peerInboxId: INBOX };
  const unnamed = { title: INBOX, peerInboxId: INBOX };
  const group = { title: 'Project Alpha', peerInboxId: undefined };

  test('matches the title case-insensitively and reports the range', async () => {
    const { matchConversationFilter } = await import('../src/index');
    expect(matchConversationFilter(named, 'LIC')).toEqual({ field: 'title', value: 'Alice', index: 1, length: 3 });
    expect(matchConversationFilter(group, 'alpha')).toEqual({ field: 'title', value: 'Project Alpha', index: 8, length: 5 });
  });

  test('falls back to the peer inbox ID when the name does not match', async () => {
    const { matchConversationFilter } = await import('../src/index');
    expect(matchConversationFilter(named, '8f1c3d')).toEqual({ field: 'inboxId', value: INBOX, index: 24, length: 6 });
  });

  test('an unnamed peer (title === inbox ID) always matches as an inbox ID', async () => {
    const { matchConversationFilter } = await import('../src/index');
    expect(matchConversationFilter(unnamed, '9f2c')).toEqual({ field: 'inboxId', value: INBOX, index: 0, length: 4 });
  });

  test('trims the query and treats empty or non-matching queries as no match', async () => {
    const { matchConversationFilter } = await import('../src/index');
    expect(matchConversationFilter(named, '  lic  ')?.field).toBe('title');
    expect(matchConversationFilter(named, '')).toBeNull();
    expect(matchConversationFilter(named, '   ')).toBeNull();
    expect(matchConversationFilter(named, 'zzz')).toBeNull();
  });

  test('accepts the same rows the surfaces accepted before the helper existed', async () => {
    const { matchConversationFilter } = await import('../src/index');
    // Legacy behavior: title OR peerInboxId substring, case-insensitive.
    for (const conversation of [named, unnamed, group]) {
      for (const query of ['ali', 'ALPHA', INBOX.slice(30, 38), 'nope']) {
        const legacy =
          conversation.title.toLowerCase().includes(query.toLowerCase()) ||
          (conversation.peerInboxId ?? '').toLowerCase().includes(query.toLowerCase());
        expect(matchConversationFilter(conversation, query) !== null).toBe(legacy);
      }
    }
  });

  test('snippet windows the match with ellipses only where text was cut', async () => {
    const { filterMatchSnippet, matchConversationFilter } = await import('../src/index');
    const match = matchConversationFilter(named, '8f1c3d')!;
    expect(filterMatchSnippet(match)).toEqual({ before: '…2b4a6e', hit: '8f1c3d', after: '5b7a9e…' });
    // Match at the very start: no leading ellipsis, no cut before it.
    const head = matchConversationFilter(unnamed, '9f2c')!;
    expect(filterMatchSnippet(head)).toEqual({ before: '', hit: '9f2c', after: '4d7b1a…' });
    // Match at the very end: no trailing ellipsis.
    const tail = matchConversationFilter(unnamed, INBOX.slice(-4))!;
    expect(filterMatchSnippet(tail)).toEqual({ before: '…9b0a2c', hit: '4e6d', after: '' });
    // Short titles fit entirely: no ellipses at all.
    const title = matchConversationFilter(named, 'lic')!;
    expect(filterMatchSnippet(title)).toEqual({ before: 'A', hit: 'lic', after: 'e' });
  });
});
