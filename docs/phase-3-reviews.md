# Phase 3: customer reviews (read side)

A read-only reviews and ratings inbox per app, with internal triage and two events. Replying is a
store write and is **not** built. Reference: [api/reviews](api/reviews.md).

## Done and tested (against fakes)

- Connectors (`packages/connectors`): `AppStoreReviewsConnector`, `PlayReviewsConnector` and the
  iTunes lookup `fetchRatingSummary`, reusing the existing key handling, HTTP plumbing (timeouts,
  redaction, bounded 429 waits) and error mapping. Parsers are tolerant: a missing field never
  throws; an entry without an id or a rating from 1 to 5 is counted as skipped.
- Database: migration 19 (`app_reviews`, `review_sync_state`, `app_rating_summaries`), the drizzle
  schemas, a data migration test. Deleting an app removes its rows.
- Server: incremental, idempotent `syncReviews` (inline route and `review.sync` job), per
  credential serialization, the shared store rate limiter, timeouts, Play 7 day gap warnings, backoff,
  the scheduler (`MRM_REVIEW_SYNC_INTERVAL_MINUTES`, off by default) and retention pruning
  (`MRM_REVIEW_RETENTION_DAYS`).
- Routes: list with filters and cursor paging, summary with its basis, sync, triage; registered in
  the OpenAPI registry with full schemas; roles `reviews.read`, `reviews.sync`, `reviews.triage`.
- Events `review.new_low_rating` and `review.sync_failed` through the log, SSE and signed webhooks.
- Web: a Reviews tab (histogram, average with its basis, versions, weekly trend as inline SVG,
  filters, cards as plain text, triage, Sync now).

All of this is tested with fixtures and fakes on SQLite. **No request was ever made to App Store
Connect, Google Play or the iTunes lookup, and the web tab was not opened in a browser.**

## Not verified (to check with a real account)

- Apple: which App Store Connect API key role may read `customerReviews` (the page names none),
  the values of a response `state`, and the attribute names of `customerReviewSummarizations` (the
  connector can read them, but nothing stores or shows them yet).
- Google: which Play Console permission a read-only service account needs for `reviews.list`
  (Google's guide names "Reply to reviews"; see [credentials](credentials.md#customer-reviews)), the
  order of the list, how long a page token stays valid, and the `tokenPagination` shape beyond
  `nextPageToken`.
- iTunes lookup: the `country` parameter and the rating fields in the answer are not documented on
  the pages checked (see the connector header).
- Postgres: the migration and the queries were not run on Postgres (SQLite only).
- The pace of Apple's `X-Rate-Limit` and Google's 200 requests per hour per app under real load.

## Limits to know

- Google Play returns only the last 7 days and only reviews with a comment. A gap is recorded when
  the server was not reading often enough; reviews missed that way cannot be recovered.
- The store-wide average is the App Store, US storefront only. Google Play has none.
- The first read of an app is a quiet baseline: it stores reviews and sends no low rating events.

## Decisions for the maintainers

- Whether a deep link into the store console should be offered. Neither store documents a stable URL
  to one review, so none is shown.
- Whether to add a workspace wide inbox (out of scope here).
- Whether replying should ever be built: it would be a store write and needs the approval gate every
  other store write has.
