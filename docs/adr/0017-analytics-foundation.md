# ADR 0017: Analytics, as a normalised store of daily facts with honest limits

Status: connectors, server and database implemented and tested against fakes on SQLite (the Postgres variants run when
`MRM_TEST_POSTGRES_URL` is set). **No store was ever contacted: every request shape is written from the vendors' pages as read on
2026-11-19 and anything [the study](../research/analytics-apis.md) marks UNVERIFIED is still UNVERIFIED** (see
[Not verified](#not-verified-unverified)). No screens yet. API: [api/analytics](../api/analytics.md). Migration 31.

## Context

People want to see how an app does: impressions, product page views, downloads, conversion, sessions, crashes, ratings, sales. The
stores offer this in four different ways: Apple's Analytics Reports (an asynchronous report request, daily instances that Apple
**deletes after 35 days**, files behind five-minute links), Apple's Sales and Trends (a daily summary behind the vendor number),
Google's Play Developer Reporting API (crash and ANR rate by day), and Google's monthly CSV files in a Cloud Storage bucket. None offers
retention cohorts, rating counts, a rating history from Apple, or impressions from Google. A product that draws one chart over all of
that would invent numbers where the stores give none.

So this ADR adds a **foundation**, not a dashboard: every source is read into one small table of daily facts, and the read API says,
for every series, where it comes from, how late the store may still change it, and what limits it.

## Decision

1. **One normalised store.** `analytics_daily`: a fact is (app, platform, source, metric, day, one optional dimension) with a
   `value_micro` (the value times 1,000,000 as an integer, so counts, rates and money share one column and sums are exact). Dimensions:
   `territory`, `source_type`, `app_version`, `currency`. Days are UTC text `YYYY-MM-DD` as the store labels them (Apple sales and Play
   vitals follow Pacific Time; this is said in the series notes). The daily facts are **never pruned**: Apple keeps an instance 35 days,
   so ours is the only copy. Run rows (90 days) and instance bookkeeping (120 days) are pruned.
2. **Idempotent by construction.** A point is written by key and replaced only by a **later processing date** (the store restated the
   day) or by the same date with another value. An older reading never replaces a newer one. Reading again, syncing again and importing
   again store nothing new (`written: 0`). An Apple instance is read once.
3. **Four sources, by platform.** iOS and macOS: `apple_analytics` (App Store Discovery and Engagement, Downloads, App Sessions, App
   Crashes) and `apple_sales` (Sales and Trends daily summary; units per territory and **proceeds per currency, never converted or added
   across currencies**). Android: `play_vitals` (crash rate and ANR rate, total and by version code) and `play_reports` (monthly CSVs:
   installs, ratings, store performance). `INSTALLS` reports ended on 2026-11-04 and are never requested. The Sales mapping leaves out
   updates, in-app purchases and other apps.
4. **Off by default, per workspace.** The workspace setting `analytics.enabled` (default `false`) gates syncing, the scheduled job and
   the Apple enable action. Reading what is stored and **importing a file** work whatever it says (they contact no store).
   `MRM_ANALYTICS_INTERVAL_MINUTES` (default 360, `0` off) only sets the interval of the scheduled job: with the setting off it queues nothing.
5. **Apple, two ways in.**
   - *Automatic:* one explicit, role-gated, two-step action creates an ONGOING `analyticsReportRequest` (the only store write of
     analytics): `GET` shows the plan (what exists at Apple, what would be created, whether the key's role may create, a `confirmHash`),
     `POST` with the hash creates it. If what Apple has changed in between, nothing is sent (`409 plan_changed`). An optional
     `backfill` adds one ONE_TIME_SNAPSHOT (history from 2024-01-01; Apple allows one a month). A 403 is **`analytics_role_required`**
     (Apple lists the Admin role): the status says so, with the import as the alternative. Audited as `analytics.enable`, ids only.
   - *By file:* `POST .../analytics/import/preview` then `POST .../analytics/import?confirmHash=` with the report file as the raw body
     (`.tsv`, `.csv` or the `.gz` as downloaded). Strict: 10 MiB as received, 64 MiB decompressed, 400,000 rows, 80 columns; columns are
     matched **by name** (the report name in the file name, else the header), never by position; unknown reports, missing columns, bad
     gzip, no usable row are fixed codes. The hash covers the normalised data, so the confirmed file must be the previewed one. An imported
     number never replaces one the API read (its processing date is unknown, so any API reading wins).
6. **Downloading a segment.** Apple's segment links last five minutes: each is fetched at once, **without** the bearer header, capped in
   size while received and again while decompressed, and the URL is never logged, stored, audited or returned (non-enumerable in the
   connector, redacted from errors). The checksum algorithm is UNVERIFIED and is not checked.
7. **Google.** Vitals use the Reporting API with its own scope (`playdeveloperreporting`); `GoogleTokenProvider` now takes a scope and
   keeps one token per scope, so the default `androidpublisher` token is never sent to another API. The CSV reports use
   `devstorage.read_only` and the bucket id the person copies from Play Console (workspace setting `analytics.playBucketId`; an optional
   per-app override is stored). `StoreHttp` gained a **bytes** mode (a cap while received, no JSON) for the files.
8. **A fixed vocabulary, everywhere.** Errors are codes (`analyticsErrorCodes`), setup needs are codes (`analyticsSetupCodes`) with a
   next-step code (`analyticsNextSteps`), coverage limits are codes (`coverageNoteCodes`). A client switches on codes; the sentences are
   for people and never carry a URL, a token, a report row or store text. Store errors are classified and **dropped**: only the code is kept.
9. **Honest series.** `GET overview` returns one series per metric with its `source`, `delayDays` (how late the store may still change a
   day), `coverage` (`complete`, `partial`, `none`; first and last day, gap days, notes) and, with `?breakdown=`, the top values of one
   dimension. A series with no data says so (`source_not_connected` or `no_data_yet`) and has `null`, never zero. Two **derived** series
   (`product_page_conversion`, `impression_tap_rate`) are marked `derived` and are null where the denominator is missing. Apple counts are
   not unique users; Apple usage data is a sample of users who opted in; Google offers no impressions; Apple has no rating history.
10. **Rights.** `analytics.read`: every role. `analytics.manage` (sync, enable, import, the settings): owners and admins, **explicit-only
    for API tokens** like `store.publish`. Every route is about one app, so a token restricted to apps is limited to its apps.
11. **Audit and events.** `analytics.sync`, `analytics.enable`, `analytics.import`: ids, counts and codes only. Event `analytics.synced`
    (ids and counts, needs `analytics.read`) is raised when a sync or an import stored something new, not for a sync that changed nothing.

## Tables (migration 31)

- `analytics_daily` (primary key: app, platform, source, metric, day, `dim_type`, `dim_value`; `''` means a total), `analytics_sync_runs`
  (one row per source per sync, import included: counts and a fixed `error_code`), `analytics_report_requests` (one per app and access type),
  `analytics_instances` (Apple instances read, so each is read once), `analytics_app_config` (the Apple mode `off`, `ongoing` or `import`,
  an optional bucket override), `analytics_source_state` (last attempt, last success, last error code, first and last day per source).
- Deleting an app deletes all of them. Orphans are removed by the upkeep.

## Windows and rules

- Apple instances: at most 60 per sync (a backlog continues), newest first; a failure that will not go away (`segment_too_large`,
  `bad_gzip`, `bad_format`, `missing_columns`, `unknown_report`) is recorded once and not retried, a transient one (`segment_expired`,
  `rate_limited`, `store_unavailable`, `timeout`) is retried by the next sync. A report with no usable row is read (and counts as read).
- Sales: a first read goes back 30 days, later reads start two days before the newest stored day, at most 31 days a sync, the newest day asked for is yesterday.
- Vitals: a first read goes back 90 days, later reads start a week before the newest stored day.
- Play reports: a first read takes three months, later ones the current and the previous month (the current month's file grows).
- A source that cannot run yet (no request, no vendor number, no bucket id) is **skipped** with its setup code: not a failure.

## Not verified (UNVERIFIED)

Everything in [the study's list](../research/analytics-apis.md#10-unverified-list-to-settle-in-phase-0) still stands. In particular, no
request was made to a store: the segment delimiter, the checksum, the time zone of the Date column, the Device strings that identify a
Mac, the `salesReports` parameters and its encoding, the exact field names of the Reporting API rows and `freshnessInfo`, the unit of the
crash rate (stored as the API sends it), the Play Console permission names, whether the bucket needs its own IAM grant, the file names and
encoding of the CSV reports, the `store_performance` columns (and whether Google still fills them after the June and July 2026
change), and what Apple answers to a second report request for the same app. The parsers read **by header name** and say what they
could not map; test fixtures use the documented columns with made-up numbers.

## Decisions for the maintainer

- Whether `analytics.manage` (sync, enable, import) should stay an admin right, or members may sync (they cannot today).
- Whether the scheduled sync default of 6 hours is right (Apple data is final after two to five days; Play vitals lag two days).
- Whether to keep the daily facts for ever (today) or add a retention setting.
- Whether to offer the Apple ONE_TIME_SNAPSHOT backfill by default in the web screen (it is an option of the enable action).
- Whether a Google Cloud Storage bucket id per app (stored, not yet exposed by a route) or only per workspace is wanted.
