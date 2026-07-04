# Cone

Cone is an open family of e2e encrypted messaging apps optimized for agents and people, and a standard for building your own messaging app over the same graph.

The graph is [XMTP](https://xmtp.org): every Cone account is an XMTP identity, so Cone apps reach each other — and any other XMTP-reachable identity — end-to-end encrypted, with no Cone-run server in the message path. The standard is the frozen protocol layer in [SPEC.md](SPEC.md) (secret-key derivation, the Cone envelope content type, pairing and invite key material, all guarded by golden vectors) plus the shared `@cone/core` implementation: a client you build on it unlocks the same account and interoperates with every other Cone app.

It has three primary messaging surfaces:

- ConePWA — a static installable PWA for humans
- ConeTUI — a terminal chat UI (`cone chat`)
- ConeCLI — a CLI/library for agents and developers

All three unlock the same XMTP-backed account from a portable `SECRET KEY`, can message XMTP-reachable identities, and maintain a local address book of contacts.

**Working with an agent?** Point it at [SKILL.md](SKILL.md) — the agent-facing guide to setup, identity, sending text and structured JSON, the poll-shaped read model, pairing, and the consent boundary. (It currently assumes a clone of this repo; a hosted zero-install version is tracked in TODO.md.)

Cone is pre-release: the protocol layer a new client depends on is already frozen, but nothing is deployed or published yet — distribution is tracked in [TODO.md](TODO.md).

## Install

Prerequisite: [Bun](https://bun.sh) 1.3+ (its installer puts `~/.bun/bin` on your PATH).

```sh
bun run setup
```

That installs workspace dependencies and links a global `cone` binary (`bun link` → `~/.bun/bin/cone`). There is no build step for the CLI — Bun runs the TypeScript directly.

First run (two terminals — pairing and group invites go through the rendezvous service, and nothing is deployed yet):

```sh
bun run dev:rendezvous   # terminal 1: serves http://localhost:8787, the default CONE_RENDEZVOUS_URL
```

```sh
cone keygen              # terminal 2: prints a SECRET KEY — save it; it IS your account
cone login --remember    # paste the key once
cone doctor --plain      # verify secret, state DB, rendezvous, and XMTP reachability
cone chat                # open the TUI
cone pair                # mint a code and wait; the other account enters it (PWA "Join code" or `cone pair <code>`)
```

Plain messaging (`cone send`, `cone listen`, `cone chat`) talks to XMTP directly and needs no rendezvous.

`cone` works from any directory. One Bun quirk to know: running it *inside this repo* picks up the repo `.env` — with `CONE_HOME=./.cone` there, repo runs keep their state in `./.cone` (handy for development), while runs from anywhere else use `~/.config/cone` and `~/.local/share/cone`. Delete that line from `.env` if you want one identity everywhere. When in doubt, `cone config` prints the effective configuration and where each value came from. Uninstall the binary with `cd packages/cli && bun unlink`.

## CLI

```sh
cone keygen                  # print a new SECRET KEY — it IS the account
cone login --remember        # remember it locally (agents: pipe via --secret-stdin)
cone whoami
cone config                  # effective configuration + where each value came from
cone doctor                  # health checks: secret, state DB, rendezvous, XMTP

cone send --to <inboxId|address|contactName> --text "hello"
cone send --to <peer> --data '<json>' [--reply-to <messageId>] [--idempotency-key <key>]
cone inbox [sync | read <conversationId|contactName|inboxId>]
cone messages [--cursor-name <name>] [--peek]   # new mail since a durable cursor; exit 3 = nothing new
cone wait [--timeout-ms <ms>]                   # drain missed mail, else block until one message arrives
cone listen [--once]                            # stream allowed senders (daemon-shaped)
cone chat                                       # open the TUI

cone requests [list | accept <target> [--save-as <name>] | block <target>] [--denied]
cone contacts [list | add | rename | delete]
cone pair [<code>] [--share-name <name>] [--save-as <contactName>] [--print]
cone timer <target> [<duration>|off]            # disappearing messages (30s, 1h, 6d, 4w, ...)
cone group <create|info|add|remove|rename|describe|promote|demote|send|leave|invite|join|joins|links> ...
cone backup export --out backup.cone
cone backup import --in backup.cone
```

Run `cone` with no arguments for the full usage — every flag and group subcommand. [SKILL.md](SKILL.md) documents the agent-facing contract in depth: JSON output shapes, stable error codes, exit-code semantics, idempotency, and polling recipes.

The CLI reads `CONE_SECRET_KEY`, `cone login --remember`, or command-level `--secret-stdin`. For automation, pipe the key instead of using the interactive prompt:

```sh
printf '%s\n' "$CONE_SECRET_KEY" | cone login --secret-stdin --remember
```

The `SECRET_KEY` determines the XMTP account/inbox. The CLI stores one remembered secret and one local state database by default. `CONE_HOME` is the single path override — one directory holding both `config.json` and `state.sqlite` — for tests and concurrent agent processes (see [Configuration](#configuration)).

JSON (one document per line) is the default output for agents; use `--plain` for human-readable output. Pairing names are explicit: `--share-name` proposes a peer-visible contact name during pairing, `--save-as` saves the peer under a local contact name — contact names are local aliases, not global usernames.

`cone inbox sync` pulls account-level XMTP state into the local encrypted read model. `cone inbox` lists local conversations (allowed senders only) and `cone inbox read <target>` reads a local transcript. `cone chat` opens the lightweight terminal chat client over the same local read model; use `cone chat --plain-log` for a non-interactive stream log.

## How it works

### Consent and Requests

Cone uses XMTP consent as its anti-spam and trust boundary, and defaults to strict. Your main inbox shows only people you've allowed. A message from someone unknown becomes a **Request** rather than an inbox conversation, and never an address-book entry — Requests live in a sub-surface of Chats (the `Requests` tab in the PWA, `t` in the TUI, `cone requests` on the CLI) where you can preview, **Accept** (moves them to your inbox, optionally saving a named contact), or **Block**. Blocking denies the peer's inbox, so they can't return with a new conversation; unblock from PWA Settings (or `cone requests accept`).

Consent is implied by intent: pairing, sending an outbound message, accepting a request, and manually adding a contact all mark the peer allowed. Decisions apply locally first (so the UI is correct even offline) and propagate to XMTP best-effort, reconciling on the next sync.

For agents, this boundary is a **prompt-injection firewall**: an unknown sender's text can never reach an agent's context, tools, or response generation — `cone listen`, `cone wait`, and `cone messages` all deliver allowed senders only, and accepting a request is the explicit human-or-policy gate before any agent behavior runs. No webhook, shared inbox, or public Slack channel offers this property; it is the difference between Cone and "just use XMTP directly." Read receipts are only sent for allowed conversations, so previewing a Request never tells the sender you saw it.

### Groups

Group chats follow the same trust model. A group a **contact** adds you to lands straight in Chats ("allow contacts to add you to groups", on by default — `groupAutoAllow` in CLI config); a group a stranger adds you to is a Request; a group a **blocked** sender adds you to is silently discarded. Your block list follows you into groups: a denied sender's messages are dropped even inside groups you've accepted. Agents never auto-accept groups — explicit `cone requests accept` is the boundary. Joining a group never shows pre-join history (MLS forward secrecy), and invites never auto-create contacts.

Beyond direct adds, groups support **invite codes**: any member mints a single-use, 10-minute code (`v` in the TUI's group info, "Invite by code" in the PWA, `cone group invite`), the joiner enters it (`g` in the TUI, the Pair tab's "Join a group" card, `cone group join <code>`), and the inviter's client adds them directly over the same encrypted rendezvous used for pairing. Because the joiner asked, the group's welcome is auto-allowed — it never sits in Requests.

For invites that outlive a conversation, **invite links** (`--link`, `l` in the TUI, "Invite link" in the PWA) mint a `cone_gi_v1_…` capability token: anyone holding it is admitted the next time the minting account syncs — no process waits on either side. Links default to a single use and a week, and are revocable. The rendezvous service addresses rooms by a hash of the secret, so it can never decrypt what it relays.

Group management lives in **group info**: `i` on a group in the TUI, or the `group · N members` header button in the PWA. Members show with roles (the creator is the *owner* — XMTP's super admin); any member can add members and rename under the default policy, admins remove, owners manage roles. Promoting someone else to owner is how ownership transfers — an owner can't leave until another owner exists. **Leaving is visible to the group; blocking is silent** — both are offered, labeled honestly. Membership and rename events render as system lines in the transcript ("Alice added Bob"), and if you're removed (or leave), the chat stays readable but marked left.

### Delivery

Sending is fully optimistic on every surface: the message appears in the transcript the instant you press `Enter` and the composer clears. A successful send is silent — XMTP has no per-recipient "delivered" ack, so the meaningful signal is whether a message published to the network. Only a send that fails to publish is marked (`✗` "not delivered", in red), offering **retry or delete** (PWA: buttons; TUI: `Enter` retries, `Ctrl+X` deletes). The local read model is kept to published messages, so a failed send never later masquerades as delivered. Identities are labeled "XMTP inbox ID" where the distinction matters.

### Read receipts

Read receipts are on by default and toggleable (PWA Settings; `R` in the TUI chat). When on, a `cone.read.v1` control message is sent into a conversation when you read it, and a single `✓✓ Read` marker appears on the most recent of your messages the peer has read. The toggle is symmetric: turning it off stops sending receipts *and* hides peer read state — only failed sends are ever marked. Receipts are only sent for allowed conversations, so previewing a Request never acknowledges it. Receipts interoperate between Cone clients: they ride Cone's own envelope content type with no fallback text, so other XMTP clients simply never see them.

### Secret Keys

Cone secret keys look like:

```text
cone_sk_v1_<payload>
```

The key is a 32-byte root secret with version and checksum metadata. Cone deterministically derives:

- XMTP wallet private key
- XMTP local DB encryption key for non-browser SDKs
- Cone storage encryption key
- Cone backup archive key

### Pairing

Handshake-code pairing is for cases where two sides want to opt in without exchanging identifiers first.

The rendezvous service stores encrypted offers for a short time. It does not relay application messages. Offers are encrypted with a key derived from the handshake code itself — the only secret both sides share before they know each other. After both sides decrypt each other locally, they confirm over XMTP and save each other as contacts. Handshake codes expire after thirty minutes, but the pairing they establish is permanent.

### Address Book

Contacts are local aliases. A contact stores:

- display name
- canonical XMTP inbox ID
- optional EVM address
- source: `manual`, `paired`, or `self` (a contact is created only when you add, pair, or accept someone — never automatically from an unknown inbound message)

Names are not global usernames and do not affect XMTP identity.

## Configuration

Configuration is layered by lifetime, and `cone config` is the one place to see it resolved — every effective value plus exactly where it was set, `git config --show-origin`-style: a built-in default (and the knob that changes it), a config-file key, a command-line flag, or an environment variable pinpointed to the `.env` line that defined it (`.env:2`) or the shell. Bun auto-loads `.env` only for processes launched from the repo directory, which is the usual source of "why does it behave differently here?" — `cone config` names the line.

Per-process environment variables (the complete list):

| Variable | Meaning | Default |
| --- | --- | --- |
| `CONE_SECRET_KEY` | Account secret for this process; beats the remembered secret | — |
| `XMTP_ENV` | XMTP network: `production`, `dev`, or `local`. Identities are env-scoped — a dev identity can never touch the production account | `production` |
| `CONE_HOME` | The single path override: one directory holding `config.json` and `state.sqlite` | `~/.config/cone` + `~/.local/share/cone` |
| `CONE_RENDEZVOUS_URL` | Rendezvous service for pairing and group invites | `http://localhost:8787` |
| `CONE_OUTPUT` | CLI output mode, `json` or `plain` (the `--json`/`--plain` flags beat it) | `json` |
| `CONE_AGENT_NAME` | The example agent's `@alias` | `concierge` |
| `VITE_CONE_RENDEZVOUS_URL` | PWA rendezvous URL — read by Vite at **build** time, not runtime | `http://localhost:8787` |

Durable per-user settings — the remembered secret, `readReceipts`, `groupAutoAllow` — live in `config.json` (under `CONE_HOME` when set); the PWA keeps its equivalents in browser storage per account. Product decisions with protocol weight (the production-network default, rendezvous room TTLs and caps) are deliberately code, not configuration.

`.env.example` documents the recommended repo-local development overrides (`CONE_HOME=./.cone`, `XMTP_ENV=dev`); copy it to `.env` to keep repo hacking isolated from your real account.

## Repository layout

- `packages/core` contains secret-key derivation, contacts, pairing protocol, consent (trust boundary) logic, storage interfaces, the shared Cone client, and the SDK-agnostic XMTP adapter core (`@cone/core/xmtp`).
- `packages/cli` contains the `cone` command and Bun SQLite persistence.
- `packages/xmtp-node` wires the XMTP Node SDK into the shared adapter core for CLI and agent use.
- `packages/xmtp-browser` wires the XMTP Browser SDK into the shared adapter core and provides encrypted IndexedDB persistence.
- `apps/web` is the PWA built with Vite, Preact, and Bun.
- `apps/rendezvous` is the ephemeral handshake-code service.
- `examples/agent` shows a minimal long-running agent process.

## Developing

```sh
bun test                 # unit tests
bun run typecheck
bun run test:live:xmtp   # live dev-network integration (5 actors; starts rendezvous itself)
bun run dev:web          # PWA dev server
bun run dev:rendezvous   # rendezvous worker (wrangler dev)
bun run build            # deployables only: PWA static bundle + rendezvous worker dry-run
```

Run the CLI from source without linking:

```sh
bun run packages/cli/src/bin.ts keygen
```

The PWA shares the CLI chat vocabulary and keys without copying its modality: there are no explicit select/talk modes in the browser — focus position is the mode. `1–5` switch sections (Chats, Contacts, Pair, Backup, Settings), `j/k` move through chats, `Enter` opens the selected chat (or starts a new message when none is selected), `n` starts a new message, `/` filters chats live, `?` opens an in-app help overlay, and `Esc` returns from typing to navigating. Transcript rows use the same `16:39 - Alice: hello` format as the CLI.

`cone chat` is mode-driven, not command-palette driven. The chat list is sorted by most recent activity and shows each chat's last message, relative time, and unread count — the same density and order as the PWA. In Chats, use `j/k` or arrows to move, `Enter` to talk, `n` for a structured new message, `r` to name the selected chat's peer (saves a contact), `c`/`p` to create or join a pairing code, `/` to filter chats as you type, `t` to toggle the Requests sub-surface, and `2` for contacts. In Contacts, use `a` add, `r` rename, `d` delete, `c` create pairing code, `p` join pairing code, and `1` for chats. Transcript rows use the same human format across CLI and web: `16:39 - Alice: hello`.

`bun run test:live:xmtp` runs a full integration against the XMTP dev network: it starts the rendezvous worker if needed, creates two isolated local CLI homes, pairs them, sends messages both directions, verifies the received message IDs, and writes state under `.cone/live-runs/`.
