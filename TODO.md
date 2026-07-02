# TODO

## Agent readiness (planned for 2026-06-13)

Goal metric for the whole batch: **a stranger agent handed only a SKILL.md URL goes from nothing installed → key generated → verified ping-pong message exchange in under two minutes, unattended.** Every item below serves that metric or the agent-to-agent network thesis.

### 1. Distribution / time-to-first-message

- [ ] **Publish the CLI to npm** so `bunx <package> keygen` works with no clone. Blockers to resolve:
  - `@cone/cli` `bin` currently points at TS source (`./src/bin.ts`) — fine under Bun, breaks for Node consumers. Either add a build step that emits JS for the published package, or declare Bun as an explicit runtime requirement (`engines`, README, and a clear error if run under Node).
  - All workspace packages are unpublished (`@cone/core`, `@cone/xmtp-node` are `workspace:*` deps) — they need real published versions or the CLI must be bundled into a single publishable artifact.
  - Public name is settled (Cone; `cone` binary, `cone_sk_v1_` secrets) — decide only the npm package name (`cone` may be taken; `@cone/cli`?).
- [ ] **Single-file compiled binaries** as an alternative install path: `bun build --compile` per platform (macOS arm64/x64, Linux arm64/x64), attached to GitHub releases, with a curl-able install script. Agents without Bun or npm can still get a working `cone`.
- [ ] **Fix the nightly XMTP pin before publishing** (see the standing item under "Pre-existing" below — it is a hard blocker for this section). A fresh `bun install` resolving a different nightly months from now is exactly the failure mode that strands an unattended agent. If stable is still broken on macOS arm64, pin an exact known-good nightly version (`=6.1.0-nightly.X`, not a range) and/or vendor the bindings.
- [ ] **Host SKILL.md at a stable URL and rewrite it to be fully self-contained from zero.** Today it assumes the repo is already cloned and invokes `bun run packages/cli/src/bin.ts ...`. The rewrite should walk: install (one `bunx`/curl command) → `keygen` → `login --secret-stdin` → verify with the echo bot (see §4) → pair/send/listen → consent recipes. Include the exact JSON output shape for every command (agents write parsers against the examples), exit-code semantics, and two operating recipes: a heartbeat/polling loop for turn-based agents and a long-running `listen` daemon for persistent agents.

### 2. Poll-shaped read model for turn-based agents

Most agent harnesses wake → check → respond → sleep; they cannot hold a blocking stream. `cone listen --once` only catches messages that arrive *while streaming* — a message that arrived while the agent was asleep is only reachable via sync. The store already tracks `unreadCount`/`lastReadAt` per conversation (`packages/core/src/client.ts:477`) but the CLI never surfaces them.

- [ ] **`cone messages --since <cursor>`** (or `cone inbox unread`): runs `sync`, returns all new allowed-sender messages since the cursor as JSON plus a new opaque cursor value, exits. Cursor should be durable (store it in the state DB keyed by a caller-supplied name, e.g. `--cursor-name agent-main`) so a crashed agent never loses its place.
- [ ] **Distinct exit code for "no new messages"** (e.g. exit 0 = new messages in payload, exit 3 = nothing new, exit 1 = error) so shell loops are one-liners without JSON parsing.
- [ ] **`cone wait [--timeout-ms <ms>]`**: sync first (drain anything missed while asleep), then block until at least one new allowed message arrives, print it/them as JSON, exit. This is the single primitive that makes heartbeat loops, cron jobs, and harness hooks trivial. Timeout exit should use the "nothing new" exit code, not an error.
- [ ] Surface `unreadCount`/`lastReadAt` in `cone inbox` JSON output.

### 3. Structured agent-to-agent payloads (expose what core already has)

`client.sendJson` and the `cone.app.json.v1` envelope already exist (`packages/core/src/client.ts:113`, `packages/core/src/envelope.ts:5`) but are not reachable from the CLI and not documented in the skill. This is the substrate for agent↔agent RPC.

- [ ] **`cone send --to <peer> --json '<payload>'`** wired to `client.sendJson`. Mutually exclusive with `--text`.
- [ ] **Decode envelopes on the read side**: `cone listen`, `cone wait`, `cone messages`, and `cone inbox read` should surface a parsed `json` field alongside `text` when the message is a `cone.app.json.v1` envelope, so consumers never hand-parse the wrapper.
- [ ] **`replyTo` correlation**: optional `--reply-to <messageId>` on send, carried in the envelope and surfaced on the read side. With this, request/response patterns between agents work over plain async messaging.
- [ ] **Idempotency key on send**: optional `--idempotency-key <key>`; the client records sent keys in the state DB and short-circuits a duplicate send (returning the original `messageId`). A crashed agent retrying "transfer $5" must not double-send.
- [ ] Deliberately do **not** spec payload schemas beyond the envelope — agents negotiate their own. Envelope + correlation + idempotency only.

### 4. Make the happy path real off this machine

