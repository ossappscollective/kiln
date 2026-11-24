# ADR 0060: EAS Update state stored by the status sync, and the stuck-rollout alert

Status: server and web implemented, tested against hand-written fixtures; **not viewed in a browser, no real Expo call**. Migration 64.
API: [api/eas-builds](../api/eas-builds.md). Builds on [ADR 0036](0036-eas-build-submit-status.md) (stored status sync) and [ADR 0037](0037-eas-update.md) (live EAS Update view).

## Context

The Overview showed the latest build and submission from stored data, but the OTA state (which update each channel serves, how far a rollout is)
was only read live on the Builds page. The "stuck rollout" alert was skipped in ADR 0037 because nothing stored the state over time.

## Decision

1. **Stored by the existing sync, one more request.** `refreshEasStatus` also calls `expoUpdateChannels` (the query of ADR 0037) and keeps, for the
   platform of the app record, per channel the CURRENT update (the newest update of the branches the channel serves by its branch mapping; every branch
   when the mapping names none of them) and any update that is mid-rollout (1 to 99). Table `eas_updates` (one row per app, channel and update): branch,
   update group id, runtime version, message (first line, 200 characters), created at, rollout percentage, `rollout_since`, `stuck_event_at`,
   `is_current`. `eas_status_sync` gets `updates_read_at` and `updates_error` (a short code): a failed updates read keeps the old rows and the good builds
   read. No new job; the rows go with the link (`clearEasStatus`) and the app (`deleteApp`).
2. **Views.** `GET .../eas/status` carries `updates { readAt, lastError, channels[{ channel, current, rollouts[] }] }` from the database only. The Overview
   card shows "Current update per channel" with "Updated X ago", a link to the update at Expo and one to Builds, EAS updates; empty states say "never read"
   and "none for this platform" and a failed read says what is shown is older.
3. **Alert `eas.update_rollout_stuck`.** Raised by the same read, as an event of the same name (webhook-listable), when a rollout has stayed at one
   percentage below 100 for longer than the rule parameter `hours` (default 48, 1 to 720, a workspace setting like the other thresholds; **no per app
   value**: no alert threshold in this code base is per app). The clock is `rollout_since`: when Kiln first read that percentage (a changed percentage
   starts again). It is therefore a lower bound: Kiln cannot know how long a rollout sat there before it first looked. Once per update
   (`stuck_event_at`), alert key `eas.update_rollout_stuck:{appId}:{group}`, 90 days. Payload: `appId`, `updateId`, `group`, `platform`, `channel`,
   `percentage`, `hours`; never the message. Catalog, text and email in en, fr, es and de, webhook entry, docs.
4. **Release step.** For a release matched to an EAS build (ADR 0036 rules), the release detail adds a quiet "OTA update published" line when the
   stored current update of the build's channel is for the platform of the build and has exactly the build's runtime version (`matchOta`). A build
   without a channel or runtime version, a channel without a stored current update, or another runtime version: nothing.

## Checked against Expo's sources (2026-11-24)

- **Confirmed** in eas-cli `packages/eas-cli/src/graphql/types/Update.ts` (UpdateFragment): `id group message createdAt runtime { id version } platform
  rolloutPercentage rolloutControlUpdate { id group } branch { id name }`. (Already confirmed for ADR 0037; read again for this one.)
- **Confirmed** in docs.expo.dev/eas-update/rollouts: a per-update rollout is started with `eas update --rollout-percentage`, raised with `eas update:edit`,
  finished by setting 100, reverted with `eas update:revert-update-rollout`; its state is visible with `eas update:list` and `eas update:view`.
- **Not confirmed** by the docs page: that the GraphQL API exposes `rolloutPercentage` (it is in eas-cli's own query, which is the evidence we have; the
  GraphQL API is not documented as a public contract), and what Expo sends once a rollout reaches 100 (`null` or 100). Both 0, 100 and null are treated as
  "not mid-rollout", so neither can raise the alert.
- **Assumed**: the address of an update group page, `https://expo.dev/accounts/{account}/projects/{slug}/updates/{group}` (same family as the build and
  submission pages of ADR 0036, also unverified); that the newest update of the served branches is "the update the channel serves" (a branch-based rollout
  between two branches serves both: the newest one is shown); that a read of updates is allowed with the token that reads builds.
- Fixtures are hand-written from eas-cli's query documents, not recorded from a live account.

## Not done, and why

- A per app threshold for the alert: it would be the first per-app alert setting; the workspace rule is the pattern everywhere else.
- A rollout between two branches (`branchMapping` with a condition) has no percentage (the operand scale is unverified, ADR 0037), so it never counts as stuck.
- History of updates: only the current update and rollouts are stored, not a timeline.
- The release step does not look at update age relative to the build: a same-runtime update older than the build is still the one the channel serves.

## UNVERIFIED

No real Expo call was made; the stuck clock, the stored shapes and the card are tested against fakes and the web logic is unit tested, but the Overview card
and the release line were not viewed in a browser.
