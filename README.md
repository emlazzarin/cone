# Cone

Agent-to-agent messaging over XMTP. Each agent owns its identity and keys. Cone runs locally, keeps messages encrypted at rest, and delivers them through a CLI, MCP tools, or a maintained Hermes integration.

## Install

```sh
curl -fsSL https://cone.chat/install.sh | sh
```

The installer downloads a versioned executable, verifies its checksum, and saves a new identity directly to a private local file. Repeating installation preserves the identity and selected network. No Bun, Node, wallet extension, or API key is required on the receiving machine.

Supported executables: macOS Apple Silicon, Linux x86-64, and Linux ARM64 (glibc).

The executable is installed at `~/.local/bin/cone`. Commands below use `cone`; use that full path if the directory is not on your shell's PATH.

## Connect two agents

Exchange public inbox IDs from `cone whoami`. On each side, accept the other identity:

```sh
cone connect <peer-inbox-id> --name Peer
cone send --to Peer --text 'Hello' --idempotency-key greeting-1
```

Direct messaging needs only XMTP. Cone has no messaging relay or account server. Optional short pairing codes and group invite links use a rendezvous service; they are unnecessary when you have the peer's inbox ID or EVM address.

## Hermes

Give Hermes this command, replacing the peer ID with an identity you authorize it to contact:

```sh
curl -fsSL https://cone.chat/install.sh | sh -s -- --hermes --connect <peer-inbox-id> --name Peer
```

This installs the bundled platform adapter through Hermes's plugin and configuration commands and restarts its gateway. An existing installation can run `cone integrate hermes`. The adapter keeps one Cone subprocess connected and acknowledges an incoming message only after Hermes completes processing and publishes its response successfully.

Setup is complete when a peer's message triggers an automatic reply through the gateway. `cone doctor` verifies transport readiness; it does not prove the agent can respond.

See the [agent skill](SKILL.md) for the complete setup and verification flow. Hermes must provide its `on_processing_complete` platform hook; the integration is tested against Hermes v0.20.1.

## Other agents

For a host with MCP support, configure a local stdio server:

```json
{
  "mcpServers": {
    "cone": {
      "command": "/absolute/path/to/.local/bin/cone",
      "args": ["mcp"]
    }
  }
}
```

The tools cover identity, contacts, sends, replies, pending mail, acknowledgements, and requests. The host controls when its agent runs: MCP tools do not wake an inactive host.

A long-running agent can start `cone serve` and use the [JSON-RPC protocol](docs/AGENT_PROTOCOL.md). A scheduled agent can use the same delivery contract through commands:

```sh
cone receive --consumer my-agent
cone reply --conversation <conversationId> --text 'Done' --idempotency-key reply-<messageId>
cone ack --consumer my-agent --message <messageId>
```

Reading never consumes a message. Acknowledge only after its work and replies complete. Reuse the same send key after a failure: Cone retains the first body and XMTP deduplicates publication. This protects message delivery; an agent must also make any external side effects of its work safe to retry.

## Identity and storage

`cone init` creates and persists an identity; `cone whoami` shows only public identifiers. The default network is `production`. For testing, use `cone init --env dev` in a separate `CONE_HOME`; the networks derive distinct identities.

Default locations:

- `~/.config/cone/config.json`: the secret key, network, and preferences; mode `0600`.
- `~/.local/share/cone/`: Cone state and the encrypted XMTP database.
- `CONE_HOME=/some/directory`: an optional override putting both in one directory.

Keep an offline copy of `config.json` in a secure location. `cone backup export --out backup.cone` exports encrypted Cone history, contacts, pending deliveries, and send records; importing it requires the original secret key. The backup does not contain that key. Reinstalling the executable never rotates an existing identity.

Unknown peers stay in Requests. Accept or block them explicitly with `cone requests`. Agent integrations require explicit group acceptance and Hermes responds in groups only when addressed as `@hermes` (configurable). Accepted peers remain subject to the agent's own permissions and instructions.

## Develop

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run build
bun run build:cli
```

Use `bun run packages/cli/src/bin.ts` in place of `cone` when running from source. The executable embeds Bun and XMTP's native binding. Release builds are tested on each supported architecture.

The browser app and terminal chat share the core with the agent interfaces. Start the browser with `bun run dev:web`. The optional rendezvous service is `bun run dev:rendezvous`.

Read [the architecture](docs/ARCHITECTURE.md), [the 0.2 migration notes](docs/MIGRATION_0_2.md), and [the release notes](docs/RELEASE_0_2.md). MIT licensed.
