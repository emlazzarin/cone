import { describe, expect, test } from 'bun:test';

import type { ConeClient, ConeMessage, SentMessage } from '@cone/core';

import {
  applyConversationMeta,
  createAddContactForm,
  createChatState,
  createDeleteContactForm,
  createDeleteConversationForm,
  createNewMessageForm,
  createPairCreateResultForm,
  createPairJoinForm,
  handleInput,
  InputDecoder,
  messageBody,
  renderChat,
  visibleConversations,
  wrapText,
} from '../src/chat';

describe('cos chat', () => {
  test('renders select mode with a useful top bar and mode-specific footer', () => {
    const state = createChatState(
      { env: 'dev', inboxId: 'inbox-alice-long' },
      [{
        conversationId: 'dm-bob',
        peerInboxId: 'inbox-bob-long',
        title: 'PWA Tester',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    );
    state.streamState = 'online';
    state.messages = [{
      conversationId: 'dm-bob',
      direction: 'inbound',
      kind: 'text',
      messageId: 'msg-1',
      senderInboxId: 'inbox-bob-long',
      sentAt: '2026-01-01T16:39:00',
      text: "hey what's your name",
    }];

    const output = renderChat(state, 100, 24);

    expect(output).toContain('Cone of Silence ·dev');
    expect(output).toContain('1 Chats');
    expect(output).toContain('2 Contacts');
    expect(output).toContain('live');
    expect(output).toContain('PWA Tester');
    expect(output).toContain('you inbox-...long');
    expect(output).toContain("16:39 - PWA Tester: hey what's your name");
    expect(output).toContain('Enter talk');
    expect(output).toContain('n new message');
    expect(output).toContain('/ filter');
    expect(output).toContain('d delete');
    expect(output).not.toContain('unread');
    expect(output).not.toContain('Chats select');
    expect(output).not.toContain('s sync');
    expect(output).not.toContain('Chat(select)');
    expect(output).not.toContain('sync:idle stream:online');
    expect(output).not.toContain('send/run');
    expect(output).not.toContain('p pair');
  });

  test('renders chat mode as an insert-like message composer', () => {
    const state = createChatState(
      { env: 'dev', inboxId: 'inbox-alice-long' },
      [{
        conversationId: 'dm-bob',
        peerInboxId: 'inbox-bob-long',
        title: 'Bob',
      }],
    );
    state.mode = 'chat-talk';
    state.input = 'jk are text here';

    const output = renderChat(state, 80, 20);

    expect(output).toContain('Bob');
    expect(output).toContain('Message:');
    expect(output).toContain('jk are text here');
    expect(output).toContain('█');
    expect(output).toContain('Enter send');
    expect(output).toContain('Esc back');
    expect(output).not.toContain('message Bob:');
    expect(output).not.toContain('Tab focus');
    expect(output).not.toContain('[p] pair');
  });

  test('renders contacts with explicit contact details', () => {
    const state = createChatState(
      { env: 'dev', inboxId: 'inbox-alice' },
      [],
      [{
        contactId: 'contact-bob',
        createdAt: '2026-01-01T00:00:00.000Z',
        address: '0x1111111111111111111111111111111111111111',
        inboxId: 'inbox-bob-long',
        name: 'Bob',
        source: 'paired',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    );
    state.mode = 'contacts-select';

    const output = renderChat(state, 90, 20);

    expect(output).toContain('[contacts]');
    expect(output).toContain('[contact]');
    expect(output).toContain('Bob');
    expect(output).toContain('XMTP inbox ID: inbox-bob-long');
    expect(output).toContain('EVM address: 0x1111111111111111111111111111111111111111');
    expect(output).toContain('Source: paired');
    expect(output).toContain('Created: 2026-01-01T00:00:00.000Z');
    expect(output).toContain('Updated: 2026-01-01T00:00:00.000Z');
    expect(output).toContain('r rename');
    expect(output).toContain('d delete');
    expect(output).toContain('c code');
    expect(output).toContain('p join code');
  });

  test('renders structured Contacts(edit) forms instead of parser-driven prompts', () => {
    const state = createChatState({ env: 'dev', inboxId: 'inbox-alice' });
    state.mode = 'contacts-edit';
    state.editForm = createAddContactForm();
    state.editForm.fields[0]!.value = 'Dana Laptop';
    state.editForm.fields[1]!.value = 'inbox-dana';

    const output = renderChat(state, 100, 20);

    expect(output).toContain('[Add contact]');
    expect(output).toContain('> Name: Dana Laptop');
    expect(output).toContain('XMTP inbox ID or EVM address: inbox-dana');
    expect(output).toContain('Tab next field');
    expect(output).toContain('Shift+Tab previous');
    expect(output).not.toContain('name | inbox-or-address');
  });

  test('renders delete and pairing as structured Contacts(edit) forms', () => {
    const contact = {
      contactId: 'contact-bob',
      createdAt: '2026-01-01T00:00:00.000Z',
      inboxId: 'inbox-bob',
      name: 'Bob',
      source: 'manual' as const,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const deleteState = createChatState({ env: 'dev', inboxId: 'inbox-alice' }, [], [contact]);
    deleteState.mode = 'contacts-edit';
    deleteState.editForm = createDeleteContactForm(contact);
    const pairState = createChatState({ env: 'dev', inboxId: 'inbox-alice' });
    pairState.mode = 'contacts-edit';
    pairState.editForm = createPairJoinForm();
    const codeState = createChatState({ env: 'dev', inboxId: 'inbox-alice' });
    codeState.mode = 'contacts-edit';
    codeState.editForm = createPairCreateResultForm('forest-wormhole-direction', '2026-01-01T00:10:00.000Z');

    expect(renderChat(deleteState, 90, 18)).toContain('Type DELETE to confirm');
    expect(renderChat(pairState, 90, 18)).toContain('Handshake code');
    expect(renderChat(pairState, 90, 18)).not.toContain('blank creates one');
    expect(renderChat(pairState, 90, 18)).toContain('Share my name (optional)');
    expect(renderChat(pairState, 90, 18)).toContain('Save the other side as (optional)');
    expect(renderChat(codeState, 90, 18)).toContain('forest-wormhole-direction');
    expect(renderChat(codeState, 90, 18)).toContain('Code expires at');
    expect(renderChat(codeState, 90, 18)).toContain('CLI: cos pair forest-wormhole-direction');
  });

  test('renders local chat deletion as a structured confirmation form', () => {
    const conversation = {
      conversationId: 'dm-bob',
      peerInboxId: 'inbox-bob',
      title: 'Bob',
    };
    const state = createChatState({ env: 'dev', inboxId: 'inbox-alice' }, [conversation]);
    state.mode = 'chat-compose';
    state.editForm = createDeleteConversationForm(conversation);

    const output = renderChat(state, 90, 18);

    expect(output).toContain('[Delete chat Bob]');
    expect(output).toContain('Type DELETE to remove Bob');
    expect(output).toContain('Enter Delete');
  });

  test('starts local chat deletion from Chat(select) and submits after confirmation', async () => {
    const conversation = {
      conversationId: 'dm-bob',
      peerInboxId: 'inbox-bob',
      title: 'Bob',
    };
    const state = createChatState({ env: 'dev', inboxId: 'inbox-alice' }, [conversation]);
    const deleted: string[] = [];
    const client = stubClient({
      deleteConversation: async (conversationId) => {
        deleted.push(conversationId);
        state.conversations = state.conversations.filter((candidate) => candidate.conversationId !== conversationId);
      },
    });
    const refresh = async () => {};

    await handleInput('d', client, state, refresh, async () => {}, async () => {});
    expect(state.mode).toBe('chat-compose');
    expect(state.editForm?.kind).toBe('conversation-delete');
    state.editForm!.fields[0]!.value = 'DELETE';

    await handleInput('\n', client, state, refresh, async () => {}, async () => {});

    expect(deleted).toEqual(['dm-bob']);
    expect(state.mode).toBe('chat-select');
    expect(state.status).toContain('deleted local chat Bob');
  });

  test('chat Enter clears the composer before network send resolves', async () => {
    const conversation = {
      conversationId: 'dm-bob',
      peerInboxId: 'inbox-bob',
      title: 'Bob',
    };
    const state = createChatState({ env: 'dev', inboxId: 'inbox-alice' }, [conversation]);
    state.mode = 'chat-talk';
    state.input = 'hello';
    let sendStarted = false;
    let resolveSend: ((sent: SentMessage) => void) | undefined;
    const client = stubClient({
      sendText: () => {
        sendStarted = true;
        return new Promise<SentMessage>((resolve) => {
          resolveSend = resolve;
        });
      },
    });
    let refreshes = 0;

    const returned = await Promise.race([
      handleInput('\n', client, state, async () => {
        refreshes += 1;
      }, async () => {}, async () => {}).then(() => true),
      delay(25).then(() => false),
    ]);

    expect(returned).toBe(true);
    expect(sendStarted).toBe(true);
    expect(state.input).toBe('');
    expect(state.status).toContain('sending to Bob');

    resolveSend?.({ conversationId: 'dm-bob', messageId: 'sent-1', sentAt: '2026-01-01T00:00:00.000Z' });
    await delay(0);
    expect(state.status).toContain('sent to Bob');
    expect(refreshes).toBe(1);
  });

  test('renders optimistic outbound rows instantly and marks failures with retry', async () => {
    const conversation = {
      conversationId: 'dm-bob',
      peerInboxId: 'inbox-bob',
      title: 'Bob',
    };
    const state = createChatState({ env: 'dev', inboxId: 'inbox-alice' }, [conversation]);
    state.mode = 'chat-talk';
    state.input = 'hello optimism';
    let rejectSend: ((error: Error) => void) | undefined;
    const client = stubClient({
      sendText: () => new Promise<SentMessage>((_resolve, reject) => {
        rejectSend = reject;
      }),
    });

    await handleInput('\n', client, state, async () => {}, async () => {}, async () => {});

    // The row is in the transcript before the network resolves, unmarked.
    const optimistic = renderChat(state, 100, 24);
    expect(optimistic).toContain('me: hello optimism');
    expect(optimistic).not.toContain('✗');
    expect(state.input).toBe('');

    rejectSend?.(new Error('network down'));
    await delay(0);

    // Failure marks the row and restores the text for an instant retry.
    const failed = renderChat(state, 100, 24);
    expect(failed).toContain('✗');
    expect(failed).toContain('hello optimism');
    expect(state.input).toBe('hello optimism');
    expect(state.status).toContain('send failed');

    // Retrying supersedes the failed row; on success the pending row is
    // dropped and refresh surfaces the delivered copy from the store.
    const retryClient = stubClient();
    const refreshWithDelivered = async () => {
      state.messages = [{
        conversationId: 'dm-bob',
        direction: 'outbound' as const,
        kind: 'text' as const,
        messageId: 'real-1',
        senderInboxId: 'inbox-alice',
        sentAt: new Date().toISOString(),
        text: 'hello optimism',
      }];
    };
    await handleInput('\n', retryClient, state, refreshWithDelivered, async () => {}, async () => {});
    await delay(0);
    const retried = renderChat(state, 100, 24);
    expect(retried).toContain('me: hello optimism');
    expect(retried).not.toContain('✗');
    expect(state.pendingMessages).toHaveLength(0);
  });

  test('shows a single ✓✓ Read marker on the latest read outbound message', () => {
    const conversation = { conversationId: 'dm-bob', peerInboxId: 'inbox-bob', title: 'Bob' };
    const state = createChatState({ env: 'dev', inboxId: 'inbox-alice' }, [conversation]);
    state.messages = [
      { conversationId: 'dm-bob', direction: 'outbound', kind: 'text', messageId: 'o1', senderInboxId: 'inbox-alice', sentAt: '2026-01-01T10:00:00.000Z', text: 'first' },
      { conversationId: 'dm-bob', direction: 'outbound', kind: 'text', messageId: 'o2', senderInboxId: 'inbox-alice', sentAt: '2026-01-01T10:01:00.000Z', text: 'second' },
      { conversationId: 'dm-bob', direction: 'inbound', kind: 'control', messageId: 'r1', senderInboxId: 'inbox-bob', sentAt: '2026-01-01T10:02:00.000Z', json: { type: 'cos.read.v1' } },
    ];

    const output = renderChat(state, 80, 16);
    expect(output).toContain('✓✓ Read');
    // The read receipt itself is never shown as a transcript line.
    expect(output).not.toContain('[read]');
    // Exactly one marker.
    expect(output.match(/Read/g)?.length).toBe(1);
  });

  test('hides read state and the receipt line when read receipts are off', () => {
    const conversation = { conversationId: 'dm-bob', peerInboxId: 'inbox-bob', title: 'Bob' };
    const state = createChatState({ env: 'dev', inboxId: 'inbox-alice' }, [conversation]);
    state.readReceipts = false;
    state.messages = [
      { conversationId: 'dm-bob', direction: 'outbound', kind: 'text', messageId: 'o1', senderInboxId: 'inbox-alice', sentAt: '2026-01-01T10:00:00.000Z', text: 'first' },
      { conversationId: 'dm-bob', direction: 'inbound', kind: 'control', messageId: 'r1', senderInboxId: 'inbox-bob', sentAt: '2026-01-01T10:02:00.000Z', json: { type: 'cos.read.v1' } },
    ];

    const output = renderChat(state, 80, 16);
    expect(output).not.toContain('✓✓ Read');
    expect(output).toContain('receipts off');
  });

  test('R toggles read receipts and sends one when viewing new inbound messages', async () => {
    const conversation = { conversationId: 'dm-bob', peerInboxId: 'inbox-bob', title: 'Bob' };
    const state = createChatState({ env: 'dev', inboxId: 'inbox-alice' }, [conversation]);
    const receipts: string[] = [];
    const client = stubClient({
      listMessages: async () => [
        { conversationId: 'dm-bob', direction: 'inbound', kind: 'text', messageId: 'i1', senderInboxId: 'inbox-bob', sentAt: '2026-01-01T10:00:00.000Z', text: 'hi' },
      ],
      sendReadReceipt: async (to) => { receipts.push(String(to)); },
    });

    // Viewing the conversation acknowledges the newest inbound message once.
    await handleInput('j', client, state, async () => {}, async () => {}, async () => {});
    expect(receipts).toEqual(['inbox-bob']);
    await handleInput('j', client, state, async () => {}, async () => {}, async () => {});
    expect(receipts).toEqual(['inbox-bob']); // deduped — nothing new arrived

    // Turning receipts off stops sending and is reflected in the top bar.
    await handleInput('R', client, state, async () => {}, async () => {}, async () => {});
    expect(state.readReceipts).toBe(false);
    expect(state.status).toContain('read receipts off');
  });

  test('Ctrl+X discards a failed message instead of retrying it', async () => {
    const conversation = { conversationId: 'dm-bob', peerInboxId: 'inbox-bob', title: 'Bob' };
    const state = createChatState({ env: 'dev', inboxId: 'inbox-alice' }, [conversation]);
    state.mode = 'chat-talk';
    state.input = 'doomed';
    const client = stubClient({ sendText: () => Promise.reject(new Error('network down')) });

    await handleInput('\n', client, state, async () => {}, async () => {}, async () => {});
    await delay(0);
    expect(state.pendingMessages.some((entry) => entry.status === 'failed')).toBe(true);
    expect(renderChat(state, 90, 16)).toContain('✗');

    // Ctrl+X (\u0018) drops the failed row without resending.
    await handleInput('\u0018', client, state, async () => {}, async () => {}, async () => {});
    expect(state.pendingMessages).toHaveLength(0);
    expect(state.status).toContain('discarded');
    expect(renderChat(state, 90, 16)).not.toContain('✗');
  });

  test('Ctrl+X also discards a failed message from the chat list', async () => {
    const conversation = { conversationId: 'dm-bob', peerInboxId: 'inbox-bob', title: 'Bob' };
    const state = createChatState({ env: 'dev', inboxId: 'inbox-alice' }, [conversation]);
    state.mode = 'chat-talk';
    state.input = 'doomed';
    const client = stubClient({ sendText: () => Promise.reject(new Error('network down')) });

    await handleInput('\n', client, state, async () => {}, async () => {}, async () => {});
    await delay(0);
    expect(state.pendingMessages.some((entry) => entry.status === 'failed')).toBe(true);

    // The chat-select footer offers Ctrl+X for the selected chat's
    // failed row too — Esc back to the list, then discard.
    await handleInput('\u001b', client, state, async () => {}, async () => {}, async () => {});
    expect(state).toHaveProperty('mode', 'chat-select');
    await handleInput('\u0018', client, state, async () => {}, async () => {}, async () => {});
    expect(state.pendingMessages).toHaveLength(0);
    expect(state.status).toContain('discarded');
  });

  test('renders structured new-message form with target suggestions', () => {
    const state = createChatState(
      { env: 'dev', inboxId: 'inbox-alice' },
      [{
        conversationId: 'dm-bob',
        peerInboxId: 'inbox-bob',
        title: 'Bob',
      }],
      [{
        contactId: 'contact-dana',
        createdAt: '2026-01-01T00:00:00.000Z',
        inboxId: 'inbox-dana',
        name: 'Dana',
        source: 'manual',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    );
    state.mode = 'chat-compose';
    state.editForm = createNewMessageForm();
    state.editForm.fields[0]!.value = 'Da';

    const output = renderChat(state, 100, 22);

    expect(output).toContain('[New message]');
    expect(output).toContain('> To: Da');
    expect(output).toContain('Message:');
    expect(output).toContain('Suggestions from contacts and conversations');
    expect(output).toContain('Dana');
    expect(output).toContain('Up/Down choose target');
    expect(output).toContain('Enter accept target');
  });

  test('keeps selected rows visible in long inbox lists', () => {
    const state = createChatState(
      { env: 'dev', inboxId: 'inbox-alice' },
      Array.from({ length: 30 }, (_, index) => ({
        conversationId: `dm-${index}`,
        peerInboxId: `inbox-${index}`,
        title: `Chat ${index}`,
      })),
    );
    state.selectedIndex = 29;

    const output = renderChat(state, 80, 12);

    expect(output).toContain('> Chat 29');
    expect(output).not.toContain('Chat 0');
  });

  test('sorts chats by recency and shows previews, times, and unread badges', () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const state = createChatState(
      { env: 'dev', inboxId: 'inbox-alice' },
      [
        { conversationId: 'dm-old', peerInboxId: 'inbox-old', title: 'Old Chat', updatedAt: minutesAgo(60 * 24 * 2) },
        { conversationId: 'dm-new', peerInboxId: 'inbox-new', title: 'Fresh Chat', updatedAt: minutesAgo(60) },
      ],
    );
    applyConversationMeta(state, [
      {
        conversationId: 'dm-old',
        direction: 'outbound',
        kind: 'text',
        messageId: 'm-old',
        senderInboxId: 'inbox-alice',
        sentAt: minutesAgo(60 * 24 * 2),
        text: 'see you tomorrow',
      },
      {
        conversationId: 'dm-new',
        direction: 'inbound',
        kind: 'text',
        messageId: 'm-new',
        senderInboxId: 'inbox-new',
        sentAt: minutesAgo(2),
        text: 'are you around?',
      },
    ]);
    state.unreadByConversation['dm-new'] = 2;

    expect(state.conversations[0]?.conversationId).toBe('dm-new');
    const output = renderChat(state, 100, 24);
    expect(output).toContain('Fresh Chat');
    expect(output).toContain('are you around?');
    expect(output).toContain('you: see you tomorrow');
    expect(output).toContain('2m');
    expect(output).toContain('●2');
    expect(output).toContain('2 new');
  });

  test('filters chats live with / and clears with Esc', async () => {
    const client = stubClient();
    const refresh = async () => {};
    const syncNow = async () => {};
    const quit = async () => {};
    const state = createChatState(
      { env: 'dev', inboxId: 'inbox-alice' },
      [
        { conversationId: 'dm-bob', peerInboxId: 'inbox-bob', title: 'Bob' },
        { conversationId: 'dm-codex', peerInboxId: 'inbox-codex', title: 'Codex' },
      ],
    );

    await handleInput('/', client, state, refresh, syncNow, quit);
    expect(state.filterActive).toBe(true);

    await handleInput('c', client, state, refresh, syncNow, quit);
    await handleInput('o', client, state, refresh, syncNow, quit);
    expect(state.filter).toBe('co');
    expect(visibleConversations(state).map((conversation) => conversation.title)).toEqual(['Codex']);
    expect(renderChat(state, 100, 24)).toContain('[chats /co 1/2]');

    await handleInput('\r', client, state, refresh, syncNow, quit);
    expect(state.filterActive).toBe(false);
    expect(state.filter).toBe('co');

    await handleInput('\u001b', client, state, refresh, syncNow, quit);
    expect(state.filter).toBe('');
    expect(visibleConversations(state)).toHaveLength(2);
  });

  test('humanizes Cone JSON envelopes instead of dumping protocol wrappers', () => {
    const appJson: ConeMessage = {
      conversationId: 'dm-bob',
      direction: 'inbound',
      json: { type: 'cos.app.json.v1', value: 'plain value' },
      kind: 'json',
      messageId: 'msg-json',
      senderInboxId: 'inbox-bob',
      sentAt: '2026-01-01T00:00:00.000Z',
    };
    expect(messageBody(appJson)).toBe('plain value');

    const control: ConeMessage = {
      conversationId: 'dm-bob',
      direction: 'inbound',
      json: { type: 'cos.pair.confirm.v1' },
      kind: 'control',
      messageId: 'msg-control',
      senderInboxId: 'inbox-bob',
      sentAt: '2026-01-01T00:00:00.000Z',
    };
    expect(messageBody(control)).toBe('[pair confirmed]');
  });

  test('wraps multiline text and long tokens', () => {
    expect(wrapText('alpha beta gamma', 8)).toEqual(['alpha', 'beta', 'gamma']);
    expect(wrapText('abcdefghijk', 4)).toEqual(['abcd', 'efgh', 'ijk']);
    expect(wrapText('one\ntwo', 10)).toEqual(['one', 'two']);
  });

  test('indents wrapped transcript rows under the message body', () => {
    const state = createChatState(
      { env: 'dev', inboxId: 'inbox-alice' },
      [{
        conversationId: 'dm-bob',
        peerInboxId: 'inbox-bob',
        title: 'Bob',
      }],
    );
    state.messages = [{
      conversationId: 'dm-bob',
      direction: 'inbound',
      kind: 'text',
      messageId: 'msg-long',
      senderInboxId: 'inbox-bob',
      sentAt: '2026-01-01T16:39:00',
      text: 'this is a message that wraps cleanly',
    }];

    const output = renderChat(state, 60, 14);

    expect(output).toContain('16:39 - Bob: this');
    expect(output).toContain('             wraps cleanly');
  });

  test('does not expose slash command or command palette concepts', () => {
    const state = createChatState({ env: 'dev', inboxId: 'inbox-alice' });
    const output = renderChat(state, 100, 20);

    expect(output).not.toContain('/sync');
    expect(output).not.toContain('/pair');
    expect(output).not.toContain('command palette');
    expect(output).not.toContain('cmd');
  });

  test('uses 1 and 2 as portable pane shortcuts outside typing modes', async () => {
    const client = {} as ConeClient;
    const refresh = async () => {};
    const syncNow = async () => {};
    const quit = async () => {};
    const state = createChatState({ env: 'dev', inboxId: 'inbox-alice' });

    state.mode = 'contacts-select';
    await handleInput('1', client, state, refresh, syncNow, quit);
    expect(state.mode as string).toBe('chat-select');

    await handleInput('2', client, state, refresh, syncNow, quit);
    expect(state.mode as string).toBe('contacts-select');

    state.mode = 'chat-talk';
    state.input = '';
    await handleInput('2', client, state, refresh, syncNow, quit);
    expect(state.mode as string).toBe('chat-talk');
    expect(state.input).toBe('2');
  });

  test('decodes coalesced and split terminal input chunks', () => {
    const decoder = new InputDecoder();

    expect(decoder.push('jk')).toEqual(['j', 'k']);
    expect(decoder.push('\u001b')).toEqual([]);
    expect(decoder.push('[A')).toEqual(['\u001b[A']);
    expect(decoder.push('hi\n')).toEqual(['h', 'i', '\n']);
  });
});

function stubClient(overrides: Partial<ConeClient> = {}): ConeClient {
  return {
    canMessage: async () => true,
    close: async () => {},
    createHandshakeCode: async () => ({ code: 'forest-wormhole-direction', expiresAt: '2026-01-01T00:10:00.000Z' }),
    deleteContact: async () => {},
    deleteConversation: async () => {},
    exportBackup: async () => new Uint8Array(),
    identity: async () => ({ env: 'dev', inboxId: 'inbox-alice' }),
    importBackup: async () => {},
    listContacts: async () => [],
    listConversations: async () => [],
    listMessages: async () => [],
    pairWithCode: async () => ({
      contact: {
        contactId: 'contact-peer',
        createdAt: '2026-01-01T00:00:00.000Z',
        inboxId: 'inbox-peer',
        name: 'Peer',
        source: 'paired',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      peer: { env: 'dev', inboxId: 'inbox-peer' },
      sentConfirmation: true,
    }),
    resolveIdentity: async () => ({ inboxId: 'inbox-peer', source: 'contact' }),
    saveContact: async (input) => ({
      contactId: 'contact-peer',
      createdAt: '2026-01-01T00:00:00.000Z',
      inboxId: input.inboxId ?? 'inbox-peer',
      name: input.name,
      source: input.source ?? 'manual',
      updatedAt: '2026-01-01T00:00:00.000Z',
      address: input.address,
    }),
    sendJson: async () => ({ messageId: 'sent-json', sentAt: '2026-01-01T00:00:00.000Z' }),
    sendReadReceipt: async () => {},
    sendText: async () => ({ conversationId: 'dm-peer', messageId: 'sent-text', sentAt: '2026-01-01T00:00:00.000Z' }),
    streamMessages: async () => () => {},
    sync: async () => ({
      completedAt: '2026-01-01T00:00:00.000Z',
      conversationsSynced: 0,
      errors: [],
      messagesSynced: 0,
      ok: true,
      startedAt: '2026-01-01T00:00:00.000Z',
    }),
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
