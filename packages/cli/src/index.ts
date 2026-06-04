import {
  createConeClient,
  createHandshakeCode,
  deriveAccount,
  generateSecretKey,
  parseSecretKey,
  type ConeClient,
  type IncomingMessage,
  type SecretKey,
  type XmtpAdapter,
  type XmtpEnv,
} from '@cone/core';
import { createNodeXmtpAdapter } from '@cone/xmtp-node';

import { loadSecretKey, readConfig, writeConfig } from './config';
import { defaultConfigPath, defaultRendezvousUrl, defaultStatePath, normalizeCliId } from './paths';
import { HttpRendezvousClient } from './rendezvous';
import { BunSQLiteStore } from './store';

export { BunSQLiteStore } from './store';
export { HttpRendezvousClient } from './rendezvous';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdinText: () => Promise<string>;
}

export interface CliDeps {
  createClient?: (secret: SecretKey, options?: { env?: XmtpEnv; id?: string }) => Promise<ConeClient>;
}

export async function createCliClient(secret: SecretKey, options: { env?: XmtpEnv; id?: string; xmtp?: XmtpAdapter } = {}): Promise<ConeClient> {
  const account = deriveAccount(secret, { env: options.env ?? readEnv() });
  const statePath = defaultStatePath(options.id);
  const store = new BunSQLiteStore(statePath);
  const xmtp = options.xmtp ?? await createNodeXmtpAdapter({ account, dbPath: `${statePath}.xmtp.db3` });
  return createConeClient({
    account,
    rendezvous: new HttpRendezvousClient(defaultRendezvousUrl()),
    store,
    xmtp,
  });
}

export async function runCli(args: string[], io: CliIo = defaultIo(), deps: CliDeps = {}): Promise<number> {
  let context: CliContext = { args, output: 'json' };
  let command: string | undefined;
  let activeClient: ConeClient | undefined;
  const getClient = async () => {
    activeClient = await loadClient(context, io, deps);
    return activeClient;
  };

  try {
    context = parseCliArgs(args);
    command = context.args[0];
    switch (command) {
      case 'keygen': {
        io.stdout(`${generateSecretKey()}\n`);
        return 0;
      }
      case 'login': {
        const secret = parseSecretKey(await readSecretInput(context.args, io));
        const configPath = defaultConfigPath(context.id);
        if (context.args.includes('--remember')) {
          writeConfig({ ...readConfig(configPath), secretKey: secret }, configPath);
          writeValue(io, context, {
            id: context.id ?? 'default',
            ok: true,
            path: configPath,
            remembered: true,
          }, (value) => `Secret key saved for id "${value.id}" at ${value.path}.\n`);
        } else {
          writeValue(io, context, {
            id: context.id ?? 'default',
            ok: true,
            remembered: false,
          }, () => 'Secret key is valid. Use COS_SECRET_KEY or pass --remember to persist it.\n');
        }
        return 0;
      }
      case 'whoami': {
        const client = await getClient();
        writeValue(io, context, await client.identity(), (identity) => {
          return [
            `Inbox ID: ${identity.inboxId}`,
            identity.address ? `Address: ${identity.address}` : undefined,
            `XMTP env: ${identity.env}`,
          ].filter(Boolean).join('\n') + '\n';
        });
        return 0;
      }
      case 'send': {
        const to = requiredOption(context.args, '--to');
        const text = requiredOption(context.args, '--text');
        const client = await getClient();
        const sent = await client.sendText(to, text);
        writeValue(io, context, sent, (value) => `Sent ${value.messageId}${value.conversationId ? ` in ${value.conversationId}` : ''}.\n`);
        return 0;
      }
      case 'listen': {
        const client = await getClient();
        if (context.output === 'plain') {
          io.stdout('Listening for Cone of Silence messages...\n');
        }
        const once = context.args.includes('--once');
        const timeoutMs = Number(optionalOption(context.args, '--timeout-ms') ?? (once ? '30000' : '0'));
        let resolveFirstMessage: (() => void) | undefined;
        const firstMessage = once
          ? new Promise<void>((resolve) => {
              resolveFirstMessage = resolve;
            })
          : null;
        const unsubscribe = await client.streamMessages((message) => {
          writeMessage(io, context, message);
          resolveFirstMessage?.();
        });
        if (once && firstMessage) {
          await waitForFirstMessage(firstMessage, timeoutMs);
          await unsubscribe();
        } else {
          await new Promise(() => undefined);
        }
        return 0;
      }
      case 'contacts': {
        return await handleContacts(context.args.slice(1), io, context, await getClient());
      }
      case 'pair': {
        if (context.args[1] === 'new') {
          const code = createHandshakeCode(new Date());
          writeValue(io, context, code, (value) => `Handshake code: ${value.code}\nExpires at: ${value.expiresAt}\n`);
          return 0;
        }
        return await handlePair(context.args.slice(1), io, context, await getClient());
      }
      case 'conversations': {
        const client = await getClient();
        writeValue(io, context, await client.listConversations(), (conversations) => {
          if (conversations.length === 0) {
            return 'No conversations.\n';
          }
          return conversations.map((conversation) => `${conversation.title} (${conversation.conversationId})`).join('\n') + '\n';
        });
        return 0;
      }
      case 'backup': {
        return await handleBackup(context.args.slice(1), io, context, await getClient());
      }
      default:
        io.stderr(helpText());
        return command ? 1 : 0;
    }
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await activeClient?.close();
  }
}

