# Phase 3: customer reviews

A reviews and ratings inbox per app and across all apps, with internal triage, events, and
**replies (the first store write of this product, off by default)**. Reference:
[api/reviews](api/reviews.md), [ADR 0007](adr/0007-review-replies.md).

## Done and tested (against fakes)

- Connectors (`packages/connectors`): `AppStoreReviewsConnector`, `PlayReviewsConnector` and the
  iTunes lookup `fetchRatingSummary`, reusing the existing key handling, HTTP plumbing (timeouts,
  redaction, bounded 429 waits) and error mapping. Parsers are tolerant: a missing field never
  throws; an entry without an id or a rating from 1 to 5 is counted as skipped.
- Database: migration 19 (`app_reviews`, `review_sync_state`, `app_rating_summaries`), the drizzle
  schemas, a data migration test. Deleting an app removes its rows.
- Server: incremental, idempotent `syncReviews` (inline route and `review.sync` job), per
  credential serialization, the shared store rate limiter, timeouts, Play 7 day gap warnings, backoff,
  the scheduler (`KILN_REVIEW_SYNC_INTERVAL_MINUTES`, off by default) and retention pruning
  (`KILN_REVIEW_RETENTION_DAYS`).
- Routes: list with filters and cursor paging, summary with its basis, sync, triage; registered in
  the OpenAPI registry with full schemas; roles `reviews.read`, `reviews.sync`, `reviews.triage`.
- Events `review.new_low_rating` and `review.sync_failed` through the log, SSE and signed webhooks.
- Web: a Reviews tab (histogram, average with its basis, versions, weekly trend as inline SVG,
  filters, cards as plain text, triage, Sync now).

### Replies and the workspace inbox (added later)

- Connectors: `replyToReview` (Apple `customerReviewResponses`, Google `reviews.reply`), Apple
  `deleteReviewResponse` (no route), `getReview` for the read-back; strict text checks, a separate
  `StoreHttp` with no 429 retry for writes, timeouts and `ReplyOutcomeUnknownError`.
- Database: migration 21: `review_reply_drafts`, `review_reply_templates` and the three
  workspace-first indexes of the inbox.
- Server: `KILN_REVIEW_REPLY_ENABLED` kill switch (default off), `reviews.reply` (admin and up, and
  explicit-only for tokens), draft then `confirmHash` send, an atomic claim per review, a stale claim
  and an unknown outcome settled by re-reading the review, a 30 an hour workspace limit, audit and an
  event without text, templates (50), an optional translation seam, and
  `GET /reviews` and `GET /reviews/summary` for the whole workspace.
- Web: a top-level Reviews screen (filters kept in the address, summary strip, keyboard triage j k t
  r /), `ReplyDialog` (two steps with the exact text, the count against the limit and the public
  warning), and the reply row on every review card.

All of this is tested with fixtures and fakes on SQLite. **No request was ever made to App Store
Connect, Google Play or the iTunes lookup, no reply was ever sent to a store, and the web screens
were not opened in a browser.**

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
- Replies: Apple's success status, the attribute and relationship names of the response request
  (the field pages did not render), whether `include=response` works on one review, the length limit
  (this server caps at 5000), which API key role may respond (Admin assumed) and the reported 405.
  Google: whether `reviews.reply` works on a review older than the 7 day window.
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
- Replies: see [open decisions](open-decisions.md#21-replying-to-reviews).

## Addendum: settings and translation

- Migration 20: `workspace_settings`, `review_translations`, `translation_usage`. A typed settings
  registry ([api/settings](api/settings.md)) with roles `settings.read` (member and above) and
  `settings.write` (admin and above); the low rating threshold is now the setting
  `reviews.lowRatingThreshold` (default 2). Raising it never re-sends events for reviews already
  read: an event needs a first sighting or a changed rating (tested in `review-threshold.test.ts`).
- Translation of reviews ([api/reviews](api/reviews.md#translation)): `packages/connectors/src/translate/`
  (Google v2 with an API key by default, DeepL, Azure, LibreTranslate with a custom address),
  `services/translation.ts` (cache, daily budget, auto mode, `translateText` for other features),
  vault kinds `translate_*`, a Settings screen and a Translate button on review cards.
- Tested with fakes only (adapters, SSRF guard, budget and day rollover, cache, auto mode bounds, no
  text in logs, audit or events, OpenAPI). **No request was ever made to Google, DeepL, Azure or a
  LibreTranslate server, and the Settings screen and the Translate button were not opened in a
  browser.** Unverified provider details are listed in [credentials](credentials.md#review-translation-provider-keys)
  and in the header of each file under `packages/connectors/src/translate/`.
- Not built: "Translate all visible" in the Reviews tab (needs the translations held above the
  cards), showing cached translations without a click in `auto` mode (needs a cache-only read), a
  picker for which credential of a kind to use, and a Google service account variant.
