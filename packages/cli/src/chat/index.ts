import { errorMessage, formatMessageLine, formatSyncStatus, type ConeClient, type Unsubscribe } from '@cone/core';

import { ESC_FLUSH_MS, InputDecoder } from './input-decoder';
import { handleInput } from './input';
import { renderChat } from './render';
import {
  applyConversationMeta,
  clampSelections,
  createChatState,
  loadDraft,
  preserveSelection,
  promoteActiveContactConversation,
  refreshMessages,
  selectedContact,
  selectedConversation,
} from './state';
import { CSI, shortId } from './text';
import type { ChatOptions, RefreshOptions } from './types';

const AUTO_SYNC_MS = 60_000;

export async function runChat(client: ConeClient, options: ChatOptions = {}): Promise<void> {
  if (options.plainLog) {
    await runPlainLog(client, options);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('cos chat requires an interactive TTY; use cos chat --plain-log for non-interactive output');
  }

  const state = createChatState(await client.identity(), await client.listConversations(), await client.listContacts());
  state.readReceipts = options.readReceipts ?? true;
  let persistedReadReceipts = state.readReceipts;
  applyConversationMeta(state, await client.listMessages());
  clampSelections(state);
  await refreshMessages(client, state);

  let unsubscribe: Unsubscribe | undefined;
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const render = () => {
    if (!closed) {
      process.stdout.write(renderChat(state, process.stdout.columns ?? 100, process.stdout.rows ?? 30));
    }
  };

  const refresh = async (refreshOptions: RefreshOptions = {}) => {
    const previousConversationId = selectedConversation(state)?.conversationId;
    const previousContactId = selectedContact(state)?.contactId;
    state.conversations = await client.listConversations();
    state.contacts = await client.listContacts();
    applyConversationMeta(state, await client.listMessages());
    preserveSelection(state, previousConversationId, previousContactId);
    clampSelections(state);
    promoteActiveContactConversation(state);

    const currentConversationId = selectedConversation(state)?.conversationId;
    if (previousConversationId !== currentConversationId) {
      state.transcriptScroll = 0;
      loadDraft(state);
    }

    await refreshMessages(client, state);
    if (!refreshOptions.preserveScroll) {
      state.transcriptScroll = 0;
    }
    render();
  };

  const syncNow = async (syncOptions: { quiet?: boolean } = {}) => {
    const previousStatus = state.status;
    state.syncState = 'syncing';
    if (!syncOptions.quiet) {
      state.status = 'syncing';
    }
    render();

    const result = await client.sync();
    state.syncState = result.ok ? 'idle' : 'stale';
    state.status = syncOptions.quiet && result.ok
      ? state.streamState === 'online' ? 'live' : previousStatus
      : formatSyncStatus(result);
    await refresh({ preserveScroll: true });
  };

  const markSyncFailed = (error: unknown) => {
    state.syncState = 'stale';
    state.status = `sync failed: ${errorMessage(error)}`;
    render();
  };

  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    if (syncTimer) {
      clearInterval(syncTimer);
    }
    await unsubscribe?.();
    restoreTerminal();
  };

  setupTerminal();
  try {
    render();

    if (options.syncOnOpen !== false) {
      void syncNow({ quiet: true }).catch(markSyncFailed);
      syncTimer = setInterval(() => {
        void syncNow({ quiet: true }).catch(markSyncFailed);
      }, AUTO_SYNC_MS);
    }

    try {
      unsubscribe = await client.streamMessages(async (message) => {
        const activeConversationId = selectedConversation(state)?.conversationId;
        const isActiveAtBottom = message.conversationId === activeConversationId && state.transcriptScroll === 0;
        if (!isActiveAtBottom) {
          state.unreadByConversation[message.conversationId] = (state.unreadByConversation[message.conversationId] ?? 0) + 1;
        }
        state.streamState = 'online';
        state.status = message.conversationId === activeConversationId ? 'new message' : 'new message in another chat';
        await refresh({ preserveScroll: message.conversationId !== activeConversationId || state.transcriptScroll > 0 });
      });
      state.streamState = 'online';
      state.status = 'live';
      render();
    } catch (error) {
      state.streamState = 'offline';
      state.status = `stream failed: ${errorMessage(error)}`;
      render();
    }

    await new Promise<void>((resolve) => {
      const decoder = new InputDecoder();
      let inputQueue = Promise.resolve();
      let flushTimer: ReturnType<typeof setTimeout> | undefined;

      const clearFlushTimer = () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
      };

      const enqueueInput = (input: string) => {
        inputQueue = inputQueue
          .then(async () => {
            await handleInput(String(input), client, state, refresh, syncNow, async () => {
              clearFlushTimer();
              process.stdin.off('data', onData);
              process.stdout.off('resize', render);
              await close();
              resolve();
            });
            if (state.readReceipts !== persistedReadReceipts) {
              persistedReadReceipts = state.readReceipts;
              options.onReadReceiptsChange?.(state.readReceipts);
            }
            render();
          })
          .catch((error: unknown) => {
            state.status = errorMessage(error);
            render();
          });
      };

      const flushPendingInput = () => {
        clearFlushTimer();
        for (const input of decoder.flush()) {
          enqueueInput(input);
        }
      };

      const onData = (chunk: Buffer) => {
        clearFlushTimer();
        for (const input of decoder.push(String(chunk))) {
          enqueueInput(input);
        }
        if (decoder.hasPending()) {
          flushTimer = setTimeout(flushPendingInput, ESC_FLUSH_MS);
        }
      };
      process.stdin.on('data', onData);
      process.stdout.on('resize', render);
    });
  } finally {
    await close();
  }
}

async function runPlainLog(client: ConeClient, options: ChatOptions): Promise<void> {
  const identity = await client.identity();
  process.stdout.write(`cos chat ${shortId(identity.inboxId)} ${identity.env}\n`);
  if (options.syncOnOpen !== false) {
    const result = await client.sync();
    process.stdout.write(`${formatSyncStatus(result)}\n`);
  }
  const conversations = await client.listConversations();
  for (const conversation of conversations) {
    process.stdout.write(`# ${conversation.title} ${conversation.conversationId}\n`);
  }
  await client.streamMessages((message) => {
    process.stdout.write(`${formatMessageLine(message, shortId(message.senderInboxId))}\n`);
  });
  await new Promise(() => undefined);
}

function setupTerminal(): void {
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.setRawMode(true);
  process.stdout.write(`${CSI}?1049h${CSI}?25l`);
}

function restoreTerminal(): void {
  process.stdin.setRawMode(false);
  process.stdout.write(`${CSI}?25h${CSI}?1049l`);
}

export type { ChatMode, ChatOptions, ChatState, ContactEditForm } from './types';
export {
  createAddContactForm,
  createDeleteContactForm,
  createDeleteConversationForm,
  createNewMessageForm,
  createPairCreateResultForm,
  createPairJoinForm,
  createRenameContactForm,
} from './forms';
export { renderChat } from './render';
export { handleInput } from './input';
export { applyConversationMeta, createChatState, visibleConversations } from './state';
export { InputDecoder } from './input-decoder';
export { messageBody } from '@cone/core';
export { wrapText } from './text';
