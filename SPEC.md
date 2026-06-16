# Cone of Silence Product Spec

Cone of Silence is a Bun-first TypeScript product with a static PWA and a CLI/library. Both unlock the same XMTP account from a long `SECRET KEY`, can message any XMTP-reachable identity, save local address-book entries, and pair with an ephemeral handshake code.

## Architecture

- `packages/core`: shared product model, secret parsing, deterministic key derivation, contact/address-book logic, backup encryption, pairing encryption, storage interfaces, the adapter-facing `ConeClient`, and the SDK-agnostic XMTP adapter implementation (`@cone/core/xmtp`) that both adapter packages reuse.
- `packages/cli`: `cos` binary, Bun SQLite persistence, command parsing.
- `packages/xmtp-node`: XMTP Node SDK wiring (client creation, signer) for CLI and agent use.
- `packages/xmtp-browser`: XMTP Browser SDK wiring and encrypted IndexedDB store for the PWA.
- `apps/web`: Vite + Preact PWA.
- `apps/rendezvous`: Cloudflare Worker/Durable Object rendezvous service.

## Secret Model

`SECRET KEY` format is `cos_sk_v1_<base64url-payload>`. It contains a 32-byte random seed, a version byte, and checksum metadata. The seed derives labeled keys for XMTP wallet signing, XMTP local DB encryption, Cone storage encryption, and backup archives. Pairing-offer encryption is keyed by the normalized handshake code alone — the peer cannot know any account-derived secret before pairing completes.

## Messaging

Cone resolves identities through the configured XMTP adapter. v1 supports inbox IDs and EVM addresses. Address-book names are local aliases that resolve to canonical inbox IDs. Before sending, Cone asks the adapter whether the resolved identity is messageable.

`client.sync()` is the explicit account-level network refresh. It asks the XMTP adapter to sync conversations/messages, persists conversations and encrypted message snapshots into Cone storage, and records sync metadata. `client.listConversations()` and `client.listMessages()` are local read-model calls.

## CLI Account And State

The CLI has no local selector. The cryptographic account is determined by the `SECRET KEY`, with the default derived account label currently fixed to `main`.

By default, the CLI uses one remembered secret and one local state database. `COS_HOME` can isolate config and state under a directory for tests and concurrent agent runs. Exact `COS_STATE_PATH` and `COS_CONFIG_PATH` overrides still take precedence.

CLI output is JSON by default for agent use. `--plain` switches supported commands to human-readable output.

`cos inbox sync`, `cos inbox`, and `cos inbox read <conversationId|contactName|inboxId>` provide non-TUI validation surfaces for the local inbox read model; `cos inbox` lists `allowed` conversations only and notes any pending request count. `cos requests` is the explicit Requests surface: `cos requests [list]` lists unknown senders (`--denied` lists blocked ones), `cos requests accept <target> [--save-as <name>]` allows a sender (optionally saving a named contact), and `cos requests block <target>` denies the peer inbox. `cos listen` streams `allowed` senders only — the agent boundary. `cos chat` opens a lightweight terminal UI with four primary modes: `Chat(select)`, `Chat(talk)`, `Contacts(select)`, and `Contacts(edit)`. The chat list is sorted by most recent activity and shows last-message previews, relative times, and unread counts (shared formatting with the PWA via `@cone/core`). `Chat(select)` exposes `n` for a structured new-message form with contact/conversation suggestions, `r` to name the selected chat's peer (saves/renames a contact), `c`/`p` to create or join a pairing code (parity with the PWA Pair tab), `/` for a live chat filter, and `t` to toggle the Requests sub-surface (where `a` accepts and `b` blocks, blocking confirmed by a second press). Contacts also expose pairing: `c` creates a code and `p` joins a code. Active form fields show a cursor.

## PWA Interaction

The PWA is pointer- and touch-native with TUI-parity accelerators. It has no explicit select/talk modes; focus expresses the mode (typing in the composer vs. navigating). `1–5` switch sections (Chats, Contacts, Pair, Backup, Settings), `j/k` move the chat selection, `Enter` opens the selected chat (or starts a new message when none is selected), `n` composes a new message, `/` filters chats, `?` toggles a help overlay, `Esc` leaves typing. Conversation rows show avatar, last-message preview, relative time, and unread count; transcript lines share the CLI `HH:MM - sender: body` format. Read markers are stored locally per account. Within Chats, a Chats/Requests segmented toggle appears when there are pending requests (or the tab is open); the Requests sub-surface lists unknown senders with Accept/Block per row, and blocked senders are managed (unblock) from Settings. A Settings toggle hides the Requests tab entirely.

