# Cone of Silence v1 Spec

## Goal

`cone-of-silence` is a TypeScript library built on `@xmtp/agent-sdk` that lets two agents establish a permanent, authenticated peer connection with a simple invite flow.

v1 intentionally does not implement human-readable connection codes or a rendezvous server. The only pairing primitive is a single-use invite token.

## User Experience

The target UX is:

1. The user tells Agent A: `set up the cone-of-silence skill and create an invite`
2. Agent A returns an invite token
3. The user gives that token to Agent B
4. The user tells Agent B: `set up the cone-of-silence skill and accept this invite: <token>`
5. Agent B contacts Agent A over XMTP and completes the handshake
6. Both agents persist each other as trusted peers

This is the closest v1 UX to a share-code flow without introducing a shared rendezvous mechanism.

## Scope

v1 includes:

- XMTP-backed peer-to-peer pairing
- single-use expiring invite tokens
- permanent peer pinning by `inboxId`
- sending text and JSON messages to an active peer
- minimal storage for trust state and idempotency

v1 excludes:

- human-readable share codes
- rendezvous servers
- multi-party/group pairing
- full task protocol design
- opinionated transcript storage
- connection revocation
- capability negotiation

## Trust Model

XMTP authenticates the sender of a message. `cone-of-silence` decides whether that sender is an allowed peer.

The canonical peer identity is:

- `peerInboxId`

Secondary metadata:

- `peerAddress`

Trust is not anchored to:

- display names
- conversation IDs
- installation IDs

If a peer identity changes, the connection must be re-established through a new invite.

## Public API

```ts
import type { Agent } from '@xmtp/agent-sdk';

export type ConnectionStatus = 'pending' | 'active';

export interface ConeOptions {
  agent: Agent;
  store: ConeStore;
  inviteExpiryMs?: number; // default: 24h
  handshakeTimeoutMs?: number; // default: 60s
}

export interface Cone {
  readonly self: LocalIdentity;

  createInvite(options?: CreateInviteOptions): Promise<Invite>;
  acceptInvite(token: string): Promise<Connection>;

  handleMessage(ctx: MessageContext): Promise<boolean>;

  extractInviteToken(text: string): string | null;
  renderInviteInstructions(invite: Invite): string;

  listConnections(): Promise<Connection[]>;
  getConnection(ref: ConnectionRef): Promise<Connection | null>;

  sendText(ref: ConnectionRef, text: string): Promise<SentMessage>;
  sendJson<T>(ref: ConnectionRef, value: T): Promise<SentMessage>;

  on(event: 'connection:active', listener: (c: Connection) => void): Unsubscribe;
  on(event: 'message:text', listener: (e: TextMessageEvent) => void): Unsubscribe;
  on(event: 'message:json', listener: (e: JsonMessageEvent<unknown>) => void): Unsubscribe;
}

export interface LocalIdentity {
  inboxId: string;
  address?: string;
}

export interface CreateInviteOptions {
  label?: string;
  expiresInMs?: number;
}

export interface Invite {
  inviteId: string;
  token: string;
  expiresAt: string;
  inviter: LocalIdentity;
}

export interface Connection {
  connectionId: string;
  pairId: string;
  status: ConnectionStatus;
  peerInboxId: string;
  peerAddress?: string;
  alias?: string;
  conversationId?: string;
  createdAt: string;
  activatedAt?: string;
}

export interface SentMessage {
  id: string;
  sentAt: string;
}

export type ConnectionRef =
  | { connectionId: string }
  | { peerInboxId: string };

export interface TextMessageEvent {
  connection: Connection;
  text: string;
  messageId: string;
  sentAt: string;
}

export interface JsonMessageEvent<T> {
  connection: Connection;
  value: T;
  messageId: string;
  sentAt: string;
}

export type Unsubscribe = () => void;

export async function createCone(options: ConeOptions): Promise<Cone>;
```

## `createCone()` Behaviour

`createCone()` is idempotent with respect to the store. If the store already contains connections and invites from a previous session, they are available immediately on the returned `Cone` instance. There is no separate "setup" vs "resume" path — calling `createCone()` with the same store always produces a fully-initialised `Cone`.

## Message Processing

The host agent is responsible for its own message loop. Cone provides a `handleMessage(ctx)` method that the host calls for each incoming message.

- If the message is a cone-of-silence control message (`cos.*`), `handleMessage` processes it and returns `true`.
- If the message is an application message from a known peer, `handleMessage` emits the appropriate event (`message:text` or `message:json`) and returns `true`.
- If the message is unrelated to cone-of-silence, `handleMessage` returns `false`.

```ts
agent.on('message', async (ctx) => {
  const handled = await cone.handleMessage(ctx);
  if (!handled) {
    // not a cone-of-silence message — handle normally
  }
});
```

## Example Usage

```ts
const cone = await createCone({
  agent,
  store: new JsonFileStore('./.cone/state.json'),
});

// Agent A: create invite
const invite = await cone.createInvite({ label: 'Bob' });
console.log(cone.renderInviteInstructions(invite));

// Agent B: accept invite
const connection = await cone.acceptInvite(tokenFromUser);

// Send messages over an active connection
await cone.sendText({ peerInboxId: 'peer-inbox-id' }, 'hello');
await cone.sendJson({ peerInboxId: 'peer-inbox-id' }, { task: 'summarize', url: '...' });

// Listen for incoming messages
cone.on('message:text', (e) => {
  console.log(`${e.connection.peerInboxId}: ${e.text}`);
});
```

