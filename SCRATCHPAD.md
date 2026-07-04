# Scratchpad

The single working-notes file. Shipped behavior lives in SPEC.md; sequencing
lives in TODO.md; history lives in git. This file holds only what's in flight,
what's deliberately deferred (with the reasoning that deferred it), and the
hard-won gotchas that will bite again if forgotten.

## Active — staging live-testing toward production (2026-07-03)

Hosting is live on staging (infra lives in the private `emlazzarin/cone-infra`
repo: OpenTofu DNS, Caddy, systemd, deploy scripts). `*.staging.cone.chat` is
basic-auth gated except `rv.` (capability-based) ; `agents.staging.cone.chat`
serves the assembled skill + source tarball. Prod droplet is provisioned and
serving the landing page only — rendezvous/web/agents not yet deployed there,
`DEFAULT_RENDEZVOUS_URL` not yet flipped.

Fixed from Eddy's first two agent-pairing sessions (Hermes agent):
- **60-second wait vs 10-minute code**: `pairWithCode`/group invite/join
  defaulted `timeoutMs` to 60s while codes lived 10 min — the PWA side "timed
  out", the agent later completed against the stored offer, and the PWA's
  save-contact path never ran (this also masqueraded as "no proposed name" and
  "no contact created"). All waits now default to the full code window, codes
  live **30 minutes** (`PAIRING_TTL_MS`, server ceiling matches), and the
  waits take an `AbortSignal` (PWA "Stop waiting" button).
- **Deleted chats resurrected by sync**: local row delete + mirror-first sync
  re-created them. Now `hiddenConversations` tombstones in store metadata
  (SQLite whitelist branch added!); a message newer than the tombstone, or a
  local send, un-hides. Views filter tombstoned ids.
- **Agent sends published but invisible to the PWA peer**: pairing's dueling
  confirmations guarantee duplicate MLS DMs; sync fetched messages from
  *canonical* DMs only. Node reads stitch duplicates in, browser reads do
  not → agent messages (published into its duplicate) never reached the PWA
  read model. sync now lists DMs twice: canonical-only for conversations,
  `includeDuplicateDms: true` for messages; the existing fold reunites them.
  Verified live (CLI×CLI, dev network + staging rendezvous).
- Skill rewritten prescriptively (agent setup runbook: durable key =
  `--remember`, never echo the key — the Hermes agent pasted its secret key
  into chat! —, env persisted where the event loop runs, pairing verified via
  inbox, gateway wiring is an obligation with a 30s-poll default, completion
  checklist). PWA: login Enter submits (textarea never implicit-submits),
  `y` copies the pair code, explicit "＋ Add contact" button + `a` key.

Third live-test round (2026-07-03, Eddy on mobile + re-used key on a new
device):
- **Accepted requests reappearing / stale requests on a fresh device**: XMTP
  consent is dual-keyed (per-inbox and per-conversation). Accepting a DM wrote
  only the inbox-level record; the sync mirror read the DM's
  conversation-level record ("unknown") and flipped rows back to Requests —
  and a new installation of an old key saw every historic DM as a Request.
  Fix: `toDmConversation` falls back to inbox-level consent when the
  conversation record is unknown, and `setConversationConsent` now writes the
  conversation-level record too.
- Requests-list Accept no longer navigates into the thread (batch-clearing
  stale requests was accept→thread→back per item).
- Mobile PWA: unwrappable 64-char hex ids pushed layout past the viewport
  (renders "zoomed in"; iOS then re-zooms on every input focus).
  `overflow-wrap: anywhere` on id/code-bearing classes, `overflow-x: clip`
  backstop on body, viewport pinned (`maximum-scale=1, user-scalable=no`).
- Skill: setup runbook is one pass — no pausing to "verify" before the event
  loop exists (the Hermes agent stopped mid-setup to check in).
- **Mobile root cause found by headless audit** (puppeteer + CDP device
  metrics against `preview.html`, all views at 320/390px): `.app` had no
  `grid-template-columns`, so the implicit `auto` column sized to the widest
  child's min-content — one unshrinkable row widened *every* row ~9px past
  the viewport. Fix: `grid-template-columns: minmax(0, 1fr)` (plus tabs +
  thread-header `flex-wrap`). The earlier `maximum-scale=1` lock had made
  this worse by removing pinch-out. The 16px mobile input bump was removed —
  the locked viewport already prevents iOS focus-zoom, and 16px controls next
  to 13px body read oversized. DM transcripts collapse membership noise
  ("X added you" per duplicate DM) into one "you and <peer> began a
  conversation" line at transcript font size; groups keep attributed lines.
  Audit criterion for future style changes: every preview view must show
  zero elements past the viewport at 320 and 390px.
