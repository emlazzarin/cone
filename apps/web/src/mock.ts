// In-memory ConeClient with sample data, used only by preview.html to render
// the signed-in app (and its density) without a real XMTP session. Not part of
// the production build — preview.html is never referenced by index.html.

import {
  READ_RECEIPT_TYPE,
  type ConeClient,
  type ConeConversation,
  type ConeIdentity,
  type ConeMessage,
  type Contact,
  type HandshakeCode,
  type IdentityRef,
  type MessageHandler,
  type PairingResult,
  type ResolvedIdentity,
  type SaveContactInput,
  type SentMessage,
  type SyncResult,
  type Unsubscribe,
} from '@cone/core';

const ME = '0x9f2c4d7b1a3e6f8c0d2b4a6e8f1c3d5b7a9e0c2d4f6b8a1c3e5d7f9b0a2c4e6d';
const ALICE = '0x3a9f1c2d4e6b8a0c2d4f6b8a1c3e5d7f9b0a2c4e6d8f1b3a5c7e9d1f3b5a7c2c';
const CODEX = '0x7c1e3d5b9a2c4e6f8b0d2a4c6e8f1b3d5a7c9e1f3b5d7a9c1e3f5b7d9a2c4e6f';
const BOB = '0x5d7f9b1a3c5e7d9f1b3a5c7e9d1f3b5a7c9e1d3f5b7a9c1e3d5f7b9a2c4e6d8f';

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export interface MockOptions {
  failSend?: boolean;
  sendDelayMs?: number;
}

