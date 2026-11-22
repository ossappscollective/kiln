# ADR 0049: TestFlight feedback and crash reports: read from App Store Connect, triaged in Kiln, never written back

Status: implemented and tested against fakes; **never run against App Store Connect** (what is not verified is listed in
[api/testflight-feedback](../api/testflight-feedback.md#unverified-check-with-a-real-account) and in the
[spike](../spikes/testflight-feedback.md)).

## Context

Beta testers send feedback (a comment, optionally screenshots) and crash reports from TestFlight. They land in App Store Connect and in
Xcode Organizer, which a release manager does not open every day. Kiln already reads store reviews, triages them and alerts on them
([ADR 0027](0027-review-feed-and-new-review-alert.md)); beta feedback is the same kind of inbox, one step earlier in the life of a build. The
[spike](../spikes/testflight-feedback.md) read Apple's official pages before any code: the two list endpoints
(`betaFeedbackScreenshotSubmissions`, `betaFeedbackCrashSubmissions`), the crash log resource (`betaCrashLogs`), the key roles
(Admin, App Manager or Developer) and what is not documented (a real response, paging links, the behaviour of an app without TestFlight use).

## Decision

1. **A connector that reads only.** `AppleTestFlightFeedbackConnector` (`packages/connectors/src/apple/appstore-testflight-feedback.ts`) lists
   feedback (200 per page, newest first, at most 2 pages and 400 items per sync), reads the crash log of a new crash and, on request, fresh
   screenshot links. Capability `testflightFeedbackApi` (Apple true, Google Play false: Play has no equivalent and a sync is refused with
   `422 testflight_not_supported`). Parsers are tolerant: an unknown field changes nothing, a missing one gives null, a malformed item is
   skipped with a warning. A 403 or 404 on one of the two lists is a warning; both refused fails the sync.
2. **A stored copy, additive.** `testflight_feedback` (one row per submission) and `testflight_sync` ([migration 54](#migration-54)).
   A sync upserts what it read and deletes nothing; triage fields are never overwritten by a sync. A failed sync keeps what was stored and
   records the failure. Reading the list asks no store.
3. **Triage like reviews.** Status `new`, `seen`, `in_progress`, `resolved`, `ignored`, an assignee (a member of the workspace) and an
   internal note (2,000 characters). Rights are the review ones: `reviews.read`, `reviews.sync`, `reviews.triage`. Triage is Kiln's data and
   is never sent to Apple. Audit rows: `testflight.synced` (counts only) and `testflight.triage` (ids and status, never the note).
4. **Tester privacy.** The email is stored (Apple shows it to the team for invited testers; testers of a public link are anonymous unless they
   typed one). It is shown only to users who can write settings (admin and up). Everyone else sees a pseudonym: `tester_key`, the first six
   hex characters of `sha256(workspace + lowercased email)` in upper case, stable per workspace so "the same tester again" is visible
   without the address. Tester names are never stored. The email, the comment and the log are never in an alert, an event, a webhook or an
   audit row.
5. **Screenshots: sizes stored, links on request.** Apple returns signed, expiring links. Kiln never stores or logs them; only width and
   height are kept. `GET .../screenshots` asks Apple for fresh links and answers with `Cache-Control: no-store`. The content security policy
   (`img-src 'self' data:`) is **not relaxed**: the UI shows the links as links that open in a new tab, not as inline images. Relaxing the
   policy for an unverified host would weaken every page of the app for one view.
6. **Crash logs and grouping.** The log text is stored capped at 64 KiB with a `truncated` flag. The signature is computed from the full
   text before capping: the first `Exception Type:` value plus the top frame of the crashed thread, with offsets, file and line and
   addresses removed ([rule](../api/testflight-feedback.md#crash-grouping)). A log whose layout is not recognised has no signature and
   is listed alone; an address-only (unsymbolicated) frame groups by image name and says so in the UI. A wrong grouping can only merge or
   split a list, never change data.
7. **Retention.** `KILN_REVIEW_RETENTION_DAYS` (default 365, `0` keeps everything), applied by `pruneTestflight` inside the existing review
   upkeep. It matches Apple's own one year for feedback; Apple's crash log download window (120 days) is why Kiln keeps the log it has read.
8. **Scheduling reuses the review scheduler.** The `review.sync` job handler is wrapped: after the reviews of an app it runs the TestFlight
   read of the same app. There is no second scheduler, no new setting, and the same lease, backoff and failure counting. A manual sync is
   `POST .../testflight/sync` with the per-workspace app-sync limiter.
9. **Alerts.** `testflight.feedback` (severity info) and `testflight.crash` (severity warning), group `reviews`, default channel inbox,
   audience `reviews.read`, dedupe per submission for 30 days. The **first sync of an app is a baseline and emits nothing**. After that, up
   to 10 events per kind per sync, then one grouped event (`grouped`, `count`). The payload is ids, build number, version and platform
   only. Digests, chat routing and webhooks (`testflight.feedback`, `testflight.crash`) work through the existing pipeline; no chat default
   route was added. Texts in four languages (`apps/server/locales/alerts`).
10. **UI.** A view `TestFlight` of the Reviews page (`?view=testflight`, `requires: reviews.read`, shown only when an Apple app is in scope):
    Feedback and Crashes tabs, filters (version, build, status, tester), crash groups, a list with a detail (comment, device facts, crash log
    in a monospace block with copy, screenshot links on request, triage), a sync button, an App Store Connect link-out and empty states.
    Design tokens only; all strings in the `testflight` catalog (en, fr, es, de); server texts through `coded()`.

## Write side: documented, not built

Apple offers `DELETE /v1/betaFeedbackScreenshotSubmissions/{id}` and `DELETE /v1/betaFeedbackCrashSubmissions/{id}`. They are **not built**:
a delete cannot be undone, the feedback is also the tester's record in Xcode Organizer, and the shapes cannot be checked without an account.
If it is ever added, it should follow the other store writes: a flag off by default (`KILN_TESTFLIGHT_DELETE_ENABLED`), a `testflight.delete`
action for owner and admin (explicit-only for tokens), step-up confirmation, a dry run that names the submission and its date, an audit row
with the id and never the text, and no retry after an unknown outcome. The local row is marked `deleted` only after Apple answers 204.

## Migration 54

`packages/db/src/migrations-testflight-feedback.ts`: `testflight_feedback`, `testflight_sync`, with indexes on workspace, app and creation
date. No foreign key to apps: `deleteApp` removes the rows. Both schema files and a migration test
(`migration-testflight-feedback.test.ts`) are in step.

## Consequences

- Release managers see beta feedback and crashes next to store reviews, with owners and states, without opening App Store Connect.
- Crashes of one cause are one line in a group list; a changed log layout degrades to "no group", not to a wrong one.
- Reading reuses the review job, so a workspace gets no new background load beyond up to two list reads per app per review cycle.
- Everything about the real shape of Apple's answers is unverified; fixtures follow the documented names and the parsers tolerate variation.
- Follow-ups: record real responses from a test account into the fixtures; the delete write above; inline screenshots if a verified image host
  can be allow-listed; Android internal testing feedback has no API and is out of scope.
