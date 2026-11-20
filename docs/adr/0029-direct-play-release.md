# ADR 0029: Release to production directly on Google Play (no draft first)

Status: implemented and tested against fakes (connector, server, web). **Never run against Google Play.** What was not verified is listed
at the end and in [api/releases-write](../api/releases-write.md#unverified-check-with-a-real-account).

## Context

The path for a Google Play release was three gated steps: push the draft ([ADR 0009](0009-staged-store-drafts.md)), submit it
([ADR 0010](0010-store-submit.md)), release it ([ADR 0014](0014-release-management.md)). A real user (an app with **managed publishing
off**) promoted a build to production, pushed the draft, and was then stuck: Google refuses `changesNotSentForReview` when managed
publishing is off (the push falls back to a draft release, commit `f0fed91`), the pending view had no item for "a draft release waits
to be released" (so "Review and publish all" was greyed and said "Nothing pending"), and the user said: "next time I do not want to
go through a draft first, I want to push to production and submit for review directly".

For Google Play there is no separate submit. A commit **without** `changesNotSentForReview` sends the edit to Google's review
(`play-submit` does exactly that; the release step already commits a track release this way).

## Decision

1. **A direct release is the release step with `direct: true`, nothing else underneath.** One Play edit: read the track; if it holds
   **no draft release with the version codes**, build the release from the **staged** release fields (version codes, release name, notes
   per language), status `inProgress` with the typed `userFraction` (`completed` for 100%, no fraction), every other release of the
   track sent back as read (the logic of the draft push, `#applyFields`/`#readTrack`, and of "Check with Google Play", which also drops
   the older completed release when the proposal is completed), and commit **without** the hold-back. Google then reviews it and
   publishes after the review. A draft with these codes that already exists is released as it is (today's behaviour), with a warning.
   A release that already holds the codes, or codes Google does not list, **block**.
2. **Gates unchanged, none weakened.** `MRM_STORE_RELEASE_ENABLED` (default off), `store.release` (admin and up, explicit-only on
   tokens), preview with `confirmHash` and the typed phrase `release <identifier> <track> <percent>%`, a re-read right before the write
   and refusal on drift (`state_changed`), one write in flight per app (the release claim), never retried, a lost answer is read back,
   audit `store.released` with ids and counts only (`direct`, `created`; never a note) and the event `release.started`. The share is
   always typed by the person: a staged intended share only pre-fills nothing on the server. The `confirmHash` also binds hashes of
   the staged name and notes, so a note changed after the preview needs a new preview. The batch and the single step run the same
   service (`previewRelease`/`applyRelease`); the batch step is `{ type: "release", direct: true, ... }`.
3. **The preview says what happens in plain words:** which version codes, which track, to whom (a share, or everybody), in which
   languages the notes are, "Google reviews this release before users get it; it cannot be undone from here". No note text is in any
   answer.
4. **Default plan.** With only release fields staged (no listing text or graphics), "Review and publish all" on Google Play is ONE step
   "Release to production" (the share still needs input), not push + submit + release. "Save as a draft only" is the explicit push
   alone. A push and a direct release cannot share a plan (the release would find the draft the push wrote, and that is the old path).
   The existing three-step path stays available (staged listing texts or graphics, "Advanced: do one step").
5. **Pending.** A pushed draft release is a pending item `draft_release` (next step `release`): from the push record of the app (the
   manifest gains an optional `release: { track, codes }`, JSON, no migration) and from draft releases of the last sync in
   `production` (or any track when the app pushed something). A push that held only release fields no longer shows a "submit" item
   or a submit step: Google Play has nothing to submit for them. Releasing removes the item. The banner, the chips and the detail
   follow the newer of the summary and the view, and the detail reads again when the summary is newer and says something else.
6. **Default share per app.** The settings of an Android app hold "Default share for Google Play releases" (a whole percent 1 to 100,
   empty means ask). It is stored in `workspace_settings` under `app.<appId>.release` (the `ai-config.ts` precedent, no migration),
   read and changed by `GET/PUT /apps/{id}/release-settings` (read `apps.read`, change `apps.write`, audit
   `app.release_settings_update` with old and new values), and removed with the app. The Release step (Advanced > Release), the
   direct "Release to production" step in the plan dialog, and the share in the Build step (the promote flow) start from it. It only
   pre-fills: the person can change it, a staged `user_fraction` wins over it, and a pre-filled share is not a confirmed share (the
   typed phrase `release <identifier> <track> <percent>%` still names it).
7. **Staged rollout only when possible.** `rolloutOffer` in `@mrm/core` (pure, tested) decides whether the share is asked:
   - No earlier production release in the stored releases (none `live`, `rolling_out` or `halted` in `production`, as of the last
     sync; `earlierProductionRelease` in the settings answer): no staged rollout is possible, the share input is hidden, the release
     is made at 100% (`completed`, no `userFraction`), and the screen says "This is the first release in production: Google Play does
     not offer a staged rollout for it." Only the production track follows this rule.
   - Per-app "Staged rollout on Google Play": `auto` (default; offered when an earlier production release exists), `always_ask`
     (always offered, for what the stored releases cannot show), `never` (always 100%).
   - If Google refuses the share at "Check with Google Play" or at the release (the words mention a fraction or a rollout, and a
     share below 100% was asked), the screen says "Google Play did not accept a staged rollout for this app: release to everyone
     instead or change the setting." Nothing is retried by itself, and an unknown outcome is never worded as "not accepted".
8. **MCP.** The MCP server has no release write tool (store writes are API only), so there is nothing to keep consistent there;
   `check_play_release` is unchanged and stays valid for this path.

## Not verified (UNVERIFIED against real Google)

- That a commit without `changesNotSentForReview` of a track update sends the edit to review, and that Google publishes after review
  when managed publishing is off. Inferred from the `edits.commit` flag and from `play-submit`.
- That `tracks.update` accepts an `inProgress` or `completed` release with no draft first, and what it does to a completed release
  beside an older one (sent as the check stages it: the older completed release left out).
- Which error Google gives for a share it does not accept (see "Staged rollout only when possible": shown, never retried), and which
  apps Google offers a staged rollout for. Google documents a rollout for updates, not for the first publication; it does not
  document, and the API does not tell, that small apps get no rollout option (reported by a person).
