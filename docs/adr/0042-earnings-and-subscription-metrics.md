# ADR 0042: Google Play earnings and subscription metrics

Status: accepted. Builds on [ADR 0017](0017-analytics-foundation.md) (the analytics store and its vocabularies) and [ADR 0038](0038-sales-analytics.md) (sales analytics;
its "Not done" section named the two things built here).

## Context

Analytics had sales figures per currency: Apple developer proceeds, and Google Play **estimated** sales, which are what the buyer paid (tax included, Google's fee not
deducted). Google's **Earnings** report, the net figure for accounting, was not read. Nothing counted subscriptions: how many are active, how many started, how many
were cancelled.

## Decision

1. **Earnings (Android): a new source `play_earnings`.** It reads `earnings/earnings_YYYYMM*.zip` in the reports bucket that `play_reports` and `play_sales` already
   use (same bucket resolution, same token, same `bucket_id_missing`, `bucket_forbidden` and `play_sales_forbidden` codes; the code and its message now speak of
   "financial reports", not only sales). The file holds every app of the account, so rows are filtered by `Package ID`. The sync reads the current and the previous month
   (six months on the first read). A month with no file is "not available yet": skipped, no error, no zero. A refused folder (the Play Console permission View financial
   data is missing) is `play_sales_forbidden` with the same next step; the statistics keep working.
2. **Monthly figures are stored on the first day of the month of the FILE, and labelled monthly.** `analytics_daily` is keyed by day. The report is a monthly
   statement whose transaction dates are Pacific Time, while every other series is UTC, and a day-by-day series would arrive a month late. So a month is one fact, dated
   the first of the month, and a new `MetricInfo.cadence: 'monthly'` marks these metrics. The overview carries `cadence: "monthly"` per series and reads them with
   `granularity=month`; their coverage counts months (the newest month expected is the one before the current month, from the 7th on), never "gaps" or "recent days
   incomplete". The web draws months as "Oct 2026", never as a day. No migration: `analytics_daily` already holds them.
3. **What is stored, per merchant currency** (dimension `currency`, `<CUR>:<product>` per product; never converted or added): `earnings_net` (the signed sum of every line
   of the app), `earnings_charges`, `earnings_taxes`, `earnings_fees` (the lines of one family, as signed; adjustments and unknown types are in the net only, so net =
   charges + taxes + fees + the rest), and `earnings_orders` (number of plain `Charge` lines). **Gross and net are two separate series** of the same currency and month;
   neither is derived from the other. The amount is `Amount (Merchant Currency)`, the currency Google pays out in.
4. **Subscriptions, Apple: a new source `apple_subscriptions`.** `GET /v1/salesReports` with `SUBSCRIPTION` (a snapshot of the day) and `SUBSCRIPTION_EVENT`, `SUMMARY`,
   `DAILY`, version `1_3`, with the vendor number the sales summary already uses. Metrics (counts, unitless): `subscriptions_active` (standard price),
   `subscriptions_active_trial`, `subscriptions_active_offer` (levels, summed over the rows of the day) and `subscriptions_new`, `subscriptions_cancelled`,
   `subscriptions_trial_conversions` (events, summed over `Quantity`), for the app, per product (the Products page's `storeRef` maps Apple's Subscription Apple ID to the
   product id) and per standard duration (new dimension `duration`). Events are classified from their names (see UNVERIFIED); renewals, reactivations, refunds and billing
   events are not counted. The **SUBSCRIBER** report is **not read**: it has one row per subscriber with a subscriber id, and no per-person data is stored here.
5. **Subscriptions, Google Play: a new source `play_subscriptions`.** Google does offer them: `financial-stats/subscriptions/subscriptions_<package>_<product>_YYYYMM_<dimension>.csv`
   in the same bucket, one file per product and month, with New, Canceled and Active Subscriptions per day. Metrics `play_subscriptions_new`,
   `play_subscriptions_cancelled`, `play_subscriptions_active`, for the app (summed over the rows) and per product. These files are under `financial-stats`, so they need
   View financial data too. Apple's and Google's counts are different measures and are never mixed (a metric belongs to one source).
6. **No money in subscription metrics, no counts in money metrics.** Subscription counts have no unit and no currency; money exists only in the earnings and the
   existing sales metrics, per currency.
7. **Web.** The Analytics page gets a "Subscriptions" card (active with trials, new, cancelled, and the active ones by product; Apple `breakdown=product`) and, for Android,
   "Earnings (net, monthly)": net and charges as two lines of one currency, with the currency tabs, select and locale default of the sales cards, a twelve-month range of
   its own, and "not available yet" when the source is set up and has no month. Both are drawn only when the source has stored data. The explanations of the bucket id say
   that earnings and subscriptions also need View financial data.
8. **Registry, MCP.** The overview schema gains `cadence`; the sources and metrics enums come from `@kiln/core`, so the operation and OpenAPI documents follow. The MCP
   `get_analytics_overview` text names the new series. The permission is the same as for the other analytics reads (`analytics.read`).

## Not done

- Apple's per-subscriber `SUBSCRIBER` report (privacy, see 4). Revenue-per-subscription and churn rates are not derived: an event count over a level is a rate this
  server does not claim.
- MRR from the stores. (RevenueCat's own MRR is shown on the Products page, see [ADR 0043](0043-revenuecat-metrics.md).)
- A daily earnings series, or earnings by day of the month: the report's dates are Pacific Time and the figure is a monthly statement.

## UNVERIFIED (nothing ran against Apple or Google; also in [the API page](../api/analytics.md#not-verified-unverified) and the connector files)

Confirmed from Google's help page (answer 6135870) and Apple's field tables, read 2026-11-21: the object names, the column names, the transaction types, Apple's report
types and version, the permission. Not confirmed:

- **the sign of each Earnings line type.** The net is a plain signed sum; it is right only if Google writes fees and refunds negative and taxes with the sign that makes
  the ledger add up to the payout. The charges/taxes/fees families exist so the sign can be checked against a real file;
- that the earnings zip holds one CSV and its encoding, the spelling of the types and column names (case-insensitive match), whether a file can be split or suffixed
  (every object with the prefix is read; an identical copy is skipped), `Package ID` versus `Product ID`, a thousands separator, the 10 MiB cap, and what Cloud Storage
  answers without View financial data (assumed 403);
- Apple: the count column names beyond the documented ones (header text: `free trial` is trial, `pay up front` and `pay as you go` are paid offers) and that they do not
  overlap; the day and time zone of a Subscription report; the event names (new = `Subscribe`, `Opt-In`, `Start ...`; cancelled = `Cancel...`; a trial conversion =
  `Paid Subscription from Introductory Offer` on a free-trial row; new includes trials started); that `Subscription Apple ID` equals the stored `storeRef`; the `Desktop`
  device of a Mac subscription; that the file is tab separated;
- Google subscriptions: the dimension suffix (`country` is documented; `overview` is tried first), the date format, whether rows overlap (summed as they are, which would
  count a subscription twice), and what `Active Subscriptions` includes (trials, grace period, paused).

## Consequences

- Two new Play sources and one Apple source; `analyticsSources`, `sourcesForPlatform`, the metrics, the `duration` dimension, seven coverage notes and `MetricInfo.cadence`
  are in `@kiln/core`; the status shows three more sources per platform with their setup needs.
- A first sync reads up to six months of earnings and, per day, two Apple reports (bounded by the same per-sync day cap as sales).
- Products are capped like the sales products (`productSalesLimits`), so a subscription catalogue cannot grow the table without bound.
