#!/usr/bin/env bun
// Render the real TUI (renderChat + real state) at several sizes and modes —
// the fastest way to eyeball a render change without a live session.
//
//   bun run scripts/tui-preview.ts
import { createChatState, renderChat } from '../packages/cli/src/chat';

const identity = { env: 'dev' as const, inboxId: 'inbox-alice-0123456789abcdef' };
const conversations = [
  { conversationId: 'dm-bob', kind: 'dm' as const, peerInboxId: 'inbox-bob', title: 'Bob', consentState: 'allowed' as const, updatedAt: '2026-07-02T16:20:00.000Z' },
  { conversationId: 'group-crew', kind: 'group' as const, title: 'crew', groupName: 'crew', memberCount: 3, consentState: 'allowed' as const, updatedAt: '2026-07-02T16:00:00.000Z', members: [
    { inboxId: 'inbox-alice-0123456789abcdef', level: 'superAdmin' as const, consentState: 'allowed' as const },
    { inboxId: 'inbox-bob', level: 'member' as const, consentState: 'allowed' as const },
    { inboxId: 'inbox-carol', level: 'admin' as const, consentState: 'allowed' as const },
  ] },
  { conversationId: 'dm-stranger', kind: 'dm' as const, peerInboxId: 'inbox-stranger', title: 'inbox-stranger', consentState: 'unknown' as const, updatedAt: '2026-07-02T15:00:00.000Z' },
];
const contacts = [
  { contactId: 'c-bob', name: 'Bob', inboxId: 'inbox-bob', source: 'paired' as const, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
];

function makeState() {
  const state = createChatState(identity, conversations, contacts);
  state.streamState = 'online';
  state.messages = [
    { conversationId: 'dm-bob', direction: 'inbound', kind: 'text', messageId: 'm1', senderInboxId: 'inbox-bob', sentAt: '2026-07-02T16:02:00.000Z', text: 'can you review the pairing PR before the demo?' },
    { conversationId: 'dm-bob', direction: 'outbound', kind: 'text', messageId: 'm2', senderInboxId: identity.inboxId, sentAt: '2026-07-02T16:04:00.000Z', text: 'on it — give me 10' },
    { conversationId: 'dm-bob', direction: 'inbound', kind: 'control', messageId: 'r1', senderInboxId: 'inbox-bob', sentAt: '2026-07-02T16:05:00.000Z', json: { type: 'cone.read.v1' } },
    { conversationId: 'dm-bob', direction: 'inbound', kind: 'text', messageId: 'm3', senderInboxId: 'inbox-bob', sentAt: '2026-07-02T16:19:00.000Z', text: 'no rush, just want it in before EOD' },
  ];
  state.previewByConversation = {
    'dm-bob': 'no rush, just want it in before EOD',
    'group-crew': 'me: ship it',
    'dm-stranger': 'hey, are you the dev behind Cone?',
  };
  state.unreadByConversation = { 'group-crew': 2 };
  state.status = 'live';
  return state;
}

function show(title: string, state: ReturnType<typeof makeState>, width: number, height: number): void {
  console.log(`\n━━━ ${title} (${width}×${height}) ━━━`);
  // Drop the leading clear-screen/hide-cursor line so frames stack nicely.
  console.log(renderChat(state, width, height).split('\n').slice(1).join('\n'));
}

show('chat-select, wide', makeState(), 100, 22);

const talk = makeState();
talk.mode = 'chat-talk';
talk.input = 'sounds good — pushing the fix now';
show('chat-talk, wide', talk, 100, 22);

const narrow = makeState();
show('chat-select, narrow (single column)', narrow, 60, 18);

const narrowTalk = makeState();
narrowTalk.mode = 'chat-talk';
narrowTalk.input = 'typing on a phone-sized terminal';
show('chat-talk, narrow', narrowTalk, 60, 18);

const requests = makeState();
requests.scope = 'requests';
requests.selectedIndex = 0;
// The real TUI swaps state.messages per selected conversation.
requests.messages = [
  { conversationId: 'dm-stranger', direction: 'inbound', kind: 'text', messageId: 's1', senderInboxId: 'inbox-stranger', sentAt: '2026-07-02T15:00:00.000Z', text: 'hey, are you the dev behind Cone?' },
];
show('requests sub-surface', requests, 100, 16);

const info = makeState();
info.selectedIndex = 1;
info.mode = 'group-info';
show('group info', info, 100, 18);

const short = makeState();
show('very short terminal (compact rows)', short, 100, 12);
