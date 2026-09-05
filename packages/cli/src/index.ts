import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  GROUP_INVITE_TTL_MS,
  HttpRendezvousClient,
  createConeClient,
  createHandshakeCode,
  deriveAccount,
  ConeError,
  errorMessage,
  formatMessageLine,
  formatRetention,
  generateSecretKey,
  isAllowedConversation,
  isAppJsonEnvelope,
  isControlEnvelope,
  isDeniedConversation,
  isRequestConversation,
  parseRetention,
  parseSecretKey,
  type ConeClient,
  type ConeConversation,
  type ConeMessage,
  type IncomingMessage,
  type SecretKey,
  type XmtpAdapter,
  type XmtpEnv,
} from '@cone/core';
import { createNodeXmtpAdapter } from '@cone/xmtp-node';

import { initializeConfig, loadSecretKey, readConfig, writeConfig } from './config';
import { envVarLocation } from './env-origin';
import { defaultConfigPath, defaultRendezvousUrl, defaultStatePath, resolveConfigPath, resolveRendezvousUrl, resolveStatePath, type ConfigSource } from './paths';
import { BunSQLiteStore } from './store';
import { runChat } from './chat';
import { AgentSession } from './agent';
import { serveAgent } from './serve';
import { integrateHermes } from './integrate';
import { serveMcp } from './mcp';
import packageInfo from '../../../package.json';

export { BunSQLiteStore } from './store';
export { AgentSession } from './agent';
export { HttpRendezvousClient } from '@cone/core';

export interface CliIo {
  isStdinTty: () => boolean;
  secretLine: (prompt: string) => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdinText: () => Promise<string>;
}

export interface CliDeps {
  createClient?: (secret: SecretKey, options?: { env?: XmtpEnv; autoAllowGroupsFromContacts?: boolean }) => Promise<ConeClient>;
}

export async function createCliClient(
  secret: SecretKey,
  options: { env?: XmtpEnv; xmtp?: XmtpAdapter; autoAllowGroupsFromContacts?: boolean } = {},
): Promise<ConeClient> {
  const account = deriveAccount(secret, { env: options.env ?? readEnv() });
  const statePath = defaultStatePath();
  const store = new BunSQLiteStore(statePath);
  let xmtp = options.xmtp;
  try {
    xmtp ??= await createNodeXmtpAdapter({ account, dbPath: `${statePath}.xmtp.db3` });
    return await createConeClient({
    account,
    rendezvous: new HttpRendezvousClient(defaultRendezvousUrl()),
    store,
    xmtp,
    // "Allow contacts to add you to groups" — config-backed, default on for
    // human use. Agent processes pass false: their boundary is explicit accept.
    autoAllowGroupsFromContacts: options.autoAllowGroupsFromContacts ?? readConfig().groupAutoAllow ?? true,
    });
  } catch (error) {
    await xmtp?.close?.();
    store.close();
    throw error;
  }
}

