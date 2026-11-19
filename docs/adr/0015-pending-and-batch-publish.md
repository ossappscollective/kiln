# ADR 0015: One place for everything pending, and publishing it in one go

Status: implemented and tested against fakes on SQLite (the Postgres variants run when `MRM_TEST_POSTGRES_URL` is set); **never
run against App Store Connect or Google Play**. API: [api/pending](../api/pending.md). Migration 29.

## Context

A person who changes an app here touches four different places before anything is live: the staged texts and graphics
([ADR 0009](0009-staged-store-drafts.md)), the draft push, the submit for review ([ADR 0010](0010-store-submit.md)), the release
([ADR 0014](0014-release-management.md)) and the rollout ([ADR 0008](0008-store-rollout-writes.md)). Each is a gated step with its
own switch, right, preview and confirmation. What was missing is the view Google Play's "Publishing overview" gives: **one place per
app that lists everything that is pending**, and one final step where the person reviews it and publishes it all at once. Portfolio
and app lists also have to show which apps have something pending.

## Decision

1. **The pending view reads stored state only.** `GET /apps/{id}/pending` and `GET /pending/summary` need `listing.read`, read no
   store and no repository, need no switch and are cheap (a fixed number of queries; the staged view is built only for apps that
   have unpushed staged rows). Items have a `kind` (`listing_text`, `asset_set`, `release_field`, `pushed_draft`, `in_review`,
   `approved`, `rollout_step`), a `state`, `problems` (an `error` blocks the step the item waits for) and the `nextStep` that
   publishes it (`push_draft`, `submit`, `release`, `rollout`; null for what only waits for the store). Counts and ids only: never a
   staged text. No ETag: no other summary here has one.
2. **Nothing new can be written by the view.** It lists; it does not stage, push or submit.
3. **The batch publish adds no power.** `POST /apps/{id}/publish/preview` and `POST /apps/{id}/publish` run the steps through the
   services that already run them (`applyDraftPush`, `applySubmit`, `applyRelease`, `applyRollout`). Each step keeps its switch,
   its role right, its claim, its own re-read of the store right before the write, its refusal on drift (`state_changed`), its
   never-retry rule and its read-back of a lost answer. The plan only combines their previews.
4. **Off by default, behind a master switch that turns nothing else on.** `MRM_STORE_PUBLISH_BATCH_ENABLED` (default `false`).
   Every included step also needs its own switch (`409 step_disabled`; in the plan `feature_disabled`) and its own right. The
   batch is `store.publish` (owner and admin; **explicit-only on tokens**). A token needs `store.publish` AND the right of every
   step it includes; the registry checks `store.publish` only, so the handler checks the rest and names what is missing (`403`).
5. **One typed phrase for the whole batch.** `publish <app name> <n> steps` (`step` for 1), needed when any included step is
   irreversible: submit, release, rollout. It covers exactly the steps of the plan, because the plan hash binds them and the phrase
   carries their number: the phrase of one plan cannot confirm another. It is checked before any store is read. A push alone is
   not irreversible and needs no phrase.
6. **What the batch does NOT do: it never types a phrase the person did not type.** Submit and release have their own phrases
   (`submit <identifier> <version>`, `release <identifier> <version>` or `release <identifier> <track> <percent>%`). The plan shows
   them as `stepPhrase` and binds them into the plan hash; at apply the batch passes each step **the phrase its own preview
   produced and promised**, and no other, and only after the person typed the batch phrase for a plan that listed it. This does
   not weaken the individual gates: a step still refuses a phrase that does not match its own preview, a hash that does not match
   the store as it is read right then, and a store that moved (`state_changed`). The batch phrase is an additional, plan-wide
   confirmation; it replaces the per-step typing only for the steps the plan names and cannot be reused for another plan.
   Rollout has no phrase of its own: its `confirmHash` is the gate and the batch phrase stands in for the typed confirmation.
7. **A step that needs an earlier step's result is deferred, with a promise.** Submit needs the pushed draft; a Google Play release
   needs the draft release a push writes. They cannot be previewed before the push ran, and previewing them first would bind a
   `confirmHash` the push invalidates. The plan carries a **promise** (the step's `summary` and phrase: version, counts, track,
   share). After the earlier steps applied, the step is previewed again with its own preview function; if the summary or the
   phrase is not the promise it is **skipped as `plan_drifted`** (nothing written, the person reviews a new plan); if the preview
   blocks it is skipped as `blocked`; only a preview that matches the promise is applied, with the `confirmHash` that preview just
   produced. An App Store release acts on the approved version, not the editable one a push writes, so it is previewed up front.
8. **Order, stop, never retry.** Steps run in the order push, submit, release, rollout. The batch stops at the first step that is
   not applied; the rest are `skipped` (`previous_step_not_applied`). A failed step reports the individual error code, HTTP status
   and an `outcome` (`refused`, `not_applied`, `unknown`, `partial`). An unknown outcome was already read back by the step's own
   service; the batch never sends again, and the step keeps its own `outcome_unknown` block until a preview reads the store.
   The answer is `200` with the result of every step even when one failed: `completed`, `stoppedAt` and `steps` say what happened.
9. **Combinations that are refused or warned.** A rollout cannot share a batch with a release (the release changes what the rollout
   acts on): the rollout is `blocked`. On Google Play, submit followed by release warns: Play refuses a release while changes are in
   review (`changes_in_review`); the batch stops there and says so.
10. **One publish in flight per app and platform.** A new table, `store_publish_claims` (migration 29, same shape as the other claim
    tables; deleted with the app). A second publish is `409 publish_in_progress`. The lock is a claim with a time to live
    (15 minutes by default, a batch of up to four steps): an older one is not trusted, the claims and re-reads of the steps decide
    what is safe. Existing claim tables were not reused: they belong to the steps and would collide with them.
11. **Audit and events carry ids, counts and hashes.** Audit `pending.published` (when something was applied or failed) and the
    event `pending.published` (when something was applied), with the plan hash, the totals and per-step outcome codes. Never a text,
    a store answer or a credential. Each step still writes its own audit entry and event. Both are attributed to the token when a
    token published.
12. **Pending rollout items come from the release plan.** Nothing is staged for a rollout, so a `rollout_step` item is a due step of
    a release plan ([ADR 0014](0014-release-management.md), plans). The batch's `rollout` step always needs an explicit request.

## Consequences

- The web can show one "Pending changes" place per app and a badge in portfolio and app lists from stored data alone, and a
  review screen from the plan.
- A publish that stops in the middle leaves the earlier steps applied (they cannot be undone from here); the result and the new
  pending view say exactly where things stand.

## Not verified (UNVERIFIED)

- Everything runs against fakes. No store was contacted.
- Whether a Google Play push followed by a release in one go behaves as the fakes do (the draft release a push writes, the version
  codes Play lists) was not checked against Play.
- A submit followed by a release on Google Play is expected to be refused by Play (`changes_in_review`); not verified.
- The number of staged items one `pending/summary` handles in a large workspace was not measured.