Both surfaces render outbound sends optimistically: the message is appended to the transcript and the composer clears before the network round-trip resolves. A delivered message is reconciled against the optimistic row (matched by body and a five-minute send-time window); a failed send is marked and offers retry or delete. Optimistic rows are local-only and never persisted.

## Delivery Status

XMTP exposes a sender-side delivery status (`DecodedMessage.deliveryStatus`: unpublished/published/failed) but no per-recipient delivery ack. The adapter sends synchronously — a resolved send is published; a rejection is a delivery failure surfaced to the optimistic UI. `SentMessage.deliveryStatus` carries the result. The adapter read paths (`listMessages`/`sync`/`streamMessages`) keep only published messages (`normalizeDeliveryStatus` handles the SDK's numeric enum and string forms), so a message that failed to publish cannot later sync in and appear delivered. Successful sends are silent; failures are the only visible state, with retry (resend) and delete (discard the optimistic row).

## Read Receipts

Read receipts are a Cone control message (`cos.read.v1`) sent into a conversation, riding the same envelope channel as pairing confirmations rather than the XMTP-native read-receipt content type — so they require no adapter changes and interoperate only between Cone clients. They are hidden from the transcript. When a conversation is viewed with read receipts enabled, the client sends one receipt acknowledging the newest inbound message, deduped so repeated views don't re-send. `latestReadOutboundId` derives, from the peer's most recent receipt, the single most recent outbound message at or before it; both surfaces show one `✓✓ Read` marker there. The marker is rendered inline in a reserved right-hand gutter on outbound rows (not as its own line), so it moves between messages without reflowing the transcript and never crowds wrapping text. The setting defaults on, persists per surface (PWA: localStorage per account; CLI: `readReceipts` in config), and is symmetric: when off, the client neither sends receipts nor shows peer read state (no gutter is reserved), and only failed sends are marked.

## Disappearing Messages

Disappearing messages ride XMTP's native conversation-level settings (`MessageDisappearingSettings { fromNs, inNs }`), not a Cone control message — so timers interoperate with other compliant XMTP clients and either DM participant can change them. The adapter exposes `getRetention`/`setRetention` and converts at the ns↔ms boundary; Cone models the setting as `MessageRetention { durationMs, fromAt }` mirrored on `ConeConversation.retention` with the same lifecycle as the consent mirror: mirror-first writes (`client.setRetention(conversationId, durationMs | null)` updates local state immediately, the network settings write is best-effort), reconciled from the network on every sync.

Expiry is **derived, never stored**: a message sent at or after `fromAt` disappears `durationMs` after its send time, computed from the conversation's *current* retention. Enabling a timer is forward-looking (earlier history never expires), and changing or removing the timer immediately re-derives the whole conversation — matching XMTP semantics. `ConeMessage.expiresAt` is computed at read time for UI use.

libxmtp's cleanup worker only deletes from the XMTP-level local DB; Cone's own encrypted snapshots are enforced separately. `listMessages` filters expired messages at view time (so they are never rendered, even between purges), and `client.purgeExpiredMessages()` deletes them from Cone storage — it runs during `sync()`, before `exportBackup()` (a backup never contains expired messages), and before any settings change (a message that already hit its timer is gone for good and cannot be resurrected by relaxing the timer). Purged messages keep their processed-message markers so a copy still lingering in the XMTP DB cannot re-ingest on the next sync.

Both surfaces share the preset vocabulary (off, 30s, 5m, 1h, 8h, 1d, 1w, 4w — Cone convention; XMTP itself takes any duration). Custom durations are first-class: the TUI accepts free text (`45m`, `6d`) and every surface displays a non-preset value as-is (the PWA select grows an extra option for it) rather than snapping it to a bucket. Durations format/parse via `formatRetention`/`parseRetention` (s/m/h/d/w units). CLI: `cos timer <target> [<duration|off>]` shows or sets; `cos inbox read` JSON carries `retention` and `expiresAt`. TUI: `e` in `Chat(select)` opens a one-field picker (Up/Down cycle presets), the thread header shows a `timer 1h` chip (ASCII — the hourglass glyph is double-width in many terminals), and an exact-expiry refresh drops rows the moment they expire. PWA: a `⌛` select in the chat header — `e` focuses it, and while focused `j/k` or arrows step a draft value, Enter applies, Esc leaves (pointer selection applies directly); a `⌛` chip marks conversation rows with an active timer, and the 8-second poll drops expired rows. Timer changes are announced via the status line; the persistent indicator is the header chip.

Because settings changes ride conversation metadata, not the message stream, every surface must sync to see a change made elsewhere: the TUI's 60-second auto-sync covers it, and the PWA syncs once at session start and every 60 seconds thereafter (its 8-second poll only re-reads local state).

Deletion is cooperative, not cryptographic: a peer on a client that does not honor the settings can retain anything. The setting is honest hygiene shared between compliant clients, and the UI copy says so.

## Consent

XMTP consent is Cone's anti-spam and trust boundary. Every conversation carries a consent state — `allowed`, `unknown`, or `denied` — mirrored locally on `ConeConversation.consentState` for fast, offline-capable UI and reconciled from the network on every sync. Consent is **peer-inbox-level**: blocking targets the inbox, so a denied sender cannot reappear with a fresh conversation.

The default is strict. Main chat surfaces show `allowed` only. Unknown inbound senders become **Requests** — a sub-surface of Chats on both apps (not a new top-level section) — and never an address-book entry; a contact is created only on accept. `denied` conversations are hidden from all normal lists, streams, and compose suggestions, and are managed from a blocked list (PWA Settings). Consent is implied by intent: a successful pairing, an outbound send, accepting a request, and manually adding a contact all mark the peer `allowed`. Accepting marks `allowed` (optionally saving a named contact in the same flow); blocking marks `denied`.

Writes are mirror-first: the local state updates immediately and the XMTP network consent write is best-effort, reconciled on the next sync. If the network write fails, the decision still holds locally (treated as local-only until it propagates). `client.sync()` pulls `allowed` + `unknown` (so Requests populate) and never `denied`. View-time filters (`isAllowedConversation` / `isRequestConversation` / `isDeniedConversation` in `@cone/core`) split the single read model; a conversation stored before consent existed is treated as `allowed` so upgrades never hide existing chats.

**Agent boundary.** `client.streamMessages` defaults to `allowed`-only — an unknown sender can never drive an agent's workflow, tools, or response generation. Human surfaces opt in to `['allowed', 'unknown']` so Requests update live; `cos listen` and the example agent keep the strict default. Unknown senders are visible only through the explicit Requests surface (`cos requests`); accepting consent is the boundary before any agent behavior runs. Read receipts are gated on `allowed`, so previewing a Request never acknowledges it to the sender.

Consent maps 1:1 to the XMTP SDK `ConsentState` enum at the adapter boundary (`@cone/core/xmtp`), via `setConsent`, `getConsent`, and consent-filtered stream/sync/list calls. Inbox-level consent covers DM peers; group conversations carry their own consent keyed by conversation id (XMTP `ConsentEntityType.GroupId`) — see Groups.

## Groups

Conversations carry `kind: 'dm' | 'group'` (rows stored before groups are DMs; readers branch on `kind === 'group'`). A group row mirrors the XMTP group's shared state: `groupName`/`groupDescription` (network metadata any member may edit under the default policy — unlike Cone's local contact aliases), `memberCount`, `addedByInboxId` (who added this account), and a cached member mirror `{ inboxId, level, consentState }` refreshed on sync for offline info panels. The adapter opens one message stream per conversation type so every delivered message is tagged with its kind — a group message can never be persisted as a DM-shaped conversation attributed to whoever spoke first. A group message streamed before any sync fetches the real group shape via `getGroupInfo` (placeholder row reconciled by the next sync if offline).

