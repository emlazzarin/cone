// In-memory ConeClient with sample data, used only by preview.html to render
// the signed-in app (and its density) without a real XMTP session. Not part of
// the production build — preview.html is never referenced by index.html.

import {
  READ_RECEIPT_TYPE,
  isExpiredMessage,
  type ConeClient,
  type ConeConversation,
  type ConeGroupMember,
  type ConeIdentity,
  type ConeMessage,
  type Contact,
  type CreateGroupInput,
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
    contact('c-alice', 'Alice', ALICE, '0x3a9f1c2d4e6b8a0c2d4f6b8a1c3e5d7f9b0a2c4e', 'paired'),
    contact('c-codex', 'Codex', CODEX, undefined, 'paired'),
    contact('c-bob', 'bob.eth', BOB, '0x5d7f9b1a3c5e7d9f1b3a5c7e9d1f3b5a7c9e1d3f', 'manual'),
  ];

  const STRANGER = '0x1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff0011';
  const SPAMMER = '0x99aa88bb77cc66dd55ee44ff33001122334455667788990011223344556677ab';
  const groupMembers: ConeGroupMember[] = [
    { inboxId: ME, level: 'superAdmin', consentState: 'allowed' },
    { inboxId: ALICE, level: 'member', consentState: 'allowed' },
    { inboxId: BOB, level: 'member', consentState: 'allowed' },
  ];
  const conversations: ConeConversation[] = [
    conversation('dm:alice', ALICE, '0x3a9f1c2d4e6b8a0c2d4f6b8a1c3e5d7f9b0a2c4e', 'Alice', minutesAgo(2), 'allowed'),
    // Codex has a custom (non-preset) disappearing-messages timer, as if set
    // via TUI free text — previews exercise the ⌛ chip and the header select
    // acknowledging a custom value.
    { ...conversation('dm:codex', CODEX, undefined, 'Codex', minutesAgo(64), 'allowed'), retention: { durationMs: 6 * 24 * 60 * 60_000, fromAt: minutesAgo(90) } },
    conversation('dm:bob', BOB, '0x5d7f9b1a3c5e7d9f1b3a5c7e9d1f3b5a7c9e1d3f', 'bob.eth', minutesAgo(60 * 24 * 3), 'allowed'),
    // A group chat — previews exercise multi-sender transcripts and the
    // group header/meta rendering.
    {
      conversationId: 'group:crew',
      kind: 'group',
      title: 'Cone Crew',
      groupName: 'Cone Crew',
      memberCount: groupMembers.length,
      members: groupMembers,
      updatedAt: minutesAgo(15),
      consentState: 'allowed',
    },
    // An unknown sender — appears in the Requests sub-surface, not the inbox.
    conversation('dm:stranger', STRANGER, undefined, STRANGER, minutesAgo(8), 'unknown'),
    // A blocked sender — hidden everywhere except the Settings blocked list.
    conversation('dm:spammer', SPAMMER, undefined, SPAMMER, minutesAgo(120), 'denied'),
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
    text('m8', 'dm:stranger', STRANGER, ME, 'inbound', 'hey, are you the dev behind Cone?', minutesAgo(8)),
    groupText('g1', 'group:crew', ALICE, 'pushed the new pairing flow to dev', minutesAgo(40)),
    groupText('g2', 'group:crew', BOB, 'nice — trying it now', minutesAgo(30)),
    groupText('g3', 'group:crew', ME, 'ship it', minutesAgo(15)),
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
    sendToConversation: async (conversationId: string, body: string): Promise<SentMessage> => {
      if (options.sendDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.sendDelayMs));
      }
      if (options.failSend) {
        throw new Error('XMTP unreachable (mock failure)');
      }
      const sentAt = new Date().toISOString();
      messages.push(text(`s${messages.length}`, conversationId, ME, ALICE, 'outbound', body, sentAt));
      const conversation = conversations.find((entry) => entry.conversationId === conversationId);
      if (conversation) {
        conversation.updatedAt = sentAt;
      }
      return { messageId: `s${messages.length}`, conversationId, sentAt };
    },
    sendReadReceipt: async () => undefined,
    createGroup: async (input: CreateGroupInput): Promise<ConeConversation> => {
      const created: ConeConversation = {
        conversationId: `group:${conversations.length}`,
        kind: 'group',
        title: input.name ?? 'Group',
        groupName: input.name,
        groupDescription: input.description,
        memberCount: input.members.length + 1,
        members: groupMembers,
        updatedAt: new Date().toISOString(),
        consentState: 'allowed',
      };
      conversations.push(created);
      return created;
    },
    listGroupMembers: async () => groupMembers.map((member) => ({ ...member })),
    addGroupMembers: async () => undefined,
    removeGroupMembers: async () => undefined,
    leaveGroup: async (conversationId: string) => {
      const conversation = conversations.find((entry) => entry.conversationId === conversationId);
      if (conversation) {
        conversation.active = false;
      }
    },
    renameGroup: async (conversationId: string, name: string) => {
      const conversation = conversations.find((entry) => entry.conversationId === conversationId);
      if (conversation) {
        conversation.groupName = name;
        conversation.title = name;
      }
    },
    setGroupDescription: async (conversationId: string, description: string) => {
      const conversation = conversations.find((entry) => entry.conversationId === conversationId);
      if (conversation) {
        conversation.groupDescription = description || undefined;
      }
    },
    setGroupMemberLevel: async () => undefined,
    setConsent: async (to: IdentityRef, state) => {
      const inboxId = typeof to === 'string' ? to : to.inboxId;
      for (const conversation of conversations) {
        if (conversation.peerInboxId === inboxId) {
          conversation.consentState = state;
        }
      }
    },
    setConversationConsent: async (conversationId: string, state) => {
      const conversation = conversations.find((entry) => entry.conversationId === conversationId);
      if (conversation) {
        conversation.consentState = state;
      }
    },
    setRetention: async (conversationId: string, durationMs: number | null) => {
      const conversation = conversations.find((entry) => entry.conversationId === conversationId);
      if (conversation) {
        conversation.retention = durationMs !== null && durationMs > 0
          ? { durationMs, fromAt: new Date().toISOString() }
          : undefined;
      }
    },
    purgeExpiredMessages: async () => {
      const retentionByConversation = new Map(conversations.map((entry) => [entry.conversationId, entry.retention]));
      const now = Date.now();
      const before = messages.length;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (isExpiredMessage(message, retentionByConversation.get(message.conversationId), now)) {
          messages.splice(index, 1);
        }
      }
      return before - messages.length;
    },
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
    inviteToGroupWithCode: async (_code: string, conversationId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { conversationId, joiner: { inboxId: STRANGER, proposedName: 'Sam' } };
    },
    joinGroupWithCode: async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { conversationId: 'group:crew', groupName: 'crew', memberCount: 3, inviter: { inboxId: ALICE } };
    },
    listPendingGroupJoins: async () => [],
    cancelGroupJoin: async () => undefined,
    createGroupInviteLink: async (conversationId: string) => ({
      linkId: `link-${Date.now()}`,
      conversationId,
      token: 'cone_gi_v1_M0ckT0kenM0ckT0ken',
      nonce: 'mock-nonce',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
      maxUses: 1,
      uses: 0,
      servicedParticipantIds: [],
    }),
    listGroupInviteLinks: async () => [],
    revokeGroupInviteLink: async () => undefined,
    serviceGroupInviteLinks: async () => [],
    exportBackup: async () => new TextEncoder().encode('{"type":"cone.backup.v1"}'),
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

function conversation(conversationId: string, peerInboxId: string, peerAddress: string | undefined, title: string, updatedAt: string, consentState: ConeConversation['consentState']): ConeConversation {
  return { conversationId, kind: 'dm', peerInboxId, peerAddress, title, updatedAt, consentState };
}

function groupText(messageId: string, conversationId: string, senderInboxId: string, body: string, sentAt: string): ConeMessage {
  return {
    messageId,
    conversationId,
    senderInboxId,
    sentAt,
    kind: 'text',
    direction: senderInboxId === ME ? 'outbound' : 'inbound',
    text: body,
  };
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
