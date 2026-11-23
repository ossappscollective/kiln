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
