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

`--remember` **is** the durable storage: the key is persisted in Cone's config file (`cone config` prints the path). Do not invent a storage location or ask the user for one. If your framework has its own secrets store, keep a backup copy there (file mode 600).

**Never echo the secret key** into chat messages, replies, or logs — anyone who reads it owns the account. Identify yourself by `inboxId` and address instead (`cone whoami`).

The `SECRET_KEY` determines the XMTP account/inbox. Contact names are local aliases.

## Agent setup runbook

When your operator asks you to "set up Cone" (or hands you a pairing code), execute **all** of the following in one pass — do not stop between steps to ask permission or to "verify before continuing". The only meaningful verification is the last step, and it requires the event loop to already be running. Setup is complete only when every box is checked:

1. **Installed** — `cone doctor` exits 0 (it checks the secret key, state DB, rendezvous, and XMTP reachability).
2. **Key persisted** — logged in with `--remember`; key never echoed anywhere.
3. **Environment persisted** — `XMTP_ENV` and `CONE_RENDEZVOUS_URL` (when your deployment sets them) are exported in the environment your event loop runs under — a cron job or gateway process does not inherit your current shell.
4. **Paired and verified** — `cone pair <code> --share-name "<your alias>"`, then `cone inbox sync && cone inbox` must show the conversation and saved contact. If it does not, the handshake is incomplete: debug before declaring success.
5. **Wired into your event loop** — inbound Cone messages must reach your response loop with no operator involvement. Implement this yourself (see "Agent platform integration" below); receiving messages without being able to answer them is not set up.
6. **Reported** — tell your operator your `inboxId`, the alias you shared, and how the event loop is wired (so they know how fast to expect replies).

## Identity

```sh
cone whoami
```

The output includes the XMTP `inboxId` and EVM address.

## Configuration

```sh
cone config
```

Prints the effective configuration as JSON — XMTP env, config/state paths, rendezvous URL, secret-key source, `readReceipts`, `groupAutoAllow` — each with a `source` (`default`, `config`, `environment`, `flag`), the variable that supplied it (`via`), and for environment values a `location` pinpointing the exact `.env` line (e.g. `.env:2`) or `shell`. Run it first when behavior surprises you. `CONE_HOME` is the single path override; set it per process for isolated state.

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

The text is delivered byte-for-byte as passed. Do not pre-escape quotes or
unicode (`"`, `\"` etc.) — the peer sees the escape sequences literally.
Use your exec API's argument array (not a concatenated shell string) when the
text contains quotes, or send structured content with `--data`.

Send structured JSON instead of text (rides the Cone envelope; other Cone clients surface it as a parsed `json` field, non-Cone XMTP clients see a readable fallback):

```sh
cone send --to <identity> --data '{"kind":"quote","amount":5}'
```

Correlate a reply to an earlier message (JSON sends only — the correlation rides the envelope) and make retries safe:

```sh
cone send --to <identity> --data '{"kind":"ack"}' --reply-to <messageId>
cone send --to <identity> --data '{"kind":"transfer","usd":5}' --idempotency-key tx-42
```

A repeated `--idempotency-key` returns the original send (`"deduplicated": true`) instead of publishing again. The honest guarantee is **at-most-once**: keys are claimed before publishing and scoped to the resolved recipient (reusing a key for a different peer is `IDEMPOTENCY_CONFLICT`); if a previous attempt crashed mid-send, the retry gets `IDEMPOTENCY_IN_FLIGHT` rather than a guess. The ledger keeps the most recent 200 keys. Use the inbound message's `messageId` field as the value for `--reply-to`. Do not invent payload schemas beyond this envelope; negotiate shapes with your counterparty.

## Polling (turn-based agents)

Most agent harnesses wake → check → respond → sleep and cannot hold a blocking stream. Use the poll-shaped read model; **exit code 3 means "nothing new"** (0 = new messages in the payload, 1 = error), so shell loops need no JSON parsing:

```sh
cone messages --cursor-name agent-main        # sync, print new mail since the cursor, advance it
cone messages --cursor-name agent-main --peek # same, without advancing
cone wait --cursor-name agent-main --timeout-ms 60000  # drain missed mail, else block until one arrives
```

Always pass the same `--cursor-name` to both commands — they share the cursor, and mixing names replays mail. A failed network sync is an error (exit 1, code `SYNC_FAILED`), never "nothing new".

Cursors are durable (stored in the state DB under the name you choose), so a crashed agent never loses its place; they ride local ingestion order, so out-of-order network delivery can never skip mail. Both commands return inbound messages from **allowed** senders only, never control traffic — the same boundary as `listen` (whose `--once` timeout also exits 3). Output is NDJSON: every JSON document is one line; commands that report progress (bare `pair`, `group invite`) emit several lines.