- Mobile polish round 2 (same day): transcript bottom-anchors like Signal
  (`.transcript > :first-child { margin-top: auto }` — scrolls normally when
  long, empty-state centering unaffected); app height follows
  `visualViewport` via a `--viewport-height` CSS var + scroll pin (iOS
  keyboards never shrink dvh — Safari pans nav off-screen otherwise), so
  topbar/tabs/back stay visible while typing; login Unlock button moved to
  the right (thumb side, same side as Send).
- Round 3: the viewport pin is **signed-in only** — on the (scrollable) login
  screen the forced `scrollTo(0,0)` fought the user and killed iOS's
  long-press paste callout (couldn't paste the secret key). Touch devices
  (`hover: none and pointer: coarse`) hide all kbd chips + login keyhints;
  the opt-in ? overlay keeps them. Direction decided: **one adaptive PWA**,
  not a mobile fork — mobile issues so far were bugs/adaptations, not
  architecture; revisit only if touch needs its own interaction model.
- Rounds 4–5 (keyboard; the shape that finally holds): scrollTo-on-*scroll*
  pinning fights Safari's reveal-the-input scroll (composer stuck under
  keyboard, flashing per keypress) — and the round-4 "follow the pan with
  translateY(vv.offsetTop)" baked stale pan offsets into the layout
  (truncated transcript, black gap, no composer). Stable shape: signed-in
  screen page-unscrollable (`.screen--app { height:100dvh; overflow:hidden
  }`), app height = `visualViewport.height`, **one** `scrollTo(0,0)` per vv
  *resize* (never per scroll event, no transforms), transcript re-pins to
  bottom on resize. Login untouched (paste callout).
- Hermes round-2 feedback: polling/idempotency/consent shape praised. Two
  items: (1) **async pairing** for automated bootstrap — blocking window is
  awkward; skill now documents the background-process pattern (`cone pair …
  &` + `wait` before first send); a true non-blocking pair (post offer, exit,
  complete on later sync — pending-group-join machinery is precedent) is
  deferred until a second agent framework hits the same wall. (2) sqlcipher
  stderr warnings: native SQLCipher mlock noise on Linux, not switchable via
  SDK (its logger already defaults Off); skill now says "parse stdout only;
  stderr is logs" which is the durable contract anyway.

Open / unexplained:
- Agent reported a DM row with `peerInboxId` = `<conversationId>:<inboxId>`
  concatenation. Not reproduced CLI×CLI; likely SDK-nightly shape leak. Need
  the agent's state dump if it recurs post-fix; the duplicate-ingestion fold
  may make it moot.
- `"` in delivered text: Cone's encode path never unicode-escapes —
  attributed to the agent pre-escaping in its shell command; skill now warns.
- Next readiness test's success criterion: "agent replies unprompted", not
  "agent pairs" — the mechanics reviews never simulated docs-as-prompt.

## Previous batch — agent readiness (agreed with Eddy 2026-07-02)

Code-side items **done 2026-07-02**: §2 poll read model (`pollMessages`
durable cursors, `cone messages`/`cone wait`, exit 3 = nothing new), §3
structured payloads (`send --data` — `--json` is the output flag — with
`--reply-to` envelope correlation and `--idempotency-key` dedup ledger),
`cone doctor`, structured JSON errors with stable codes, SQLite WAL +
concurrency test, consent-firewall wording in README. Earlier the same day
(protocol hardening): env default `production`, `cone config` provenance,
envelope content type, protocol freeze + golden vectors.

**2026-07-02 review pass complete** — 12 reviewers (8 Claude finder angles +
4 Codex personas), findings + statuses ledgered in REVIEW-2026-07-02.md; all
correctness/contract/UX items fixed same day (seq-based poll cursors,
at-most-once idempotency, unwrapped reads, NDJSON, typed ConeError codes,
NO_COLOR, segment-fitting footer). Deferred to hosting: the **public echo-bot
consent policy** (a stranger's ping lands in Requests; the bot needs explicit
policy-gated auto-accept + rate limits + an isolated key — design before
deploying) and the Bun rendezvous port.

Sequence from here:
1. **Eddy's code review pass** — done (see above).
2. **Hosting prep** (single droplet: Caddy static PWA/docs + Bun rendezvous
   port reusing `applyExchange` + concierge/echo agent under systemd), then
   flip `DEFAULT_RENDEZVOUS_URL`, publish the echo bot address in SKILL.
3. **§1 distribution** (npm name, compiled binaries, hosted self-contained
   SKILL; hard blocker: pin an exact XMTP nightly) and §5 (MCP server,
   `@cone/agent` library) after hosting.
4. Small leftover: first-class `unreadCount`/`lastReadAt` in `cone inbox`
   JSON output.

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
