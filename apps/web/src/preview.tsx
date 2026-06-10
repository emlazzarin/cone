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
// ?fail=1 makes mock sends reject; ?slow=<ms> delays them — for verifying
// optimistic and failed transcript rows.
const mock = createMockBootstrap({
  failSend: params.has('fail'),
  sendDelayMs: params.has('slow') ? Number(params.get('slow') || 1500) : 0,
});

render(
  <App
    bootstrap={{
      ...mock,
      view,
      ...(composeTo === null ? {} : { composing: true, selectedConversationId: '', to: composeTo }),
    }}
  />,
  document.getElementById('app')!,
);
