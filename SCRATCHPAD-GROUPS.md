# Scratchpad: Groups

Working notes for group chat. Current plan at top, journal at the bottom. (See SPEC.md for shipped behavior; this file tracks in-flight work. Disappearing-messages work tracks separately in SCRATCHPAD.md; retention-on-groups rides that track.)

## Current plan

- [x] **Phase 0 — stream guard** (shipped 2026-06-12; superseded by Phase 1's dual streams)
  - Passed the SDK's `ConversationType.Dm` to `streamAllMessages` so group messages could not reach the DM-shaped read model (phantom-DM hole). Phase 1 replaced the pin with one stream per conversation type, each tagging messages with their kind.
- [x] **Phase 1 — core group model** (shipped 2026-06-12; live-verified on the dev network)
  - `ConeConversation.kind: 'dm' | 'group'`; `peerInboxId` becomes DM-only; group fields: `name`, `description`, `memberCount`, `addedByInboxId`, cached member mirror `{ inboxId, level, consentState }` refreshed on sync (offline info panels)
  - Adapter: `SdkGroup` beside `SdkDm` (same MaybePromise node/browser normalization); sync/list include groups; `createGroup(inboxIds, { name, description, locked })`; add/removeMembers; listMembers; updateName/Description; admin ops (add/removeAdmin, add/removeSuperAdmin); `requestRemoval` (leave); consent generalized to inbox-or-group entity (`ConsentEntityType.GroupId`, keyed by conversation id)
  - Decode the `GroupUpdated` content type into a stored `cos.group.update.v1` control message → system lines ("Alice added Bob", "Carol renamed the group to X"). Same mechanism later gives disappearing-timer attribution (SCRATCHPAD.md open item)
  - Consent rules: create/send into group ⇒ group allowed (mirror-first). Added by someone ⇒ `unknown` ⇒ Requests, labeled "Group · added by <resolved name>". Toggle **"allow contacts to add you to groups"** (default ON, gates on address-book contacts): ON + adder is a contact ⇒ straight to Chats (auto-allowed); OFF ⇒ all adds go to Requests. Blocked adder ⇒ discarded silently (deny mirror + best-effort network deny; no Request row, no auto-leave — leaving is visible, blocking must not signal). Unknown adder ⇒ Requests regardless of toggle. Denied inboxes are filtered inside allowed groups (your block list follows you into groups). Agents ignore the toggle: explicit accept only
  - Read receipts stay DM-only (gate `cos.read.v1` send/derive on `kind`)
  - CLI minimal: `cos group create|info|add|leave`; groups flow through `cos inbox`/`cos inbox read`/`cos requests` with `kind`
  - Tests mirror the DM consent suite: welcome→Request, toggle on/off/blocked/unknown adder matrix, deny-propagation, in-group sender filter, GroupUpdated decode, group accept/block targets GroupId not inbox
  - Live spike (extend `test:live:xmtp`, third inbox): welcome ⇒ unknown consent, `addedByInboxId` populated, GroupUpdated decodes, consent-filtered stream excludes unaccepted groups
- [ ] **Phase 2 — admin & surfaces**
  - TUI/PWA: groups in chat list (member-count badge), info panel (members + roles, contacts-first naming, short-inboxId fallback), add/remove member, rename, promote/demote admin, transfer-ownership flow (super admin cannot leave — promote first), leave vs block as distinct actions with honest copy, removed/left ⇒ `isActive` handling, "You joined — earlier messages aren't visible" system line
- [ ] **Phase 3 — invites**
  - **3a Direct add**: member picker over contacts/identities (mostly falls out of Phase 2); `canMessage` gate
  - **3b Synchronous group code**: pairing machinery reused asymmetrically. Inviter (in-group) posts an encrypted *group descriptor* `{ groupName, memberCount, inviterInboxId/address, conversationId }`; joiner posts a *join request* `{ inboxId, address, proposedName }`. Inviter's polling client decrypts and calls `addMembers` — auto-add is correct here (the code was created seconds ago; intent unambiguous). 10-minute TTL, single use. No auto-contacts; name suggestions ride the payloads
  - **3c Async invite links**: rendezvous v2 — `roomId = SHA-256(code)` so the worker never sees the decryption secret (backport to pairing in the same change); rooms hold one descriptor + N join offers; long TTL + max-uses + DELETE for revocation. Link = `https://<host>/#join=<token>` (fragment never hits a server; CLI: `cos group join <token>`); token format `cos_gi_v1_<secret>`. **Knock by default**: join requests queue and surface Requests-style to admitting members; `--auto` links auto-admit (capability, Discord-style). Invite secret is distributed into the group as a hidden `cos.group.invite.v1` control message so *any* member whose role passes the add policy (including an always-on agent) can service knocks. Joiner tracks pending join requests and auto-allows the group when the matching welcome arrives (requesting to join is implied consent); joiner can cancel
- [ ] **Phase 4 — agent kit**
  - Group context in `cos listen` JSON (kind, group name, sender identity); mention-convention helper (no native mention content type — simple addressed-to-me text convention; respond-only-when-addressed prevents agent reply loops); `--auto-accept-groups-from-contacts` opt-in flag; example group-concierge agent that services 3c invite links
- [ ] **Spec/docs**: SPEC.md groups section (consent rules, invite tiers, admin model, MLS no-history caveat, installation limits); README; TODO checkbox

## Phase 1 shipping notes (2026-06-12)

- **Scope deltas vs the plan above:** adapter-level admin ops (add/removeAdmin, add/removeSuperAdmin) and updateName/Description were deferred to Phase 2 — thin passthroughs with no Phase 1 consumer weren't worth three fakes of churn. Surfaces got slightly *more* than "CLI minimal": groups render in TUI/PWA chat lists and transcripts, group sends route via `sendToConversation`, accept/block are conversation-scoped, read receipts are kind-gated. The GroupUpdated → cos.group.update.v1 envelope skips the admin-change arrays for now (add when Phase 2 renders them).
- **Streams:** one `streamAllMessages` per conversation type (`Dm` + `Group`), injected as `dmConversationType`/`groupConversationType`; every `IncomingMessage` carries `conversationKind`. `Dm` vs `Group` narrowing for `getConversationById` uses an `addMembers`-presence duck check (`isSdkGroup`).
- **Denied-inbox set** lives in `ConeStoreMetadata.deniedInboxIds`, maintained by Cone-side consent writes; backs the in-group sender drop (stream + views). Denials made on other devices reconcile via `adapter.getConsent` in the add policy; a consent-stream subscription can tighten this later.
- **Live test caught two real store bugs** (worth remembering as a class): BunSQLiteStore's `peer_inbox_id` column was NOT NULL (group rows have no peer → rebuild-table migration `relaxPeerInboxConstraint`), and `getMetadata` whitelisted only the two timestamp keys while `putMetadata` `String()`-ed values — `deniedInboxIds` would have been silently dropped/corrupted. JSON `data` columns made the *model* migration-free, but the denormalized columns and metadata key whitelist still bite.
- Live run validated on dev network: welcome → `unknown` + `addedByInboxId` populated (stranger-adder → Request; contact-adder → auto-allow), group fan-out over live streams tagged `group`, creator = superAdmin in `members()`. One Bun teardown segfault observed on a `cos send` exit (nightly bindings flake, command had succeeded; passed on re-run) — watch for recurrence.

## Design decisions

- **Toggle gates on address-book contacts** (named entries), not all allowed peers — Eddy 2026-06-12. Someone accepted-but-unnamed still lands in Requests when they add you.
- **No auto-contacts from any invite flow** (including the synchronous code — a deliberate divergence from pairing's mutual save). Instead, proposed-name/profile *suggestions* ride invite payloads and the UI offers one-tap save. Generalizes into the self-profile/share-card track (see Open items).
- **Knock servicing is group-wide, not creator-only**: the invite secret is shared into the group as a control message; any member with the token whose role passes the add policy can admit. No privilege escalation — under the default policy members can mint invites anyway; in `--locked` groups only admins' adds succeed.
- **Leave ≠ block**, both offered: leave (`requestRemoval`) is visible to the group (`leftInboxes`); block (deny GroupId) hides locally while silently remaining a member.
- **Creation presets**: default (`All_Members`) or `--locked` (`AdminOnly`). Custom `PermissionPolicySet` deferred.
- **Group name is shared network state** (any member can edit under default policy) — unlike Cone's local aliases. A local title override is deferred.
- **One key per agent**: every device/process on a SECRET KEY is an XMTP installation (max 10/inbox); agent fleets need distinct keys. Document this.
- **MLS history honesty**: new members can't see pre-join messages (forward secrecy). State it in UI copy; it is not a bug.

## Verified facts (researched 2026-06-11/12; SDKs: node 6.1.0-nightly, browser 7.0.0)

- **No native invite-link primitive.** Membership changes only when a member client with add permission calls `addMembers`. Convos (Ephemera) does links via a backend + an accepting agent — same shape we get from rendezvous v2 + `cos listen`.
- **Group consent**: `ConsentEntityType.GroupId = 0`, entity = conversation id. A group you create is auto-`Allowed` (libxmtp sets it on the create path); a group you're added to is `Unknown` — **no SDK auto-allow rule exists**; `conversation.addedByInboxId` is the documented app-layer hook.
- **Default permission policy** (libxmtp `default_policy()` + docs): add member = all members; remove member = admin; metadata = all members *except* disappearing settings = admin (min protocol version = super admin); add/remove admin + permission changes = super admin. Creator = sole super admin; **super admin cannot leave**; `addSuperAdmin` is additive (multiple super admins legal).
- **`GroupUpdated` content**: `{ initiatedByInboxId, addedInboxes, removedInboxes, leftInboxes, metadataFieldChanges{fieldName,oldValue,newValue}, addedAdminInboxes, removedAdminInboxes, addedSuperAdminInboxes, removedSuperAdminInboxes }`; `isGroupUpdated` guard exported by both SDKs.
- **Streaming**: `streamAllMessages` spans conversation types and accepts `conversationType` + `consentStates` filters; `streamAllGroupMessages`/`streamAllDmMessages` variants exist. `listGroups`/`listDms` split; distinguish via `instanceof Group/Dm` or `metadata().conversationType` (Dm=0, Group=1).
- **`createGroupOptimistic`** creates offline/instant, publishes on first send. `CreateGroupOptions`: `{ permissions, groupName, groupImageUrlSquare, groupDescription, customPermissionPolicySet, messageDisappearingSettings, appData (≤8KB, policy-gated) }`.
- **`members()`** → `GroupMember { inboxId, installationIds, permissionLevel (Member=0/Admin=1/SuperAdmin=2), consentState, accountIdentifiers }`.
- **Limits**: 250 members/group; 10 installations/inbox; ~1MB message cap; no pre-join history (welcome carries current-epoch secrets only).
- **Disappearing settings are identical on groups** (methods live on the base conversation) — retention work generalizes nearly free; timer changes admin-gated by default.
- **Rendezvous v1 weakness**: the worker receives the raw code (`idFromName(body.code)`) while offers are encrypted under `codeScopedKey(code)` — an honest-but-curious worker could decrypt offers. v2's hashed room ids fix this for links and pairing alike.
- Browser/node splits follow the known pattern (MaybePromise): group getters are sync on node, cached-or-async on browser; `syncAll` returns a summary (node) vs void (browser); `countMessages` number vs bigint.

## Open items

- [ ] Live spike (Phase 1 gate): confirm on dev network — welcome ⇒ unknown consent, `addedByInboxId` population, GroupUpdated decoding, consent-filtered streams excluding unaccepted groups
- [ ] **Self-profile / share-card track** (separate feature, Eddy 2026-06-12): volunteer profile info (display name, later more) sent as `cos.profile.v1` suggestions on pair / request-accept / group-join; recipients get one-tap "save as contact" with the suggestion prefilled, editable later. Makes mutual address-book saves easy without any auto-save.
- [ ] Group read receipts ("Read by k" aggregation) — deferred
- [ ] Local title override for groups — deferred
- [ ] `appData` product use (e.g. advertised invite policy) — expose in adapter, defer use
- [ ] PWA hosting (TODO) is a prerequisite for clickable `#join=` links; until then tokens are pasted (PWA field / CLI arg)

## Journal

- **2026-06-12** — Groups design agreed with Eddy after full think-through (invites, admin, XMTP features, agents, consent). Key calls: contacts-gated auto-allow toggle (default ON), silent discard of adds from blocked inboxes, group-wide knock servicing via in-group token distribution, no auto-contacts from invites (self-profile suggestion track spun off instead), knock-by-default links with `--auto` capability mode, read receipts DM-only, default + `--locked` presets. Phase 0 stream guard implemented alongside this doc.
- **2026-06-12 (later)** — Eddy: groups before the agent-readiness batch (overriding TODO §6 sequencing). Phase 1 shipped: core model (`kind`, group fields, member mirror), dual kind-tagged streams, group consent (GroupId) + add-policy matrix, GroupUpdated decode + `formatGroupUpdate`, denied-sender in-group filter, `sendToConversation`, `cos group create|info|add|send|leave`, group-aware Requests on all three surfaces, minimal TUI/PWA group rendering. 133 unit tests + full live three-actor group flow pass (see shipping notes for the two store bugs the live run caught). SPEC Groups section written. Next: Phase 2 (admin & surfaces).
