import { describe, expect, test } from 'bun:test';
import type { Agent, MessageContext } from '@xmtp/agent-sdk';

import { ConeImpl } from '../src/cone';
import { MemoryStore } from '../src/stores/MemoryStore';
import { decodeToken } from '../src/token';
import type { Connection, CosAcceptV1, StoredConnection } from '../src/types';

function makeMockAgent(inboxId = 'agent-inbox', address = '0xABCD') {
  const sentMessages: Array<{ conversationId: string; text: string }> = [];
  const mockDm = {
    id: 'dm-conversation-id',
    sendText: async (text: string) => {
      sentMessages.push({ conversationId: 'dm-conversation-id', text });
      return `msg-${Math.random().toString(36).slice(2)}`;
    },
    messages: async () => [],
  };

  return {
    agent: {
      client: {
        inboxId,
        address,
        env: 'dev',
        conversations: {
          createDm: async (_inboxId: string) => mockDm,
        },
      },
      address,
    } as unknown as Agent,
    sentMessages,
    mockDm,
  };
}

function makeMockCtx(opts: {
  messageId: string;
  senderInboxId: string;
  content: string;
  conversationId?: string;
}) {
  const sentTexts: string[] = [];
  const conversationId = opts.conversationId ?? 'conv-id';
  const conversation = {
    id: conversationId,
    sendText: async (text: string) => {
      sentTexts.push(text);
      return 'msg-confirm';
    },
  };

  return {
    ctx: {
      message: {
        id: opts.messageId,
        senderInboxId: opts.senderInboxId,
        content: opts.content,
        sentAtNs: BigInt(Date.now()) * 1_000_000n,
      },
      conversation,
      isText: () => true,
    } as unknown as MessageContext,
    sentTexts,
  };
}

function makeStoredConnection(id: string, peerInboxId: string): StoredConnection {
  const now = new Date().toISOString();
  return {
    connectionId: id,
    pairId: `pair-${id}`,
    status: 'active',
    peerInboxId,
    createdAt: now,
    activatedAt: now,
    conversationId: `dm-${id}`,
  };
}

async function createInviteAcceptMessage(cone: ConeImpl) {
  const invite = await cone.createInvite();
  const payload = decodeToken(invite.token);

  const accept: CosAcceptV1 = {
    type: 'cos.accept.v1',
    inviteId: invite.inviteId,
    inviteSecret: payload.secret,
    fromInboxId: 'spoofed-inbox-id',
    fromAddress: '0xPEER',
    nonce: 'accept-nonce',
  };

  return { invite, accept };
}

