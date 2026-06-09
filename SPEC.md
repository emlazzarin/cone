# Cone of Silence Product Spec

Cone of Silence is a Bun-first TypeScript product with a static PWA and a CLI/library. Both unlock the same XMTP account from a long `SECRET KEY`, can message any XMTP-reachable identity, save local address-book entries, and pair with an ephemeral handshake code.

## Architecture

- `packages/core`: shared product model, secret parsing, deterministic key derivation, contact/address-book logic, backup encryption, pairing encryption, storage interfaces, and the adapter-facing `ConeClient`.
- `packages/cli`: `cos` binary, Bun SQLite persistence, command parsing, HTTP rendezvous client.
- `packages/xmtp-node`: XMTP Node SDK adapter for CLI and agent use.
- `packages/xmtp-browser`: XMTP Browser SDK adapter and encrypted IndexedDB store for the PWA.
- `apps/web`: Vite + Preact PWA.
- `apps/rendezvous`: Cloudflare Worker/Durable Object rendezvous service.

## Secret Model

`SECRET KEY` format is `cos_sk_v1_<base64url-payload>`. It contains a 32-byte random seed, a version byte, and checksum metadata. The seed derives labeled keys for XMTP wallet signing, XMTP local DB encryption, Cone storage encryption, backup archives, and pairing.

## Messaging

Cone resolves identities through the configured XMTP adapter. v1 supports inbox IDs and EVM addresses. Address-book names are local aliases that resolve to canonical inbox IDs. Before sending, Cone asks the adapter whether the resolved identity is messageable.

`client.sync()` is the explicit account-level network refresh. It asks the XMTP adapter to sync conversations/messages, persists conversations and encrypted message snapshots into Cone storage, and records sync metadata. `client.listConversations()` and `client.listMessages()` are local read-model calls.

## CLI Account And State

The CLI has no local selector. The cryptographic account is determined by the `SECRET KEY`, with the default derived account label currently fixed to `main`.

By default, the CLI uses one remembered secret and one local state database. `COS_HOME` can isolate config and state under a directory for tests and concurrent agent runs. Exact `COS_STATE_PATH` and `COS_CONFIG_PATH` overrides still take precedence.

CLI output is JSON by default for agent use. `--plain` switches supported commands to human-readable output.

`cos inbox sync`, `cos inbox`, and `cos inbox read <conversationId|contactName|inboxId>` provide non-TUI validation surfaces for the local inbox read model. `cos chat` opens a lightweight terminal UI with four primary modes: `Chat(select)`, `Chat(talk)`, `Contacts(select)`, and `Contacts(edit)`. `Chat(select)` also exposes `n` for a structured new-message form with contact/conversation suggestions. Contacts expose explicit pairing actions: `c` creates a code and `p` joins a code.

## Pairing

Handshake-code pairing is ephemeral and opt-in. Two participants enter the same high-entropy code. Each posts an encrypted offer to the rendezvous service. Once both offers exist, clients decrypt locally, confirm over XMTP, and save each other as contacts. The rendezvous service caps rooms at two participants and expires offers after 10 minutes.

`cos pair <code> --share-name <name>` sends an optional peer-visible proposed contact name. `cos pair <code> --save-as <contactName>` saves the peer under a local contact name. Cone never sends local state selectors as identity hints.

## Persistence

The CLI uses `bun:sqlite`. Conversation rows, sync metadata, processed message IDs, contacts, and encrypted message payloads are persisted locally. The PWA uses IndexedDB and stores the full Cone snapshot encrypted with the derived storage key. Browser XMTP storage is treated as separate because XMTP does not use `dbEncryptionKey` for browser DB encryption.

## Tests

Tests cover deterministic key derivation, secret validation, contact behavior, encrypted storage, pairing encryption, wrong-code failures, room capacity, CLI command behavior, and adapter contracts with mocks.

`bun run test:live:xmtp` runs a live XMTP dev-network integration: start/reuse rendezvous, create two isolated CLI homes, pair them, send both directions, and verify received message IDs and sender inbox IDs.
