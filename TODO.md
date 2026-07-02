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

- [x] **`cone messages [--cursor-name <name>] [--peek]`** (2026-07-02): sync, then all new allowed inbound messages since the durable named cursor (`client.pollMessages`; cursors are opaque watermarks in the state DB).
- [x] **Exit code 3 = nothing new** (0 = new messages, 1 = error) on `messages` and `wait`.
- [x] **`cone wait [--timeout-ms <ms>]`** (2026-07-02): drains missed mail via the cursor, else blocks on the stream until one new allowed message arrives; control envelopes never wake it.
- [ ] Surface `unreadCount`/`lastReadAt` in `cone inbox` JSON output. (Rows serialize whole objects, so values appear when set; making them first-class output is still open.)

### 3. Structured agent-to-agent payloads (expose what core already has)

`client.sendJson` and the `cone.app.json.v1` envelope already exist (`packages/core/src/client.ts:113`, `packages/core/src/envelope.ts:5`) but are not reachable from the CLI and not documented in the skill. This is the substrate for agent↔agent RPC.

- [x] **`cone send --to <peer> --data '<json>'`** (2026-07-02; `--data` because `--json` is the global output flag) wired to `client.sendJson`, mutually exclusive with `--text`.
- [x] **Envelopes decoded on the read side**: `listen`/`wait`/`messages`/`inbox read` all carry the parsed `json` field (the envelope codec landed with protocol hardening).
- [x] **`--reply-to <messageId>`** correlation, carried in the app-JSON envelope (json sends only).
- [x] **`--idempotency-key <key>`**: recorded in the state DB (capped ledger); a duplicate send returns the original messageId with `deduplicated: true`.
- [x] No payload schemas beyond the envelope — agents negotiate their own.

### 4. Make the happy path real off this machine

- [ ] **Host the rendezvous worker** (it is already a Cloudflare Worker in `apps/rendezvous`) and change the default URL — `defaultRendezvousUrl()` currently falls back to `http://localhost:8787` (`packages/cli/src/paths.ts:25`), so pairing is impossible for anyone following the skill on a clean machine.
- [x] **XMTP env default is `production`** (protocol hardening, 2026-07-02): `dev`/`local` are explicit opt-ins, env is part of the key-derivation salt (separate identities per network), `whoami` prints the env, and `cone config` shows where the value came from.
- [x] **`cone doctor`** (2026-07-02): secret, state DB, rendezvous (`/v2/exchange` 400 probe), XMTP reachability — each `{ name, ok, detail }`, exit 0 only when all pass.
- [ ] **Hosted echo bot**: a tiny always-on agent (the `examples/agent` process, hosted anywhere cheap) with a well-known address published in SKILL.md. Skill instructs: send `ping`, expect `pong` — verifies key derivation, network, consent, send, and receive end-to-end before the agent's first real correspondent. Also doubles as the network's "hello world."
- [x] **Structured errors** (2026-07-02): JSON mode emits `{"error":{code,message}}` on stderr with stable codes (USAGE, NO_SECRET, BAD_SECRET, NOT_MESSAGEABLE, RENDEZVOUS_UNREACHABLE, SELF_PAIRING, TIMEOUT, NOT_A_MEMBER, NOT_FOUND, ERROR).
- [x] **SQLite concurrency** (2026-07-02): the Cone state DB runs in WAL with a 5s busy timeout (tested: two handles, interleaved writes); SKILL.md states the rules — same `CONE_HOME` listen+send is fine, fleets get one `CONE_HOME` (and one key) per agent. The XMTP node DB is libxmtp-managed; heavy multi-process use of one identity remains their domain.

### 5. Two more integration surfaces

- [ ] **MCP server — `cone mcp` (stdio)**: thin wrapper over the existing `ConeClient` exposing tools: `whoami`, `send` (text + json + replyTo), `check_messages` (the §2 cursor poll), `list_requests`, `accept_request`, `block_request`, `pair_create`, `pair_join`, `list_contacts`, `doctor`. With the skill covering CLI-driving agents and MCP covering tool-mounting agents, both integration styles are served. Roughly a day of work; the client API already has everything.
- [ ] **Published in-process library for "light local process" agents**: `examples/agent` currently reaches across packages with relative imports (`../../../packages/cli/src/config`) — that path is the smell. Extract a published `@cone/agent` (or add `createNodeClient` to `@cone/xmtp-node`) with the ~8-method surface: `identity`, `sendText`, `sendJson`, `streamMessages`, `sync`, requests (list/accept/block), `pair`, `setConsent`. Rewrite `examples/agent` to be ~10 lines with a single import from the published package.

### 6. Agent-network thesis

- [x] **Consent boundary marketed as a prompt-injection firewall** (README + SKILL, 2026-07-02): unknown senders' text can never reach an agent's context/tools; the differentiator vs. raw XMTP.
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