describe('ConeImpl', () => {
  test('createInvite returns invite metadata and stores it', async () => {
    const { agent } = makeMockAgent();
    const store = new MemoryStore();
    const cone = new ConeImpl(agent, store, 60_000, 100);

    const invite = await cone.createInvite();
    const stored = await store.getInvite(invite.inviteId);

    expect(invite.inviteId).toBeString();
    expect(invite.token).toStartWith('cos:invite:v1:');
    expect(invite.expiresAt).toBeString();
    expect(invite.inviter).toEqual({ inboxId: 'agent-inbox', address: '0xABCD' });
    expect(stored).not.toBeNull();
  });

  test('createInvite respects custom expiresInMs', async () => {
    const { agent } = makeMockAgent();
    const store = new MemoryStore();
    const cone = new ConeImpl(agent, store, 60_000, 100);
    const before = Date.now();

    const invite = await cone.createInvite({ expiresInMs: 2_000 });
    const expiresAt = Date.parse(invite.expiresAt);

    expect(expiresAt).toBeGreaterThanOrEqual(before + 1_500);
    expect(expiresAt).toBeLessThanOrEqual(before + 4_000);
  });

  test('extractInviteToken finds tokens in text and returns null when absent', () => {
    const { agent } = makeMockAgent();
    const cone = new ConeImpl(agent, new MemoryStore(), 60_000, 100);

    expect(cone.extractInviteToken('accept this invite: cos:invite:v1:abc123')).toBe('cos:invite:v1:abc123');
    expect(cone.extractInviteToken('cos:invite:v1:abc123 starts here')).toBe('cos:invite:v1:abc123');
    expect(cone.extractInviteToken('no invite token here')).toBeNull();
  });

  test('renderInviteInstructions includes token and accept guidance', async () => {
    const { agent } = makeMockAgent();
    const cone = new ConeImpl(agent, new MemoryStore(), 60_000, 100);
    const invite = await cone.createInvite();
    const instructions = cone.renderInviteInstructions(invite);

    expect(instructions).toContain(invite.token);
    expect(instructions).toMatch(/accept/i);
  });

  test('handleMessage accepts a valid cos.accept.v1 and activates a connection', async () => {
    const { agent } = makeMockAgent();
    const store = new MemoryStore();
    const cone = new ConeImpl(agent, store, 60_000, 100);
    const events: Connection[] = [];
    cone.on('connection:active', (connection) => events.push(connection));
    const { invite, accept } = await createInviteAcceptMessage(cone);
    const { ctx, sentTexts } = makeMockCtx({
      messageId: 'msg-accept-1',
      senderInboxId: 'peer-inbox-1',
      content: JSON.stringify(accept),
      conversationId: 'conv-1',
    });

    await expect(cone.handleMessage(ctx)).resolves.toBe(true);

    const storedInvite = await store.getInvite(invite.inviteId);
    const storedConnections = await store.listConnections();

    expect(storedInvite?.status).toBe('consumed');
    expect(storedInvite?.consumedBy).toEqual({ inboxId: 'peer-inbox-1', address: '0xPEER' });
    expect(storedConnections).toHaveLength(1);
    expect(storedConnections[0]).toMatchObject({
      pairId: storedInvite?.pairId,
      status: 'active',
      peerInboxId: 'peer-inbox-1',
      peerAddress: '0xPEER',
      conversationId: 'conv-1',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      connectionId: storedConnections[0].connectionId,
      pairId: storedConnections[0].pairId,
      status: 'active',
      peerInboxId: 'peer-inbox-1',
    });
    expect(sentTexts).toHaveLength(1);
    expect(JSON.parse(sentTexts[0])).toMatchObject({
      type: 'cos.confirm.v1',
      inviteId: invite.inviteId,
      connectionId: storedConnections[0].connectionId,
      pairId: storedConnections[0].pairId,
      replyToNonce: accept.nonce,
    });
  });

  test('handleMessage rejects cos.accept.v1 with wrong secret', async () => {
    const { agent } = makeMockAgent();
    const store = new MemoryStore();
    const cone = new ConeImpl(agent, store, 60_000, 100);
    const { invite, accept } = await createInviteAcceptMessage(cone);
    const { ctx } = makeMockCtx({
      messageId: 'msg-accept-2',
      senderInboxId: 'peer-inbox-2',
      content: JSON.stringify({ ...accept, inviteSecret: 'wrong-secret' }),
    });

    await expect(cone.handleMessage(ctx)).resolves.toBe(false);

    expect(await store.getInvite(invite.inviteId)).toMatchObject({ status: 'pending' });
    expect(await store.listConnections()).toHaveLength(0);
  });

  test('handleMessage rejects expired invites', async () => {
    const { agent } = makeMockAgent();
    const store = new MemoryStore();
    const cone = new ConeImpl(agent, store, 60_000, 100);
    const { invite, accept } = await createInviteAcceptMessage(cone);
    const storedInvite = await store.getInvite(invite.inviteId);

    await store.putInvite({
      ...(storedInvite as StoredInvite),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const { ctx } = makeMockCtx({
      messageId: 'msg-accept-3',
      senderInboxId: 'peer-inbox-3',
      content: JSON.stringify(accept),
    });

    await expect(cone.handleMessage(ctx)).resolves.toBe(false);
    expect(await store.listConnections()).toHaveLength(0);
  });

  test('handleMessage is idempotent for already consumed invites', async () => {
    const { agent } = makeMockAgent();
    const store = new MemoryStore();
    const cone = new ConeImpl(agent, store, 60_000, 100);
    const { invite, accept } = await createInviteAcceptMessage(cone);

    await store.consumeInvite(invite.inviteId, { inboxId: 'existing-peer', address: '0xOLD' });

    const { ctx } = makeMockCtx({
      messageId: 'msg-accept-4',
      senderInboxId: 'peer-inbox-4',
      content: JSON.stringify(accept),
    });

    await expect(cone.handleMessage(ctx)).resolves.toBe(true);
    expect(await store.listConnections()).toHaveLength(0);
  });

  test('handleMessage rejects unknown invite ids', async () => {
    const { agent } = makeMockAgent();
    const cone = new ConeImpl(agent, new MemoryStore(), 60_000, 100);
    const { ctx } = makeMockCtx({
      messageId: 'msg-accept-5',
      senderInboxId: 'peer-inbox-5',
      content: JSON.stringify({
        type: 'cos.accept.v1',
        inviteId: 'missing-invite',
        inviteSecret: 'secret',
        fromInboxId: 'peer-inbox-5',
        nonce: 'nonce-5',
      }),
    });

    await expect(cone.handleMessage(ctx)).resolves.toBe(false);
  });

  test('handleMessage short-circuits repeated message ids', async () => {
    const { agent } = makeMockAgent();
    const store = new MemoryStore();
    const cone = new ConeImpl(agent, store, 60_000, 100);
    const events: Connection[] = [];
    cone.on('connection:active', (connection) => events.push(connection));
    const { accept } = await createInviteAcceptMessage(cone);
    const { ctx, sentTexts } = makeMockCtx({
      messageId: 'msg-accept-6',
      senderInboxId: 'peer-inbox-6',
      content: JSON.stringify(accept),
    });

    await expect(cone.handleMessage(ctx)).resolves.toBe(true);
    await expect(cone.handleMessage(ctx)).resolves.toBe(true);

    expect(await store.listConnections()).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(sentTexts).toHaveLength(1);
  });

  test('handleMessage emits message:text for plain text from known peers', async () => {
    const { agent } = makeMockAgent();
    const store = new MemoryStore();
    const connection = makeStoredConnection('known-text', 'peer-text');
    await store.putConnection(connection);
    const cone = new ConeImpl(agent, store, 60_000, 100);
    const events: Array<{ text: string; connectionId: string }> = [];
    cone.on('message:text', (event) => {
      events.push({ text: event.text, connectionId: event.connection.connectionId });
    });
    const { ctx } = makeMockCtx({
      messageId: 'msg-text-1',
      senderInboxId: 'peer-text',
      content: 'hello from peer',
    });

    await expect(cone.handleMessage(ctx)).resolves.toBe(true);
    expect(events).toEqual([{ text: 'hello from peer', connectionId: 'known-text' }]);
  });

  test('handleMessage emits message:json for wrapped json from known peers', async () => {
    const { agent } = makeMockAgent();
    const store = new MemoryStore();
    const connection = makeStoredConnection('known-json', 'peer-json');
    await store.putConnection(connection);
    const cone = new ConeImpl(agent, store, 60_000, 100);
    const events: unknown[] = [];
    cone.on('message:json', (event) => events.push(event.value));
    const { ctx } = makeMockCtx({
      messageId: 'msg-json-1',
      senderInboxId: 'peer-json',
      content: JSON.stringify({ type: 'cos.app.json.v1', value: { ok: true, count: 2 } }),
    });

    await expect(cone.handleMessage(ctx)).resolves.toBe(true);
    expect(events).toEqual([{ ok: true, count: 2 }]);
  });

  test('handleMessage rejects app messages from unknown peers', async () => {
    const { agent } = makeMockAgent();
    const cone = new ConeImpl(agent, new MemoryStore(), 60_000, 100);
    const { ctx } = makeMockCtx({
      messageId: 'msg-text-unknown',
      senderInboxId: 'unknown-peer',
      content: 'who am i',
    });

    await expect(cone.handleMessage(ctx)).resolves.toBe(false);
  });

  test('handleMessage no-ops for cos.confirm.v1 envelopes', async () => {
    const { agent } = makeMockAgent();
    const cone = new ConeImpl(agent, new MemoryStore(), 60_000, 100);
    const { ctx } = makeMockCtx({
      messageId: 'msg-confirm-1',
      senderInboxId: 'peer-confirm',
      content: JSON.stringify({
        type: 'cos.confirm.v1',
        inviteId: 'invite-1',
        connectionId: 'connection-1',
        pairId: 'pair-1',
        fromInboxId: 'peer-confirm',
        replyToNonce: 'nonce-1',
      }),
    });

    await expect(cone.handleMessage(ctx)).resolves.toBe(true);
  });

  test('sendText sends via DM for active connections', async () => {
    const { agent, sentMessages } = makeMockAgent();
    const store = new MemoryStore();
    await store.putConnection(makeStoredConnection('connection-send-text', 'peer-send-text'));
    const cone = new ConeImpl(agent, store, 60_000, 100);

    const sent = await cone.sendText({ connectionId: 'connection-send-text' }, 'hello dm');

    expect(sent.id).toBeString();
    expect(sent.sentAt).toBeString();
    expect(sentMessages).toEqual([{ conversationId: 'dm-conversation-id', text: 'hello dm' }]);
  });

  test('sendText throws for missing connections', async () => {
    const { agent } = makeMockAgent();
    const cone = new ConeImpl(agent, new MemoryStore(), 60_000, 100);

    await expect(cone.sendText({ connectionId: 'missing-connection' }, 'hello')).rejects.toThrow(/not found or inactive/i);
  });

  test('sendJson wraps values in cos.app.json.v1 envelopes', async () => {
    const { agent, sentMessages } = makeMockAgent();
    const store = new MemoryStore();
    await store.putConnection(makeStoredConnection('connection-send-json', 'peer-send-json'));
    const cone = new ConeImpl(agent, store, 60_000, 100);

    await cone.sendJson({ peerInboxId: 'peer-send-json' }, { greeting: 'hi', count: 1 });

    expect(sentMessages).toHaveLength(1);
    expect(JSON.parse(sentMessages[0].text)).toEqual({
      type: 'cos.app.json.v1',
      value: { greeting: 'hi', count: 1 },
    });
  });

  test('listConnections and getConnection resolve store-backed connections', async () => {
    const { agent } = makeMockAgent();
    const store = new MemoryStore();
    const first = makeStoredConnection('connection-a', 'peer-a');
    const second = makeStoredConnection('connection-b', 'peer-b');
    await store.putConnection(first);
    await store.putConnection(second);
    const cone = new ConeImpl(agent, store, 60_000, 100);

    const listed = await cone.listConnections();
    const byPeer = await cone.getConnection({ peerInboxId: 'peer-b' });
    const byId = await cone.getConnection({ connectionId: 'connection-a' });
    const missing = await cone.getConnection({ connectionId: 'missing' });

    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ connectionId: 'connection-a' }),
      expect.objectContaining({ connectionId: 'connection-b' }),
    ]));
    expect(byPeer).toMatchObject({ connectionId: 'connection-b', peerInboxId: 'peer-b' });
    expect(byId).toMatchObject({ connectionId: 'connection-a', peerInboxId: 'peer-a' });
    expect(missing).toBeNull();
  });
});
