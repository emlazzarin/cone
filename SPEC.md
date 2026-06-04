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

## CLI Identity Selection

The CLI supports `--id <localId>` and `COS_ID` as local selectors for config and state. An id is not a network username and is not part of XMTP identity. The cryptographic account is still determined by the `SECRET KEY`.

When `COS_HOME` is set, id-scoped config and state are stored under that directory for local tests and agent runs. Exact `COS_STATE_PATH` and `COS_CONFIG_PATH` overrides still take precedence.

CLI output is JSON by default for agent use. `--plain` switches supported commands to human-readable output.

## Pairing

Handshake-code pairing is ephemeral and opt-in. Two participants enter the same high-entropy code. Each posts an encrypted offer to the rendezvous service. Once both offers exist, clients decrypt locally, confirm over XMTP, and save each other as contacts. The rendezvous service caps rooms at two participants and expires offers after 10 minutes.

`pair join --name <name>` sends a proposed contact name to the peer. If `--name` is omitted, the CLI uses `--id` as the proposed name. This is only a local address-book suggestion for the recipient, not a globally registered alias.

## Persistence

The CLI uses `bun:sqlite`. Message payloads are encrypted before persistence. The PWA uses IndexedDB and stores the full Cone snapshot encrypted with the derived storage key. Browser XMTP storage is treated as separate because XMTP does not use `dbEncryptionKey` for browser DB encryption.

## Tests

Tests cover deterministic key derivation, secret validation, contact behavior, encrypted storage, pairing encryption, wrong-code failures, room capacity, CLI command behavior, and adapter contracts with mocks.

`bun run test:live:xmtp` runs a live XMTP dev-network integration: start/reuse rendezvous, create two id-scoped CLI accounts, pair them, send both directions, and verify received message IDs and sender inbox IDs.
