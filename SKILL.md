---
name: cone-of-silence
description: >
  Use this skill to establish a secure, permanent connection between two agents
  over XMTP. Triggers: "connect to another agent", "set up cone-of-silence",
  "create an invite", "accept an invite", "send a message to my peer agent".
version: "1.0.0"
---

# cone-of-silence

cone-of-silence lets two agents establish a permanent, authenticated peer connection using a single-use invite token over XMTP. No shared server required. After pairing, agents can send text and JSON messages directly to each other.

## Prerequisites

- `@xmtp/agent-sdk` installed
- `cone-of-silence` available (local path or npm)
- XMTP credentials in `.env` (see Step 1)

---

## Step 1: Generate credentials (first time only)

Run:

```sh
bun run gen:keys
```

Output looks like this:

```
# Paste these into your .env file (keep them secret, never commit)

XMTP_WALLET_KEY=0xabc123...
XMTP_DB_ENCRYPTION_KEY=def456...
XMTP_ENV=dev
```

Paste that output into your `.env`. Also add:

```
CONE_STATE_PATH=./.cone/state.json
```

What each variable means:

| Variable | Purpose |
|---|---|
| `XMTP_WALLET_KEY` | secp256k1 private key. Your agent's permanent XMTP identity. |
| `XMTP_DB_ENCRYPTION_KEY` | 32 random bytes (hex). Encrypts the local XMTP message database. |
| `XMTP_ENV` | `dev` for the test network, `production` for the live network. |
| `CONE_STATE_PATH` | Where cone-of-silence stores invites and connections. |

**These are permanent identity keys. Generate once, store securely, never regenerate unless you want a new identity.**

---

## Step 2: Wire cone-of-silence into your agent

```ts
import { Agent } from '@xmtp/agent-sdk';
import { createCone, JsonFileStore } from 'cone-of-silence';
// or, if running from source:
// import { createCone, JsonFileStore } from '../src/index';

const agent = await Agent.createFromEnv();

const cone = await createCone({
  agent,
  store: new JsonFileStore(process.env.CONE_STATE_PATH ?? './.cone/state.json'),
});

// Register event listeners before starting the agent
cone.on('connection:active', (connection) => {
  console.log(`Peer connected: ${connection.peerInboxId}`);
});

cone.on('message:text', (event) => {
  console.log(`Text from ${event.connection.peerInboxId}: ${event.text}`);
});

cone.on('message:json', (event) => {
  console.log(`JSON from ${event.connection.peerInboxId}:`, event.value);
});

// Pass every incoming message through cone first
agent.on('message', async (ctx) => {
  const handled = await cone.handleMessage(ctx);
  if (!handled) {
    // not a cone-of-silence message — handle it yourself
  }
});

await agent.start();
```

`createCone()` is idempotent. Call it on every startup. It restores prior connections and invites from the store automatically.

---

## Step 3: Create an invite (you are the inviter)

```ts
const invite = await cone.createInvite();
const instructions = cone.renderInviteInstructions(invite);

// instructions is a human-readable string containing the token.
// Give it to the other agent's operator — paste it in their chat,
// send it via another channel, etc.
console.log(instructions);
```

The token looks like:

```
cos:invite:v1:eyJpbnZpdGVJZCI6Ii4uLiJ9...
```

Once the other agent accepts, `connection:active` fires automatically on your side. You don't need to poll or do anything else.

---

## Step 4: Accept an invite (you are the accepter)

```ts
// Receive the token string from the user's message or another channel.
// Extract it from free-form text if needed:
const token = cone.extractInviteToken(userMessage) ?? userMessage.trim();

// Accept the invite. This is blocking — it waits up to 60s for the inviter to confirm.
try {
  const connection = await cone.acceptInvite(token);
  console.log(`Connected to peer: ${connection.peerInboxId}`);
} catch (err) {
  // Throws on timeout, invalid token, or expired token
  console.error(`Failed to accept invite: ${err.message}`);
}
```

`acceptInvite()` polls the XMTP DM conversation directly. It does not go through `handleMessage`. The inviter's agent must be running and have `cone.handleMessage` wired up, or the handshake will time out.

---

## Step 5: Send and receive messages

Send to a peer by inbox ID or connection ID:

```ts
// By peer inbox ID
await cone.sendText({ peerInboxId: 'peer-inbox-id' }, 'hello');
await cone.sendJson({ peerInboxId: 'peer-inbox-id' }, { task: 'summarize', url: 'https://...' });

// By connection ID
await cone.sendText({ connectionId: 'conn-abc123' }, 'hello');
```

Listen for incoming messages:

```ts
cone.on('message:text', (event) => {
  // event.connection  — the Connection object
  // event.text        — the message string
  // event.messageId   — XMTP message ID
  // event.sentAt      — ISO timestamp
});

cone.on('message:json', (event) => {
  // event.value — the deserialized JSON value
});
```

Messages only work on **active** connections. Sending to a pending or unknown peer throws.

---

## Connection reference

Look up a connection:

```ts
const conn = await cone.getConnection({ peerInboxId: 'peer-inbox-id' });
const conn = await cone.getConnection({ connectionId: 'conn-abc123' });
// Returns null if not found
```

List all connections:

```ts
const connections = await cone.listConnections();
// Returns Connection[]
// Each connection has: connectionId, peerInboxId, status ('pending' | 'active'), createdAt, activatedAt
```

---

## Troubleshooting

**"handshake timeout"**
The inviter's agent wasn't running or didn't call `cone.handleMessage`. Make sure both agents are running and that `handleMessage` is wired into the inviter's `agent.on('message', ...)` handler.

**`handleMessage` returns `false`**
The message wasn't from a known peer and wasn't a cone control message. Handle it yourself in the `if (!handled)` branch.

**Token expired**
Invites expire after 24 hours by default. Call `cone.createInvite()` again to get a fresh token.

**"connection not found or inactive"**
You're trying to send to a peer you haven't paired with yet, or the `ConnectionRef` is wrong. Check `cone.listConnections()` to see what's active.

---

## Full example

See `examples/agent.ts` for a complete working agent that handles both roles.
