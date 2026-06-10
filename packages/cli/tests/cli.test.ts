import { describe, expect, test } from 'bun:test';

import { generateSecretKey, type ConeClient, type ConeConversation, type ConeIdentity, type ConeMessage, type Contact, type IncomingMessage, type MessageHandler, type SecretKey, type SentMessage, type SyncResult, type Unsubscribe, type XmtpEnv } from '@cone/core';

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
      peerInboxId: 'inbox-alice',
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
