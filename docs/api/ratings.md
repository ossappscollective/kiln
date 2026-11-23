# API: ratings and health

Both endpoints read stored data and ask no store. They need `reviews.read` and are listed in the operation registry (`getAppRatings`,
`getAppHealth`; see openapi.md). Decision and honesty rules: docs/adr/0052-ratings-health.md.

## GET /api/workspaces/{workspaceId}/apps/{appId}/ratings

Query: `days` 7 to 730 (default 90, counted back from today, UTC), `granularity` `day` | `week` | `month`, `country` `all` or a two letter code taken
from `countries`. `400 invalid_request` with `issues` for a bad value, `404 not_found` for an unknown app.

Answer: `store`, `from`, `to`, `granularity`, `country`, `historyStart` (the first day Kiln has a reading, or null), `capabilities`
(`count`, `stars`: false for Google Play), `countries` (the last reading of each country read: `average`, `count`, `newCount`, `newAverage`,
`change`, `day`), `summary` (`average`, `count`, `newCount`, `newRatingsKnown`, `written`: written reviews by stars), `buckets` (one per period:
`average`, `count`, `newCount`, `newStars`, `newUnknown`, `dayAverage`, `reset`, `spansGap`) and `written` (stars of the reviews Kiln stored, per bucket).

Rules: the stores keep no history, so rows begin at the first sync; a bucket with no reading has `average: null` (never 0); a count may fall;
`newRatingsKnown` is false until two days of readings exist; `newAverage` is null when Apple's rounding is bigger than the change.

## GET /api/workspaces/{workspaceId}/apps/{appId}/health

Query: `days` 7 to 730. Answer: `store`, `unit` (`perSessions` for the App Store, `share` for Google Play), `setup` (`setupCode`, `lastErrorCode`,
`lastOkAt` of the analytics source, or null), `hasData`, `days` (`crash`, `freeze`, `crashMentions` per day; null is "no number"), `versions` (newest first:
`crash`, `freeze` with `rate`, `volume`, `steady`, and `change` against the previous version) and `finding` (the regression, or null).

The web tab Ratings and health (`#/portfolio/<app>/insights?view=ratings&section=ratings|reviews|stability|releases|countries`) calls both with the
range and the period before it, and works out every change on the client from the buckets.

See docs/api/health.md for the regression rule.
