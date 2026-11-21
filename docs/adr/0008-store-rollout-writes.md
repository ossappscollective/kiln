# ADR 0008: Changing a store rollout

Status: implemented and tested against fakes on SQLite; **never run against App Store Connect or
Google Play**. The facts that were not verified are listed in [api/rollout](../api/rollout.md#unverified-check-with-a-real-account).

## Context

After replies to reviews ([ADR 0007](0007-review-replies.md)) this is the second write to a store. It
changes **who receives an update**: Google Play's staged rollout share, and the App Store's phased
release. It affects every user of an app at once, and two of its changes (complete the Play rollout,
release to all on the App Store) cannot be undone from here. It uses the pattern of ADR 0007, with
the differences that follow from a state that someone else can change while a person is deciding.

## Decision

1. **A kill switch, off by default.** `KILN_STORE_ROLLOUT_ENABLED=true` turns it on. While off, state,
   preview and apply answer `409 rollout_disabled` and no connector is built.
2. **A separate right.** `releases.rollout`, admin and up. An API token gets it only when its action
   list names it (`tokenExplicitOnlyActions`, as for `reviews.reply`).
3. **Preview, then confirm with a hash.** A preview reads the live state and returns the current
   state, the proposed state and a `confirmHash` of the request and the state it was made from.
   Apply requires the hash.
4. **Re-read and refuse on drift.** Apply reads the store again inside the connector's write (for
   Google Play, inside the edit, before the update) and writes only when the state still matches the
   hash. A store that changed in the meantime is `409 state_changed` with the new state and a new hash.
5. **Only the changes that are safe to offer.** Google Play: raise the share (never lower it; the
   one way down is halt), halt, resume (a halted release only), complete. App Store: pause, resume,
   release to all; no share can be set (Apple decides it per day) and a finished phased release is
   never touched. Complete and release to all are marked `irreversible` and say so in the preview.
6. **One write in flight per app and platform**, kept in the database (`store_rollout_claims`,
   migration 22) so it holds across processes. A claim expires after 3 minutes. Google Play edits of
   one service account are also serialised in process, as for the read-only connector.
7. **No blind retry.** Writes never retry, also not a 429. A timeout, a cut connection or a 5xx on the
   write is an unknown outcome: the server reads the store back. Found: success
   (`confirmedByReread`). The old state: a confirmed failure on the App Store (it answers
   synchronously), but only `outcome_unknown` on Google Play (a commit can be slow to show). Unreadable
   or ambiguous: `outcome_unknown`, which blocks writes to that app until a read succeeds.
8. **Google Play never cancels a review.** The commit's default, `CANCEL_IN_REVIEW_AND_SUBMIT`, would
   cancel changes in review. The connector sends `ERROR_IF_IN_REVIEW` instead.
9. **Audit and events hold ids and values, never credentials.** `release.rollout_changed` (audit and
   event, in one transaction) and `release.rollout_failed` (audit) hold the app, store, target,
   action, the before and after (status and share, or phased state), the hash and whether the outcome
   was confirmed by a re-read.
10. **The registry is default-deny.** Four operations in `operations/registry.ts` (tag
    `rollout`): config (`apps.read`), state and preview (`releases.rollout`, read), apply
    (`releases.rollout`, destructive).

## Consequences

- Nothing is sent to a store unless an operator turned the switch on and an admin confirmed a preview
  that is still true.
- The state shown is not stored: it is read from the store each time, so a person always decides on
  what the store says now. The stored releases of an app catch up with the next sync.
- Because the Play share cannot be lowered, a rollout that went wrong is halted, and fixed in Play
  Console or with a new release. This is deliberate.
- The App Store connector needs an `appStoreId`, so an app that was not synced yet is refused
  (`app_not_synced`) before anything is called.