function printableMessage(message: IncomingMessage): Omit<IncomingMessage, 'raw'> {
  const { raw: _raw, ...rest } = message;
  return rest;
}

function writeMessage(io: CliIo, context: CliContext, message: IncomingMessage): void {
  if (context.output === 'plain') {
    io.stdout(`[${message.sentAt}] ${message.senderInboxId}: ${message.text ?? JSON.stringify(message.json)}\n`);
    return;
  }
  io.stdout(`${JSON.stringify(printableMessage(message))}\n`);
}

function writeValue<T>(io: CliIo, context: CliContext, value: T, plain: (value: T) => string): void {
  if (context.output === 'plain') {
    io.stdout(plain(value));
    return;
  }
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

async function waitForFirstMessage(firstMessage: Promise<void>, timeoutMs: number): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    await firstMessage;
    return;
  }

  let timeout: Timer | undefined;
  try {
    await Promise.race([
      firstMessage,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`listen timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function handleContacts(args: string[], io: CliIo, context: CliContext, client: ConeClient): Promise<number> {
  const command = args[0];
  if (command === 'list') {
    writeValue(io, context, await client.listContacts(), (contacts) => {
      if (contacts.length === 0) {
        return 'No contacts.\n';
      }
      return contacts.map((contact) => `${contact.name} (${contact.inboxId})`).join('\n') + '\n';
    });
    return 0;
  }
  if (command === 'add') {
    const name = requiredOption(args, '--name');
    const identity = requiredOption(args, '--identity');
    const resolved = await client.resolveIdentity(identity);
    const contact = await client.saveContact({ name, inboxId: resolved.inboxId, address: resolved.address });
    writeValue(io, context, contact, (value) => `Saved ${value.name} (${value.inboxId}).\n`);
    return 0;
  }
  if (command === 'rename') {
    const contactId = args[1];
    const name = args[2];
    if (!contactId || !name) {
      throw new Error('usage: cos contacts rename <contactId> <name>');
    }
    const existing = (await client.listContacts()).find((contact) => contact.contactId === contactId);
    if (!existing) {
      throw new Error(`contact not found: ${contactId}`);
    }
    const contact = await client.saveContact({ ...existing, name });
    writeValue(io, context, contact, (value) => `Renamed contact to ${value.name}.\n`);
    return 0;
  }
  if (command === 'delete') {
    const contactId = args[1];
    if (!contactId) {
      throw new Error('usage: cos contacts delete <contactId>');
    }
    await client.deleteContact(contactId);
    writeValue(io, context, { contactId, deleted: true }, () => 'Contact deleted.\n');
    return 0;
  }
  throw new Error('usage: cos contacts <list|add|rename|delete>');
}

async function handlePair(args: string[], io: CliIo, context: CliContext, client: ConeClient): Promise<number> {
  const command = args[0];
  if (command === 'new') {
    const code = await client.createHandshakeCode();
    writeValue(io, context, code, (value) => `Handshake code: ${value.code}\nExpires at: ${value.expiresAt}\n`);
    return 0;
  }
  if (command === 'join') {
    const code = args[1];
    if (!code) {
      throw new Error('usage: cos pair join <code>');
    }
    const name = optionalOption(args, '--name') ?? context.id;
    const result = await client.pairWithCode(code, { proposedName: name });
    const cliResult = {
      ...result,
      next: {
        send: `cos${context.id ? ` --id ${context.id}` : ''} send --to ${JSON.stringify(result.contact.name)} --text "hello"`,
        listen: `cos${context.id ? ` --id ${context.id}` : ''} listen`,
      },
    };
    writeValue(io, context, cliResult, (value) => {
      return [
        `Paired with ${value.contact.name} (${value.contact.inboxId}).`,
        `Send with: ${value.next.send}`,
        `Listen with: ${value.next.listen}`,
      ].join('\n') + '\n';
    });
    return 0;
  }
  throw new Error('usage: cos pair <new|join>');
}

async function handleBackup(args: string[], io: CliIo, context: CliContext, client: ConeClient): Promise<number> {
  const command = args[0];
  if (command === 'export') {
    const out = requiredOption(args, '--out');
    await Bun.write(out, await client.exportBackup());
    writeValue(io, context, { out, exported: true }, () => `Backup exported to ${out}.\n`);
    return 0;
  }
  if (command === 'import') {
    const input = requiredOption(args, '--in');
    await client.importBackup(new Uint8Array(await Bun.file(input).arrayBuffer()));
    writeValue(io, context, { imported: true, in: input }, () => `Backup imported from ${input}.\n`);
    return 0;
  }
  throw new Error('usage: cos backup <export|import>');
}

async function loadClient(context: CliContext, io: CliIo, deps: CliDeps): Promise<ConeClient> {
  const secret = context.args.includes('--secret-stdin')
    ? parseSecretKey(await io.stdinText())
    : loadSecretKey(defaultConfigPath(context.id));
  const env = optionalOption(context.args, '--env') as XmtpEnv | undefined;
  return deps.createClient ? deps.createClient(secret, { env, id: context.id }) : createCliClient(secret, { env, id: context.id });
}

async function readSecretInput(args: string[], io: CliIo): Promise<string> {
  if (!args.includes('--secret-stdin')) {
    throw new Error('login requires --secret-stdin');
  }
  return io.stdinText();
}

function requiredOption(args: string[], name: string): string {
  const value = optionalOption(args, name);
  if (!value) {
    throw new Error(`missing required option: ${name}`);
  }
  return value;
}

function optionalOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

type OutputMode = 'json' | 'plain';

interface CliContext {
  args: string[];
  id?: string;
  output: OutputMode;
}

function parseCliArgs(args: string[]): CliContext {
  const rest: string[] = [];
  let id = normalizeCliId(process.env.COS_ID);
  let output: OutputMode = process.env.COS_OUTPUT === 'plain' ? 'plain' : 'json';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === '--id') {
      id = normalizeCliId(args[index + 1]);
      if (!id) {
        throw new Error('missing required option: --id');
      }
      index += 1;
      continue;
    }
    if (arg === '--json') {
      output = 'json';
      continue;
    }
    if (arg === '--plain') {
      output = 'plain';
      continue;
    }
    rest.push(arg);
  }

  return { args: rest, id, output };
}

function readEnv(): XmtpEnv {
  const env = process.env.XMTP_ENV ?? 'dev';
  if (env === 'local' || env === 'dev' || env === 'production') {
    return env;
  }
  throw new Error(`invalid XMTP_ENV: ${env}`);
}

function defaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdinText: async () => {
      return (await new Response(Bun.stdin.stream()).text()).trim();
    },
  };
}

function helpText(): string {
  return `Usage:
  cos keygen
  cos [--id <localId>] [--json|--plain] login --secret-stdin [--remember]
  cos [--id <localId>] [--json|--plain] whoami [--env dev|production|local]
  cos [--id <localId>] [--json|--plain] send --to <inboxId|address|contactName> --text "..."
  cos [--id <localId>] [--json|--plain] listen [--once] [--timeout-ms <ms>]
  cos contacts list
  cos contacts add --name <name> --identity <inboxId|address>
  cos contacts rename <contactId> <name>
  cos contacts delete <contactId>
  cos [--id <localId>] pair new
  cos [--id <localId>] pair join <code> [--name <name>]
  cos conversations
  cos backup export --out backup.cos
  cos backup import --in backup.cos
`;
}
