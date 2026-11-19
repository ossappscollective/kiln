# ADR 0010: Submitting the pushed draft for store review

Status: implemented and tested against fakes on SQLite; **never run against App Store Connect or Google Play**.
The facts that were not verified are listed in [api/submit](../api/submit.md#unverified-check-with-a-real-account).

## Context

[ADR 0009](0009-staged-store-drafts.md) writes a draft and stops there on purpose. The step after it, handing the
draft to the store's review, is the first write of this server that **cannot be taken back from here**: an
App Review submission is cancelled only in App Store Connect, a Google Play review only in Play Console. It
can also be wrong in ways a draft cannot (a version that releases by itself after approval, a draft that someone
changed after it was pushed). It is therefore a separate, gated step and not a flag on the push.

## Decision

1. **A separate step with its own kill switch.** `MRM_STORE_SUBMIT_ENABLED`, default `false`, independent of
   `MRM_STORE_DRAFT_WRITE_ENABLED`. While off, preview and submit answer `409 store_submit_disabled` after the
   rights check and no connector is built.
2. **A separate right, owner and admin: `store.submit`, explicit-only on tokens.** It is not `store.push_draft`:
   pushing is reversible, submitting is not, and the people who may do the first are not automatically the people who may do the
   second. We did **not** make it owner-only: an admin already controls credentials, tokens and the rollout
   right, so owner-only would not protect against anything an admin cannot already do, and release managers
   are usually admins. Workspaces that want it narrower can mint tokens without it and keep the switch off. A
   later "second person approves" step is an open decision, not part of this change.
3. **It needs a prior successful draft push, recorded, and checks the store against it.** A successful push
   writes `store_draft_pushes` (migration 24): per app and platform the version, and hashes of every text and
   file written since the last submit (merged across pushes of one version, replaced when the version changed,
   never a text or a file). A refused or partial push records nothing. The submit reads the store again
   and refuses (`draft_differs`, `version_changed`, `nothing_pushed`) when the store's draft is not what was pushed.
   Staged rows are not used: they can be edited or cleared after the push and say nothing about the store.
4. **Preview, then confirm with a hash and a typed phrase, re-read and refuse on drift.** The preview shows what goes
   to review (per locale counts, never text), the version and build, what cannot be undone, and the checks. It
   gives a `confirmHash` over the app, the pushed record and the store as read (version, release type, build,
   listing hashes, tracks, draft) and the **phrase to type** (`submit <identifier> [<version>]`). The submit
   verifies the phrase before it reads anything, reads the store inside the connector right before the write
   and writes only when the hash still matches and nothing blocks (`409 state_changed` with a new preview;
   `409 blocked` with the checks). While anything blocks the preview carries no hash and no phrase.
5. **Checks are data.** Blocking items stop a submit; warnings do not. They cover the draft differing from the push,
   the version, the build (missing, expired, not processed), a locale list that is empty, no screenshots, a locale
   without screenshots (warning), required listing texts (the listing field specs), image sizes and counts
   (`store-asset-specs`; only rules whose number an official page confirms block), images that are not processed,
   a draft push in flight or of unknown outcome, and the release type (see 6).
6. **It never releases and never changes a rollout.** App Store: a version whose release type is not `MANUAL`
   (automatic after approval, scheduled, or unreadable) is **blocked**: this server does not change the release type,
   because changing it is a different decision with different consequences. The review submission carries the
   version only. Google Play: `edits.commit` without `changesNotSentForReview` and with
   `changesInReviewBehavior=ERROR_IF_IN_REVIEW` (the default would cancel a review in progress); the connector writes no
   track, listing or image, so nothing can raise a rollout or complete one. Tracks are read and shown, and are part of
   the hash.
7. **One in flight per app and platform** (`store_submit_claims`, migration 24, with a time to live; a stale claim is
   taken over, the re-read and the hash decide). A draft push in flight, or whose outcome is unknown, blocks a submit.
8. **No blind retry; an unknown outcome is read back where the store allows it.** A lost answer on the irreversible
   request is read back: App Store shows the version in review (success, `confirmedByReread`) or not
   (`502 write_failed`, `not_applied`), or the store cannot be read (`409 outcome_unknown`, which blocks until a
   preview reads the store). **Google Play shows no review state through its API**, so a lost commit
   answer is always `409 outcome_unknown`: the person checks Play Console. Google refuses a second send while changes
   are in review, so a later confirmed submit cannot silently double it.
9. **Audit and events hold ids and hashes.** `listing.submitted`, `listing.submit_failed`, the event
   `listing.submitted` and `credential.use` with purpose `store.submit`. Never a text, a credential, a token or a
   store response body. A successful submit deletes the push record in the same transaction.
10. **The registry and the API description list it.** Four operations (tag `submit`): config, state (database only),
    preview, submit (`destructive`). The default-deny registry test covers the routes.

## Consequences

- A submit of Google Play also sends changes that were made in Play Console and are held back: Google lists none
  of them through the API. The preview says so (`includesChangesNotPushedHere`, `play_pending_changes`).
- Nothing here can recall a submission. The first real submit should be on a test app, with the release type set to manual.
- Whether the Apple request bodies and the Play behaviours hold is UNVERIFIED (see the API page); the connectors fail closed:
  an unexpected answer is an error or `outcome_unknown`, never an assumed success.
- "A second person must approve" and "submit at a time of day" are not built.
