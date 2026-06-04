# Cone of Silence

Cone of Silence is a Bun-first XMTP messaging product for humans, developers, and AI agents.

It has two primary surfaces:

- a static installable PWA for humans
- a CLI/library for agents and developers

Both unlock the same XMTP-backed account from a portable `SECRET KEY`, can message XMTP-reachable identities, and maintain a local address book of contacts.

## Status

This repo has been reset around the full product architecture:

- `packages/core` contains secret-key derivation, contacts, pairing protocol, storage interfaces, and the shared Cone client.
- `packages/cli` contains the `cos` command and Bun SQLite persistence.
- `packages/xmtp-node` adapts the XMTP Node SDK for CLI and agent use.
- `packages/xmtp-browser` adapts the XMTP Browser SDK and provides encrypted IndexedDB persistence.
- `apps/web` is the PWA built with Vite, Preact, and Bun.
- `apps/rendezvous` is the ephemeral handshake-code service.
- `examples/agent` shows a minimal long-running agent process.

## Install

```sh
bun install
```

## Commands

```sh
bun run typecheck
bun test
bun run test:live:xmtp
bun run build
```

Run the PWA locally:

```sh
bun run dev:web
```

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
cos keygen
cos --id alice login --secret-stdin --remember
cos --id alice whoami
cos --id alice send --to <inboxId|address|contactName> --text "hello"
cos --id alice listen
cos contacts list
cos contacts add --name <name> --identity <inboxId|address>
cos pair new
cos --id alice pair join <code>
cos backup export --out backup.cos
cos backup import --in backup.cos
```

The CLI reads `COS_SECRET_KEY`, `cos login --secret-stdin --remember`, or command-level `--secret-stdin`.

`--id <localId>` selects local config and state. It is not a global username. If `--name` is omitted during pairing, the CLI id is used as the proposed contact name for the peer.

Set `COS_HOME=./.cone` to keep id-scoped config and state in a local ignored directory while testing. Use `--plain` for human-readable output; JSON is the default for agent-friendly structured output.

## Secret Keys

Cone secret keys look like:

```text
cos_sk_v1_<payload>
```

The key is a 32-byte root secret with version and checksum metadata. Cone deterministically derives:

- XMTP wallet private key
- XMTP local DB encryption key for non-browser SDKs
- Cone storage encryption key
- Cone backup archive key
- pairing encryption key

## Pairing

Handshake-code pairing is for cases where two sides want to opt in without exchanging identifiers first.

The rendezvous service stores encrypted offers for a short time. It does not relay application messages. After both sides decrypt each other locally, they confirm over XMTP and save each other as contacts.

## Address Book

Contacts are local aliases. A contact stores:

- display name
- canonical XMTP inbox ID
- optional EVM address
- optional notes
- source: `manual`, `paired`, `inbound`, or `self`

Names are not global usernames and do not affect XMTP identity.

## Live XMTP Test

Run a full local integration against the XMTP dev network:

```sh
bun run test:live:xmtp
```

The script starts the rendezvous worker if needed, creates two local ids, pairs them, sends messages both directions, verifies the received message IDs, and writes state under `.cone/live-runs/`.
