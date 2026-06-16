# Scratchpad: Disappearing Messages

Working notes for the disappearing-messages feature. Current plan at top, journal at the bottom. (See SPEC.md for shipped behavior; this file tracks in-flight work.)

## Current plan

Foundation: XMTP's native conversation-level disappearing settings (`messageDisappearingSettings` / `updateMessageDisappearingSettings(fromNs, inNs)` / `removeMessageDisappearingSettings`), not a Cone control message. Native settings interop with other compliant XMTP clients, either DM participant can set them, and libxmtp's worker cleans the XMTP-level local DB. The core of the work is making Cone's own store, read model, and backups expiry-aware — XMTP's cleanup knows nothing about Cone's encrypted message snapshots.

- [x] **Phase 1 — core model + adapter** (`@cone/core`, `@cone/core/xmtp`)
  - `MessageRetention { durationMs, fromAt }` mirrored on `ConeConversation.retention` (consent-mirror pattern: stamp on persist, reconcile on sync, view-time filter)
  - `XmtpAdapter.getRetention/setRetention`; `SdkDm` gains the SDK methods as `MaybePromise`; ns↔ms at the adapter boundary
  - `ConeClient.setRetention(conversationId, durationMs | null)` — mirror-first, best-effort network write
  - Enforcement: expired messages filtered from `listMessages`, purged from the store during `sync()` and before `exportBackup()`; `ConeStore.deleteMessage`; `ConeClient.purgeExpiredMessages()` for surfaces to call on a timer
  - Retention helpers: presets, `formatRetention`, `parseRetention`, `messageExpiresAt`
  - Tests: mirror stamping/reconcile, view filtering, purge, peer-initiated changes, backup excludes expired, timer-off keeps history
- [x] **Phase 2 — CLI/agent surface**: `cos timer <target> <duration|off>`; retention + `expiresAt` in `cos inbox read` JSON
- [x] **Phase 3 — TUI**: `e` opens preset picker (off/5m/1h/8h/1d/7d/30d); `timer <duration>` header chip; status-line confirmation; exact-expiry refresh so expired rows drop while a chat is open
- [x] **Phase 4 — PWA**: `⌛` select in the chat header (`e` focuses it), `⌛` chip on rows with a timer, help row, footer hint; the existing 8s poll drops expired rows (listMessages filters them)
- [x] **Phase 5 — spec + docs**: SPEC.md "Disappearing Messages" section, SKILL.md `cos timer` + chat key, TODO.md checked off

## Design decisions

- **Derived expiry, not stamped.** Expiry is computed at read/purge time from `(message.sentAt, conversation.retention)`, never stored on `StoredMessage`. XMTP semantics: messages sent at/after `fromNs` expire `inNs` after send, *under the current settings* — turning the timer off (or changing `fromAt`) stops pending expirations. A stamped `expiresAt` would need restamping on every settings change; a derived one is always faithful. `ConeMessage.expiresAt` is computed in `listMessages` so UIs can show countdowns.
- **Either peer can change the timer** (both DM members are super admins). Sync reconciles the mirror from the network — same revert-until-propagated semantics as consent.
- **Settings changes purge first.** `setRetention` purges under the *old* settings before writing the new mirror, so a message that already hit its timer (hidden but not yet purged) can never reappear because the timer was relaxed or removed. Matches XMTP's continuously-running cleanup worker.
- **No synthesized system messages in core (v1).** `isVisibleChatMessage` hides control messages, so a stored control envelope wouldn't render anyway. UIs observe mirror changes and render their own "Disappearing messages: 1h" line; revisit parsing XMTP `GroupUpdated` later if attribution ("who changed it") matters.
- **`processedMessageIds` survive purge** so a still-undeleted XMTP-DB copy can't resurrect a purged message on the next sync.
- **Honesty caveat** (for SPEC + UI copy): cooperative hygiene, not a cryptographic guarantee — a non-compliant peer client can retain anything.
- Naming: code says `retention`; UI copy says "disappearing messages" / timer.

## Verified facts

- Both pinned SDKs ship the full API; `MessageDisappearingSettings = { fromNs: bigint, inNs: bigint }` (`fromNs` = epoch-ns the rule starts, `inNs` = duration). `messageDisappearingSettings()` is sync on node / async on browser — same `MaybePromise` split the adapter already normalizes for `consentState`.
- Both stores serialize whole objects into a JSON `data` column/snapshot → new optional fields need no migration. `IndexedDbStore` delegates to `MemoryStore`, so `deleteMessage` is a passthrough.
- Interface implementors to update: `FakeAdapter` (core/tests/client.test.ts), `PairingAdapter` (core/tests/pairing.test.ts), `MockClient` + `stubClient` (cli/tests), web preview mock (apps/web/src/mock.ts).

