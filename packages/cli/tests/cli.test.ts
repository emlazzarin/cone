import { describe, expect, test } from 'bun:test';

import { generateSecretKey, type ConeClient, type ConeConsentState, type ConeConversation, type ConeGroupMember, type ConeIdentity, type ConeMessage, type Contact, type IncomingMessage, type MessageHandler, type SecretKey, type SentMessage, type SyncResult, type Unsubscribe, type XmtpEnv } from '@cone/core';

import { runCli, type CliIo } from '../src/index';

describe('CLI', () => {
  test('keygen prints a parseable secret', async () => {
    const io = makeIo();

    expect(await runCli(['keygen'], io)).toBe(0);
    expect(io.out[0]?.startsWith('cos_sk_v1_')).toBe(true);
  });

  test('login reads a single prompted secret without requiring stdin EOF', async () => {
    const secret = generateSecretKey();
    const io = makeIo('', { secretLine: secret });

    expect(await runCli(['login'], io)).toBe(0);

    expect(io.prompts).toEqual(['Paste SECRET_KEY: ']);
    expect(JSON.parse(io.out.join(''))).toEqual({ ok: true, remembered: false });
  });

  test('login --secret-stdin warns when used from an interactive terminal', async () => {
    const secret = generateSecretKey();
    const io = makeIo(secret, { isStdinTty: true });

    expect(await runCli(['login', '--secret-stdin'], io)).toBe(0);

    expect(io.err.join('')).toContain('press Ctrl-D');
    expect(io.err.join('')).toContain('cos login --remember');
  });

  test('send command resolves client from stdin secret and sends text', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    let receivedOptions: { env?: XmtpEnv } | undefined;

    const exitCode = await runCli(
      ['send', '--secret-stdin', '--to', 'Alice', '--text', 'hello'],
      io,
      {
        createClient: async (_secret: SecretKey, options?: { env?: XmtpEnv }) => {
          receivedOptions = options;
          return client;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(client.sent).toEqual([{ to: 'Alice', text: 'hello' }]);
    expect(receivedOptions).toEqual({ env: undefined });
  });

  test('contacts commands list and add contacts through the client', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(
      await runCli(
        ['contacts', 'add', '--secret-stdin', '--name', 'Alice', '--identity', '0x1111111111111111111111111111111111111111'],
        io,
        { createClient: async () => client },
      ),
    ).toBe(0);

    expect(client.contacts[0]?.name).toBe('Alice');
  });

  test('pair creates a handshake code without unlocking an account', async () => {
    const io = makeIo(generateSecretKey());

    expect(await runCli(['pair'], io, { createClient: async () => {
      throw new Error('client should not be created');
    } })).toBe(0);

    const output = JSON.parse(io.out.join('')) as { code?: string };
    expect(output.code).toContain('-');
  });

  test('pair with a code does not send a peer-visible name implicitly', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(
      await runCli(
        ['pair', 'shared-code', '--secret-stdin'],
        io,
        { createClient: async () => client },
      ),
    ).toBe(0);

    expect(client.pairRequests[0]).toEqual({ code: 'shared-code', proposedName: undefined });
    const output = JSON.parse(io.out.join('')) as { next?: { send?: string }; contact?: { name?: string } };
    expect(output.contact?.name).toBe('Dana');
    expect(output.next?.send).toBe('cos send --to "Dana" --text "hello"');
  });

  test('pair with a code supports explicit share and local contact names', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(
      await runCli(
        ['pair', 'shared-code', '--secret-stdin', '--share-name', 'Charlie CLI', '--save-as', 'Dana Laptop'],
        io,
        { createClient: async () => client },
      ),
    ).toBe(0);

    expect(client.pairRequests[0]).toEqual({ code: 'shared-code', proposedName: 'Charlie CLI' });
    const output = JSON.parse(io.out.join('')) as { next?: { send?: string }; contact?: { name?: string } };
    expect(output.contact?.name).toBe('Dana Laptop');
    expect(output.next?.send).toBe('cos send --to "Dana Laptop" --text "hello"');
  });

  test('old pair subcommands point to the simplified syntax', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(['pair', 'join', 'shared-code', '--secret-stdin'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('usage: cos pair [code]');
  });

  test('listen --once waits for one message before exiting', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    const exitPromise = runCli(
      ['listen', '--secret-stdin', '--once', '--timeout-ms', '1000'],
      io,
      { createClient: async () => client },
    );

    await client.waitForHandler();
    await client.emit({
      conversationId: 'dm-cli',
      messageId: 'msg-cli-inbound',
      raw: {},
      senderInboxId: 'inbox-alice',
      sentAt: new Date().toISOString(),
      text: 'hello from alice',
    });

    expect(await exitPromise).toBe(0);
    expect(io.out.join('')).toContain('hello from alice');
    expect(client.unsubscribed).toBe(true);
  });

  test('inbox commands sync and read through the local read model', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [{
      conversationId: 'dm-cli',
      contactId: 'contact-alice',
      kind: 'dm' as const, peerInboxId: 'inbox-alice', consentState: 'allowed',
      title: 'Alice',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }];
    client.messages = [{
      conversationId: 'dm-cli',
      direction: 'inbound',
      kind: 'text',
      messageId: 'msg-cli',
      senderInboxId: 'inbox-alice',
      sentAt: '2026-01-01T00:00:00.000Z',
      text: 'hello',
    }];

    expect(await runCli(['inbox', 'sync', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.synced).toBe(true);
    expect(await runCli(['inbox', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(await runCli(['inbox', 'read', '--secret-stdin', 'Alice'], io, { createClient: async () => client })).toBe(0);

    const output = io.out.join('\n');
    expect(output).toContain('Alice');
    expect(output).toContain('hello');
  });

  test('chat requires an interactive terminal unless plain log is requested', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(['chat', '--secret-stdin'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('requires an interactive TTY');
  });

  test('inbox list hides requests and points to cos requests', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-allowed', kind: 'dm' as const, peerInboxId: 'inbox-allowed', title: 'Allowed', consentState: 'allowed' },
      { conversationId: 'dm-req', kind: 'dm' as const, peerInboxId: 'inbox-stranger', title: 'inbox-stranger', consentState: 'unknown' },
    ];

    expect(await runCli(['inbox', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    const output = io.out.join('');
    expect(output).toContain('Allowed');
    expect(output).not.toContain('inbox-stranger');
    expect(output).toContain('1 request');
  });

  test('requests list shows only unknown senders', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-allowed', kind: 'dm' as const, peerInboxId: 'inbox-allowed', title: 'Allowed', consentState: 'allowed' },
      { conversationId: 'dm-req', kind: 'dm' as const, peerInboxId: 'inbox-stranger', title: 'inbox-stranger', consentState: 'unknown' },
    ];

    expect(await runCli(['requests', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    const output = io.out.join('');
    expect(output).toContain('inbox-stranger');
    expect(output).not.toContain('Allowed');
  });

  test('requests accept marks the peer allowed and can save a contact', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-req', kind: 'dm' as const, peerInboxId: 'inbox-stranger', title: 'inbox-stranger', consentState: 'unknown' },
    ];

    expect(await runCli(['requests', 'accept', 'dm-req', '--save-as', 'Stranger', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.consentCalls).toContainEqual({ to: 'inbox-stranger', state: 'allowed' });
    expect(client.conversations.find((c) => c.conversationId === 'dm-req')?.consentState).toBe('allowed');
    expect(client.contacts.some((contact) => contact.name === 'Stranger' && contact.inboxId === 'inbox-stranger')).toBe(true);
  });

  test('requests block denies the peer inbox', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-req', kind: 'dm' as const, peerInboxId: 'inbox-stranger', title: 'inbox-stranger', consentState: 'unknown' },
    ];

    expect(await runCli(['requests', 'block', 'inbox-stranger', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.consentCalls.at(-1)).toEqual({ to: 'inbox-stranger', state: 'denied' });
    expect(client.conversations.find((c) => c.conversationId === 'dm-req')?.consentState).toBe('denied');
  });

  test('group create resolves members and reports the new group', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(
      ['group', 'create', '--secret-stdin', '--member', 'Alice', '--member', 'inbox-bob', '--name', 'Crew', '--locked'],
      io,
      { createClient: async () => client },
    )).toBe(0);

    expect(client.groupCreates[0]).toEqual({ name: 'Crew', members: ['Alice', 'inbox-bob'], locked: true });
    const output = JSON.parse(io.out.join('')) as { kind?: string; title?: string };
    expect(output.kind).toBe('group');
    expect(output.title).toBe('Crew');
  });

  test('group create requires at least one member', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(['group', 'create', '--secret-stdin', '--name', 'Crew'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('usage: cos group create');
  });

  test('group info, add, send, and leave resolve a group by name', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'group-crew', kind: 'group', title: 'Crew', groupName: 'Crew', consentState: 'allowed' },
      { conversationId: 'dm-alice', kind: 'dm', peerInboxId: 'inbox-alice', title: 'Alice', consentState: 'allowed' },
    ];
    client.groupMembers = [
      { inboxId: 'inbox-cli', level: 'superAdmin', consentState: 'allowed' },
      { inboxId: 'inbox-bob', level: 'member', consentState: 'allowed' },
    ];

    expect(await runCli(['group', 'info', 'Crew', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(io.out.join('')).toContain('inbox-cli [superAdmin]');

    expect(await runCli(['group', 'add', 'Crew', '--member', 'inbox-dana', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.groupMemberAdds).toEqual([{ conversationId: 'group-crew', members: ['inbox-dana'] }]);

    expect(await runCli(['group', 'send', 'Crew', '--text', 'hello crew', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.sentToConversation).toEqual([{ conversationId: 'group-crew', text: 'hello crew' }]);

    expect(await runCli(['group', 'leave', 'Crew', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.leftGroups).toEqual(['group-crew']);
  });

  test('group commands reject DM targets and unknown groups', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-alice', kind: 'dm', peerInboxId: 'inbox-alice', title: 'Alice', consentState: 'allowed' },
    ];

    expect(await runCli(['group', 'info', 'Alice', '--secret-stdin'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('group not found');
  });

  test('requests accept and block on a group target the group conversation', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'group-req', kind: 'group', title: 'Mystery Crew', consentState: 'unknown' },
    ];

    expect(await runCli(['requests', 'accept', 'group-req', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.consentCalls).toContainEqual({ to: 'group-req', state: 'allowed' });
    expect(client.conversations[0]?.consentState).toBe('allowed');

    expect(await runCli(['requests', 'block', 'group-req', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.consentCalls.at(-1)).toEqual({ to: 'group-req', state: 'denied' });
    // Accept's --save-as is DM-only; a group accept never creates a contact.
    expect(client.contacts).toHaveLength(0);
  });

  test('timer sets, shows, and clears the disappearing-messages duration', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-alice', kind: 'dm' as const, peerInboxId: 'inbox-alice', title: 'Alice', consentState: 'allowed' },
    ];

    expect(await runCli(['timer', 'Alice', '1h', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.retentionCalls.at(-1)).toEqual({ conversationId: 'dm-alice', durationMs: 3_600_000 });
    expect(io.out.join('')).toContain('Disappearing messages in Alice: 1h.');

    expect(await runCli(['timer', 'dm-alice', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(io.out.at(-1)).toContain('Disappearing messages in Alice: 1h.');

    expect(await runCli(['timer', 'inbox-alice', 'off', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.retentionCalls.at(-1)).toEqual({ conversationId: 'dm-alice', durationMs: null });
    expect(io.out.at(-1)).toContain('Disappearing messages off in Alice.');
  });

  test('timer rejects unknown targets and junk durations', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-alice', kind: 'dm' as const, peerInboxId: 'inbox-alice', title: 'Alice', consentState: 'allowed' },
    ];

    expect(await runCli(['timer', '--secret-stdin'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('usage: cos timer');

    expect(await runCli(['timer', 'Nobody', '1h', '--secret-stdin'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('not found');

    expect(await runCli(['timer', 'Alice', 'banana', '--secret-stdin'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('invalid duration');
    expect(client.retentionCalls).toHaveLength(0);
  });
});

function makeIo(
  stdin = '',
  options: { isStdinTty?: boolean; secretLine?: string } = {},
): CliIo & { err: string[]; out: string[]; prompts: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  return {
    err,
    out,
    prompts,
    isStdinTty: () => options.isStdinTty ?? false,
    secretLine: async (prompt) => {
      prompts.push(prompt);
      return options.secretLine ?? stdin;
    },
    stderr: (text) => err.push(text),
    stdinText: async () => stdin,
    stdout: (text) => out.push(text),
  };
}

class MockClient implements ConeClient {
  conversations: ConeConversation[] = [];
  contacts: Contact[] = [];
  messages: ConeMessage[] = [];
  pairRequests: Array<{ code: string; proposedName?: string }> = [];
  sent: Array<{ to: string; text: string }> = [];
  sentToConversation: Array<{ conversationId: string; text: string }> = [];
  consentCalls: Array<{ to: string; state: ConeConsentState }> = [];
  groupCreates: Array<{ name?: string; members: unknown[]; locked?: boolean }> = [];
  groupMemberAdds: Array<{ conversationId: string; members: unknown[] }> = [];
  leftGroups: string[] = [];
  groupMembers: ConeGroupMember[] = [];
  retentionCalls: Array<{ conversationId: string; durationMs: number | null }> = [];
  synced = false;
  closed = false;
  unsubscribed = false;
  private handler: MessageHandler | null = null;
  private resolveHandler?: () => void;
  private readonly handlerReady = new Promise<void>((resolve) => {
    this.resolveHandler = resolve;
  });

  identity(): Promise<ConeIdentity> {
    return Promise.resolve({ env: 'dev', inboxId: 'inbox-cli' });
  }

  resolveIdentity(ref: unknown) {
    if (typeof ref === 'string' && ref.startsWith('0x')) {
      return Promise.resolve({ address: ref, inboxId: 'inbox-address', source: 'address' as const });
    }
    return Promise.resolve({ inboxId: String(ref), source: 'contact' as const });
  }

  canMessage(): Promise<boolean> {
    return Promise.resolve(true);
  }

  sendText(to: unknown, text: string): Promise<SentMessage> {
    this.sent.push({ text, to: String(to) });
    return Promise.resolve({ messageId: 'msg-cli', sentAt: new Date().toISOString() });
  }

  sendJson(): Promise<SentMessage> {
    return Promise.resolve({ messageId: 'msg-json', sentAt: new Date().toISOString() });
  }

  sendReadReceipt(): Promise<void> {
    return Promise.resolve();
  }

  setConsent(to: unknown, state: ConeConsentState): Promise<void> {
    const inboxId = typeof to === 'object' && to !== null && 'inboxId' in to ? String((to as { inboxId: string }).inboxId) : String(to);
    this.consentCalls.push({ to: inboxId, state });
    this.conversations = this.conversations.map((conversation) =>
      conversation.peerInboxId === inboxId ? { ...conversation, consentState: state } : conversation,
    );
    return Promise.resolve();
  }

  // Mirrors the real client: DM rows record peer-inbox consent, groups record
  // the conversation id.
  setConversationConsent(conversationId: string, state: ConeConsentState): Promise<void> {
    const conversation = this.conversations.find((entry) => entry.conversationId === conversationId);
    if (conversation?.kind !== 'group' && conversation?.peerInboxId) {
      return this.setConsent({ inboxId: conversation.peerInboxId }, state);
    }
    this.consentCalls.push({ to: conversationId, state });
    this.conversations = this.conversations.map((entry) =>
      entry.conversationId === conversationId ? { ...entry, consentState: state } : entry,
    );
    return Promise.resolve();
  }

  sendToConversation(conversationId: string, text: string): Promise<SentMessage> {
    this.sentToConversation.push({ conversationId, text });
    return Promise.resolve({ conversationId, messageId: 'msg-conv', sentAt: new Date().toISOString() });
  }

  createGroup(input: { name?: string; members: unknown[]; locked?: boolean }): Promise<ConeConversation> {
    this.groupCreates.push({ name: input.name, members: input.members, locked: input.locked });
    const conversation: ConeConversation = {
      conversationId: `group-${this.groupCreates.length}`,
      kind: 'group',
      title: input.name ?? 'Group',
      groupName: input.name,
      memberCount: input.members.length + 1,
      consentState: 'allowed',
    };
    this.conversations.push(conversation);
    return Promise.resolve(conversation);
  }

  listGroupMembers(): Promise<ConeGroupMember[]> {
    return Promise.resolve(this.groupMembers);
  }

  addGroupMembers(conversationId: string, members: unknown[]): Promise<void> {
    this.groupMemberAdds.push({ conversationId, members });
    return Promise.resolve();
  }

  removeGroupMembers(): Promise<void> {
    return Promise.resolve();
  }

  leaveGroup(conversationId: string): Promise<void> {
    this.leftGroups.push(conversationId);
    return Promise.resolve();
  }

  setRetention(conversationId: string, durationMs: number | null): Promise<void> {
    this.retentionCalls.push({ conversationId, durationMs });
    this.conversations = this.conversations.map((conversation) =>
      conversation.conversationId === conversationId
        ? {
            ...conversation,
            retention: durationMs !== null && durationMs > 0
              ? { durationMs, fromAt: new Date().toISOString() }
              : undefined,
          }
        : conversation,
    );
    return Promise.resolve();
  }

  purgeExpiredMessages(): Promise<number> {
    return Promise.resolve(0);
  }

  sync(): Promise<SyncResult> {
    this.synced = true;
    return Promise.resolve({
      completedAt: new Date().toISOString(),
      conversationsSynced: this.conversations.length,
      errors: [],
      messagesSynced: this.messages.length,
      ok: true,
      startedAt: new Date().toISOString(),
    });
  }

  streamMessages(handler: MessageHandler): Promise<Unsubscribe> {
    this.handler = handler;
    this.resolveHandler?.();
    return Promise.resolve(() => {
      this.unsubscribed = true;
      this.handler = null;
    });
  }

  waitForHandler(): Promise<void> {
    return this.handlerReady;
  }

  async emit(message: IncomingMessage): Promise<void> {
    await this.handler?.(message);
  }

  listConversations() {
    return Promise.resolve(this.conversations);
  }

  listMessages(conversationId?: string) {
    return Promise.resolve(this.messages.filter((message) => !conversationId || message.conversationId === conversationId));
  }

  deleteConversation(conversationId: string): Promise<void> {
    this.conversations = this.conversations.filter((conversation) => conversation.conversationId !== conversationId);
    this.messages = this.messages.filter((message) => message.conversationId !== conversationId);
    return Promise.resolve();
  }

  listContacts(): Promise<Contact[]> {
    return Promise.resolve(this.contacts);
  }

  async saveContact(input: { name: string; inboxId?: string; address?: string }): Promise<Contact> {
    await Promise.resolve();
    if (this.closed) {
      throw new Error('client was closed before saveContact completed');
    }
    const contact: Contact = {
      contactId: `contact-${this.contacts.length + 1}`,
      createdAt: new Date().toISOString(),
      inboxId: input.inboxId ?? 'inbox-address',
      name: input.name,
      source: 'manual',
      updatedAt: new Date().toISOString(),
      address: input.address,
    };
    this.contacts.push(contact);
    return contact;
  }

  deleteContact(contactId: string): Promise<void> {
    this.contacts = this.contacts.filter((contact) => contact.contactId !== contactId);
    return Promise.resolve();
  }

  createHandshakeCode() {
    return Promise.resolve({ code: 'anchor-beacon-cedar-drift-ember', expiresAt: new Date().toISOString() });
  }

  pairWithCode(code: string, options?: { proposedName?: string }) {
    this.pairRequests.push({ code, proposedName: options?.proposedName });
    return Promise.resolve({
      contact: {
        contactId: 'contact-dana',
        createdAt: new Date().toISOString(),
        inboxId: 'inbox-dana',
        name: 'Dana',
        source: 'paired' as const,
        updatedAt: new Date().toISOString(),
      },
      peer: {
        env: 'dev' as const,
        inboxId: 'inbox-dana',
      },
      sentConfirmation: true,
    });
  }

  exportBackup(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array());
  }

  importBackup(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