export function createMockBootstrap(options: MockOptions = {}) {
  const identity: ConeIdentity = { inboxId: ME, address: '0x9f2c4d7b1a3e6f8c0d2b4a6e8f1c3d5b7a9e0c2d', env: 'dev' };

  const contacts: Contact[] = [
    contact('self-me', 'Me', ME, '0x9f2c4d7b1a3e6f8c0d2b4a6e8f1c3d5b7a9e0c2d', 'self'),
    contact('c-alice', 'Alice', ALICE, '0x3a9f1c2d4e6b8a0c2d4f6b8a1c3e5d7f9b0a2c4e', 'paired'),
    contact('c-codex', 'Codex', CODEX, undefined, 'paired'),
    contact('c-bob', 'bob.eth', BOB, '0x5d7f9b1a3c5e7d9f1b3a5c7e9d1f3b5a7c9e1d3f', 'inbound'),
  ];

  const conversations: ConeConversation[] = [
    conversation('dm:alice', ALICE, '0x3a9f1c2d4e6b8a0c2d4f6b8a1c3e5d7f9b0a2c4e', 'Alice', minutesAgo(2)),
    conversation('dm:codex', CODEX, undefined, 'Codex', minutesAgo(64)),
    conversation('dm:bob', BOB, '0x5d7f9b1a3c5e7d9f1b3a5c7e9d1f3b5a7c9e1d3f', 'bob.eth', minutesAgo(60 * 24 * 3)),
  ];

  const messages: ConeMessage[] = [
    text('m1', 'dm:alice', ALICE, ME, 'inbound', 'hey, you around?', minutesAgo(6)),
    text('m2', 'dm:alice', ME, ALICE, 'outbound', 'yep — what’s up', minutesAgo(5)),
    text('m3', 'dm:alice', ALICE, ME, 'inbound', 'can you review the pairing PR before the demo?', minutesAgo(3)),
    text('m4', 'dm:alice', ALICE, ME, 'inbound', 'no rush, just want it in before EOD', minutesAgo(2)),
    readReceipt('r-alice', 'dm:alice', ALICE, ME, minutesAgo(1)),
    text('m5', 'dm:codex', CODEX, ME, 'inbound', 'sync complete: 3 conversations, 41 messages', minutesAgo(70)),
    text('m6', 'dm:codex', ME, CODEX, 'outbound', 'thanks, listening for new messages now', minutesAgo(64)),
    text('m7', 'dm:bob', BOB, ME, 'inbound', 'gm', minutesAgo(60 * 24 * 3)),
  ];

  let handshake = 0;

  const client: ConeClient = {
    identity: async () => identity,
    resolveIdentity: async (ref: IdentityRef): Promise<ResolvedIdentity> => ({
      inboxId: typeof ref === 'string' ? ref : ref.inboxId ?? ALICE,
      source: 'inboxId',
    }),
    canMessage: async () => true,
    sendText: async (to: IdentityRef, body: string): Promise<SentMessage> => {
      if (options.sendDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.sendDelayMs));
      }
      if (options.failSend) {
        throw new Error('XMTP unreachable (mock failure)');
      }
      const conversationId = conversations.find((conversation) => conversation.peerInboxId === to)?.conversationId ?? 'dm:alice';
      const sentAt = new Date().toISOString();
      messages.push(text(`s${messages.length}`, conversationId, ME, ALICE, 'outbound', body, sentAt));
      const conversation = conversations.find((entry) => entry.conversationId === conversationId);
      if (conversation) {
        conversation.updatedAt = sentAt;
      }
      return { messageId: `s${messages.length}`, conversationId, sentAt };
    },
    sendJson: async () => ({ messageId: 'json', conversationId: 'dm:alice', sentAt: new Date().toISOString() }),
    sendReadReceipt: async () => undefined,
    sync: async (): Promise<SyncResult> => ({
      completedAt: new Date().toISOString(),
      conversationsSynced: conversations.length,
      errors: [],
      messagesSynced: messages.length,
      ok: true,
      startedAt: new Date().toISOString(),
    }),
    streamMessages: async (_handler: MessageHandler): Promise<Unsubscribe> => () => undefined,
    listConversations: async () => conversations.map((conversation) => ({ ...conversation })),
    listMessages: async (conversationId?: string) =>
      messages.filter((message) => !conversationId || message.conversationId === conversationId).map((message) => ({ ...message })),
    deleteConversation: async (conversationId: string) => {
      const index = conversations.findIndex((conversation) => conversation.conversationId === conversationId);
      if (index >= 0) {
        conversations.splice(index, 1);
      }
    },
    listContacts: async () => contacts.map((entry) => ({ ...entry })),
    saveContact: async (input: SaveContactInput): Promise<Contact> => {
      const next = contact(`c-${contacts.length}`, input.name, input.inboxId ?? ALICE, input.address, input.source ?? 'manual');
      contacts.push(next);
      return next;
    },
    deleteContact: async (contactId: string) => {
      const index = contacts.findIndex((entry) => entry.contactId === contactId);
      if (index >= 0) {
        contacts.splice(index, 1);
      }
    },
    createHandshakeCode: async (): Promise<HandshakeCode> => {
      handshake += 1;
      return {
        code: ['forest', 'wormhole', 'direction', 'lantern'][handshake % 4] + '-' + ['echo', 'amber', 'quartz', 'harbor'][handshake % 4],
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    },
    pairWithCode: async (): Promise<PairingResult> => {
      const peer = contact(`c-${contacts.length}`, 'New peer', '0x' + 'a'.repeat(64), undefined, 'paired');
      contacts.push(peer);
      return { contact: peer, peer: { inboxId: peer.inboxId, env: 'dev' }, sentConfirmation: true };
    },
    exportBackup: async () => new TextEncoder().encode('{"type":"cos.backup.v1"}'),
    importBackup: async () => undefined,
    close: async () => undefined,
  };

  return {
    session: { accountId: 'preview', client, env: 'dev' as const, identity },
    selectedConversationId: 'dm:alice',
  };
}

function contact(contactId: string, name: string, inboxId: string, address: string | undefined, source: Contact['source']): Contact {
  return { contactId, name, inboxId, address, source, createdAt: minutesAgo(9999), updatedAt: minutesAgo(2) };
}

function conversation(conversationId: string, peerInboxId: string, peerAddress: string | undefined, title: string, updatedAt: string): ConeConversation {
  return { conversationId, peerInboxId, peerAddress, title, updatedAt };
}

function text(
  messageId: string,
  conversationId: string,
  senderInboxId: string,
  recipientInboxId: string,
  direction: ConeMessage['direction'],
  body: string,
  sentAt: string,
): ConeMessage {
  return { messageId, conversationId, senderInboxId, recipientInboxId, sentAt, kind: 'text', direction, text: body };
}

function readReceipt(
  messageId: string,
  conversationId: string,
  senderInboxId: string,
  recipientInboxId: string,
  sentAt: string,
): ConeMessage {
  return { messageId, conversationId, senderInboxId, recipientInboxId, sentAt, kind: 'control', direction: 'inbound', json: { type: READ_RECEIPT_TYPE } };
}