`createGroup` uses XMTP's default permission preset (any member adds members and edits metadata; admins remove members; the creator is the sole super admin) or `locked` (the `AdminOnly` preset). Members resolve through contacts/identities and are deduped (the creator is added by XMTP itself); **invites never auto-create contacts**. Sending into a group uses `sendToConversation` (DM rows route through the identity path so reachability and implied-consent semantics are unchanged). Membership and metadata changes arrive as XMTP `GroupUpdated` system messages, decoded into a `cos.group.update.v1` control envelope (initiator, added/removed/left inboxes, metadata field changes) — hidden from transcripts like all control messages, humanized in previews ("[Alice added Bob]"), with `formatGroupUpdate` providing attributed system lines for surfaces. A member leaves via `leaveGroup` (`requestRemoval`); a super admin must transfer the role first (XMTP forbids the last super admin leaving). New members cannot see pre-join history (MLS forward secrecy); groups cap at 250 members.

**Group consent.** Creating a group or sending into one implies group consent (mirror-first, like DMs). Being added by someone else arrives as `unknown` and is resolved by the group-add policy, applied idempotently at sync/welcome time:

- Added by a **blocked inbox** → silently denied: no Request row, no signal back. Cone does not auto-leave — leaving is visible to the group (`leftInboxes`), blocking must not be. This also closes the re-add loop: every new group is a fresh conversation id, so without it a blocked sender could generate Requests forever.
- Added by an **address-book contact** with the **"allow contacts to add you to groups"** toggle on (the default; CLI config `groupAutoAllow`) → auto-allowed, straight into Chats.
- Anyone else (or toggle off) → stays `unknown`, a **Request** alongside DM requests. Accept/block go through `setConversationConsent`, which targets the peer inbox for DMs and the group id for groups; `--save-as` contact saving is DM-only.