export async function runCli(args: string[], io: CliIo = defaultIo(), deps: CliDeps = {}): Promise<number> {
  let context: CliContext = { args, output: 'json', outputSource: 'default' };
  let command: string | undefined;
  let activeClient: ConeClient | undefined;
  const getClient = async (options: { autoAllowGroupsFromContacts?: boolean } = {}) => {
    activeClient = await loadClient(context, io, deps, options);
    return activeClient;
  };

  try {
    context = parseCliArgs(args);
    command = context.args[0];
    switch (command) {
      case '--version':
      case 'version': {
        io.stdout(`cone ${packageInfo.version}\n`);
        return 0;
      }
      case 'integrate': {
        if (context.args[1] !== 'hermes') throw usageError('usage: cone integrate hermes [--name <agent-name>]');
        initializeConfig(readEnv());
        const result = await integrateHermes({
          binary: optionalOption(context.args, '--binary'), hermes: optionalOption(context.args, '--hermes'),
          home: optionalOption(context.args, '--hermes-home'), name: optionalOption(context.args, '--name'),
          restart: !context.args.includes('--no-restart'),
        });
        writeValue(io, context, result, () => 'Hermes integration installed. Verify an incoming message and automatic reply.\n');
        return 0;
      }
      case 'init': {
        const env = optionalOption(context.args, '--env') ?? readEnv();
        if (!['local', 'dev', 'production'].includes(env)) throw usageError('invalid XMTP environment');
        const initialized = initializeConfig(env as XmtpEnv);
        const client = await getClient({ autoAllowGroupsFromContacts: false });
        writeValue(io, context, { ...await client.identity(), created: initialized.created }, value =>
          `Cone ready on ${value.env}.\nInbox: ${value.inboxId}\n`);
        return 0;
      }
      case 'connect': {
        const to = context.args[1];
        if (!to) throw usageError('usage: cone connect <identity> [--name <name>]');
        const client = await getClient({ autoAllowGroupsFromContacts: false });
        const peer = await client.resolveIdentity(to);
        if (!await client.canMessage({ inboxId: peer.inboxId })) throw new Error('peer is not reachable on XMTP');
        const contact = await client.saveContact({ name: optionalOption(context.args, '--name') ?? peer.inboxId, inboxId: peer.inboxId, address: peer.address });
        writeValue(io, context, contact, value => `Connected to ${value.name}.\n`);
        return 0;
      }
      case 'serve': {
        initializeConfig(readEnv());
        const client = await getClient({ autoAllowGroupsFromContacts: false });
        await serveAgent(new AgentSession(client, error => io.stderr(`${errorMessage(error)}\n`)));
        return 0;
      }
      case 'mcp': {
        initializeConfig(readEnv());
        const client = await getClient({ autoAllowGroupsFromContacts: false });
        await serveMcp(new AgentSession(client, error => io.stderr(`${errorMessage(error)}\n`)));
        return 0;
      }
      case 'messages':
      case 'wait':
      case 'receive': {
        const timeoutMs = parseTimeoutMs(context.args, command === 'wait' ? 30000 : 0);
        const client = await getClient({ autoAllowGroupsFromContacts: context.args.includes('--auto-accept-groups-from-contacts') });
        const session = new AgentSession(client, () => {});
        try {
          await session.start();
          const result = await session.receive({ consumer: optionalOption(context.args, '--consumer') ?? optionalOption(context.args, '--cursor-name'),
            limit: Number(optionalOption(context.args, '--limit') ?? 50), waitMs: timeoutMs });
          const output = { ...result, messages: await enrichMessages(client, result.messages), timedOut: timeoutMs > 0 && result.messages.length === 0 };
          writeValue(io, context, output, value => value.messages.length
            ? `${value.messages.map(message => formatMessageLine(message, message.senderInboxId)).join('\n')}\n`
            : 'No pending messages.\n');
          return result.messages.length ? 0 : EXIT_NOTHING_NEW;
        } finally { await session.close(); }
      }
      case 'ack': {
        const ids = collectOptions(context.args, '--message');
        if (!ids.length) throw usageError('usage: cone ack --message <messageId> [--message <messageId>] [--consumer <name>]');
        const client = await getClient({ autoAllowGroupsFromContacts: false });
        await client.acknowledgeMessages(ids, { consumer: optionalOption(context.args, '--consumer') });
        writeValue(io, context, { acknowledged: ids }, () => `Acknowledged ${ids.length} message(s).\n`);
        return 0;
      }
      case 'reply': {
        const client = await getClient({ autoAllowGroupsFromContacts: false });
        await syncOrThrow(client);
        const sent = await client.sendToConversation(requiredOption(context.args, '--conversation'), requiredOption(context.args, '--text'), {
          idempotencyKey: requiredOption(context.args, '--idempotency-key'),
        });
        writeValue(io, context, sent, value => `Sent ${value.messageId}.\n`);
        return 0;
      }
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
          }, () => 'Secret key is valid. Use CONE_SECRET_KEY or pass --remember to persist it.\n');
        }
        return 0;
      }
      case 'config': {
        return handleConfig(io, context);
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
        const text = optionalOption(context.args, '--text');
        // --data, not --json: --json is the global output-mode flag.
        const jsonPayload = optionalOption(context.args, '--data');
        if ((text === undefined) === (jsonPayload === undefined)) {
          throw usageError('usage: cone send --to <identity> (--text "..." | --data \'<json>\') [--reply-to <messageId>] [--idempotency-key <key>]');
        }
        const replyTo = optionalOption(context.args, '--reply-to');
        if (replyTo && jsonPayload === undefined) {
          // Correlation rides the app-JSON envelope; plain text has none.
          throw usageError('--reply-to requires --data (correlation rides the JSON envelope)');
        }
        const sendOptions = { replyTo, idempotencyKey: optionalOption(context.args, '--idempotency-key') };
        const client = await getClient();
        const sent = jsonPayload !== undefined
          ? await client.sendJson(to, parseJsonArgument(jsonPayload), sendOptions)
          : await client.sendText(to, text ?? '', sendOptions);
        writeValue(io, context, sent, (value) =>
          `${value.deduplicated ? 'Already sent (idempotency key matched)' : 'Sent'} ${value.messageId}${value.conversationId ? ` in ${value.conversationId}` : ''}.\n`);
        return 0;
      }
      // JSON health check an agent runs first when anything fails.
      case 'doctor': {
        return await handleDoctor(context, io);
      }
      case 'listen': {
        // Agent trust boundary: streamMessages defaults to allowed senders
        // only, so an unknown sender can never drive an agent's workflow.
        // Unknown senders surface only through the explicit `cone requests`.
        // Group adds are stricter still: even a contact's add waits for an
        // explicit accept unless --auto-accept-groups-from-contacts is given.
        activeClient = await loadClient(context, io, deps, {
          autoAllowGroupsFromContacts: context.args.includes('--auto-accept-groups-from-contacts'),
        });
        const listenClient = activeClient;
        if (context.output === 'plain') {
          io.stdout('Listening for Cone messages (allowed senders only)...\n');
        }
        const once = context.args.includes('--once');
        const timeoutMs = parseTimeoutMs(context.args, once ? 30_000 : 0);
        let resolveFirstMessage: (() => void) | undefined;
        const firstMessage = once
          ? new Promise<void>((resolve) => {
              resolveFirstMessage = resolve;
            })
          : null;
        const unsubscribe = await listenClient.streamMessages(async (message) => {
          // Control envelopes (receipts, group updates) never reach an agent
          // loop — same boundary as messages/wait.
          if (isControlEnvelope(message.json)) {
            return;
          }
          writeMessage(io, context, await enrichIncomingMessage(listenClient, message));
          resolveFirstMessage?.();
        });
        if (once && firstMessage) {
          // Timeout is "nothing new" (exit 3), matching messages/wait — a
          // quiet network is not an error.
          const arrived = await waitForFirstMessage(firstMessage, timeoutMs).then(() => true).catch(() => false);
          await unsubscribe();
          if (!arrived) {
            writeValue(io, context, { messages: [], timedOut: true }, () => 'No new messages (timed out).\n');
            return EXIT_NOTHING_NEW;
          }
        } else {
          await new Promise(() => undefined);
        }
        return 0;
      }
      case 'inbox': {
        return await handleInbox(context.args.slice(1), io, context, await getClient());
      }
      case 'group': {
        return await handleGroup(context.args.slice(1), io, context, await getClient());
      }
      case 'requests': {
        return await handleRequests(context.args.slice(1), io, context, await getClient());
      }
      case 'timer': {
        return await handleTimer(context.args.slice(1), io, context, await getClient());
      }
      case 'contacts': {
        return await handleContacts(context.args.slice(1), io, context, await getClient());
      }
      case 'chat': {
        const client = await getClient();
        await runChat(client, {
          plainLog: context.args.includes('--plain-log'),
          syncOnOpen: !context.args.includes('--no-sync-on-open'),
          readReceipts: readConfig().readReceipts ?? true,
          onReadReceiptsChange: (value) => writeConfig({ ...readConfig(), readReceipts: value }),
        });
        return 0;
      }
      case 'pair': {
        return await handlePair(context.args.slice(1), io, context, getClient);
      }
      case 'backup': {
        return await handleBackup(context.args.slice(1), io, context, await getClient());
      }
      default:
        io.stderr(helpText());
        return command ? 1 : 0;
    }
  } catch (error) {
    const code = errorCode(error, errorMessage(error));
    const hint = code === 'NETWORK_UNREACHABLE' ? '\nTry: cone doctor --plain' : '';
    const message = `${errorMessage(error)}${hint}`;
    if (context.output === 'plain') {
      io.stderr(`${message}\n`);
    } else {
      // Agents parse errors; free text forces them to guess. Stable codes,
      // one JSON object on stderr.
      io.stderr(`${JSON.stringify({ error: { code, message } })}\n`);
    }
    return 1;
  } finally {
    await activeClient?.close();
  }
}

// Exit code contract for poll-shaped commands: 0 = new messages in the
// payload, 3 = nothing new (not an error), 1 = error.
const EXIT_NOTHING_NEW = 3;

function usageError(message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = 'USAGE';
  return error;
}

function parseJsonArgument(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw usageError('--data payload is not valid JSON');
  }
}

