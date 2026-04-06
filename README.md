# cone-of-silence

Secure, permanent agent-to-agent connections over XMTP. No phone numbers, no shared servers — just a single-use invite token.

## How it works

Two agents pair by passing a token through whatever channel they already share (a chat thread, a task description, a human copy-pasting between windows). The token carries the inviter's XMTP identity and a high-entropy secret. The accepter uses it to contact the inviter directly over XMTP and complete a two-message handshake. After that, both agents permanently know each other's `inboxId` and can exchange messages without any intermediary.

The full flow:

1. A user tells Agent A: `create invite`
2. Agent A generates a single-use token and returns it
3. The user copies that token and gives it to Agent B
4. The user tells Agent B: `accept invite: <token>`
5. Agent B opens a DM to Agent A over XMTP and sends a signed accept message
6. Agent A validates the secret, confirms, and both sides store the connection as active

From that point on, both agents know each other by `inboxId`. The connection survives restarts because it's persisted in the store.

## Install

```bash
bun add cone-of-silence
```

`@xmtp/agent-sdk` is a peer dependency — install it alongside:

```bash
bun add @xmtp/agent-sdk
```

## Setup: generate credentials

```bash
bun run gen:keys
```

Copy `.env.example` to `.env` and fill in the generated values:

```env
# secp256k1 private key — your agent's permanent XMTP identity
XMTP_WALLET_KEY=0x...

# 32 random bytes as hex — encrypts the local XMTP message database
XMTP_DB_ENCRYPTION_KEY=...

# "dev" for the test network, "production" for real traffic
XMTP_ENV=dev

# Where cone-of-silence stores invites and connections
CONE_STATE_PATH=./.cone/state.json
```

`XMTP_WALLET_KEY` is your agent's identity. Losing it means losing the ability to receive messages at that inbox. Keep it secret.

## Wiring it up

```ts
import { Agent } from '@xmtp/agent-sdk';
import { createCone, JsonFileStore } from 'cone-of-silence';

const agent = await Agent.createFromEnv();

const cone = await createCone({
  agent,
  store: new JsonFileStore(process.env.CONE_STATE_PATH ?? './.cone/state.json'),
});

// Subscribe to events
cone.on('connection:active', (connection) => {
  console.log(`New peer: ${connection.peerInboxId}`);
});

cone.on('message:text', (event) => {
  console.log(`${event.connection.peerInboxId}: ${event.text}`);
});

cone.on('message:json', (event) => {
  console.log(`json from ${event.connection.peerInboxId}:`, event.value);
});

// Wire cone into your message loop
agent.on('message', async (ctx) => {
  const handled = await cone.handleMessage(ctx);
  if (handled) return;

  if (!ctx.isText()) return;
  const text = ctx.message.content.trim();

  // "create invite" command
  if (text.toLowerCase() === 'create invite') {
    const invite = await cone.createInvite();
    await ctx.conversation.sendText(cone.renderInviteInstructions(invite));
    return;
  }

  // "accept invite: <token>" command
  const token = cone.extractInviteToken(text);
  if (token) {
    const connection = await cone.acceptInvite(token);
    await ctx.conversation.sendText(`Connected to ${connection.peerInboxId}`);
    return;
  }
});

await agent.start();
```

`createCone()` is idempotent. Call it with the same store on every startup and it restores all existing connections automatically.

## API reference

### `createCone(options)`

```ts
createCone({
  agent: Agent,
  store: ConeStore,
  inviteExpiryMs?: number,     // default: 24h
  handshakeTimeoutMs?: number, // default: 60s
}): Promise<Cone>
```

Returns a fully initialized `Cone`. If the store already has state from a previous session, it's available immediately.

### Methods on `Cone`

| Method | Description |
|---|---|
| `createInvite(options?)` | Generates a single-use invite token. `options.label` is a human note; `options.expiresInMs` overrides the default expiry. Returns an `Invite` with the opaque `token` string. |
| `acceptInvite(token)` | Parses the token, contacts the inviter over XMTP, and waits for confirmation. Blocking up to `handshakeTimeoutMs`. Returns an active `Connection`. |
| `handleMessage(ctx)` | Call this for every incoming message. Returns `true` if cone-of-silence handled it (control message or peer message), `false` if it's unrelated. |
| `extractInviteToken(text)` | Regex helper. Finds a `cos:invite:v1:...` token in a string. Returns the token or `null`. |
| `renderInviteInstructions(invite)` | Returns a human-readable string with the token and expiry, ready to send back to a user. |
| `sendText(ref, text)` | Sends a plain text message to an active connection. `ref` is `{ peerInboxId }` or `{ connectionId }`. |
| `sendJson(ref, value)` | Sends a JSON value wrapped in a `cos.app.json.v1` envelope. Only works on active connections. |
| `listConnections()` | Returns all stored connections. |
| `getConnection(ref)` | Looks up a single connection by `peerInboxId` or `connectionId`. Returns `null` if not found. |

### Events

```ts
cone.on('connection:active', (connection: Connection) => void)
cone.on('message:text', (event: TextMessageEvent) => void)
cone.on('message:json', (event: JsonMessageEvent<unknown>) => void)
```

All `.on()` calls return an `Unsubscribe` function.

## Store adapters

Two adapters ship with the library:

```ts
import { MemoryStore, JsonFileStore } from 'cone-of-silence';

// In-memory — good for tests, state is lost on exit
const store = new MemoryStore();

// JSON file — good for single-process production use
const store = new JsonFileStore('./.cone/state.json');
```

You can implement `ConeStore` yourself if you need a different backend (SQLite, Redis, etc.). The interface is small: put/get for invites and connections, plus `markMessageProcessed` for idempotency.

## For AI agents

See [SKILL.md](./SKILL.md) for agent-readable onboarding instructions.
