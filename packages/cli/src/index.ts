import { createInterface } from 'node:readline/promises';

import {
  createConeClient,
  createHandshakeCode,
  deriveAccount,
  formatConeMessageLine,
  formatIncomingMessageLine,
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
import { defaultConfigPath, defaultRendezvousUrl, defaultStatePath } from './paths';
import { HttpRendezvousClient } from './rendezvous';
import { BunSQLiteStore } from './store';
import { runChat } from './chat';

export { BunSQLiteStore } from './store';
export { HttpRendezvousClient } from './rendezvous';

export interface CliIo {
  isStdinTty: () => boolean;
  secretLine: (prompt: string) => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdinText: () => Promise<string>;
}

export interface CliDeps {
  createClient?: (secret: SecretKey, options?: { env?: XmtpEnv }) => Promise<ConeClient>;
}

export async function createCliClient(secret: SecretKey, options: { env?: XmtpEnv; xmtp?: XmtpAdapter } = {}): Promise<ConeClient> {
  const account = deriveAccount(secret, { env: options.env ?? readEnv() });
  const statePath = defaultStatePath();
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
        const secret = parseSecretKey(await readLoginSecret(context.args, io));
        const configPath = defaultConfigPath();
        if (context.args.includes('--remember')) {
          writeConfig({ ...readConfig(configPath), secretKey: secret }, configPath);
          writeValue(io, context, {
            ok: true,
            path: configPath,
            remembered: true,
          }, (value) => `Secret key saved at ${value.path}.\n`);
        } else {
          writeValue(io, context, {
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
      case 'inbox': {
        return await handleInbox(context.args.slice(1), io, context, await getClient());
      }
      case 'contacts': {
        return await handleContacts(context.args.slice(1), io, context, await getClient());
      }
      case 'chat': {
        const client = await getClient();
        await runChat(client, {
          plainLog: context.args.includes('--plain-log'),
          syncOnOpen: !context.args.includes('--no-sync-on-open'),
        });
        return 0;
      }
      case 'pair': {
        const pairArgs = context.args.slice(1);
        const code = firstPairCode(pairArgs);
        if (code === 'new' || code === 'join') {
          throw new Error('usage: cos pair [code] [--share-name <name>] [--save-as <contactName>]');
        }
        if (!code) {
          const code = createHandshakeCode(new Date());
          writeValue(io, context, code, (value) => `Handshake code: ${value.code}\nExpires at: ${value.expiresAt}\n`);
          return 0;
        }
        return await handlePair(pairArgs, io, context, await getClient());
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
    io.stdout(`${formatIncomingMessageLine(message, message.senderInboxId)}\n`);
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

async function handleInbox(args: string[], io: CliIo, context: CliContext, client: ConeClient): Promise<number> {
  const commandIndex = firstSubcommandIndex(args);
  const command = commandIndex === undefined ? undefined : args[commandIndex];
  const rest = commandIndex === undefined ? args : args.slice(commandIndex + 1);
  if (!command || command === 'list') {
    writeValue(io, context, await client.listConversations(), (conversations) => {
      if (conversations.length === 0) {
        return 'No conversations.\n';
      }
      return conversations.map((conversation) => {
        const updated = conversation.updatedAt ? ` ${conversation.updatedAt}` : '';
        return `${conversation.title} (${conversation.conversationId})${updated}`;
      }).join('\n') + '\n';
    });
    return 0;
  }
  if (command === 'sync') {
    const result = await client.sync();
    writeValue(io, context, result, (value) => {
      const status = value.ok ? 'Sync complete' : 'Sync failed';
      const details = `${value.conversationsSynced} conversations, ${value.messagesSynced} messages`;
      return value.errors.length > 0
        ? `${status}: ${details}\n${value.errors.join('\n')}\n`
        : `${status}: ${details}\n`;
    });
    return result.ok ? 0 : 1;
  }
  if (command === 'read') {
    const target = firstPositional(rest) ?? optionalOption(args, '--conversation') ?? optionalOption(args, '--contact');
    if (!target) {
      throw new Error('usage: cos inbox read <conversationId|contactName|inboxId>');
    }
    const conversation = await findInboxConversation(client, target);
    const messages = await client.listMessages(conversation.conversationId);
    writeValue(io, context, { conversation, messages }, (value) => {
      const { conversation: selected, messages: transcript } = value;
      if (transcript.length === 0) {
        return `No messages in ${selected.title}.\n`;
      }
      return transcript.map((message) => {
        const from = message.direction === 'outbound' ? 'me' : selected.title;
        return formatConeMessageLine(message, from);
      }).join('\n') + '\n';
    });
    return 0;
  }
  throw new Error('usage: cos inbox [list|sync|read]');
}

async function findInboxConversation(client: ConeClient, target: string) {
  const normalized = target.trim().toLowerCase();
  const conversations = await client.listConversations();
  const matches = conversations.filter((conversation) => {
    return [
      conversation.conversationId,
      conversation.contactId,
      conversation.peerInboxId,
      conversation.peerAddress,
      conversation.title,
    ].some((value) => value?.toLowerCase() === normalized);
  });

  const match = matches[0];
  if (matches.length === 1 && match) {
    return match;
  }
  if (matches.length > 1) {
    throw new Error(`multiple inbox conversations match: ${target}`);
  }
  throw new Error(`inbox conversation not found: ${target}`);
}

async function handlePair(args: string[], io: CliIo, context: CliContext, client: ConeClient): Promise<number> {
  const code = firstPairCode(args);
  if (args.includes('new') || args.includes('join')) {
    throw new Error('usage: cos pair [code] [--share-name <name>] [--save-as <contactName>]');
  }
  if (!code) {
    throw new Error('usage: cos pair [code] [--share-name <name>] [--save-as <contactName>]');
  }
  if (args.includes('--name')) {
    throw new Error('use --share-name for the peer-visible name or --save-as for your local contact name');
  }
  const shareName = optionalOption(args, '--share-name');
  const saveAs = optionalOption(args, '--save-as');
  const result = await client.pairWithCode(code, { proposedName: shareName });
  const contact = saveAs
    ? await client.saveContact({
        address: result.contact.address,
        inboxId: result.contact.inboxId,
        name: saveAs,
        source: 'paired',
      })
    : result.contact;
  const cliResult = {
    ...result,
    contact,
    next: {
      send: `cos send --to ${JSON.stringify(contact.name)} --text "hello"`,
      listen: 'cos listen',
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
    : loadSecretKey(defaultConfigPath());
  const env = optionalOption(context.args, '--env') as XmtpEnv | undefined;
  return deps.createClient ? deps.createClient(secret, { env }) : createCliClient(secret, { env });
}

async function readLoginSecret(args: string[], io: CliIo): Promise<string> {
  if (args.includes('--secret-stdin')) {
    if (io.isStdinTty()) {
      io.stderr('Reading SECRET_KEY from stdin. Paste it, press Enter, then press Ctrl-D.\nFor interactive login, use: cos login --remember\n');
    }
    return io.stdinText();
  }

  return io.secretLine('Paste SECRET_KEY: ');
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

function firstPositional(args: string[]): string | undefined {
  const valueOptions = new Set(['--contact', '--conversation']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg.startsWith('--')) {
      if (valueOptions.has(arg)) {
        index += 1;
      }
      continue;
    }
    return arg;
  }
  return undefined;
}

function firstSubcommandIndex(args: string[]): number | undefined {
  const ignoredOptions = new Set(['--secret-stdin']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || ignoredOptions.has(arg)) {
      continue;
    }
    return arg.startsWith('--') ? undefined : index;
  }
  return undefined;
}

function firstPairCode(args: string[]): string | undefined {
  const valueOptions = new Set(['--share-name', '--save-as']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === '--secret-stdin') {
      continue;
    }
    if (arg.startsWith('--')) {
      if (valueOptions.has(arg)) {
        index += 1;
      }
      continue;
    }
    return arg;
  }
  return undefined;
}

type OutputMode = 'json' | 'plain';

interface CliContext {
  args: string[];
  output: OutputMode;
}

function parseCliArgs(args: string[]): CliContext {
  const rest: string[] = [];
  let output: OutputMode = process.env.COS_OUTPUT === 'plain' ? 'plain' : 'json';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
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

  return { args: rest, output };
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
    isStdinTty: () => Boolean(process.stdin.isTTY),
    secretLine: (prompt) => readHiddenLine(prompt),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdinText: async () => {
      return (await new Response(Bun.stdin.stream()).text()).trim();
    },
  };
}

async function readHiddenLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    const readline = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      return (await readline.question(prompt)).trim();
    } finally {
      readline.close();
    }
  }

  return new Promise((resolve, reject) => {
    let value = '';
    const input = process.stdin;

    function cleanup(): void {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
    }

    function finish(): void {
      cleanup();
      process.stderr.write('\n');
      resolve(value.trim());
    }

    function onData(chunk: Buffer): void {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          process.stderr.write('\n');
          reject(new Error('login cancelled'));
          return;
        }
        if (byte === 4 || byte === 10 || byte === 13) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    }

    process.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function helpText(): string {
  return `Usage:
  cos keygen
  cos [--json|--plain] login [--remember]
  cos [--json|--plain] login --secret-stdin [--remember]
  cos [--json|--plain] whoami [--env dev|production|local]
  cos [--json|--plain] send --to <inboxId|address|contactName> --text "..."
  cos [--json|--plain] listen [--once] [--timeout-ms <ms>]
  cos [--json|--plain] inbox [list]
  cos [--json|--plain] inbox sync
  cos [--json|--plain] inbox read <conversationId|contactName|inboxId>
  cos chat [--plain-log] [--sync-on-open|--no-sync-on-open]
  cos contacts list
  cos contacts add --name <name> --identity <inboxId|address>
  cos contacts rename <contactId> <name>
  cos contacts delete <contactId>
  cos pair
  cos pair <code> [--share-name <name>] [--save-as <contactName>]
  cos backup export --out backup.cos
  cos backup import --in backup.cos
`;
}
