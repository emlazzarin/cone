---
name: cone
description: >
  Use this skill to connect to XMTP through Cone, manage contacts,
  send messages, listen for messages, and pair with another human or agent using
  a handshake code.
version: "2.0.0"
---

# Cone

Cone gives an agent an XMTP-backed identity from a portable `SECRET KEY`.

## Setup

In the Cone repo, install dependencies and link the global `cone` binary:

```sh
bun run setup
```

(Every `cone …` command below also works without linking, as `bun run packages/cli/src/bin.ts …` from the repo root.)

Generate a new key:

```sh
cone keygen
```

Use it for this process:

```sh
export CONE_SECRET_KEY='cone_sk_v1_...'
```

For a human terminal, remember it locally for the CLI:

```sh
cone login --remember
```

For an agent or script, pipe it:

```sh
printf '%s' "$CONE_SECRET_KEY" | cone login --secret-stdin --remember
```

The `SECRET_KEY` determines the XMTP account/inbox. Contact names are local aliases.

## Identity

```sh
cone whoami
```

The output includes the XMTP `inboxId` and EVM address.

## Messaging

Sync missed state into the local read model:

```sh
cone inbox sync
```

List local conversations and messages:

```sh
cone inbox
cone inbox read <conversationId-or-contact-name>
```

Open the interactive terminal chat client:

```sh
cone chat
```

Useful chat keys: `j/k` move, `Enter` talks, `Esc` returns to selection, `n` starts a structured new message, `/` filters chats as you type, `e` sets the selected chat's disappearing-messages timer, `R` toggles read receipts, `1` opens chats, `2` opens contacts, `c` creates a pairing code from Contacts, and `p` joins a pairing code from Contacts.

Read receipts are on by default. When on, the agent sends a `cone.read.v1` acknowledgement when it views a conversation, and a `✓✓ Read` marker shows on the most recent message the peer has read. Toggle with `R` (persists to config); when off, no receipts are sent or shown.

Send to an inbox ID, EVM address, or saved contact name:

```sh
cone send --to <identity> --text "hello"
```

Show or set a conversation's disappearing-messages timer (`off`, or a duration with s/m/h/d/w units like `30s`, `1h`, `6d`, `4w`):

```sh
cone timer <conversationId|contactName|inboxId>
cone timer <conversationId|contactName|inboxId> 1h
cone timer <conversationId|contactName|inboxId> off
```

Timers ride XMTP's native disappearing-messages settings, so either participant can change them and compliant clients honor them. Messages sent while a timer is on are hidden from `inbox read`/`listMessages` after they expire and purged from local storage on sync; `inbox read` JSON includes each message's `expiresAt`. Deletion is cooperative, not cryptographic — a non-compliant peer client can keep its copies.

Listen for inbound messages:

```sh
cone listen
```

`listen` streams **allowed senders only** — this is the agent trust boundary. A message from someone you haven't accepted will never reach your agent loop, so an unknown sender cannot trigger tools, file actions, or responses. Accepting a request is the explicit gate before any of that runs.

Group adds are stricter still: under `listen`, even a contact adding you to a group lands in Requests until you `cone requests accept` it (pass `--auto-accept-groups-from-contacts` to opt in to auto-allow). Each JSON line carries `conversationKind` (`dm` or `group`) plus `senderName` and `groupName` when the local store knows them, so replies and logs need no extra lookups.

**In groups, respond only when addressed.** There is no native mention type; the convention is plain `@alias` text. Check with `isAddressedTo(text, ['your-alias'])` from `@cone/core` (the CLI-shaped equivalent: match `@alias` at a word boundary). An agent that replies to every group message will feed reply loops with other agents; one that replies only when addressed cannot. Reply into a group with `cone group send <conversationId> --text "..."`.

If your agent mints invite links (`cone group invite <group> --link`), any `cone inbox sync` against the same `CONE_HOME` admits waiting joiners — a periodic sync loop makes your links admit within a minute.

## Requests

Unknown senders are held as requests, never delivered to `listen` and never added to contacts. Review and decide explicitly:

```sh
cone requests                 # list unknown senders (JSON)
cone requests accept <conversationId|inboxId> --save-as "Peer"
cone requests block <conversationId|inboxId>
cone requests --denied         # list blocked senders
```

Accepting marks the sender allowed (so future messages reach `listen`) and optionally saves a named contact. Blocking denies their inbox. Pairing and sending to someone both imply consent automatically.

## Contacts

```sh
cone contacts list
cone contacts add --name Alice --identity <inboxId-or-address>
```

Contact names are local aliases only.

## Pairing

Create a code and wait for the other side (the command prints the code, then blocks until they enter it or the window closes):

```sh
cone pair --share-name "Agent A" --save-as "Peer"
```

Join with a code from the other side:

```sh
cone pair <code> --share-name "Agent A" --save-as "Peer"
```

Mint a code without joining (for scripts that hand the code to two other actors):

```sh
cone pair --print
```

Both sides must be waiting on the same code during the ten-minute window. `--share-name` is the optional peer-visible name you propose. `--save-as` is the local contact name for the peer. The rendezvous service never relays application messages.