## Open items / to verify

- [ ] Spike on dev network: confirm libxmtp's cleanup worker actually runs under both node + browser clients as we configure them (before trusting local XMTP-DB deletion).
- [ ] Read receipts expire like any message; `latestReadOutboundId` shifts as receipts/messages expire — believed fine (they expire on similar timelines), watch in UI phases.
- [ ] `sync()` overwrites conversation rows with the adapter's view (pre-existing behavior); retention rides that overwrite as the authoritative network value. `persistOutbound`/`maybeCreateConversation` must preserve `existing?.retention`.

## Feedback round (Eddy, 2026-06-12)

1. TUI-set custom timer (6d) never showed in the PWA → root cause: **the PWA never called `client.sync()`** — its 8s poll and the stream are local-only, and settings/consent ride conversation metadata. Fixed: sync at session start + every 60s (TUI parity). This also means PWA Requests now populate from offline periods and expired messages purge in the browser.
2. Buckets as primary vocabulary: presets now off/30s/5m/1h/8h/1d/1w/4w (added 'w' unit to format/parse). Custom durations stay legal (TUI free text); every surface must *display* a custom value as-is — PWA select grows an extra option for it, never snaps to a bucket.
3. PWA dropdown hotkeys: with the ⌛ select focused, j/k + arrows step a draft, Enter applies, Esc/blur discards; pointer selection commits directly. Draft pattern avoids firing a network settings-write per keystroke.

## Journal

- **2026-06-11** — Plan agreed with Eddy: native XMTP settings as foundation, Cone-store enforcement as the real work, cooperative-deletion caveat stated honestly. Explored core/client/stores/SDK typings; confirmed API availability and the no-migration property. Settled the derived-expiry-vs-stamping question in favor of derived (see Design decisions). Starting Phase 1.
- **2026-06-12** — **Phase 1 complete.** `MessageRetention` mirror on conversations, `retention.ts` helpers (presets, parse/format, derived expiry), adapter `get/setRetention` with ns↔ms at the boundary, `ConeClient.setRetention` (mirror-first) + `purgeExpiredMessages` (on sync, before backup, before settings changes), `ConeStore.deleteMessage` across all three stores. One refinement while writing tests: purge-before-settings-change (see Design decisions) — without it, relaxing the timer could resurrect an expired-but-unpurged message. 101 tests green, typecheck clean. Next: Phase 2 (CLI `cos timer`).
- **2026-06-12** — **Phase 2 complete.** `cos timer <target> [<duration|off>]` (show/set/clear) resolves targets like `cos inbox read` does; `inbox read` JSON carries `retention`/`expiresAt` for free via serialization. 103 tests green. Next: Phase 3 (TUI).
- **2026-06-12** — **Phase 3 complete.** `e` in Chat(select) opens a timer form (Up/Down cycle off+presets, free text like '45m' accepted); header chip is ASCII `timer 1h` — U+231B `⌛` is double-width in many terminals and would overflow `pad()`-aligned rows (PWA keeps the glyph). `e` is select-mode only since chat-talk routes printable keys to the composer. runChat schedules a refresh at the earliest visible `expiresAt`, so rows vanish at the exact moment, not the next sync. Deviation from plan: change notices are status-line + header chip, not transcript lines — a real transcript line needs a timestamped event (parse XMTP `GroupUpdated`), noted as follow-up. 106 tests green. Next: Phase 4 (PWA).
- **2026-06-12** — **Phases 4 + 5 complete — feature done end to end.** PWA: native `<select>` for the timer (accessible, no popover code), `e` parity, `⌛` chips; verified visually via the preview harness (added `?selected=<conversationId>` param to it; mock gives dm:codex a 1h timer so previews exercise the chip + header control). Docs: SPEC section, SKILL.md agent docs, TODO checked. Final state: 106 tests green, typecheck clean, prod web build clean. Remaining open item: live dev-network spike to confirm libxmtp's cleanup worker runs under both SDK clients as configured (Cone's own purge is independent of it, so worst case is stale rows in the XMTP-level DB only).
- **2026-06-12** — **Feedback round applied** (see Feedback section above): PWA sync lifecycle fixed (the real bug behind "TUI change didn't show in PWA"), bucket presets 30s→4w with weeks unit, custom values acknowledged everywhere, full j/k/arrows/Enter/Esc support on the PWA timer select. Verified custom `6d` renders in the PWA header via preview harness (mock dm:codex now carries a custom timer). 106 tests green, typecheck + prod build clean.