// Stable machine-readable error codes. Explicit `code` properties win;
// otherwise classify the known failure modes by message.
function errorCode(error: unknown, message: string): string {
  const explicit = (error as { code?: unknown })?.code;
  if (typeof explicit === 'string' && explicit.length > 0) {
    return explicit;
  }
  const lower = message.toLowerCase();
  if (lower.startsWith('usage:') || lower.startsWith('use --')) {
    return 'USAGE';
  }
  if (lower.includes('missing secret key')) {
    return 'NO_SECRET';
  }
  if (lower.includes('secret key')) {
    return 'BAD_SECRET';
  }
  if (lower.includes('not xmtp-reachable') || lower.includes('not reachable on xmtp')) {
    return 'NOT_MESSAGEABLE';
  }
  if (lower.includes('rendezvous service unreachable')) {
    return 'RENDEZVOUS_UNREACHABLE';
  }
  if (lower.includes('rendezvous')) {
    return 'RENDEZVOUS_REJECTED';
  }
  if (lower.includes('same account')) {
    return 'SELF_PAIRING';
  }
  if (lower.includes('timed out')) {
    return 'TIMEOUT';
  }
  if (lower.includes('no longer a member')) {
    return 'NOT_A_MEMBER';
  }
  if (lower.includes('not found')) {
    return 'NOT_FOUND';
  }
  // Raw transport failures from the XMTP bindings read like gRPC internals;
  // classify them so agents and humans both get an actionable signal.
  if (/genericfailure|grpc|transport error|fetch failed|econnrefused|network|socket|dns/iu.test(lower)) {
    return 'NETWORK_UNREACHABLE';
  }
  return 'ERROR';
}

