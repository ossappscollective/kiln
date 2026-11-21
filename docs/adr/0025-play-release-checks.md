# ADR 0025: Promote a Google Play release, and check it with Google Play before releasing

Status: implemented and tested against fakes (connector, server, web). **Never run against Google Play.** What was verified on Google's
pages and what was not is listed in [api/releases-write](../api/releases-write.md#check-with-google-play-read-only) and at the end of this file.

## Context

A workflow (or a person) puts a build in a Google Play track that is not production, usually internal testing. The next job is "promote
it to production: write the notes, choose the share, release". The pieces exist ([ADR 0014](0014-release-management.md)): the Prepare
release steps choose a source track, a target track and version codes, stage the release fields, the draft push writes them and the gated
release starts the rollout. Two things were missing:

1. **It was hard to find.** Nothing on the Releases page or in the Next step card said "this internal release can go to production".
2. **No feedback from Google before the release.** After a bundle and a changelog are set, Play Console shows errors and warnings for the
   release. The app showed nothing of the kind, so the first sign of a problem was a refused release.

## Decision

1. **A "Promote to production" entry, nothing new underneath.** On an Android app, a release that serves users (live or rolling out) from a
   track that is not production and has version codes gets a link in its row of the Releases table, a button in the row's details and a
   line in the Next step card. It opens Prepare release on the first step with the source track, the target and the version codes in the
   address (`&from=internal&to=production&codes=241`). The default target is production for every track (internal, closed, open, a custom
   track); the person can change it in the first step. A release already live in production with the same codes is not offered. The codes
   are only **selected**: the person still uses them (stages them), writes notes, names a share and confirms in the last step, exactly as
   before. No gate, switch, right or confirmation changed.
2. **"Check with Google Play" is a read.** `PlayReleaseConnector.checkPlayRelease` opens an edit, puts the proposed release in the track
   (codes, name, notes per language, status and share as the person set them), calls `POST .../edits/{editId}:validate` and **always
   deletes the edit**. It never commits, so nothing is saved and nothing reaches users. Because it changes nothing it is a read of this
   server's rules: `listing.read`, no switch, the credential of the app audited as `credential.use` with its own purpose
   (`store.release_check`), a per-workspace limit of its own (10 a minute, each check is four store calls), errors as fixed sentences.
   Route `POST /apps/{id}/release/play-check`, operation `checkPlayRelease`, MCP tool `check_play_release` (read-only; the answer is text
   from a third party and is marked as such).
3. **Honest about what Google tells us.** The API validates an edit; it does not return the warnings Play Console shows (a missing
   deobfuscation file, the target API level and similar). So a result is "Google found no errors. The Play Console may still show
   warnings", never "no warnings". The sentence travels with the answer (`note`) and is fixed in the web app. An error is shown in Google's
   own words (cut, redacted), either when the release was put in the edit (`stage`) or when the edit was validated (`validate`).
4. **Local checks beside it, no store call.** `checkPlayProposal` (`@kiln/core`, pure): release notes missing for a language that has a
   listing, notes over 500 characters, a version code the target track already holds as live or rolling out (a problem) or a lower one
   (a warning), a share outside 0 to 100%, 100% explained as a completed release, an empty release name, and a sentence that says what the
   state means (a draft goes to nobody, a rollout reaches a share, completed is everybody). They are advice; only Google's answer and the
   gated release decide.
5. **Where it is shown.** In the Confirm step of Prepare release (staged values over the store draft, before "Review and publish all"),
   and in the release dialog (the store draft only: a release starts what the store holds, at the share just named). Neither makes the check a
   requirement: the gated release is unchanged.
6. **The proposal is staged the way the release will be.** A `completed` proposal replaces the track's older completed release in the
   edit, a rollout keeps it, and a release with the same codes is replaced, so a rule Google does not have is not reported as an error.

## Consequences

- A person can see, before releasing, whether Google Play would refuse the release, without leaving the app, and is not led to believe
  that "no errors" means "no warnings".
- The check takes the edit slot of the service account for a moment (the same queue as the other Play reads and writes), and a Play
  Console change by someone else during the check invalidates it (it is retried once).
- A check is not a promise: Google may refuse at release time for a reason `validate` does not apply, and the check cannot tell
  whether the release would wait in Google's review.
- Not part of this change: warnings from Play Console (no API), a pre-launch report, checking an App Store release (Apple has no such
  call; its preview has its own checks), a bulk check.

## Not verified

Read on Google's pages on 2026-11-20. **Verified**: `edits.validate` exists (`POST /androidpublisher/v3/applications/{packageName}/edits/{editId}:validate`,
"Validates an app edit", the request body "must be empty", a success returns an `AppEdit`); an invalid edit makes `edits.commit` throw with no
effect; an edit can be abandoned at any time; Play Console help says errors block publishing and warnings do not, and release notes allow
"up to 500 Unicode characters per language". **Not verified**: which rules `edits.validate` applies, the shape of its error answer (read as an
HTTP 400 with `error.message`), whether `tracks.update` already refuses some releases (reported as a `stage` finding), the release name
limit (Google states none; the 50 in the staged checks stays a warning), and whether Play refuses a version code lower than the one a
track holds (only a warning here). Nothing was run against Google Play.
