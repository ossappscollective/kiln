# ADR 0065: Per-app control of reviews sent to AI, and scheduled reads of competitor reviews

Status: server, core and web implemented, tested against fakes; **not viewed in a browser**, no real AI provider and no real Apple feed contacted. Two migrations (67, 68).
API: [api/ai](../api/ai.md) ("Review privacy"), [api/competitor-reviews](../api/competitor-reviews.md) ("Scheduled reads"). Builds on [ADR 0055](0055-review-summary-and-competitor-reviews.md)
(review summary, competitor reviews), [ADR 0050](0050-job-queue.md) (the job queue and the scheduler) and [ADR 0056](0056-competitor-listing-watch.md) (the watch cadence).

## Context

Review text went to the AI provider under one workspace switch. A team that wants AI for one app and not for another, or that wants only ratings to leave the
server, had no way to say so. Competitor reviews were read only on demand, so the Competitors section went stale between visits.

## Decisions: what reviews may go to AI

1. **The workspace is the ceiling.** Two new AI settings, `reviewsToAi` (default on, as before) and `competitorReviewsToAi` (default off). An app can only narrow
   what the workspace allows. The app screen shows the choice locked, with the reason, when the workspace turned the kind off.
2. **Per-app policy** (table `ai_app_review_policy`, one row per app, absent = defaults): own reviews `inherit | on | off`, competitor reviews the same, `detail`
   (`text` default: stars, title and text, no name, language, version or date; `full`: adds language, version and day, still never a name; `ratings`: counts only),
   `redact` (default on). Effective value: off when either the workspace or the app says off.
3. **One enforcement point.** `AiService.buildRun` resolves the policy before a task prepares its data and passes it in; tasks cannot reach reviews without it.
   Off gives `409 ai_reviews_disabled` (reason `workspace_off` or `app_off`) before anything is read or sent. In `ratings` mode `review_summary` is built from the
   counts the server already computes (no text, no themes, insight `detail: "ratings"`); tasks that need text (`fix_next`, `review_classify`, reply drafts,
   keyword ideas from reviews) answer `409 ai_reviews_need_text`. The client is never trusted: the web hides buttons, the server refuses.
4. **Redaction is a pure core function** (`redactReviewText`): emails, URLs, phone-like numbers, @handles and the author's name become `[email]`, `[link]`,
   `[number]`, `[handle]`, `[name]`. With `redact` off only the name is still removed. `shapeReviewForAi` is the single shaping function for summary, tags and
   reply drafts; the cache key of a summary includes detail and redaction, so a changed policy never serves a summary made under another one.
5. **Past summaries stay.** Turning a switch off deletes nothing: the card shows the disabled state with the reason and a link, and stored summaries remain
   visible with a note. `DELETE /apps/{id}/ai/summaries` ("Delete AI summaries for this app", confirmed, destructive) removes the stored summaries and reports.
6. **Preview** (`POST .../ai/review-privacy/preview`): the first three reviews exactly as they would be sent, with the allowed flag. It calls no provider.
7. **Audit**: `ai.review_policy_update` with the changes as from-to, the actor and the app; `ai.summaries_delete` with the count.
8. **Competitor reviews to AI** is enforced as a gate only (`gateCompetitorReviews`): no AI task sends them today. A future task must call the gate.

## Decisions: scheduled reads of competitor reviews

1. **Per app** (table `competitor_review_schedules`): `off` (default) / `daily` / `weekly` with a weekday, an optional IANA time zone (default UTC: Kiln has no app or
   workspace zone yet), `paused`, `maxCompetitors` (default 5, at most 10) and `maxReviews` (default 20, at most 50). **Per competitor override** (columns on
   `aso_competitors`): the mode and weekday, or "follow the app". Weekly or daily slots are 05:00 local plus a jitter.
2. **No new loop.** The existing scheduler tick calls `queueCompetitorReviewReads`, which enqueues one job per due competitor on the queue
   `aso.competitor_reviews` (priority 3, heavy), subject to the shared per-workspace limiter and per-tick caps. The handler reads through the same fetch, Apple
   limit and cool-down as the manual "Read" button.
3. **Jitter** is deterministic per competitor (a hash, up to 180 minutes), so runs spread over hours and do not hit Apple at the same minute, and a restart does not reshuffle them.
4. **Volume guard**: newest N reviews only (sorted by date, sliced); a scheduled read whose newest id equals the stored cursor (`reviews_last_seen_id`) is
   `unchanged` and writes only its time. New reviews are counted against the cursor and shown ("3 new reviews").
5. **Failures**: backoff 15 minutes doubling to 6 hours, the slot stays unserved for up to 4 tries, rate limits do not count as failures. At the second
   consecutive failure the existing `review.sync_failed` alert is raised with `source: competitor` (its own dedupe key `...:competitor`, own title and body,
   same inbox, no new alert type). No other notification: new competitor reviews notify nobody.
6. **Apple only.** A Play competitor cannot be given an override (`409 play_reviews_not_available`) and the UI says Google Play has no official API.
7. **Independent of AI.** Reading does not look at the AI switches; they apply only to a later AI step.
8. **Audit**: `aso.competitor_review_schedule_update` (from-to); scheduled reads audit as `aso.competitor_reviews_read` with actor `system`.
9. Rights: schedule read `aso.read`, write `aso.write`; policy read `ai.use`, write `apps.write`, preview `reviews.read`. Everything is scoped by workspace: another workspace's app answers 404.

## Behaviour changes

- The default detail `text` no longer sends language and app version in the summary and fix-next inputs (they were sent before); choose `full` to keep them.
- Unrelated to enforcement but new in the schedule: the manual competitor read answer has `newCount`.

## Next

- A task `competitor_review_summary` that calls `gateCompetitorReviews`.
- An app or workspace time zone, so the schedule needs no zone field.

## Not verified

No real AI provider, no real Apple feed and no real scheduler clock were used; tests use fakes and a fake clock. That Apple's feed is ordered newest first is an assumption (the
read sorts by date anyway, the cursor relies on the newest id). The screens compile and their logic is tested but they were not seen in a browser. Postgres variants of the two
migrations and tables run only with `KILN_TEST_POSTGRES_URL`.