**The block list follows you into groups.** XMTP gates group delivery per conversation, not per sender, so an allowed group still delivers messages from inboxes this account has denied. Cone maintains the denied-inbox set in store metadata (updated by every Cone-side consent write) and drops those senders' group messages before the stream handler and out of `listMessages` — a denied sender can never reach an agent loop through a shared group. Accepting a group means trusting its membership policy for everyone else.

**Agents.** The agent boundary is unchanged and sharper: streams default to allowed-only, which for groups means *explicitly accepted groups only*. Agent processes construct their client with `autoAllowGroupsFromContacts: false` (the example agent does) so even a contact's group add waits for explicit `cos requests accept`. Read receipts stay DM-only — in a group they would broadcast to every member — so previewing a group Request acknowledges nothing.

CLI: `cos group create --member <ref> [--member ...] [--name] [--description] [--locked]`, `cos group info|add|send|leave <conversationId|name>`; groups flow through `cos inbox`, `cos inbox read`, and `cos requests` with their `kind`. TUI/PWA render groups in chat lists and transcripts (member-count badges, group-aware sends and accept/block); dedicated group management surfaces (info panel, member ops, invites) are the next phase, tracked in SCRATCHPAD-GROUPS.md.

## Pairing

Handshake-code pairing is ephemeral and opt-in. Two participants enter the same high-entropy code. Each posts an encrypted offer to the rendezvous service. Once both offers exist, clients decrypt locally, confirm over XMTP, and save each other as contacts. The rendezvous service caps rooms at two participants and expires offers after 10 minutes.

`cos pair <code> --share-name <name>` sends an optional peer-visible proposed contact name. `cos pair <code> --save-as <contactName>` saves the peer under a local contact name. Cone never sends local state selectors as identity hints.

## Persistence

The CLI uses `bun:sqlite`. Conversation rows (including the consent mirror), sync metadata, processed message IDs, contacts, and encrypted message payloads are persisted locally. The PWA uses IndexedDB and stores the full Cone snapshot encrypted with the derived storage key. Browser XMTP storage is treated as separate because XMTP does not use `dbEncryptionKey` for browser DB encryption.

## Tests

Tests cover deterministic key derivation, secret validation, contact behavior, encrypted storage, pairing encryption, wrong-code failures, room capacity, consent semantics (unknown inbound → Request not contact, implied consent on send, accept/block mirror updates, allowed-only stream default), the group-add policy matrix (contact auto-allow, toggle off, blocked-adder discard, unknown → Request), in-group denied-sender filtering, group-shaped row creation from streams, GroupUpdated decoding and system-line formatting, the CLI `requests` and `group` surfaces, the TUI Requests sub-surface, the SQLite peer-column migration, and adapter contracts with mocks.

`bun run test:live:xmtp` runs a live XMTP dev-network integration: start/reuse rendezvous, create three isolated CLI homes, pair two of them, send both directions, then exercise groups end-to-end — create with a contact and a stranger, verify the contact auto-allows on sync while the stranger gets a Request and accepts, fan one group message out to both over live streams, and check membership roles (creator = super admin).