## Invite Token

The token is an opaque single-use bearer invite. Its exact wire encoding is internal, but it must carry enough information for the accepter to reach the inviter and enough entropy to prevent guessing.

Encoding: base64url JSON. Prefix: `cos:invite:v1:<base64url-payload>`.

Internal fields:

- `inviteId`
- `pairId`
- inviter `inboxId`
- inviter address, if present
- XMTP environment
- expiry
- high-entropy invite secret

Design requirements:

- single use
- expiring
- not user-editable
- safe to copy/paste between agents

## Pairing Flow

### `createInvite()`

1. Read the local XMTP identity from the agent (`agent.client.inboxId`, `agent.address`)
2. Generate:
   - `inviteId`
   - `pairId`
   - `inviteSecret` (high entropy, stored as SHA-256 hash)
   - `expiresAt`
3. Persist the invite in the local store as `pending`
4. Return the `Invite` object containing the opaque token

### `acceptInvite(token)`

1. Parse and validate the token (decode base64url JSON)
2. Reject if malformed or expired
3. Open or create a DM to the inviter `inboxId` via `agent.client.conversations.createDm()`
4. Send `cos.accept.v1` as a plain text JSON message
5. Poll the DM conversation directly for `cos.confirm.v1` (up to `handshakeTimeoutMs`). This is a self-contained receive path — it does not go through `handleMessage`.
6. Validate the confirm (see Validation Rules)
7. Persist the connection as `active`
8. Return the active `Connection`

### Inviter side (via `handleMessage`)

1. Receive `cos.accept.v1` via `handleMessage(ctx)`
2. Validate the accept message (see Validation Rules)
3. Send `cos.confirm.v1` back to the accepter
4. Persist the connection as `active`
5. Emit `connection:active` event

### Result

After a successful accept:

- both sides know the peer `inboxId`
- both sides store the connection
- subsequent application messages are authorized against the pinned peer

## Control Messages

All control messages are sent as plain text over XMTP DM, containing JSON with a `type` field.

### `cos.accept.v1`

```ts
{
  type: 'cos.accept.v1';
  inviteId: string;
  inviteSecret: string;
  fromInboxId: string;
  fromAddress?: string;
  nonce: string;
}
```

Sent by the accepter to the inviter.

### `cos.confirm.v1`

```ts
{
  type: 'cos.confirm.v1';
  inviteId: string;
  connectionId: string;
  pairId: string;
  fromInboxId: string;
  fromAddress?: string;
  replyToNonce: string;
}
```

Sent by the inviter back to the accepter after validating the invite.

## Validation Rules

On receipt of `cos.accept.v1`, the inviter must:

1. verify the invite exists
2. verify the invite is unexpired
3. verify the invite is not already consumed
4. verify `inviteSecret` matches the stored secret hash (SHA-256)
5. trust `ctx.message.senderInboxId` as the actual sender identity
6. bind that sender inbox to the new connection

On receipt of `cos.confirm.v1`, the accepter must:

1. verify `inviteId` matches the locally accepted invite
2. verify `replyToNonce` matches the nonce it sent
3. verify `ctx.message.senderInboxId` matches the inviter inbox from the token
4. mark the connection as `active`

The library must always trust XMTP metadata for sender identity over any self-reported identity fields inside a control message.

## Storage Contract

The library owns trust state. It does not require a specific database technology.

```ts
export interface ConeStore {
  putInvite(invite: StoredInvite): Promise<void>;
  getInvite(inviteId: string): Promise<StoredInvite | null>;
  consumeInvite(inviteId: string, peer: PeerSnapshot): Promise<void>;

  putConnection(connection: StoredConnection): Promise<void>;
  getConnectionById(connectionId: string): Promise<StoredConnection | null>;
  getConnectionByInboxId(peerInboxId: string): Promise<StoredConnection | null>;
  listConnections(): Promise<StoredConnection[]>;

  markMessageProcessed(messageId: string): Promise<boolean>;
}
```

The adapter contract is intentionally small so hosts can choose their own persistence layer.

Shipped adapters:

- `MemoryStore` for tests
- `JsonFileStore` for simple local usage (single-process, read-all/write-all)

## Minimum Stored State

The library must persist at least:

- pending invites
- consumed invites
- active connections
- processed control-message IDs for idempotency

The library does not need to persist:

- full XMTP transcripts
- reasoning traces
- agent memory summaries
- application artifacts beyond what the host explicitly chooses to store

## Connection State Model

Valid states:

- `pending`
- `active`

Expected transitions:

1. `createInvite()` creates a `pending` invite
2. `acceptInvite()` begins a `pending` connection on the accepter side
3. receipt of a valid `cos.accept.v1` (via `handleMessage`) creates an `active` connection on the inviter side
4. receipt of a valid `cos.confirm.v1` activates the connection on the accepter side

Rules:

- repeated processing of the same control message must be idempotent
- an invite can only be consumed once

## Message Sending

Application-level messages are only allowed over `active` connections.

v1 includes:

- `sendText()`
- `sendJson()`

Messages are sent as plain text over the existing XMTP DM conversation. JSON messages are serialized with a wrapper to distinguish them from text.

## Non-Goals

v1 is not trying to solve:

- agent discovery in the general case
- human-memorable pairing codes
- arbitrary cross-network transport
- full A2A compatibility
- connection revocation
- capability negotiation

Those can be added later without changing the invite-based trust model.
