// Dev-only preview harness: renders the signed-in app with mock data so the
// chat/contacts/pair/backup/settings surfaces can be inspected without a real
// XMTP session. Open /preview.html?view=chats (or contacts, pair, …).
import { render } from 'preact';

import { App, type View } from './app';
import { createMockBootstrap } from './mock';
import './style.css';

const params = new URLSearchParams(location.search);
const view = (params.get('view') as View | null) ?? 'chats';
const composeTo = params.get('compose');
// ?scope=requests opens the Requests sub-surface; ?fail=1 makes mock sends
// reject; ?slow=<ms> delays them — for verifying optimistic/failed rows.
// ?selected=<conversationId> opens that chat (e.g. dm:codex, which has a
// disappearing-messages timer in the mock data).
const chatScope = params.get('scope') === 'requests' ? 'requests' : 'chats';
const selected = params.get('selected');
const mock = createMockBootstrap({
  failSend: params.has('fail'),
  sendDelayMs: params.has('slow') ? Number(params.get('slow') || 1500) : 0,
});

render(
  <App
    bootstrap={{
      ...mock,
      view,
      chatScope,
      ...(selected === null ? {} : { selectedConversationId: selected }),
      ...(composeTo === null ? {} : { composing: true, selectedConversationId: '', to: composeTo }),
    }}
  />,
  document.getElementById('app')!,
);
