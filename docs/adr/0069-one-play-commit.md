# ADR 0069: One Google Play edit, one commit, for texts, graphics and release

Status: connector, server and web implemented and tested against fakes. **Not verified against real Google Play**: no store was contacted. No migration (the last is 73).
API: [api/pending](../api/pending.md) (the combined step), [api/staged-changes](../api/staged-changes.md). Builds on [ADR 0015](0015-pending-and-batch-publish.md).

## Context

A person published "OSS Card Wallet, PDF & OCR" (version code 90, internal to production) and got `changes_in_review - HTTP 409 - store HTTP 400`. The texts and screenshots were in review at Google, and the production release stayed a draft.

Root cause (confirmed by reading the code, not by seeing the run): the plan was `push_and_submit` followed by `release` (not direct). Each of them opened its own Play edit and committed it for review, so there were two sending commits. The first one put everything in review; the second one was refused by Google with `CHANGES_ALREADY_IN_REVIEW` (HTTP 400, mapped to 409 `changes_in_review`). The old plan even warned that "the release step may be refused". That the run was exactly this plan is inferred from the symptom: the kept run was not available.

## Decision

1. **One edit, one commit.** On Google Play, `push_and_submit` together with `release` is one step in the same edit: listings, images, the release on the track (`inProgress` with the share, or `completed` for 100 percent) and then `:validate` and a single `:commit`. The plan holds one sending step, with one irreversibility confirmation (one typed phrase, or one step-up bound to the plan hash). The plan's rights and switches are the union (`store.push_draft`, `store.submit`, `store.release`, and their switches). The description of the step says what it does: texts, graphics and release go to review together.
2. **Never two sending commits in a plan.** `submit` with `release` on Google Play is blocked (`two_review_commits`). A push of a draft plus a release stays possible (the draft push does not send anything). The draft-only path (`push_draft`) is unchanged.
3. **A refusal leaves nothing partial.** Every refusal before the commit deletes the edit. A commit refused with `ERROR_IF_IN_REVIEW` does not invalidate the edit, and the connector deletes it as well: texts, graphics, tracks are as they were.
4. **Changes in review.** Google exposes no "changes in review" read, so Kiln does not pretend to have one: it learns of it from the refusal, and from the kept runs for the plan hint. Kiln always sends `changesInReviewBehavior=ERROR_IF_IN_REVIEW`, except for an explicit, separately confirmed option, "replace the review in progress" (`replaceReview: true` on `push_and_submit`), which sends `CANCEL_IN_REVIEW_AND_SUBMIT`. It cancels the review in progress, sends all changes (including what was in the review) and the app loses its place in the queue. It has its own plan hash: a step-up or a phrase for the plain plan does not cover it. After a `changes_in_review` failure the recommended plan preselects the replace variant, but nothing runs until the person confirms.
5. **Partly published.** A kept run whose first sending step applied and whose release did not is shown as "Partly published: texts and graphics were sent for review; the release was not." (and, for a release left as a draft, "The release is still a draft in Google Play."). It is not a new phase of the app-state model: it is the failure phase with another headline and reason.

## What Google says (quoted, from the API reference for `edits.commit`)

- `changesInReviewBehavior` `ERROR_IF_IN_REVIEW`: the commit fails when changes are already in review (HTTP 400, `FAILED_PRECONDITION`, `CHANGES_ALREADY_IN_REVIEW`) and "won't invalidate the edit".
- `CANCEL_IN_REVIEW_AND_SUBMIT`: cancels the review in progress and sends all changes. This is Google's default when the parameter is not set, which is why Kiln always sets it explicitly.

## Recovering the state of the report (texts and graphics in review, production release in draft)

Nothing needs to be repaired in the data: Google holds the texts and graphics in review, and the production release is a draft on the track. Choose one.

**In Play Console** (no Kiln step runs):

1. Open the app, then Publishing overview. The texts and graphics are listed under "Changes in review". Check there that the review is not finished yet.
2. Either wait for the review to finish, or open Publishing overview and remove the changes from review (Play Console may name it "Remove changes from review"; the exact wording differs by account and is not verified here), which returns them to unsent changes.
3. Release > Production: open the draft release (version code 90), check the countries, the release name and the notes, then "Review release" and "Start rollout to Production" (or "Send changes for review" when Publishing overview asks for it). Set the rollout share you want (the staged release asked for it).

**In Kiln:**

(a) Replace the review and send everything together. Pending changes > the failure block of the app > "Replace the review in progress with everything together". The plan opens with one step: it sends the texts, the graphics and the release in one edit and one commit, with `CANCEL_IN_REVIEW_AND_SUBMIT`. Add the share of users, read the notice that it replaces the review in progress and that the app loses its place in the review queue, then confirm with the typed phrase or the step-up. Use it when you want the release to go with the texts and are fine to lose the place in the queue.

(b) Wait, then release. Leave the review alone. When Google has finished the review of the texts and graphics, publish again with the direct release of the staged build (the plan then has one `release` step with `direct: true` and your share). That commit holds only the release, so it does not conflict with anything.

Whichever path is used, the other store data is not touched.

## Consequences

- A plan can no longer produce two sending commits on Google Play (tested over every combination of the five steps).
- The recovery from a refusal is explicit and confirmed; it is never automatic and never a fallback.
- Google Play has "changes in review" state that Kiln can only learn from a refusal: a plan made while a review is running still fails at the commit (cleanly, with nothing partial).

## Not verified

- Whether Google accepts a single edit that changes listings, images and a track together and `:validate`s it as the fakes do.
- How `CANCEL_IN_REVIEW_AND_SUBMIT` behaves in practice (what is sent, how long the queue takes again).
- The Play Console wording and menu names in the recovery above.
