# ADR 0052: Ratings and app health

Status: accepted (2026-11-23). The idea (rating history and crash health in one place) is adapted from the Growth tools of Open Screenshot
Generator (MIT, see THIRD_PARTY_NOTICES.md). The server logic under `apps/server/src/modules/ratings/` carries that notice; the web screens are
written for Kiln and copy no markup, wording or images.

## Context

The stores answer "what is the rating now", not "what was it last month". Crash numbers sit in two different places (App Analytics, Android
vitals) and nothing connects a drop in rating to a release. People notice a bad week from a review, not from a number.

## Decision

- **Kiln records its own history.** Each review sync writes one row per day, store and country to `app_rating_days` (migration 56): the
  average, the count when the store gives one, the stars when it gives them. The newest read of a day replaces the earlier one. Only numbers,
  codes and dates are stored, never review text. The trend therefore starts the day Kiln first read the rating, and the screen says so
  ("since we started recording on ...").
- **What each store gives.** App Store: the iTunes lookup, a few countries per sync, average and count.
  Apple gives no rating history. Google Play: the daily and total average from the Cloud Storage reports, no count and no stars. Written reviews
  (stars of reviews Kiln stored) are a different, smaller thing than ratings and are always labelled as such.
- **New ratings are a difference.** The difference between two readings of a country (stars exact when both have them). A count that falls is
  not new ratings; one that falls under half is a store reset. A day without a reading carries the difference to the later day (`spansGap`).
- **Health** comes from stored analytics: App Store crashes per session (opted-in people, only for days with at least five crashing users, so a
  missing day is not a crash-free day; no freeze numbers) and Google Play user-perceived crash and ANR rate. One regression rule
  (docs/api/health.md) produces `finding` and the `health.crash_regression` event.
- **API**: `GET .../apps/{appId}/ratings` and `GET .../apps/{appId}/health`, both read-only and `reviews.read` (docs/api/ratings.md).
- **Web**: a tab Ratings and health in Insights (`?view=ratings`, rail sections `ratings`, `reviews`, `stability`, `releases`, `countries` in
  `?section=`). Following docs/ux-ia.md 0e: scope and Sync stay in the header (this page syncs reviews and analytics: `PAGE_KINDS.health`), the
  range bar and the updated line sit under the tabs, the rail lists only sections that have something to say. With both platforms, Ratings opens
  with one comparison table, a row per measure; a platform with no data is one line saying why and how to fix it.
- **The view model is pure** (`apps/web/src/lib/ratings/ratings.ts`): windows of the range and the same length before it (the API is asked for
  both), changes, low-sample handling, release rows, tiles. Tested for: no data, one snapshot, gaps, one platform, a count that drops, a reset,
  very small counts, a range that ended in the past.

## Honesty rules (tested)

1. `null` is never zero: a day with no reading is a gap in the chart.
2. Fewer than 30 ratings (or reviews) is a low sample: the count is shown with a hint and no share is computed.
3. A change needs data on both sides. History shorter than the range compares with the first reading in the range and names its date. One
   reading means no change, not "no change".
4. A rate is the mean of days with numbers; under 60% of the days on either side, no comparison is drawn.
5. Release impact is a before and after comparison (14 days before, 7 to 14 days after), "too early" under a week, never proof of cause.
6. Where a store gives no count, no stars or no freeze numbers, the screen says that, not a zero.

## Not available

Apple rating history before the first sync; ratings by star for the whole base (only new ratings by star, from differences, and written
reviews); a rating count from Google Play; per-version ratings; crash numbers for days Apple withheld. The per-country list holds the countries
a sync read, not every storefront.

## Consequences

The ratings tab is only as old as Kiln's first sync of the app; a long range on a new install shows a short line and says why. No nav badge
counts open health issues: the regression already raises an event and an alert, and a badge would need a read of every app on every page.

UNVERIFIED: all store and RevenueCat response shapes behind these numbers are hand-written fixtures; none was read from a live store.
