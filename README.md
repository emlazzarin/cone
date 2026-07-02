# Cone

Cone is a Bun-first XMTP messaging product for humans, developers, and AI agents.

It has two primary surfaces:

- ConePWA — a static installable PWA for humans
- a CLI/library for agents and developers, whose terminal chat UI is ConeTUI (`cone chat`)

Both unlock the same XMTP-backed account from a portable `SECRET KEY`, can message XMTP-reachable identities, and maintain a local address book of contacts.

## Status

This repo has been reset around the full product architecture:

- `packages/core` contains secret-key derivation, contacts, pairing protocol, consent (trust boundary) logic, storage interfaces, the shared Cone client, and the SDK-agnostic XMTP adapter core (`@cone/core/xmtp`).
- `packages/cli` contains the `cone` command and Bun SQLite persistence.
- `packages/xmtp-node` wires the XMTP Node SDK into the shared adapter core for CLI and agent use.
- `packages/xmtp-browser` wires the XMTP Browser SDK into the shared adapter core and provides encrypted IndexedDB persistence.
- `apps/web` is the PWA built with Vite, Preact, and Bun.
- `apps/rendezvous` is the ephemeral handshake-code service.
- `examples/agent` shows a minimal long-running agent process.

## Install

Prerequisite: [Bun](https://bun.sh) 1.3+ (its installer puts `~/.bun/bin` on your PATH).

```sh
bun run setup
```

That installs workspace dependencies and links a global `cone` binary (`bun link` → `~/.bun/bin/cone`). There is no build step for the CLI — Bun runs the TypeScript directly.

First run:

```sh
cone keygen              # prints a SECRET KEY — save it; it IS your account
cone login --remember    # paste the key once
cone chat                # open the TUI
cone pair                # mint a code and wait; the other account enters it (PWA "Join code" or `cone pair <code>`)
```

Pairing and group invites go through the rendezvous service. Nothing is deployed yet, so for local use run it in another terminal:

```sh
bun run dev:rendezvous   # serves http://localhost:8787, the default CONE_RENDEZVOUS_URL
```

Plain messaging (`cone send`, `cone listen`, `cone chat`) talks to XMTP directly and needs no rendezvous.

`cone` works from any directory. One Bun quirk to know: running it *inside this repo* picks up the repo `.env` — with `CONE_HOME=./.cone` there, repo runs keep their state in `./.cone` (handy for development), while runs from anywhere else use `~/.config/cone` and `~/.local/share/cone`. Delete that line from `.env` if you want one identity everywhere. Uninstall the binary with `cd packages/cli && bun unlink`.

## Developing

```sh
bun test                 # unit tests
bun run typecheck
bun run test:live:xmtp   # live dev-network integration (5 actors; starts rendezvous itself)
bun run dev:web          # PWA dev server
bun run dev:rendezvous   # rendezvous worker (wrangler dev)
bun run build            # deployables only: PWA static bundle + rendezvous worker dry-run
```

The PWA shares the CLI chat vocabulary and keys without copying its modality: there are no explicit select/talk modes in the browser — focus position is the mode. `1–5` switch sections (Chats, Contacts, Pair, Backup, Settings), `j/k` move through chats, `Enter` opens the selected chat (or starts a new message when none is selected), `n` starts a new message, `/` filters chats live, `?` opens an in-app help overlay, and `Esc` returns from typing to navigating. Transcript rows use the same `16:39 - Alice: hello` format as the CLI.

Sending is fully optimistic on both surfaces: the message appears in the transcript the instant you press `Enter` and the composer clears. A successful send is silent — XMTP has no per-recipient "delivered" ack, so the meaningful signal is whether a message published to the network. Only a send that fails to publish is marked (`✗` "not delivered", in red), offering **retry or delete** (PWA: buttons; TUI: `Enter` retries, `Ctrl+X` deletes). The local read model is kept to published messages, so a failed send never later masquerades as delivered. Identities are labeled "XMTP inbox ID" where the distinction matters. Handshake codes expire after ten minutes, but the pairing they establish is permanent.

Unknown senders never land in your main inbox: they wait in a **Requests** sub-surface of Chats (see [Consent and Requests](#consent-and-requests)) until you accept or block them, and agents ignore them by default.

Group chats follow the same trust model. A group a **contact** adds you to lands straight in Chats ("allow contacts to add you to groups", on by default — `groupAutoAllow` in CLI config); a group a stranger adds you to is a Request; a group a **blocked** sender adds you to is silently discarded. Your block list follows you into groups: a denied sender's messages are dropped even inside groups you've accepted. Agents never auto-accept groups — explicit `cone requests accept` is the boundary. Joining a group never shows pre-join history (MLS forward secrecy), and invites never auto-create contacts.

Beyond direct adds, groups support **invite codes**: any member mints a single-use, 10-minute code (`v` in the TUI's group info, "Invite by code" in the PWA, `cone group invite`), the joiner enters it (`g` in the TUI, the Pair tab's "Join a group" card, `cone group join <code>`), and the inviter's client adds them directly over the same encrypted rendezvous used for pairing. Because the joiner asked, the group's welcome is auto-allowed — it never sits in Requests.

For invites that outlive a conversation, **invite links** (`--link`, `l` in the TUI, "Invite link" in the PWA) mint a `cone_gi_v1_…` capability token: anyone holding it is admitted the next time the minting account syncs — no process waits on either side. Links default to a single use and a week, and are revocable. The rendezvous service addresses rooms by a hash of the secret, so it can never decrypt what it relays.

Group management lives in **group info**: `i` on a group in the TUI, or the `group · N members` header button in the PWA. Members show with roles (the creator is the *owner* — XMTP's super admin); any member can add members and rename under the default policy, admins remove, owners manage roles. Promoting someone else to owner is how ownership transfers — an owner can't leave until another owner exists. **Leaving is visible to the group; blocking is silent** — both are offered, labeled honestly. Membership and rename events render as system lines in the transcript ("Alice added Bob"), and if you're removed (or leave), the chat stays readable but marked left.

Read receipts are on by default and toggleable (PWA Settings; `R` in the TUI chat). When on, a `cone.read.v1` control message is sent into a conversation when you read it, and a single `✓✓ Read` marker appears on the most recent of your messages the peer has read. The toggle is symmetric: turning it off stops sending receipts *and* hides peer read state — only failed sends are ever marked. Receipts are only sent for allowed conversations, so previewing a Request never acknowledges it. Receipts interoperate between Cone clients (they ride the same control-envelope channel as pairing confirmations).

Run the rendezvous worker locally:

```sh
bun run dev:rendezvous
```

Run the CLI from source:

```sh
bun run packages/cli/src/bin.ts keygen
```

## CLI

```sh
cone keygen
cone login --remember
cone whoami
cone inbox
cone inbox sync
cone inbox read <conversationId|contactName|inboxId>
cone requests
cone requests accept <conversationId|inboxId> [--save-as <name>]
cone requests block <conversationId|inboxId>
cone chat
cone send --to <inboxId|address|contactName> --text "hello"
cone group create --member <inboxId|address|contactName> [--member ...] [--name <name>] [--locked]
cone group info <conversationId|name>
cone group add <conversationId|name> --member <ref> [--member ...]
cone group remove <conversationId|name> --member <ref> [--member ...]
cone group rename <conversationId|name> --name <name>
cone group describe <conversationId|name> --text "..."
cone group promote <conversationId|name> --member <ref> [--super]
cone group demote <conversationId|name> --member <ref>
cone group invite <conversationId|name>        # mint a single-use code, wait, add the joiner
cone group invite <ref> --link [--max-uses <n>] [--ttl <duration>]  # async token; joiners admitted on your next sync
cone group join <code|token> [--share-name <name>]   # request to join; the welcome auto-allows
cone group joins [cancel <conversationId>]     # pending joins awaiting their welcome
cone group links [revoke <linkId>]             # async invite links this account minted
cone group send <conversationId|name> --text "hello"
cone group leave <conversationId|name>
cone listen
cone contacts list
cone contacts add --name <name> --identity <inboxId|address>
cone pair
cone pair <code> [--share-name <name>] [--save-as <contactName>]
cone backup export --out backup.cone
cone backup import --in backup.cone
```

The CLI reads `CONE_SECRET_KEY`, `cone login --remember`, or command-level `--secret-stdin`.

For automation, pipe the key instead of using the interactive prompt:

```sh
printf '%s\n' "$CONE_SECRET_KEY" | cone login --secret-stdin --remember
```

The `SECRET_KEY` determines the XMTP account/inbox. The CLI stores one remembered secret and one local state database by default. Use `CONE_HOME` or exact `CONE_STATE_PATH`/`CONE_CONFIG_PATH` overrides only when you need isolated local state for tests or multiple concurrent agent processes.

Pairing names are explicit. `--share-name` proposes a peer-visible contact name during pairing. `--save-as` saves the peer under a local contact name. Contact names are local aliases and are not global usernames.

Set `CONE_HOME=./.cone` to keep config and state in a local ignored directory while testing. Use `--plain` for human-readable output; JSON is the default for agent-friendly structured output.

`cone inbox sync` pulls account-level XMTP state into the local encrypted read model. `cone inbox` lists local conversations (allowed senders only) and `cone inbox read <target>` reads a local transcript. `cone chat` opens the lightweight terminal chat client over the same local read model; use `cone chat --plain-log` for a non-interactive stream log.

`cone chat` is mode-driven, not command-palette driven. The chat list is sorted by most recent activity and shows each chat's last message, relative time, and unread count — the same density and order as the PWA. In Chats, use `j/k` or arrows to move, `Enter` to talk, `n` for a structured new message, `r` to name the selected chat's peer (saves a contact), `c`/`p` to create or join a pairing code, `/` to filter chats as you type, `t` to toggle the Requests sub-surface, and `2` for contacts. In Contacts, use `a` add, `r` rename, `d` delete, `c` create pairing code, `p` join pairing code, and `1` for chats. Transcript rows use the same human format across CLI and web: `16:39 - Alice: hello`.

## Secret Keys

Cone secret keys look like:

```text
cone_sk_v1_<payload>
```

The key is a 32-byte root secret with version and checksum metadata. Cone deterministically derives:

- XMTP wallet private key
- XMTP local DB encryption key for non-browser SDKs
- Cone storage encryption key
- Cone backup archive key

## Pairing

Handshake-code pairing is for cases where two sides want to opt in without exchanging identifiers first.

The rendezvous service stores encrypted offers for a short time. It does not relay application messages. Offers are encrypted with a key derived from the handshake code itself — the only secret both sides share before they know each other. After both sides decrypt each other locally, they confirm over XMTP and save each other as contacts.

## Consent and Requests

Cone uses XMTP consent as its anti-spam and trust boundary, and defaults to strict. Your main inbox shows only people you've allowed. A message from someone unknown becomes a **Request** rather than an inbox conversation, and never an address-book entry — Requests live in a sub-surface of Chats (the `Requests` tab in the PWA, `t` in the TUI, `cone requests` on the CLI) where you can preview, **Accept** (moves them to your inbox, optionally saving a named contact), or **Block**. Blocking denies the peer's inbox, so they can't return with a new conversation; unblock from PWA Settings (or `cone requests accept`).

Consent is implied by intent: pairing, sending an outbound message, accepting a request, and manually adding a contact all mark the peer allowed. Decisions apply locally first (so the UI is correct even offline) and propagate to XMTP best-effort, reconciling on the next sync.

The strictness is sharpest for agents: `cone listen`, the example agent, and `client.streamMessages()` default to **allowed senders only**, so an unknown sender can never trigger an agent's workflows, tools, or responses. Unknown messages are reachable only through the explicit Requests surface — accepting consent is the boundary before any agent behavior runs. Read receipts are only sent for allowed conversations, so previewing a Request never tells the sender you saw it.

## Address Book

Contacts are local aliases. A contact stores:

- display name
- canonical XMTP inbox ID
- optional EVM address
- source: `manual`, `paired`, or `self` (a contact is created only when you add, pair, or accept someone — never automatically from an unknown inbound message)

Names are not global usernames and do not affect XMTP identity.

## Live XMTP Test

Run a full local integration against the XMTP dev network:

```sh
bun run test:live:xmtp
```

The script starts the rendezvous worker if needed, creates two isolated local CLI homes, pairs them, sends messages both directions, verifies the received message IDs, and writes state under `.cone/live-runs/`.
