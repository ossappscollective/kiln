# ADR 0009: Staged listing and asset changes, pushed to the store as a draft

Status: implemented and tested against fakes on SQLite; **never run against App Store Connect or
Google Play**. The facts that were not verified are listed in
[api/staged-changes](../api/staged-changes.md#unverified-check-with-a-real-account). Submitting or
publishing is **not part of this ADR**: submitting for review is the separate, gated step of [ADR 0010](0010-store-submit.md)
([api/submit](../api/submit.md)); this server never publishes a release.

## Context

After replies ([ADR 0007](0007-review-replies.md)) and rollout changes ([ADR 0008](0008-store-rollout-writes.md))
this is the third write to a store, and the first that carries **files**. People want to collect a change
to the store listing (texts per locale, icon, screenshots, Google Play graphics), look at it, and put it
into the store as a draft that they then review in App Store Connect or Play Console. A draft changes
nothing for users until somebody submits or publishes it, so this is a smaller risk than a rollout,
but it overwrites what is in the store's draft, which someone else may be editing.

## Decision

1. **Staging writes nothing to a store.** A staged change set per app (and so per platform) holds
   _items_: a listing text (locale, field, value) or an asset set (locale, slot, ordered files).
   Sources: **repo** (a file of the connected repository at a commit), **local** (a typed text) and
   **store** (a text from the last read of the store). Staging uses `changesets.write`, viewing uses
   `listing.read`; the stored items are rows of `staged_changes` (migration 23).
2. **Files are kept by reference.** A staged file is a repository path, a commit and a git blob id.
   Bytes are read at push time through the asset index, from the clone roots and under the budgets that
   already apply to assets ([ADR 0005](0005-local-clone-reads.md)). Nothing outside the index is read; the blob id is
   checked again, the format sniffed (PNG or JPEG), and the caps applied (8 MiB per file, 100 files and
   64 MiB per push). A file that changed or vanished is `asset_changed`, never a silent substitution.
3. **Pushing a draft is a different action from submitting.** `POST .../staged/push` writes to the store's
   _editable draft_ only. It never submits for review, never sends for review, never releases, never
   publishes, and the result says `draft: true, submitted: false`. A successful push records what it wrote
   (hashes and ids, `store_draft_pushes`, migration 24) so that the separate submit step of
   [ADR 0010](0010-store-submit.md) can check the store against it.
4. **A kill switch, off by default.** `KILN_STORE_DRAFT_WRITE_ENABLED=true` turns it on. While off,
   preview and push answer `409 store_draft_disabled` (after the rights check) and no connector is built.
   Staging, viewing and the config route work.
5. **A separate right.** `store.push_draft`, admin and up, explicit-only on API tokens (the action
   list must name it; a token with no list never gets it). It is not `listing.*`: a core test keeps
   `listing.read` the only listing action.
6. **Preview, then confirm with a hash, re-read and refuse on drift.** The preview reads the store's
   draft and shows each item before and after. `confirmHash` covers the app, the staged items (text hashes,
   blob ids) and the draft the preview read. Push re-reads the draft inside the connector's write and
   writes only when it still matches, else `409 state_changed` with a new preview.
7. **One write in flight per app and platform**, in the database (`store_draft_claims`, migration 23).
   A claim expires after 5 minutes, a push after 4 minutes.
8. **No blind retry; an unknown outcome is read back.** Writes never retry (also not a 429). A timeout or
   a cut connection after the write started reads the draft: it holds the staged items (success,
   `confirmedByReread`), still the old draft (App Store: `502 write_failed`, `outcome: not_applied`; Google
   Play: `409 outcome_unknown`, because a commit may be slow to show), some of them (`409 draft_partial`), or
   cannot be read (`409 outcome_unknown`, which blocks pushes to the app until a preview reads the store).
9. **The App Store write is not atomic.** Texts and screenshot sets are written one request at a time
   to the editable version. A refusal part way is `502 draft_partial` with what was written (kept) and
   what failed; what was written is marked pushed, a second push skips what matches.
10. **Google Play is one edit.** Texts (`edits.listings`) and images (`edits.images`) are written in one edit
    that is committed with `changesNotSentForReview=true` and `changesInReviewBehavior=ERROR_IF_IN_REVIEW`.
    If Google refuses the flag the answer is `draft_not_allowed` and nothing is committed: the commit is never
    retried without the flag, because that may send the changes for review.
11. **Only what can be pushed is stageable.** App Store: description, keywords, promotional text,
    release notes, marketing and support URL, screenshots. Not name, subtitle and privacy URL (Apple keeps
    them on the app info, not the version), not previews, not the app icon (it comes with the build), not
    `imessage:` devices. Google Play: title, short and full description, icon, feature graphic, phone and
    tablet screenshots (and TV/Wear); not the promo graphic. A set replaces the whole set. Empty texts are
    refused (an empty text would erase one in the store).
12. **Audit and events hold ids and hashes, never texts or credentials.** `staged.*` (staging, ids and
    oids), `listing.draft_pushed` and `listing.draft_push_failed` (counts, ids, the confirm hash, the
    commit mode). The event `listing.draft_pushed` is sent only for a push that reached the store (or whose
    unknown outcome was confirmed). Credentials are used for the purpose `store.draft_push` and never
    logged; store errors are redacted before they are shown.

## Consequences

- **Apple deprecated the set-based screenshot resources** (App Store Connect API 4.5.1, in favour of the App Asset
  Library), so the connector writes screenshots through the **App Asset Library** (library, reference data, images,
  placements, ordering requests; read from Apple's pages on 2026-11-18). The placement group of a set is found
  from Apple's reference data and the pixel size, never from a hard-coded id. The library has no checksum, so
  the SHA-256 is kept in the image's `referenceName`; replacing a set deletes placements, not library images (the
  library is shared with custom product pages). Details and what is UNVERIFIED:
  [api/staged-changes](../api/staged-changes.md#unverified-check-with-a-real-account).
- The change set is per app and is not a pull request: it lives in the server's database, not in the repository.
  A person who wants the change in the repository uses the existing [change sets](../api/repositories.md).
- Asset reverse sync (store images into the repository) is not built: see
  [api/staged-changes](../api/staged-changes.md#reverse-sync-store-to-repository).
- Nothing here was run against a real store. The first real push should be on a test app.

## Amendment (2026-11-20): a draft release without the hold-back

Google refuses `changesNotSentForReview=true` for apps where managed publishing is off (`draft_not_allowed`). That blocked "Promote to
production" for such an app: its push holds nothing but the draft release of a track (track, version codes, release notes). A draft
release is not served to users by a commit (`status: draft`), so for an edit that holds **only** that, and only after Google refused the
hold-back, the connector commits once more without `changesNotSentForReview` (`changesInReviewBehavior=ERROR_IF_IN_REVIEW` stays).
The result says `commit: draft_release`. An edit with a store listing text or an image is never committed that way: decision 10
above stands for those. UNVERIFIED against real Google; the first push of such an app is the test, and the rollout is still the
separate, gated release step.