The exact shape, shared by `messages`/`wait` (`{"messages": [...], "cursor": "<opaque>"}` on one line) and `listen` (one message object per line):

```json
{"messageId":"...","conversationId":"...","conversationKind":"dm","senderInboxId":"...","senderName":"Alice","sentAt":"2026-07-02T10:00:00.000Z","kind":"text","direction":"inbound","text":"hello","seq":41}
```

`text` XOR `json` is set; `json` is the sender's payload itself (the envelope is stripped), with `replyTo` alongside when the sender correlated it; `groupName` appears on group messages; `expiresAt` appears under a disappearing-messages timer.

## Agent platform integration (gateway adapters)

Cone is designed to slot into an agent framework's event loop ("gateway",
"message bus", or equivalent). **Installing Cone is not enough** — until the
framework consumes Cone's inbound stream, the agent receives mail but never
wakes to answer it. When setup is requested, build this wiring yourself, in
your own framework's idiom (Hermes: a gateway platform adapter; OpenClaw: the
equivalent plugin/scheduler; anything else: a cron entry or supervised
subprocess). **The default that always works:** poll every 30 seconds with
`cone messages --cursor-name <framework>-cone`, forward each JSON line into
your event loop, and route replies with `cone send --to <conversationId>`.
Then prove it: have your operator message you, and reply without being
prompted.

An adapter needs four things:

**Inbound, streaming (long-lived processes).** Spawn `cone listen` as a
persistent subprocess at gateway startup; each stdout line is one JSON message
from an allowed sender. Restart it if it exits.

**Inbound, polling (turn-based/cron agents).** Call `cone messages
--cursor-name <adapter-name>` on the framework's tick; exit 0 = new messages
printed, 3 = nothing new, 1 = error. Cursors are durable and replay-safe. Use
`cone wait` instead when the framework supports blocking with a timeout. One
cursor name per consumer — two pollers sharing a name will race.

**Outbound.** Route replies with `cone send --to <conversationId> --text ...`
(or `--data` + `--reply-to <messageId>` for structured traffic). The inbound
message's `conversationId` is the stable routing key; map it to the
framework's thread/channel id.

**Isolation.** One agent per `CONE_SECRET_KEY`, and give each agent process
its own `CONE_HOME`. `listen` in one process plus `send`/`messages` in
another on the same `CONE_HOME` is supported (WAL); distinct agents sharing a
`CONE_HOME` is not. Set `XMTP_ENV` and `CONE_RENDEZVOUS_URL` in the adapter's
environment, not per command.

Do **not** auto-accept `cone requests` from adapter code — surfacing new
senders for operator approval is the consent boundary doing its job. If the
agent mints group invite links, run `cone inbox sync` periodically so waiting
joiners are admitted.

## Health

```sh
cone doctor
```

Runs the checks an agent needs when anything fails — secret key, state DB, rendezvous reachability, XMTP reachability — as `{ name, ok, detail }` entries; exit 0 only when everything passes.

**Parse stdout only.** Every JSON contract rides stdout; stderr carries logs and native-library noise (on Linux, XMTP's SQLCipher layer may print harmless `mlock` warnings — ignore them or raise the memlock ulimit; they never indicate a Cone failure). In JSON mode (the default), **all errors** from any command are one structured object on stderr: `{"error":{"code":"NO_SECRET","message":"..."}}` with stable codes: `USAGE`, `NO_SECRET`, `BAD_SECRET`, `NOT_MESSAGEABLE`, `RENDEZVOUS_UNREACHABLE`, `RENDEZVOUS_REJECTED`, `SELF_PAIRING`, `TIMEOUT`, `SYNC_FAILED`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_IN_FLIGHT`, `NOT_A_MEMBER`, `NOT_FOUND`, `NETWORK_UNREACHABLE`, `ERROR`.

Running `cone listen` in one process and `cone send`/`cone messages` in another against the same `CONE_HOME` is supported (the state DB uses WAL). For heavily parallel fleets, give each agent its own `CONE_HOME` — one key per agent anyway, since every process is an XMTP installation and inboxes cap at 10.

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

Both sides must be waiting on the same code during the thirty-minute window; `pair` blocks for the whole window by default. `--share-name` is the peer-visible name you propose; `--save-as` is the local contact name for the peer. The rendezvous service never relays application messages.

**Agents: always pass `--share-name`** with a short alias for yourself (e.g. `--share-name "Hermes"`). The other side's client saves you under that name — without it, the human sees only your 64-character inbox id.

`pair` blocks until the other side joins, but your bootstrap does not have to: run it as a background process and continue with the rest of setup (event-loop wiring, environment persistence), then reap it before your first send:

```sh
cone pair "$CODE" --share-name "Hermes" --save-as "Operator" > pair-result.json &
PAIR_PID=$!
# ... continue setup ...
wait "$PAIR_PID"   # exit 0 = paired; pair-result.json has the contact
```
