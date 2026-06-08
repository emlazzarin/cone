import { describe, expect, test } from 'bun:test';

import { generateSecretKey, type ConeClient, type ConeIdentity, type Contact, type IncomingMessage, type MessageHandler, type SecretKey, type SentMessage, type Unsubscribe, type XmtpEnv } from '@cone/core';

import { runCli, type CliIo } from '../src/index';

describe('CLI', () => {
  test('keygen prints a parseable secret', async () => {
    const io = makeIo();

    expect(await runCli(['keygen'], io)).toBe(0);
    expect(io.out[0]?.startsWith('cos_sk_v1_')).toBe(true);
  });

  test('send command resolves client from stdin secret and sends text', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    let receivedOptions: { env?: XmtpEnv; id?: string } | undefined;

    const exitCode = await runCli(
      ['--id', 'alice', 'send', '--secret-stdin', '--to', 'Alice', '--text', 'hello'],
      io,
      {
        createClient: async (_secret: SecretKey, options?: { env?: XmtpEnv; id?: string }) => {
          receivedOptions = options;
          return client;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(client.sent).toEqual([{ to: 'Alice', text: 'hello' }]);
    expect(receivedOptions?.id).toBe('alice');
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

  test('pair join defaults proposed name from local id and prints next steps', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(
      await runCli(
        ['--id', 'charlie', 'pair', 'join', 'shared-code', '--secret-stdin'],
        io,
        { createClient: async () => client },
      ),
    ).toBe(0);

    expect(client.pairRequests[0]).toEqual({ code: 'shared-code', proposedName: 'charlie' });
    const output = JSON.parse(io.out.join('')) as { next?: { send?: string }; contact?: { name?: string } };
    expect(output.contact?.name).toBe('Dana');
    expect(output.next?.send).toContain('--id charlie');
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
});

function makeIo(stdin = ''): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    out,
    stderr: (text) => err.push(text),
    stdinText: async () => stdin,
    stdout: (text) => out.push(text),
  };
}

class MockClient implements ConeClient {
  contacts: Contact[] = [];
  pairRequests: Array<{ code: string; proposedName?: string }> = [];
  sent: Array<{ to: string; text: string }> = [];
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
    return Promise.resolve([]);
  }

  listMessages() {
    return Promise.resolve([]);
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
