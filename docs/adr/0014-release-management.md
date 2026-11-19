# ADR 0014: Release management from the app

Status: implemented and tested against fakes on SQLite (the Postgres variants run when `MRM_TEST_POSTGRES_URL` is set); **never
run against App Store Connect or Google Play**. The facts that were not verified are listed in
[api/releases-write](../api/releases-write.md#unverified-check-with-a-real-account).

## Context

A person who wants to ship a version has to leave the app for the stores twice: to choose the build or the version codes and edit
the release fields (version, release type, date, copyright, phased release, release notes), and at the end to press "release".
[ADR 0009](0009-staged-store-drafts.md) already collects listing changes and writes them to a store's **draft**,
[ADR 0010](0010-store-submit.md) hands that draft to review, and [ADR 0008](0008-store-rollout-writes.md) changes a rollout that
is already live. What is missing is the **release fields as draft edits**, the **reads** that make them choosable (a build, a version
code), and the **release itself**: the other write of this server that cannot be taken back.

## Decision

1. **Release fields are staged items, written by the existing draft push.** A new staged kind, `release_field` (one row per
   field, and per language for Play release notes; `target` is the field id, `locale` is empty otherwise). No table changed:
   `staged_changes.kind` is text and the unique index already fits (migration 27 only adds the claims table). The App Store
   "what's new" is **not** a new field: it is the existing listing field `release_notes` (`whatsNew`), staged with the texts.
   Google Play's per language notes belong to the release, so they are a release field of their own.
2. **The draft push stays the only way to write them.** It keeps its switch (`MRM_STORE_DRAFT_WRITE_ENABLED`), its right
   (`store.push_draft`), its preview with `confirmHash`, its re-read right before the first write, its claim, its never-retry rule
   and its read-back of a lost answer. The connectors gained one more kind of write (`fields`), nothing else. The preview shows
   each field before and after, and **checks** the staged values against facts the connector reads next to each field (a build
   that is not processed, expired or unknown; version codes Play does not list; a track without a draft release). A blocking
   check refuses the push (`409 blocked`) in the guard, so it holds on the fresh read too.
3. **Canonical values.** A value is normalized when staged (version codes unique and ascending, a share as a plain decimal, a date
   in UTC, `on`/`off`) and the connectors report the store's value in the same form, so "unchanged" is an exact comparison and the
   hash of a push does not move by itself.
4. **A Play draft cannot hold a share, so the intended share is local.** `Release.userFraction` "can only be set when status is
   inProgress or halted". The staged `user_fraction` is shown as `local`, never written, never used as a default: the release step
   needs its own explicit share. When the two differ the preview warns.
5. **Limits no official page states are warnings.** Play release notes (500 characters), the release name, the copyright and the
   version string are marked UNVERIFIED and produce warnings, never errors: a wrong limit must not block a person.
6. **Release is a separate step, gated exactly like submit.** `MRM_STORE_RELEASE_ENABLED` (default `false`, independent of the draft
   and submit switches); the role action `store.release` (owner and admin, **explicit-only on tokens**: the same table entries as
   `store.submit`); a preview that reads the store and gives `confirmHash` and a **phrase to type**; a re-read inside the connector
   right before the write that refuses on drift (`409 state_changed` with a new preview), on a blocking check (`409 blocked`) and on
   a wrong phrase (`422 confirmation_mismatch`); one release in flight per app and platform (`store_release_claims`, migration 27;
   a draft push or a submit in flight blocks it); never retried; a lost answer is **read back**, never sent again; ids-only audit
   (`store.released`, `store.release_failed`) and the event `release.started`; listed in the API registry and OpenAPI.
7. **The phrase carries what is released.** App Store: `release <identifier> <version>`. Google Play:
   `release <identifier> <track> <percent>%`. The phrase of a Google Play release names the share, and the hash covers the request,
   so a confirmation of 10% cannot release 50% or 100%. The App Store phrase needs the version the store reports, so it is checked
   inside the guard (after the read, before the write); Google Play's needs no read and is refused before anything else.
8. **What can be released.** App Store: a version in `PENDING_DEVELOPER_RELEASE` (macOS is the macOS version of the same
   App Store Connect app); one waiting version, or the marketing version is named (`ambiguous_version`). Google Play: a draft release
   whose version codes Play lists as uploaded; **not** while another release of the track is rolling out (this server does not start
   a second rollout beside a running one: that is a decision for Play Console and the rollout controls). Anything else is a blocking
   check with a reason, and the preview carries no hash and no phrase.
9. **Google Play starts the release with an edit, not a new API.** The draft release gets `status: inProgress` and the share (or
   `completed` for 1), every other release as read, and the edit is committed **without** `changesNotSentForReview` and with
   `changesInReviewBehavior=ERROR_IF_IN_REVIEW`, so a review in progress is never cancelled. App Store: `POST appStoreVersionReleaseRequests`,
   which Apple documents as not cancellable.
10. **Unknown outcomes.** App Store: read the versions back; no longer waiting means released (`confirmedByReread`), still waiting
    is `502 write_failed`, anything else `outcome_unknown`. Google Play: a release with the same codes `inProgress` or `completed` is
    a success, anything else is `outcome_unknown` (a commit can be slow to show, so the old draft is not proof). `outcome_unknown`
    blocks releasing the app until a preview has read the store successfully.
11. **Reads are not writes.** `GET .../release/candidates` and `.../release/editable` use the draft connector (the same one a push
    uses), the credential of the app (audited as `credential.use`, purpose `store.release_read`), the right `listing.read`, a
    per-workspace rate limit and no switch.
12. **Optional workflow detection is out of scope.** Telling a person which CI workflow produced the build would need the build
    links the CI feature already stores; it is not trivial to do correctly (a build number is not a workflow), so it was left out.

## Consequences

- A release can be prepared, previewed and released without leaving the app, with the same safety as a submit: nothing happens by
  accident, every irreversible step names exactly what it does and is checked against the store on the freshest read.
- The release fields are not part of the push record that [submit](../api/submit.md) checks. A build or a version string changed
  after the push is visible in the store and in the submit preview (version, build), not in `draft_differs`. This is deliberate:
  the record exists to protect listing text and graphics; the version and build are read directly.
- Two switches, two rights and two confirmations separate "write a draft", "send to review" and "release": a workspace can turn on any
  one without the others.
- Open decisions, not part of this change: a second person approving a release, a release that waits for the review result,
  halting or completing a rollout from the same screen (the [rollout](../api/rollout.md) controls already do that).
