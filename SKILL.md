---
name: cone-of-silence
description: >
  Use this skill to connect to XMTP through Cone of Silence, manage contacts,
  send messages, listen for messages, and pair with another human or agent using
  a handshake code.
version: "2.0.0"
---

# Cone of Silence

Cone of Silence gives an agent an XMTP-backed identity from a portable `SECRET KEY`.

## Setup

Install dependencies in the Cone repo:

```sh
bun install
```

Generate a new key:

```sh
bun run packages/cli/src/bin.ts keygen
```

Use it for this process:

```sh
export COS_SECRET_KEY='cos_sk_v1_...'
```

For a human terminal, remember it locally for the CLI:

```sh
cos login --remember
```

For an agent or script, pipe it:

```sh
printf '%s' "$COS_SECRET_KEY" | bun run packages/cli/src/bin.ts login --secret-stdin --remember
```

The `SECRET_KEY` determines the XMTP account/inbox. Contact names are local aliases.

## Identity

```sh
bun run packages/cli/src/bin.ts whoami
```

The output includes the XMTP `inboxId` and EVM address.

## Messaging

Sync missed state into the local read model:

```sh
bun run packages/cli/src/bin.ts inbox sync
```

List local conversations and messages:

```sh
bun run packages/cli/src/bin.ts inbox
bun run packages/cli/src/bin.ts inbox read <conversationId-or-contact-name>
```

Open the interactive terminal chat client:

```sh
bun run packages/cli/src/bin.ts chat
```

Useful chat keys: `j/k` move, `Enter` talks, `Esc` returns to selection, `n` starts a structured new message, `/` filters chats as you type, `e` sets the selected chat's disappearing-messages timer, `R` toggles read receipts, `1` opens chats, `2` opens contacts, `c` creates a pairing code from Contacts, and `p` joins a pairing code from Contacts.

Read receipts are on by default. When on, the agent sends a `cos.read.v1` acknowledgement when it views a conversation, and a `✓✓ Read` marker shows on the most recent message the peer has read. Toggle with `R` (persists to config); when off, no receipts are sent or shown.

Send to an inbox ID, EVM address, or saved contact name:

```sh
bun run packages/cli/src/bin.ts send --to <identity> --text "hello"
```

Show or set a conversation's disappearing-messages timer (`off`, or a duration with s/m/h/d/w units like `30s`, `1h`, `6d`, `4w`):

```sh
bun run packages/cli/src/bin.ts timer <conversationId|contactName|inboxId>
bun run packages/cli/src/bin.ts timer <conversationId|contactName|inboxId> 1h
bun run packages/cli/src/bin.ts timer <conversationId|contactName|inboxId> off
```

Timers ride XMTP's native disappearing-messages settings, so either participant can change them and compliant clients honor them. Messages sent while a timer is on are hidden from `inbox read`/`listMessages` after they expire and purged from local storage on sync; `inbox read` JSON includes each message's `expiresAt`. Deletion is cooperative, not cryptographic — a non-compliant peer client can keep its copies.

Listen for inbound messages:

```sh
bun run packages/cli/src/bin.ts listen
```

`listen` streams **allowed senders only** — this is the agent trust boundary. A message from someone you haven't accepted will never reach your agent loop, so an unknown sender cannot trigger tools, file actions, or responses. Accepting a request is the explicit gate before any of that runs.

## Requests

Unknown senders are held as requests, never delivered to `listen` and never added to contacts. Review and decide explicitly:

```sh
bun run packages/cli/src/bin.ts requests                 # list unknown senders (JSON)
bun run packages/cli/src/bin.ts requests accept <conversationId|inboxId> --save-as "Peer"
bun run packages/cli/src/bin.ts requests block <conversationId|inboxId>
bun run packages/cli/src/bin.ts requests --denied         # list blocked senders
```

Accepting marks the sender allowed (so future messages reach `listen`) and optionally saves a named contact. Blocking denies their inbox. Pairing and sending to someone both imply consent automatically.

## Contacts

```sh
bun run packages/cli/src/bin.ts contacts list
bun run packages/cli/src/bin.ts contacts add --name Alice --identity <inboxId-or-address>
```

Contact names are local aliases only.

## Pairing

Create a code:

```sh
bun run packages/cli/src/bin.ts pair
```

Join with a code:

```sh
bun run packages/cli/src/bin.ts pair <code> --share-name "Agent A" --save-as "Peer"
```

Both sides must opt in during the short pairing window. `--share-name` is the optional peer-visible name you propose. `--save-as` is the local contact name for the peer. The rendezvous service never relays application messages.