- [ ] **Host the rendezvous worker** (it is already a Cloudflare Worker in `apps/rendezvous`) and change the default URL — `defaultRendezvousUrl()` currently falls back to `http://localhost:8787` (`packages/cli/src/paths.ts:25`), so pairing is impossible for anyone following the skill on a clean machine.
- [ ] **Make the XMTP env choice explicit.** The default is `dev` (`readEnv()` in `packages/cli/src/index.ts`), so agents following the skill silently land on the dev network. Decide the default for published builds (probably `production`), document it in SKILL.md, and make `whoami` output prominent about which env you're on.
- [ ] **`cone doctor`**: JSON health check an agent runs first when anything fails — secret key present/valid, XMTP network reachable on the configured env, rendezvous reachable, state DB openable/lock status, package version, env summary. Each check `{ name, ok, detail }`.
- [ ] **Hosted echo bot**: a tiny always-on agent (the `examples/agent` process, hosted anywhere cheap) with a well-known address published in SKILL.md. Skill instructs: send `ping`, expect `pong` — verifies key derivation, network, consent, send, and receive end-to-end before the agent's first real correspondent. Also doubles as the network's "hello world."
- [ ] **Structured errors**: errors currently print free text to stderr with exit 1 (`runCli` catch block, `packages/cli/src/index.ts:172`). In `--json` mode, emit `{"error": {"code": "...", "message": "..."}}` with stable machine-readable codes (e.g. `NO_SECRET`, `NOT_MESSAGEABLE`, `CONSENT_DENIED`, `PAIR_CODE_EXPIRED`, `NETWORK_UNREACHABLE`). Agents parse errors; free text forces them to guess.
- [ ] **Document (and test) SQLite concurrency**: agents *will* run `cone listen` in one process and `cone send` in another against the same `CONE_HOME`. Establish whether that's safe today (Bun SQLite + the XMTP node DB), fix or fence what isn't, and state the rules in SKILL.md — including when to use separate `CONE_HOME`s.

### 5. Two more integration surfaces

- [ ] **MCP server — `cone mcp` (stdio)**: thin wrapper over the existing `ConeClient` exposing tools: `whoami`, `send` (text + json + replyTo), `check_messages` (the §2 cursor poll), `list_requests`, `accept_request`, `block_request`, `pair_create`, `pair_join`, `list_contacts`, `doctor`. With the skill covering CLI-driving agents and MCP covering tool-mounting agents, both integration styles are served. Roughly a day of work; the client API already has everything.
- [ ] **Published in-process library for "light local process" agents**: `examples/agent` currently reaches across packages with relative imports (`../../../packages/cli/src/config`) — that path is the smell. Extract a published `@cone/agent` (or add `createNodeClient` to `@cone/xmtp-node`) with the ~8-method surface: `identity`, `sendText`, `sendJson`, `streamMessages`, `sync`, requests (list/accept/block), `pair`, `setConsent`. Rewrite `examples/agent` to be ~10 lines with a single import from the published package.

### 6. Agent-network thesis

- [ ] **Market the consent boundary as a prompt-injection firewall.** The allowed-only stream means an unknown sender's text can never reach an agent's context — a security property no webhook or shared Slack channel offers, and it's already built. Say this explicitly in README and SKILL.md; it's the differentiator vs. "just use XMTP directly."
- [ ] **`cone whoami --card`**: a stable, shareable identity blob (e.g. `xmtp:<inboxId>` plus optional self-described capabilities) that an agent can paste into a README, website, or registry so other agents can initiate contact without a pairing code (landing in Requests, gated by consent as usual). This is the eventual discovery/growth loop; keep v1 minimal.
- [x] Group chat is done and is the multi-agent room primitive (respond-when-addressed convention + strict group consent keep multi-agent rooms loop-free; see SPEC "Groups → Agents").

## Pre-existing

- [ ] replace the temporary XMTP nightly Node dependencies with stable releases once XMTP publishes a fixed stable macOS arm64 `@xmtp/node-bindings` package. The stable `@xmtp/node-sdk@6.0.0` currently pulls `@xmtp/node-bindings@1.10.0`, whose published macOS arm64 binary is linked to a machine-specific Nix `libiconv` path. Cone currently requires `@xmtp/node-sdk >=6.1.0-nightly <6.2.0` so Bun does not resolve back to the broken stable SDK.
- [ ] an agentic skill of how to install and use this easily for agents themselves to use (covered by §1 "Host SKILL.md…" above)
- [x] group chat functionality — complete 2026-07-02: core model, admin & surfaces, invite codes, invite links + rendezvous v2, agent kit (SPEC "Groups"; deliberately deferred pieces — knock links, in-group secret distribution — documented with reasoning in SCRATCHPAD.md)
- [ ] self-profile / share-card: volunteer profile info (name, …) offered as save-suggestions on pair / request-accept / group-join — easy mutual address-book saves without auto-save (spun off from groups design; relates to "Context box/aliases/names" below)
- [ ] add how this works/explainer + Github link
- [x] new name — **Cone** (2026-07-01): binary `cone`, `CONE_*` env, `cone_sk_v1_` secrets, `cone.*` control types
- [ ] feature to sync data between versions of app? Send encrypted data to yourself style transfer. The use of the history feature?
- [x] adopt use of "consent" or anti-spam
- [ ] Skill so you can make your own version of the app with the same secret key and data store
- [ ] Favicon and Icon (use a yellow triange in comms and the TUI app)
- [ ] Standardize data store across app versions and then allow for data store sync across app instances?
- [ ] Minify/make data store efficient?
- [ ] Should we make it possible to export your derived XMTP key (if that even makes sense)?
- [ ] What clever uses of XMTP-specific features can we use?
- [x] Support disappearing messages (XMTP-native settings; `cone timer`, TUI `e`, PWA ⌛ — see SPEC)
- [ ] Context box/aliases/names/usernames/namespace
- [ ] add Delivered to support Read (?)
- [ ] demo video involving an agent

Way Later

- [ ] make Github publishable/squash history
- [ ] hosting the site somewhere
- [ ] jokey version with (iMessage-style bubble)
