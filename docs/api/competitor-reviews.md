# Competitor reviews

Public App Store reviews of the competitors an app follows ([aso.md](aso.md)), for the Reviews page. **Apple only.** Google Play has no official
way to read the reviews of an app you do not own, and Kiln does not scrape Play pages: a Play competitor is listed with `state: unavailable`.
Design and limits: [ADR 0055](../adr/0055-review-summary-and-competitor-reviews.md).

## `GET /workspaces/{workspaceId}/apps/{id}/aso/competitor-reviews?days=28`

Right `aso.read`. Reads only what is stored; calls no store. `days` 1 to 90. Answer: `days`, `competitors[]` (`competitorId`, `name`, `store`, `country`,
`state` `ok` or `unavailable` with `reason: play_has_no_review_api`, `checkedAt`, `count`, `average`, `trend` {`earlier`, `recent`: mean of the first and
second half of the period}, `stars` [1..5], `latest[]` (id, rating, title, text cut to 300, version, at)), `own` (the same figures for this app from its
stored reviews; `null` without `reviews.read`), `retentionDays` (90), `source`, `notice`.

## `POST /workspaces/{workspaceId}/apps/{id}/aso/competitors/{competitorId}/reviews/refresh`

Right `aso.write`; rate limited per workspace. Reads Apple's feed `https://itunes.apple.com/{country}/rss/customerreviews/id={id}/sortby=mostrecent/json` once (the
storefront of the competitor, one page, at most 50 reviews) through the SSRF-safe ASO fetch and the Apple limit and cool-down. At most once per 15 minutes per
competitor: inside that window the answer is `state: recent` and nothing is called. Answer: `{ competitorId, state: read | recent, fetched, stored, checkedAt }`.
Errors: `409 play_reviews_not_available`, `429 rate_limited` (with `Retry-After`), `502 source_failed | source_unavailable`, `504 source_timeout`.

## What is stored

Per review: the feed's id, stars, title (200 characters), text (1,000), app version, day. Never the author. At most 90 days and 200 reviews per competitor;
older ones are removed on the next read; unfollowing or deleting the app removes all. The audit action `aso.competitor_reviews_read` holds ids and counts only.
Nothing here is sent to an AI model.

## Scheduled reads

Optional and off by default ([ADR 0065](../adr/0065-ai-review-privacy-and-competitor-schedule.md)). **Apple only**: Google Play has no official API for reviews of an app you do not own,
and Kiln does not scrape it. Reads run through the existing job queue (`aso.competitor_reviews`), the same limits, cool-down, backoff and failure alert as the manual read; no new scheduler loop.
Reading does not depend on the AI switches.

- `GET /workspaces/{ws}/apps/{id}/aso/competitor-review-schedule` (`aso.read`): `{ schedule: { mode: "off"|"daily"|"weekly", weekday: 0..6|null, timezone: string|null }, paused, maxCompetitors, maxReviews, updatedAt, updatedBy, nextRunAt, limits, competitors[], canEdit, notice }`. Each competitor: `competitorId`, `name`, `store`, `supported`, `override`, `effective`, `lastReadAt`, `newCount`, `failures`, `lastError` (a code: `timeout`, `rate_limited`, `invalid_input`, `unavailable...`), `backoffUntil`, `nextRunAt`.
- `PUT` the same path (`aso.write`): any of `mode`, `weekday` (required for weekly; 0 is Sunday), `timezone` (IANA or `null` for UTC), `paused`, `maxCompetitors` (1 to 10, default 5), `maxReviews` (1 to 50, default 20). Audit `aso.competitor_review_schedule_update` (from-to).
- `PUT /workspaces/{ws}/apps/{id}/aso/competitors/{competitorId}/review-schedule` (`aso.write`): `{ mode, weekday }` or `null` to follow the app. A Play competitor answers `409 play_reviews_not_available`.

Times are 05:00 in the zone plus a stable jitter of up to 3 hours per competitor. At most `maxCompetitors` are read per run. A read keeps only the newest `maxReviews`; when the newest id is the stored
cursor nothing is stored (`unchanged`). After a failure the next try waits 15 minutes, doubling to 6 hours; the second failure in a row raises `review.sync_failed` with `source: competitor`
(see [alerts](../alerts.md)). Scheduled reads audit `aso.competitor_reviews_read` with the actor `system`. The manual refresh answer now also has `newCount`. Another workspace's app answers `404`.