// Timeouts are part of the agent contract: garbage must fail fast as USAGE,
// never parse to NaN (which reads as "no timeout" and hangs forever).
function parseTimeoutMs(args: string[], fallback: number): number {
  const raw = optionalOption(args, '--timeout-ms');
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw usageError(`--timeout-ms must be a non-negative number of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function printableMessage(message: IncomingMessage): Omit<IncomingMessage, 'raw'> {
  const { raw: _raw, ...rest } = message;
  return rest;
}

// Group context for agent consumers: the local contact name for the sender
// and the group's name ride along, so an agent can address replies and log
// sensibly without keeping its own address book. Reads are local-store only.
type EnrichedMessage = IncomingMessage & { senderName?: string; groupName?: string; replyTo?: string };

async function enrichIncomingMessage(client: ConeClient, message: IncomingMessage): Promise<EnrichedMessage> {
  const enriched: EnrichedMessage = { ...message };
  // Same read contract as messages/wait: `json` is the sender's payload,
  // `replyTo` first-class — the envelope is transport plumbing.
  if (isAppJsonEnvelope(message.json)) {
    const envelope = message.json as { value: unknown; replyTo?: unknown };
    enriched.json = envelope.value;
    if (typeof envelope.replyTo === 'string') {
      enriched.replyTo = envelope.replyTo;
    }
  }
  try {
    const contacts = await client.listContacts();
    enriched.senderName = contacts.find((contact) => contact.inboxId === message.senderInboxId)?.name;
    if (message.conversationKind === 'group') {
      const conversations = await client.listConversations();
      enriched.groupName = conversations.find(
        (conversation) => conversation.conversationId === message.conversationId,
      )?.groupName;
    }
  } catch {
    // Enrichment is best-effort; the message itself always goes out.
  }
  return enriched;
}

// A failed sync must never masquerade as "nothing new" (exit 3): agents
// polling through network trouble need the error, not silence.
async function syncOrThrow(client: ConeClient): Promise<void> {
  const result = await client.sync();
  if (!result.ok) {
    throw new ConeError('SYNC_FAILED', `sync failed: ${result.errors.join('; ') || 'unknown error'}`);
  }
}

// Attach senderName/groupName to polled mail the same way listen does —
// lookups are built once per command, not per message.
async function enrichMessages(
  client: ConeClient,
  messages: ConeMessage[],
): Promise<Array<ConeMessage & { senderName?: string; groupName?: string }>> {
  if (messages.length === 0) {
    return messages;
  }
  try {
    const [contacts, conversations] = await Promise.all([client.listContacts(), client.listConversations()]);
    const nameByInbox = new Map(contacts.map((contact) => [contact.inboxId, contact.name]));
    const groupNameById = new Map(conversations.filter((c) => c.kind === 'group').map((c) => [c.conversationId, c.groupName]));
    return messages.map((message) => ({
      ...message,
      senderName: nameByInbox.get(message.senderInboxId),
      groupName: message.conversationKind === 'group' ? groupNameById.get(message.conversationId) : undefined,
    }));
  } catch {
    return messages;
  }
}

function writeMessage(io: CliIo, context: CliContext, message: EnrichedMessage): void {
  if (context.output === 'plain') {
    const sender = message.senderName ?? message.senderInboxId;
    const prefix = message.conversationKind === 'group' ? `[${message.groupName ?? 'group'}] ` : '';
    io.stdout(`${prefix}${formatMessageLine(message, sender)}\n`);
    return;
  }
  io.stdout(`${JSON.stringify(printableMessage(message))}\n`);
}

function writeValue<T>(io: CliIo, context: CliContext, value: T, plain: (value: T) => string): void {
  if (context.output === 'plain') {
    io.stdout(plain(value));
    return;
  }
  // NDJSON: one compact document per line. Commands that report progress
  // (bare pair, group invite) emit several lines; agents parse line-by-line.
  io.stdout(`${JSON.stringify(value)}\n`);
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
      throw new Error('usage: cone contacts rename <contactId> <name>');
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
      throw new Error('usage: cone contacts delete <contactId>');
    }
    await client.deleteContact(contactId);
    writeValue(io, context, { contactId, deleted: true }, () => 'Contact deleted.\n');
    return 0;
  }
  throw new Error('usage: cone contacts <list|add|rename|delete>');
}

async function handleInbox(args: string[], io: CliIo, context: CliContext, client: ConeClient): Promise<number> {
  const commandIndex = firstSubcommandIndex(args);
  const command = commandIndex === undefined ? undefined : args[commandIndex];
  const rest = commandIndex === undefined ? args : args.slice(commandIndex + 1);
  if (!command || command === 'list') {
    // Main inbox is allowed-only; unknown senders live under `cone requests`,
    // denied are hidden.
    const conversations = (await client.listConversations()).filter(isAllowedConversation);
    const requestCount = (await client.listConversations()).filter(isRequestConversation).length;
    writeValue(io, context, { conversations, requestCount }, (value) => {
      const lines = value.conversations.map((conversation) => {
        const updated = conversation.updatedAt ? ` ${conversation.updatedAt}` : '';
        return `${conversation.title} (${conversation.conversationId})${updated}`;
      });
      const header = value.conversations.length === 0 ? 'No conversations.' : lines.join('\n');
      const footer = value.requestCount > 0 ? `\n${value.requestCount} request${value.requestCount === 1 ? '' : 's'} — see cone requests.` : '';
      return `${header}${footer}\n`;
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
      throw new Error('usage: cone inbox read <conversationId|contactName|inboxId>');
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
        return formatMessageLine(message, from);
      }).join('\n') + '\n';
    });
    return 0;
  }
  throw new Error('usage: cone inbox [list|sync|read]');
}

async function findInboxConversation(client: ConeClient, target: string, pool?: ConeConversation[]) {
  const normalized = target.trim().toLowerCase();
  const conversations = pool ?? await client.listConversations();
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

// `cone group` — create and manage group conversations. Members resolve through
// contacts/identities; the creator is added (and made super admin) by XMTP.
async function handleGroup(args: string[], io: CliIo, context: CliContext, client: ConeClient): Promise<number> {
  const command = args[0];
  const rest = args.slice(1);
  const groupValueOptions = new Set(['--name', '--description', '--member', '--text', '--env']);

  if (command === 'create') {
    const members = collectOptions(rest, '--member');
    if (members.length === 0) {
      throw new Error('usage: cone group create --member <inboxId|address|contactName> [--member ...] [--name <name>] [--description <text>] [--locked]');
    }
    const conversation = await client.createGroup({
      name: optionalOption(rest, '--name'),
      description: optionalOption(rest, '--description'),
      members,
      locked: rest.includes('--locked'),
    });
    writeValue(io, context, conversation, (value) =>
      `Created group ${value.title} (${value.conversationId}), ${value.memberCount ?? members.length + 1} members.\n`);
    return 0;
  }

  if (command === 'info') {
    const conversation = await findGroupConversation(client, requireGroupTarget(rest, groupValueOptions, 'info'));
    const members = conversation.active === false
      ? conversation.members ?? []
      : await client.listGroupMembers(conversation.conversationId);
    writeValue(io, context, { conversation, members }, (value) => {
      const lines = [
        `${value.conversation.title} (${value.conversation.conversationId})`,
        value.conversation.groupDescription ? `Description: ${value.conversation.groupDescription}` : undefined,
        `Consent: ${value.conversation.consentState}`,
        value.conversation.active === false ? 'Status: no longer a member (history kept)' : undefined,
        `Members (${value.members.length}):`,
        ...value.members.map((member) => `  ${member.inboxId}${member.level === 'member' ? '' : ` [${member.level}]`}`),
      ];
      return lines.filter(Boolean).join('\n') + '\n';
    });
    return 0;
  }

  if (command === 'rename') {
    const name = requiredOption(rest, '--name');
    const conversation = await findGroupConversation(client, requireGroupTarget(rest, groupValueOptions, 'rename'));
    await client.renameGroup(conversation.conversationId, name);
    writeValue(io, context, { conversationId: conversation.conversationId, name }, (value) =>
      `Renamed group to ${value.name}. Group names are shared — every member sees the change.\n`);
    return 0;
  }

  if (command === 'describe') {
    const text = optionalOption(rest, '--text') ?? '';
    const conversation = await findGroupConversation(client, requireGroupTarget(rest, groupValueOptions, 'describe'));
    await client.setGroupDescription(conversation.conversationId, text);
    writeValue(io, context, { conversationId: conversation.conversationId, description: text }, () =>
      text ? `Updated the description of ${conversation.title}.\n` : `Cleared the description of ${conversation.title}.\n`);
    return 0;
  }

  if (command === 'remove') {
    const members = collectOptions(rest, '--member');
    if (members.length === 0) {
      throw new Error('usage: cone group remove <conversationId|name> --member <inboxId|address|contactName> [--member ...]');
    }
    const conversation = await findGroupConversation(client, requireGroupTarget(rest, groupValueOptions, 'remove'));
    await client.removeGroupMembers(conversation.conversationId, members);
    writeValue(io, context, { conversationId: conversation.conversationId, removed: members }, (value) =>
      `Removed ${value.removed.length} member${value.removed.length === 1 ? '' : 's'} from ${conversation.title}.\n`);
    return 0;
  }

  if (command === 'promote' || command === 'demote') {
    const member = requiredOption(rest, '--member');
    const level = command === 'demote' ? 'member' : rest.includes('--super') ? 'superAdmin' : 'admin';
    const conversation = await findGroupConversation(client, requireGroupTarget(rest, groupValueOptions, command));
    await client.setGroupMemberLevel(conversation.conversationId, member, level);
    writeValue(io, context, { conversationId: conversation.conversationId, member, level }, (value) =>
      command === 'demote'
        ? `Demoted ${value.member} to member in ${conversation.title}.\n`
        : `Promoted ${value.member} to ${value.level === 'superAdmin' ? 'owner (super admin)' : 'admin'} in ${conversation.title}.\n`);
    return 0;
  }

  if (command === 'add') {
    const members = collectOptions(rest, '--member');
    if (members.length === 0) {
      throw new Error('usage: cone group add <conversationId|name> --member <inboxId|address|contactName> [--member ...]');
    }
    const conversation = await findGroupConversation(client, requireGroupTarget(rest, groupValueOptions, 'add'));
    await client.addGroupMembers(conversation.conversationId, members);
    writeValue(io, context, { conversationId: conversation.conversationId, added: members }, (value) =>
      `Added ${value.added.length} member${value.added.length === 1 ? '' : 's'} to ${conversation.title}.\n`);
    return 0;
  }

  if (command === 'send') {
    const text = requiredOption(rest, '--text');
    const conversation = await findGroupConversation(client, requireGroupTarget(rest, groupValueOptions, 'send'));
    const sent = await client.sendToConversation(conversation.conversationId, text);
    writeValue(io, context, sent, (value) => `Sent ${value.messageId} in ${conversation.title}.\n`);
    return 0;
  }

  if (command === 'leave') {
    const conversation = await findGroupConversation(client, requireGroupTarget(rest, groupValueOptions, 'leave'));
    await client.leaveGroup(conversation.conversationId);
    writeValue(io, context, { conversationId: conversation.conversationId, left: true }, () =>
      `Left ${conversation.title}. Leaving is visible to the group; to hide it without signaling, block it instead.\n`);
    return 0;
  }

  // Synchronous invite code, inviter side: mint a code, print it right away
  // (that's what gets spoken/pasted to the joiner), then wait for the join
  // request and add the joiner. Single use, 10-minute TTL, no auto-contact.
  // --link mints an async capability token instead: no waiting — joiners are
  // admitted by this account's next sync (`cone inbox sync`, listen, or chat).
  if (command === 'invite') {
    const inviteValueOptions = new Set([...groupValueOptions, '--code', '--max-uses', '--ttl', '--timeout-ms']);
    const conversation = await findGroupConversation(client, requireGroupTarget(rest, inviteValueOptions, 'invite'));
    if (rest.includes('--link')) {
      const ttl = optionalOption(rest, '--ttl');
      const maxUses = optionalOption(rest, '--max-uses');
      const link = await client.createGroupInviteLink(conversation.conversationId, {
        ttlMs: ttl ? parseRetention(ttl) ?? undefined : undefined,
        maxUses: maxUses ? Number(maxUses) : undefined,
      });
      writeValue(io, context, link, (value) => [
        `Invite link token for ${conversation.title}: ${value.token}`,
        `Expires at: ${value.expiresAt} — ${value.maxUses} use${value.maxUses === 1 ? '' : 's'}.`,
        `Anyone with the token joins with: cone group join ${value.token}`,
        'They are admitted the next time this account syncs (cone inbox sync, listen, or chat).',
        `Revoke with: cone group links revoke ${value.linkId}`,
      ].join('\n') + '\n');
      return 0;
    }
    // --code lets scripts coordinate a pre-minted code (like `cone pair`).
    const providedCode = optionalOption(rest, '--code');
    const code = providedCode
      ? { code: providedCode, expiresAt: new Date(Date.now() + GROUP_INVITE_TTL_MS).toISOString() }
      : await client.createHandshakeCode();
    writeValue(io, context, { ...code, conversationId: conversation.conversationId, waiting: true }, (value) =>
      `Invite code for ${conversation.title}: ${value.code}\nExpires at: ${value.expiresAt}\nWaiting for someone to join with this code...\n`);
    // Default to the code's full window, matching the printed "Waiting…".
    const timeoutMs = Number(optionalOption(rest, '--timeout-ms') ?? String(GROUP_INVITE_TTL_MS));
    const result = await client.inviteToGroupWithCode(code.code, conversation.conversationId, { timeoutMs });
    writeValue(io, context, result, (value) => {
      const name = value.joiner.proposedName ? `${value.joiner.proposedName} (${value.joiner.inboxId})` : value.joiner.inboxId;
      const save = value.joiner.proposedName
        ? `\nSave them with: cone contacts add --name ${JSON.stringify(value.joiner.proposedName)} --identity ${value.joiner.inboxId}`
        : '';
      return `Added ${name} to ${conversation.title}.${save}\n`;
    });
    return 0;
  }

  // Joiner side: post a join request under the code and wait for the group
  // descriptor. Membership arrives with the XMTP welcome (next sync), which a
  // pending join auto-allows — requesting to join is implied consent.
  if (command === 'join') {
    const joinValueOptions = new Set(['--share-name', '--timeout-ms']);
    const code = positionalArgs(rest, joinValueOptions)[0];
    if (!code) {
      throw new Error('usage: cone group join <code> [--share-name <name>] [--timeout-ms <ms>]');
    }
    const timeoutMs = Number(optionalOption(rest, '--timeout-ms') ?? String(GROUP_INVITE_TTL_MS));
    const result = await client.joinGroupWithCode(code, {
      proposedName: optionalOption(rest, '--share-name'),
      timeoutMs,
    });
    writeValue(io, context, result, (value) =>
      `Requested to join ${value.groupName ?? value.conversationId} (${value.memberCount} members, invited by ${value.inviter.inboxId}).\n` +
      `The inviter adds you over XMTP; run: cone inbox sync\n`);
    return 0;
  }

  // Async invite links minted by this account: list, revoke.
  if (command === 'links') {
    if (rest[0] === 'revoke') {
      const linkId = rest[1];
      if (!linkId) {
        throw new Error('usage: cone group links revoke <linkId>');
      }
      await client.revokeGroupInviteLink(linkId);
      writeValue(io, context, { linkId, revoked: true }, () => `Revoked invite link ${linkId}.\n`);
      return 0;
    }
    const links = await client.listGroupInviteLinks();
    writeValue(io, context, links, (value) =>
      value.length === 0
        ? 'No active invite links.\n'
        : value.map((link) =>
            `${link.linkId} — ${link.conversationId}, ${link.uses}/${link.maxUses} uses, expires ${link.expiresAt}`,
          ).join('\n') + '\n');
    return 0;
  }

  // Pending join requests (welcomes not yet arrived): list and cancel.
  if (command === 'joins') {
    if (rest[0] === 'cancel') {
      const conversationId = rest[1];
      if (!conversationId) {
        throw new Error('usage: cone group joins cancel <conversationId>');
      }
      await client.cancelGroupJoin(conversationId);
      writeValue(io, context, { conversationId, cancelled: true }, () => `Cancelled the pending join for ${conversationId}.\n`);
      return 0;
    }
    const pending = await client.listPendingGroupJoins();
    writeValue(io, context, pending, (value) =>
      value.length === 0
        ? 'No pending group joins.\n'
        : value.map((join) => `${join.groupName ?? join.conversationId} — invited by ${join.inviterInboxId}, expires ${join.expiresAt}`).join('\n') + '\n');
    return 0;
  }

  throw new Error('usage: cone group <create|info|add|remove|rename|describe|promote|demote|send|leave|invite|join|joins|links>');
}

function requireGroupTarget(args: string[], valueOptions: Set<string>, command: string): string {
  const target = positionalArgs(args, valueOptions)[0];
  if (!target) {
    throw new Error(`usage: cone group ${command} <conversationId|name> ...`);
  }
  return target;
}

async function findGroupConversation(client: ConeClient, target: string): Promise<ConeConversation> {
  const groups = (await client.listConversations()).filter((conversation) => conversation.kind === 'group');
  const normalized = target.trim().toLowerCase();
  const matches = groups.filter((conversation) =>
    [conversation.conversationId, conversation.title, conversation.groupName]
      .some((value) => value?.toLowerCase() === normalized));
  const match = matches[0];
  if (matches.length === 1 && match) {
    return match;
  }
  if (matches.length > 1) {
    throw new Error(`multiple groups match: ${target}`);
  }
  throw new Error(`group not found: ${target}`);
}

// `cone requests` — the explicit Requests surface. Unknown inbound senders are
// listed here, never in the main inbox or the address book; accept moves them
// to the inbox (optionally saving a contact), block denies the peer inbox.
// Group adds land here too (labeled by kind); accept/block target the group.
async function handleRequests(args: string[], io: CliIo, context: CliContext, client: ConeClient): Promise<number> {
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'list';

  if (command === 'list') {
    const denied = args.includes('--denied');
    const conversations = (await client.listConversations()).filter(denied ? isDeniedConversation : isRequestConversation);
    writeValue(io, context, conversations, (value) => {
      if (value.length === 0) {
        return denied ? 'No blocked conversations.\n' : 'No requests.\n';
      }
      return value.map((conversation) => `${conversation.title} (${conversation.conversationId})`).join('\n') + '\n';
    });
    return 0;
  }

  if (command === 'accept' || command === 'block') {
    const target = firstPositional(args.slice(1));
    if (!target) {
      throw new Error(`usage: cone requests ${command} <conversationId|inboxId> ${command === 'accept' ? '[--save-as <name>]' : ''}`.trim());
    }
    const conversation = await findInboxConversation(client, target);
    const state = command === 'accept' ? 'allowed' : 'denied';
    // Conversation-scoped: DMs target the peer's inbox, groups the group id.
    await client.setConversationConsent(conversation.conversationId, state);

    const saveAs = command === 'accept' ? optionalOption(args, '--save-as') : undefined;
    const contact = saveAs && conversation.kind !== 'group' && conversation.peerInboxId
      ? await client.saveContact({ name: saveAs, inboxId: conversation.peerInboxId, address: conversation.peerAddress, source: 'manual' })
      : undefined;

    const label = conversation.kind === 'group' ? conversation.title : conversation.peerInboxId ?? conversation.title;
    writeValue(io, context, { conversationId: conversation.conversationId, kind: conversation.kind, peerInboxId: conversation.peerInboxId, state, contact }, () => {
      const named = contact ? ` Saved as ${contact.name}.` : '';
      return command === 'accept'
        ? `Accepted ${label}.${named}\n`
        : `Blocked ${label}.\n`;
    });
    return 0;
  }

  throw new Error('usage: cone requests [list|accept <target> [--save-as <name>]|block <target>] [--denied]');
}

// `cone timer` — the per-conversation disappearing-messages timer. Without a
// duration it reports the current setting; with one ('5m', '1h', '7d', 'off')
// it sets it. The XMTP settings write tells the peer; expired messages are
// hidden immediately and purged from local storage on sync.
async function handleTimer(args: string[], io: CliIo, context: CliContext, client: ConeClient): Promise<number> {
  const [target, duration] = positionalArgs(args, new Set(['--env']));
  if (!target) {
    throw new Error('usage: cone timer <conversationId|contactName|inboxId> [<duration|off>]');
  }
  const conversation = await findInboxConversation(client, target);

  if (duration === undefined) {
    const value = {
      conversationId: conversation.conversationId,
      peerInboxId: conversation.peerInboxId,
      retention: conversation.retention ?? null,
      timer: formatRetention(conversation.retention?.durationMs ?? null),
    };
    writeValue(io, context, value, (current) => `Disappearing messages in ${conversation.title}: ${current.timer}.\n`);
    return 0;
  }

  const durationMs = parseRetention(duration);
  await client.setRetention(conversation.conversationId, durationMs);
  const value = {
    conversationId: conversation.conversationId,
    peerInboxId: conversation.peerInboxId,
    durationMs,
    timer: formatRetention(durationMs),
  };
  writeValue(io, context, value, (updated) => {
    return updated.durationMs === null
      ? `Disappearing messages off in ${conversation.title}.\n`
      : `Disappearing messages in ${conversation.title}: ${updated.timer}.\n`;
  });
  return 0;
}

async function handlePair(args: string[], io: CliIo, context: CliContext, getClient: () => Promise<ConeClient>): Promise<number> {
  if (args.includes('new') || args.includes('join')) {
    throw new Error('usage: cone pair [code] [--share-name <name>] [--save-as <contactName>]');
  }
  if (args.includes('--name')) {
    throw new Error('use --share-name for the peer-visible name or --save-as for your local contact name');
  }
  let code = firstPairCode(args);
  if (!code && args.includes('--print')) {
    // Mint-only, for scripts: local, no account unlock, no network, no wait.
    const created = createHandshakeCode(new Date());
    writeValue(io, context, created, (value) => `Handshake code: ${value.code}\nExpires at: ${value.expiresAt}\n`);
    return 0;
  }
  if (!code) {
    // Pairing needs BOTH sides in the room, so minting immediately joins:
    // print the code for the other side, then wait for them.
    const created = createHandshakeCode(new Date());
    writeValue(io, context, { ...created, waiting: true }, (value) =>
      `Handshake code: ${value.code}\nExpires at: ${value.expiresAt}\nHave the other side enter this code — waiting for them (up to 60s)...\n`);
    code = created.code;
  }
  const client = await getClient();
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
      send: `cone send --to ${JSON.stringify(contact.name)} --text "hello"`,
      listen: 'cone listen',
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
  throw new Error('usage: cone backup <export|import>');
}

async function loadClient(
  context: CliContext,
  io: CliIo,
  deps: CliDeps,
  options: { autoAllowGroupsFromContacts?: boolean } = {},
): Promise<ConeClient> {
  const secret = context.args.includes('--secret-stdin')
    ? parseSecretKey(await io.stdinText())
    : loadSecretKey(defaultConfigPath());
  const env = optionalOption(context.args, '--env') as XmtpEnv | undefined;
  return deps.createClient ? deps.createClient(secret, { env, ...options }) : createCliClient(secret, { env, ...options });
}

async function readLoginSecret(args: string[], io: CliIo): Promise<string> {
  if (args.includes('--secret-stdin')) {
    if (io.isStdinTty()) {
      io.stderr('Reading SECRET_KEY from stdin. Paste it, press Enter, then press Ctrl-D.\nFor interactive login, use: cone login --remember\n');
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

// Every value of a repeatable option (e.g. --member a --member b).
function collectOptions(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (value && !value.startsWith('--')) {
        values.push(value);
      }
    }
  }
  return values;
}

function firstPositional(args: string[]): string | undefined {
  return positionalArgs(args, new Set(['--contact', '--conversation']))[0];
}

function positionalArgs(args: string[], valueOptions: Set<string>): string[] {
  const positionals: string[] = [];
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
    positionals.push(arg);
  }
  return positionals;
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
  // Where `output` came from — the flags are consumed here, so `cone config`
  // cannot reconstruct this from args.
  outputSource: 'default' | 'environment' | 'flag';
}

function parseCliArgs(args: string[]): CliContext {
  const rest: string[] = [];
  let output: OutputMode = process.env.CONE_OUTPUT === 'plain' ? 'plain' : 'json';
  let outputSource: CliContext['outputSource'] = process.env.CONE_OUTPUT ? 'environment' : 'default';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === '--json') {
      output = 'json';
      outputSource = 'flag';
      continue;
    }
    if (arg === '--plain') {
      output = 'plain';
      outputSource = 'flag';
      continue;
    }
    rest.push(arg);
  }

  return { args: rest, output, outputSource };
}

function readEnv(): XmtpEnv {
  // Production is the durable XMTP network and the default; dev/local are
  // explicit opt-ins for testing (identities are env-scoped, so they never
  // collide with the production account).
  const env = process.env.XMTP_ENV ?? readConfig().env ?? 'production';
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

// `cone config` answers "what will this process actually do?" — every
// resolved setting plus the exact place its value was set, without unlocking
// an account. Sources: 'default' is the compiled product decision, 'config'
// is the config.json file, 'environment' is an env var — whose `location`
// pinpoints the .env line or the shell (see env-origin.ts), 'flag' is a
// command-line flag. Modeled on `git config --list --show-origin`.
// `cone doctor` — the JSON health check an agent runs first when anything
// fails: secret, state DB, rendezvous, XMTP reachability. Exit 0 only when
// every check passes; each check is { name, ok, detail }.
async function handleDoctor(context: CliContext, io: CliIo): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const rendezvousUrl = defaultRendezvousUrl();
  const statePath = defaultStatePath();
  const configPath = defaultConfigPath();
  const env = readEnv();

  let secret: SecretKey | undefined;
  try {
    secret = context.args.includes('--secret-stdin') ? parseSecretKey(await io.stdinText()) : loadSecretKey(configPath);
    checks.push({ name: 'secret', ok: true, detail: 'secret key present and valid' });
  } catch (error) {
    checks.push({ name: 'secret', ok: false, detail: firstLine(error) });
  }

  try {
    const store = new BunSQLiteStore(statePath);
    await store.getMetadata();
    store.close();
    checks.push({ name: 'state-db', ok: true, detail: statePath });
  } catch (error) {
    checks.push({ name: 'state-db', ok: false, detail: `${statePath}: ${firstLine(error)}` });
  }

  // The probe lives on the transport client itself, so doctor can never
  // drift from the endpoint/protocol the real client speaks.
  if (context.args.includes('--rendezvous')) {
    const rendezvousCheck = await new HttpRendezvousClient(rendezvousUrl).probe();
    checks.push({ name: 'rendezvous', ...rendezvousCheck });
  }

  if (secret) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const identity = await Promise.race([
        (async () => {
          const client = await createCliClient(secret, { env });
          try { return await client.identity(); }
          finally { await client.close(); }
        })(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`XMTP ${env} did not respond within 20s`)), 20_000); }),
      ]);
      checks.push({ name: 'xmtp', ok: true, detail: `${env} · inbox ${identity.inboxId}` });
    } catch (error) {
      checks.push({ name: 'xmtp', ok: false, detail: firstLine(error) });
    } finally { clearTimeout(timer); }
  } else {
    checks.push({ name: 'xmtp', ok: false, detail: 'skipped — no secret key' });
  }

  const ok = checks.every((check) => check.ok);
  writeValue(io, context, { ok, env: { xmtpEnv: env, rendezvousUrl, statePath, configPath }, checks }, (value) =>
    `${value.checks.map((check) => `${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`).join('\n')}\n${value.ok ? 'All checks passed.' : 'Problems found.'}\n`);
  return ok ? 0 : 1;
}

function firstLine(error: unknown): string {
  return errorMessage(error).split('\n')[0] ?? 'unknown error';
}

function handleConfig(io: CliIo, context: CliContext): number {
  const configPath = withVia(resolveConfigPath(), 'CONE_HOME');
  const statePath = withVia(resolveStatePath(), 'CONE_HOME');
  const rendezvousUrl = withVia(resolveRendezvousUrl(), 'CONE_RENDEZVOUS_URL');
  const config = readConfig(configPath.value);

  const resolved = {
    xmtpEnv: process.env.XMTP_ENV ? sourced(readEnv(), 'XMTP_ENV') : fromConfig(config.env, 'production', '"env"'),
    configPath,
    statePath,
    rendezvousUrl,
    // The key itself is never printed — only where the CLI would find one.
    secretKey: process.env.CONE_SECRET_KEY
      ? { source: 'environment' as const, via: 'CONE_SECRET_KEY', location: envVarLocation('CONE_SECRET_KEY') }
      : { source: config.secretKey ? 'config' as const : 'none' as const },
    readReceipts: fromConfig(config.readReceipts, true, '"readReceipts"'),
    groupAutoAllow: fromConfig(config.groupAutoAllow, true, '"groupAutoAllow"'),
    output: context.outputSource === 'default'
      ? { value: context.output, source: 'default' as const }
      : context.outputSource === 'flag'
        ? { value: context.output, source: 'flag' as const, via: `--${context.output}` }
        : { value: context.output, source: 'environment' as const, via: 'CONE_OUTPUT', location: envVarLocation('CONE_OUTPUT') },
  };

  // Plain rendering: every line says, in words, where its value was set — or
  // for a built-in default, the one knob that changes it.
  const where = (entry: { source: string; via?: string; location?: string }, changeWith: string): string => {
    if (entry.source === 'default') {
      return `built-in default; ${changeWith} changes it`;
    }
    if (entry.source === 'flag') {
      return `set by the ${entry.via} flag`;
    }
    if (entry.source === 'config') {
      return `set as ${entry.via} in ${configPath.value}`;
    }
    return `set by ${entry.via} ${describeLocation(entry.location)}`;
  };
  const usesDotEnv = [resolved.xmtpEnv, resolved.configPath, resolved.statePath, resolved.rendezvousUrl, resolved.secretKey, resolved.output]
    .some((entry) => 'location' in entry && entry.location !== undefined && !entry.location.startsWith('shell'));

  writeValue(io, context, resolved, (value) => [
    `XMTP network:     ${value.xmtpEnv.value} — ${where(value.xmtpEnv, 'XMTP_ENV')}`,
    `Config file:      ${value.configPath.value} — ${where(value.configPath, 'CONE_HOME')}`,
    `State database:   ${value.statePath.value} — ${where(value.statePath, 'CONE_HOME')}`,
    `Rendezvous URL:   ${value.rendezvousUrl.value} — ${where(value.rendezvousUrl, 'CONE_RENDEZVOUS_URL')}`,
    `Secret key:       ${value.secretKey.source === 'none'
      ? 'not set — run `cone init`'
      : value.secretKey.source === 'environment'
        ? `set by CONE_SECRET_KEY ${describeLocation(value.secretKey.location)}`
        : `remembered as "secretKey" in ${value.configPath.value}; CONE_SECRET_KEY would override`}`,
    `Read receipts:    ${value.readReceipts.value ? 'on' : 'off'} — ${where(value.readReceipts, `"readReceipts" in ${value.configPath.value}`)}`,
    `Group auto-allow: ${value.groupAutoAllow.value ? 'on' : 'off'} — ${where(value.groupAutoAllow, `"groupAutoAllow" in ${value.configPath.value}`)}`,
    '                  (whether a contact can add you to a group without a Request)',
    `Output:           ${value.output.value} — ${where(value.output, 'CONE_OUTPUT or --plain/--json')}`,
    ...(usesDotEnv ? [
      '',
      `.env here is ${join(process.cwd(), '.env')},`,
      'auto-loaded by Bun for processes started in this directory only. (A shell',
      'export carrying the same value is indistinguishable from the .env line.)',
    ] : []),
  ].join('\n') + '\n');
  return 0;
}

function describeLocation(location: string | undefined): string {
  if (location === undefined || location === 'shell') {
    return 'exported in your shell';
  }
  if (location.startsWith('shell (overrides ')) {
    return `exported in your shell, overriding ${location.slice('shell (overrides '.length, -1)}`;
  }
  return `in ${location}`;
}

function sourced<T>(value: T, envVar: string): { value: T; source: ConfigSource; via?: string; location?: string } {
  return process.env[envVar] !== undefined
    ? { value, source: 'environment', via: envVar, location: envVarLocation(envVar) }
    : { value, source: 'default' };
}

function withVia(entry: { value: string; source: ConfigSource }, envVar: string): { value: string; source: ConfigSource; via?: string; location?: string } {
  return entry.source === 'environment' ? { ...entry, via: envVar, location: envVarLocation(envVar) } : entry;
}

function fromConfig<T>(configured: T | undefined, fallback: T, key: string): { value: T; source: 'config' | 'default'; via?: string } {
  return configured !== undefined
    ? { value: configured, source: 'config', via: key }
    : { value: fallback, source: 'default' };
}

function helpText(): string {
  return `Usage:
  cone init [--env production|dev|local]      (create and persist identity; safe to repeat)
  cone connect <inboxId|address> [--name <name>]
  cone integrate hermes [--name <agent-name>] [--no-restart]
  cone serve                                (persistent JSON-RPC over stdin/stdout)
  cone mcp                                  (standard MCP tools over stdin/stdout)
  cone receive [--consumer <name>] [--limit <n>] [--timeout-ms <ms>]
       (pending mail from accepted peers; reading never acknowledges; exit 3 = empty)
  cone reply --conversation <id> --text "..." --idempotency-key <key>
  cone ack --message <messageId> [--message <messageId>] [--consumer <name>]
       (acknowledge only messages whose work and replies completed)
  cone keygen
  cone [--json|--plain] login [--remember]
  cone [--json|--plain] login --secret-stdin [--remember]
  cone [--json|--plain] whoami [--env dev|production|local]
  cone [--json|--plain] config                 (effective configuration and where each value came from)
  cone [--json|--plain] send --to <inboxId|address|contactName> (--text "..." | --data '<json>')
       [--reply-to <messageId>] [--idempotency-key <key>]
       (--data rides the Cone envelope as app JSON; --reply-to correlates request/response and requires --data;
        a repeated --idempotency-key returns the original send instead of publishing again)
  cone messages                             (alias for receive; requires explicit ack)
  cone wait [--timeout-ms <ms>]              (receive with a 30-second default wait)
  cone [--json|--plain] doctor [--rendezvous]  (secret, state DB, XMTP; optional pairing service check)
  cone [--json|--plain] listen [--once] [--timeout-ms <ms>] [--auto-accept-groups-from-contacts]
       (allowed senders only; group adds stay explicit-accept unless the flag is given;
        JSON lines carry conversationKind plus senderName/groupName when known)
  cone [--json|--plain] inbox [list]
  cone [--json|--plain] inbox sync
  cone [--json|--plain] inbox read <conversationId|contactName|inboxId>
  cone [--json|--plain] requests [list] [--denied]
  cone [--json|--plain] requests accept <conversationId|inboxId> [--save-as <name>]
  cone [--json|--plain] requests block <conversationId|inboxId>
  cone [--json|--plain] timer <conversationId|contactName|inboxId>            (show)
  cone [--json|--plain] timer <conversationId|contactName|inboxId> <5m|1h|7d|off>
  cone chat [--plain-log] [--sync-on-open|--no-sync-on-open]
  cone group create --member <inboxId|address|contactName> [--member ...] [--name <name>] [--description <text>] [--locked]
  cone group info <conversationId|name>
  cone group add <conversationId|name> --member <inboxId|address|contactName> [--member ...]
  cone group remove <conversationId|name> --member <ref> [--member ...]     (admin)
  cone group rename <conversationId|name> --name <name>
  cone group describe <conversationId|name> --text "..."
  cone group promote <conversationId|name> --member <ref> [--super]         (owner makes admins; --super transfers ownership)
  cone group demote <conversationId|name> --member <ref>
  cone group send <conversationId|name> --text "..."
  cone group leave <conversationId|name>       (visible to the group; block instead to hide silently)
  cone group invite <conversationId|name> [--code <code>] [--timeout-ms <ms>]   (mint a single-use code, wait, add the joiner)
  cone group invite <conversationId|name> --link [--max-uses <n>] [--ttl <duration>]   (async token; joiners admitted on your next sync)
  cone group join <code|token> [--share-name <name>] [--timeout-ms <ms>]
  cone group joins [cancel <conversationId>]   (pending joins awaiting their welcome)
  cone group links [revoke <linkId>]           (async invite links this account minted)
  cone contacts list
  cone contacts add --name <name> --identity <inboxId|address>
  cone contacts rename <contactId> <name>
  cone contacts delete <contactId>
  cone pair [--share-name <name>] [--save-as <contactName>]   (mint a code, print it, wait for the other side)
  cone pair <code> [--share-name <name>] [--save-as <contactName>]   (join a code from the other side)
  cone pair --print                            (mint-only, for scripts: no unlock, no waiting)
  cone backup export --out backup.cone
  cone backup import --in backup.cone
`;
}
