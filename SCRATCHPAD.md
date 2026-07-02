# Scratchpad

The single working-notes file. Shipped behavior lives in SPEC.md; sequencing
lives in TODO.md; history lives in git. This file holds only what's in flight,
what's deliberately deferred (with the reasoning that deferred it), and the
hard-won gotchas that will bite again if forgotten.

## Active — agent readiness batch (agreed with Eddy 2026-07-02)

Groups completed 2026-07-02 (phases 0–4). Next: TODO's **agent readiness**
batch, in this order:

1. **§4 — make the happy path real off this machine.** Host the rendezvous
   service and flip `defaultRendezvousUrl()` off localhost; settle the XMTP
   env default for real use (and make `whoami` loud about it); `cone doctor`
   (JSON health check: secret, network, rendezvous, state DB); hosted echo
   bot with a well-known address in SKILL.md — the concierge example *is*
   that bot. §4 first because it unblocks everything: pairing for strangers,
   clickable `#join=` links (with PWA hosting), and SKILL.md's "zero →
   ping-pong in two minutes, unattended" metric.
2. **§2 — poll-shaped read model** for turn-based agents: `cone wait`,
   `cone messages --since <cursor>` with durable named cursors, distinct
   "nothing new" exit code, unread counts in `cone inbox` JSON.
3. **§1 — distribution**: npm publish (name: `cone` on npm may be taken —
   decide), compiled binaries, hosted self-contained SKILL.md. Hard blocker:
   pin an exact known-good XMTP nightly first.
4. §3 (structured payloads) and §5 (MCP server, `@cone/agent` library) ride
   behind those.

## Deferred, with reasoning

- **Knock-by-default invite links** (decided with Eddy 2026-07-01): join
  requests queueing for member approval. Deferred because it is most of the
  async-invite complexity (queue in the room, admit UX on three surfaces) and
  its servicing story stalls without an always-on member. Standing constraint
  recorded then: **agents are optional group members — no administrative
  feature may require one present or online**; any revisit designs the
  human-only degraded mode first. Auto-admit links (shipped) remain the
  escape hatch.
- **In-group invite-secret distribution** (`cone.group.invite.v1`): would let
  any authorized member service joins. Two unresolved wrinkles: MLS forward
  secrecy means post-mint joiners can never see the control message ("any
  member" is really "any member since mint" without re-distribution), and
  every holder polling rendezvous is background work plus metadata the worker
  can see. Revisit only if minter-serviced links prove unreliable.
- **Joiner-to-joiner privacy in link rooms** relies on the cleartext `role`
  field (worker returns join offers to the descriptor holder only). If roles
  ever change, joiners could decrypt each other's identities under the shared
  token key.
- **Self-profile / share-card track** (Eddy 2026-06-12): volunteer profile
  info as `cone.profile.v1` save-suggestions on pair / accept / group-join —
  easy mutual saves without auto-save. Also in TODO.
- **Group read receipts** ("Read by k" aggregation) and **local title
  override for groups** — both deliberately out of v1 group scope.
- **`appData` product use** (e.g. advertised invite policy): expose in the
  adapter when a consumer exists.
- **Retention live spike**: confirm libxmtp's cleanup worker actually runs
  under both SDK clients as configured. Cone's own purge is independent, so
  the worst case is stale rows in the XMTP-level DB only.
- **TUI narrow-tier polish** after real daily use (redesign shipped
  2026-07-02: A+B hybrid, layout kit in `chat/layout.ts`, mode chips, amber
  focus borders; preview any render change with
  `bun run scripts/tui-preview.ts`).
- **PWA hosting** is the prerequisite for clickable `https://<host>/#join=`
  links; until then tokens are pasted.

## Gotchas (the classes of bug that recur)

- **`decryptJson` does not authenticate the schema label** — payload type
  discrimination must live *inside* the ciphertext (explicit `type` fields on
  every rendezvous payload, pairing offers included since 2026-07-02). The
  cleartext schema label is untrusted, but useful for *diagnostics*: an
  unfamiliar one means "peer is on a newer Cone", surfaced as an error
  instead of a silent timeout. Same code space, no cross-flow reads.
- **Store metadata key whitelist**: BunSQLiteStore's `getMetadata` enumerates
  keys explicitly — every new `ConeStoreMetadata` field needs a branch there
  or it is silently dropped (bit us for `deniedInboxIds`, again for
  `pendingGroupJoins`). MemoryStore/IndexedDB spread through for free.
- **SQLite upserts must update every denormalized column** — `putMessage`
  once updated only `data`, which would have silently broken re-keying
  messages during duplicate-DM collapse.
- **Every spawned `bun` re-loads the repo `.env`** (cwd-scoped; real env
  vars beat it). The exact-path `CONE_STATE_PATH`/`CONE_CONFIG_PATH` knobs
  were removed 2026-07-02 because their precedence over `CONE_HOME` let a
  repo `.env` silently make separate actors share one state DB (symptom:
  `PRAGMA key or salt has incorrect value`). `CONE_HOME` is now the only
  path override; multi-actor scripts set it per actor. `cone config` prints
  the resolved values.
- **Rendezvous re-posts need stable participant ids** — link servicing
  re-posts the descriptor every sync; a fresh nonce would mean "room already
  has a descriptor" (the stable nonce lives on `GroupInviteLink`).
- **Tokens are case-sensitive, spoken codes are not** — anything that
  normalizes a rendezvous secret must branch on the `cone_gi_v1_` prefix.
- **XMTP duplicate DMs**: list with `includeDuplicateDms: false` and let
  sync fold strays; one peer must always be one thread.
- **Terminal rendering**: U+231B `⌛` is double-width in many terminals
  (ASCII in `pad()`-aligned rows); an Edit once smuggled a literal ESC byte
  into a test string — check `od -c` when a "wrong" test passes.
- **Live tests catch store bugs unit fakes cannot** — NOT NULL columns and
  metadata whitelists both surfaced only on the dev network.

## Shipped log

- **2026-06-12** — Disappearing messages end-to-end (native XMTP settings,
  derived expiry, purge-before-settings-change; all surfaces).
- **2026-06-12** — Groups Phase 1: core model, kind-tagged dual streams,
  group consent + add-policy matrix, GroupUpdated decode.
- **2026-07-01** — Groups Phase 2: admin model, `active` mirror, group-info
  surfaces. Phase 3b: synchronous invite codes (pairing machinery reused
  asymmetrically, pending-join auto-allow). Product renamed to **Cone**
  (clean wire/state break). Cleanup sweep; SPEC gained "pre-release policy:
  no upgrade paths". Phase 3c-lite: rendezvous v2 (hashed rooms, roles,
  revocation) + auto-admit invite links, minter-serviced on sync. Live
  five-actor dev-network run green.
- **2026-07-02** — TUI redesign (A+B hybrid; aggressive resize tiers; mode
  chips + amber focus highlighting). Duplicate-DM fold + "Me" removal; PWA
  name-a-peer; timer system line fixed. Groups Phase 4: `isAddressedTo`
  mention helper, enriched strict-by-default `cone listen`
  (`--auto-accept-groups-from-contacts` opt-in, senderName/groupName in
  JSON), group-concierge example agent. **Groups complete.**
