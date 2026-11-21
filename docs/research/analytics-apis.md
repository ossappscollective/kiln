# Research: official analytics APIs for an Analytics view

Date: 2026-11-19. Scope: what Apple and Google officially offer today for downloads, impressions, product page
views, conversion, sales and proceeds, crashes, ratings and retention, for iOS, macOS and Android apps, using only
the credentials this server already holds (an App Store Connect API key, a Google Play service account).
Research only: no code was changed.

Sources: Apple's documentation (fetched through the `.md` variants of developer.apple.com pages, which carry
a 2026 copyright line), Apple's App Store Connect help pages, Google's Play Developer Reporting API reference,
Google's Play Console help pages and the Android Publisher API reference, plus the connectors in
`packages/connectors/src`. Everything below is paraphrased. Anything not confirmed on an official page is marked
**UNVERIFIED**. Nothing was tested against a real account (the repo's `docs/credentials.md` has the same caveat for roles).

## 0. Headlines

1. **Apple has a real, official analytics feed** (Analytics Reports API, API 3.4.0 and later) that covers impressions,
   product page views, downloads, purchases, sessions, installs/deletes and crashes, and it **includes macOS**.
   It is asynchronous (create a request, wait 1 to 2 days, poll for instances, download pre-signed files) and
   **instances are deleted after 35 days**, so the server must persist what it downloads.
2. **Creating the Apple request needs an ADMIN key.** Listing and downloading works with ADMIN, SALES_AND_REPORTS
   or FINANCE. This conflicts with the "lowest role" advice in `docs/credentials.md` and needs a product decision.
3. **Google has no official impressions or reach data in any API or export.** Store listing visitors and
   acquisitions exist only in the Cloud Storage CSV exports (the `store_performance` files), and Google changed
   its store listing metrics in June and July 2026 (section 3.4), which puts that feed at risk.
4. **Google crash and ANR rates are well served** by the Play Developer Reporting API (JSON, by version code and
   device, daily), with no bucket needed.
5. **Neither store offers retention cohorts, rating counts or histograms, or a rating history through an API.**
   Rating trends have to come from our own snapshots (Apple) or the Cloud Storage ratings CSV (Google).
6. **New this month:** Apple stopped generating new Sales and Trends `INSTALLS` reports on 2026-11-04 with no
   replacement. Do not build on that report type.

## 1. What the repo already has (checked in `packages/connectors/src`)

| Piece                                                                                   | File                                                         | State for analytics                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Store Connect JWT (ES256, 19 min, `aud` appstoreconnect-v1, cached, `invalidate()`) | `apple-auth.ts`                                              | Reusable as is.                                                                                                                                                                                                                                                                                                                                                                                          |
| Google service account JWT bearer grant, cached token                                   | `google-auth.ts`                                             | `signGoogleAssertion` takes a `scope`, but `GoogleTokenProvider` always uses `androidpublisher`. Analytics needs two more scopes, so the provider needs a scope parameter (one cached token per scope). Small change.                                                                                                                                                                                    |
| HTTP plumbing: timeout, redaction, bounded 429 wait                                     | `store-http.ts`                                              | Always reads the body as text and tries `JSON.parse`; always sends `accept: application/json`. Apple segments are gzip files on a pre-signed URL and Google exports are CSV, so it needs a bytes (or text) mode, optional no-auth requests, and a size cap. Pre-signed Apple URLs must be fetched without the bearer header (**UNVERIFIED** that sending it breaks the download; do not send it anyway). |
| Reviews connectors, iTunes rating lookup                                                | `appstore-reviews.ts`, `play-reviews.ts`, `itunes-rating.ts` | Already read review lists and a store-wide rating. These are the only rating inputs today.                                                                                                                                                                                                                                                                                                               |
| macOS as third platform                                                                 | `docs/adr/0013-macos-platform.md`                            | An iOS and a macOS record may share one store id (universal purchase). Apple analytics is per Apple app id, so one request covers both and rows are split by the Device column. Separate Mac apps need their own request.                                                                                                                                                                                |
| Dependencies                                                                            | `packages/connectors/package.json`                           | Only `@kiln/core`. Gunzip (`node:zlib`) and UTF-16 decoding (`TextDecoder`) are built in; a small CSV/TSV parser has to be written (quoted fields, delimiter sniffing).                                                                                                                                                                                                                                   |

`docs/credentials.md` states that the Google Cloud Storage export and the Reporting API are **not used** today, so
both are new access, and an Apple analytics read is a new role requirement.

## 2. Apple

### 2.1 Analytics Reports API

Endpoints (App Store Connect API 3.4.0 and later; all under `https://api.appstoreconnect.apple.com`):

| Step                    | Call                                                                            | Notes                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create request          | `POST /v1/analyticsReportRequests` with `accessType` and the `app` relationship | `ONGOING` or `ONE_TIME_SNAPSHOT`. Response has `stoppedDueToInactivity`.                                                                                                                 |
| List requests of an app | `GET /v1/apps/{id}/analyticsReportRequests`                                     | Use to avoid creating a second request (what Apple returns on a duplicate is **UNVERIFIED**).                                                                                            |
| Delete request          | `DELETE /v1/analyticsReportRequests/{id}`                                       |                                                                                                                                                                                          |
| List reports            | `GET /v1/analyticsReportRequests/{id}/reports`                                  | Each has `name` and `category`. The example response says 116 reports exist for one request. A category filter is expected but its parameter name is **UNVERIFIED** on the fetched page. |
| List instances          | `GET /v1/analyticsReports/{id}/instances?filter[granularity]=DAILY`             | Attributes `granularity` (DAILY, WEEKLY, MONTHLY) and `processingDate`.                                                                                                                  |
| List segments           | `GET /v1/analyticsReportInstances/{id}/segments`                                | Attributes `url`, `checksum`, `sizeInBytes`. Page size 50.                                                                                                                               |
| Download                | GET the `url`                                                                   | **Valid for 5 minutes** (Apple's tip), pre-signed object storage link ending in `.csv.gz`.                                                                                               |

Categories: `APP_STORE_ENGAGEMENT`, `COMMERCE`, `APP_USAGE`, `FRAMEWORK_USAGE`, `PERFORMANCE`.

**ONGOING vs ONE_TIME_SNAPSHOT**

- `ONGOING` generates daily, weekly and monthly instances from the day of the request. The first reports take
  1 to 2 days, then new ones arrive daily. If nothing is fetched for a long time the request goes to
  `stoppedDueToInactivity` and a new request is needed (the inactivity limit is **UNVERIFIED**; a daily sync keeps it alive).
- `ONE_TIME_SNAPSHOT` returns history, which Apple's report pages say starts on 2024-01-01 "on request"
  (App Crashes Expanded: from iOS 17.4). It produces nothing after the day of the request. One snapshot request
  per month is allowed (Apple's wording). Use it once for backfill, and again only to recover missed days.
- **Instances are kept 35 days**, then deleted. After that only a snapshot can recover the data. The server must
  store rows itself.

**Instances, segments and corrections**

- An instance can hold several segments; all are needed for a complete set. A daily instance may contain several
  dates (late data). A newer `processingDate` **overwrites** the earlier one for the same Date: use the latest
  instance per (report, date) and never merge two instances (double counting).
- Weekly instances cover Monday to Sunday and are published on Fridays; monthly on the fifth of the next month.
  In weekly and monthly files the Date column is the first day of the period.
- File format: the segment object is described as CSV. The `.gz` suffix is in Apple's own example. The delimiter
  is **UNVERIFIED** (sniff tab and comma). Column positions can change: read by header name.

**Standard vs detailed, privacy**

- Several reports exist as Standard and Detailed. Standard leaves out fields that could relate to individuals
  (page title, source info, campaign). Apple says to download Standard unless the extra fields are needed.
- Detailed reports drop rows with fewer than 5 users or devices and add small random noise (roughly plus or minus 2
  in 68% of values and plus or minus 6 in 99.7%). The Detailed purchases report noises paying users and scales
  purchases, sales and proceeds with it.
- Usage reports (sessions, installs and deletes, crashes, opt-in) contain **only users who chose to share data with
  developers**. No report is generated if fewer than 5 users contribute. So these are samples, not totals.

**Reports that matter for the UI** (all list Platforms: iOS, iPadOS, macOS, tvOS, visionOS, Territories: worldwide,
unless stated)

| Report (category)                                         | Key fields                                                                                                                                                                        | Completeness           | Notes                                                                                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| App Store Discovery and Engagement (APP_STORE_ENGAGEMENT) | Event (Impression, Page view, Tap), Page Type, Source Type, Engagement Type (Get, Update, Redownload, Open, Share...), Device, Platform Version, Territory, Counts, Unique Counts | within 3 days          | The only source of impressions and product page views. Impression counts exclude page views. Detailed adds Page Title, Source Info, Campaign. |
| App Store Downloads (COMMERCE)                            | Download Type (First-time, Redownload, Manual update, Auto-update, Restore), App Version, Source Type, Page Type, Pre-Order, Territory, Counts                                    | within 2 days          | Updates are counted as download types: filter to first-time and redownload for "downloads". Weekly and monthly files exist for Detailed only. |
| App Store Purchases (COMMERCE)                            | Purchase Type (app, in-app), Content Name, Payment Method, Purchases (negative = refund), Proceeds in USD, Sales in USD, Paying Users                                             | within 2 days          | Estimates in USD. Free apps are not included. Paying users cannot be summed across rows.                                                      |
| App Sessions (APP_USAGE)                                  | App Version, Sessions, Total Session Duration, Unique Devices                                                                                                                     | within 5 days          | Opted-in users only.                                                                                                                          |
| App Store Installations and Deletions (APP_USAGE)         | Event (Install, Delete), Download Type, App Version, Counts, Unique Devices                                                                                                       | within 5 days          | Opted-in users only.                                                                                                                          |
| App Crashes (APP_USAGE)                                   | App Version, Device, Platform Version, Crashes, Unique Devices                                                                                                                    | within 5 days          | Opted-in users, only crashes that produce logs. Includes macOS.                                                                               |
| App Crashes Expanded (PERFORMANCE)                        | Count, Unique Devices, Build, Release Type                                                                                                                                        | late data up to 8 days | **iOS and iPadOS only**, daily only. Pair with App Sessions Context for a denominator.                                                        |
| App Store Opt-in (APP_USAGE)                              | Downloading Users, Users Opting-In                                                                                                                                                | within 3 days          | The share of first-time downloaders who opted in: needed to scale the usage reports.                                                          |
| Subscription State and Event (COMMERCE)                   | not read in detail                                                                                                                                                                | not read               | Out of MVP scope.                                                                                                                             |

There are also about a hundred framework usage reports (Bluetooth, widgets, ARKit...) that are out of scope.

**Conversion.** Apple publishes no conversion field in the API. A derived rate (first-time downloads divided by
unique page views, or by unique impressions) can be computed from two reports, but it will not necessarily match
the number the App Store Connect web UI shows (**UNVERIFIED**: the UI definition is not documented in the API pages).
Label it "derived".

**Role.** Apple's table: ADMIN can create and delete requests and list and download reports; SALES_AND_REPORTS
and FINANCE can list and download. Apple recommends a Sales and Reports key when sharing a key with a third
party. Practical consequence: the one-time "enable analytics" step needs an Admin key; the daily sync works with a
lower role (inferred from the table, **UNVERIFIED** in practice). The older `ACCESS_TO_REPORTS` user permission is deprecated (API 4.4).

**Delay and retention summary.** First data 1 to 2 days after the request. Daily data final after 2 to 5 days
depending on the report. Server-side retention 35 days. History only from 2024-01-01 via one snapshot a month.

### 2.2 Sales and Trends: `GET /v1/salesReports`

- Needs the SALES_AND_REPORTS role (also ADMIN or FINANCE per Apple's role wording; a Sales and Reports key reads
  this endpoint but not finance reports). Synchronous: one GET returns a file.
- Valid combinations (Apple's table): `SALES`/`SUMMARY` frequency DAILY, WEEKLY, MONTHLY, YEARLY, version `1_0`;
  `PRE_ORDER`/`SUMMARY`; `SUBSCRIPTION`/`SUMMARY`, `SUBSCRIPTION_EVENT`/`SUMMARY`, `SUBSCRIBER`/`DETAILED` daily
  `1_3`; `SUBSCRIPTION_OFFER_CODE_REDEMPTION`, `WIN_BACK_ELIGIBILITY` daily `1_0`; `NEWSSTAND`; `FIRST_ANNUAL`.
  Anything else errors.
- **`INSTALLS` is deprecated: Apple stopped generating new ones on 2026-11-04**; history can still be downloaded;
  there is no replacement. Version 1_2 of the subscription reports is gone.
- The fetched endpoint page does not list the query parameters. The usual ones (`filter[vendorNumber]`,
  `filter[reportType]`, `filter[reportSubType]`, `filter[frequency]`, `filter[version]`, `filter[reportDate]`)
  and a gzip response are **UNVERIFIED** here. The **vendor number** (from Payments and Financial Reports) is a new
  value the user must supply; whether the API can list it is **UNVERIFIED**.
- Timing (Apple help): daily is available the next day, generally by 8 a.m. Pacific Time, weekly on Mondays,
  monthly 5 days after month end, yearly 6 days after year end. Retained **1 year** (daily, weekly, monthly),
  10 years (yearly). Days run on Pacific Time.
- Columns include Begin Date, End Date, Units (negative = refund), Developer Proceeds (per unit), Customer Price,
  Product Type Identifier, Country Code, Customer Currency, Currency of Proceeds, Apple Identifier, Parent
  Identifier, Device, Supported Platforms, Version. Proceeds are in the payout currency of each row, so a
  single-currency chart needs conversion (Apple gives no rate table in the API pages), or use the USD estimates in
  the Analytics Purchases report instead. Sales and Trends figures are next-day estimates.
- macOS: the report is per vendor (all apps). Rows carry Device (the help lists "Desktop") and Supported
  Platforms; how to separate a Mac app from its iOS twin on a universal purchase is **UNVERIFIED**.

### 2.3 Finance reports: `GET /v1/financeReports`

Final proceeds by fiscal month, region and currency. The endpoint page has no parameter details (**UNVERIFIED**).
Help page: generated once per Apple fiscal month, only if there were purchases or refunds, available by the first
Friday of the next fiscal month, kept 10 years, delivered as gzip tab-delimited text. Role: Account Holder, Admin
or Finance on the help page; a Sales and Reports key cannot read it. Treat as an optional later phase.

### 2.4 Reviews and ratings

- `GET /v1/apps/{id}/customerReviews` (already used) gives reviews, not aggregate counts.
- `GET /v1/apps/{id}/customerReviewSummarizations` (API 4.0 and later) returns the AI summary text per territory.
  The page is a stub: attributes and role are **UNVERIFIED**; it carries no numbers, so it is not a chart source.
- No endpoint gives rating counts, a star histogram or a rating history. `itunes-rating.ts` uses the public
  iTunes lookup (documented as UNVERIFIED in its own header). A rating trend means storing our own daily snapshot.

### 2.5 App performance: `perfPowerMetrics` and `performanceOverviews`

- `GET /v1/apps/{id}/perfPowerMetrics` (latest versions) and `GET /v1/builds/{id}/perfPowerMetrics` (one build),
  API 1.2.0 and later. Filters seen in Apple's examples: `filter[deviceType]`, `filter[metricType]`,
  `filter[platform]=iOS`. Returns points per app **version** (not per day) with percentiles, plus generated insights.
- Categories named in Apple's pages: LAUNCH, ANIMATION (hitch rate) and STORAGE (both added in 4.4), plus the
  hang, memory, disk, battery and termination categories that the 4.4 notes mention (full value list **UNVERIFIED**:
  the category page is empty).
- Data comes from opted-in users, needs "significant usage", and takes a few days after a release.
- `GET /v1/apps/{id}/performanceOverviews` (4.5) is a stub page (**UNVERIFIED** shape).
- Diagnostics: `GET /v1/builds/{id}/diagnosticSignatures` and `GET /v1/diagnosticSignatures/{id}/logs` give
  anonymized crash, hang and disk-write signatures.
- macOS: Apple's examples and the sample use iOS only. Whether `filter[platform]` accepts macOS is **UNVERIFIED**.
  The Analytics Reports App Crashes report does include macOS.

### 2.6 Rate limits and keys

- Limit per API key, in a rolling hour, reported on every response in the `X-Rate-Limit` header (Apple's example:
  `user-hour-lim:3500;user-hour-rem:500;`, "actual limits can vary"). Over the limit: HTTP 429
  `RATE_LIMIT_EXCEEDED`. A daily sync of about 6 reports per app is roughly 20 calls per app, far below the limit.
  The per-hour budget is shared with the existing reviews and release sync.
- Segment downloads go to a separate storage host (the pre-signed link); whether they count against the limit is **UNVERIFIED**.

## 3. Google

### 3.1 Play Developer Reporting API (vitals)

- Host `https://playdeveloperreporting.googleapis.com`, versions `v1beta1` and `v1alpha1` (same resource set).
  Scope `https://www.googleapis.com/auth/playdeveloperreporting` (confirmed on the `query` and `anomalies.list`
  pages). Quota: 10 queries per second by default.
- Setup (Google's Getting Started): enable "Google Play Developer Reporting API" in the Cloud project that owns the
  service account; linking that project to the Play developer account is no longer required; invite the service
  account in Play Console Users and permissions with the minimum rights. The metric set pages name **View app
  information (read-only)**; a third-party table names "View app quality information (read-only)" for vitals,
  so the exact current label is **UNVERIFIED**. The Android vitals data is for apps the account can see; `apps:search`
  lists them.
- Resources: `anomalies.list`, `apps.search`, `apps.fetchReleaseFilterOptions`, and metric sets `vitals.crashrate`,
  `vitals.anrrate`, `vitals.excessivewakeuprate`, `vitals.stuckbackgroundwakelockrate`, `vitals.slowstartrate`,
  `vitals.slowrenderingrate`, `vitals.lmkrate`, `vitals.bitmapmemoryusage`, `vitals.anonrssandswapmemoryusage`,
  `vitals.errors.counts`, `vitals.errors.issues.search`, `vitals.errors.reports.search` (stack traces).
- Query shape (`POST .../{metricSet}:query`): `timelineSpec` (DAILY or HOURLY), `metrics`, `dimensions`, `filter`
  (equality only, AIP-160), `pageSize` (default 1000, maximum 10000), `userCohort` (OS_PUBLIC default).
  Dimensions: `versionCode`, `apiLevel`, `deviceModel`, `deviceBrand`, `deviceType`, `countryCode`, RAM bucket,
  SoC, CPU, GPU, screen size and density.
- Time zones: DAILY is `America/Los_Angeles` only; HOURLY is UTC only. The 7 and 28 day rolling averages are not
  available hourly.
- Crash metrics: `crashRate` (share of distinct users with at least one crash), its 7 and 28 day user-weighted
  forms, `userPerceivedCrashRate` (crash while the app was in active use), and `distinctUsers` (rounded, do not sum
  across periods). ANR: same shape; user-perceived ANR currently counts only input-dispatching ANRs. The unit (a
  fraction or a percent) is described as "percentage" and should be checked on the first real response (**UNVERIFIED**).
  "Crash-free users" is `1 - crashRate` if it is a fraction.
- Freshness: a `get` on the metric set returns `freshnessInfo` with the latest end time per aggregation period.
  Google's launch post says most metric sets refresh once a day, and that long ranges, many dimensions and large
  apps make queries slow. No latency figure is published (**UNVERIFIED**; read `freshnessInfo` and show "data up to").
- History: the 2022 launch post claims three years of metric history. Not restated in the current reference
  (**UNVERIFIED** today).
- Error issues: `errorIssues:search` filters `errorIssueType` CRASH, ANR or NON_FATAL, `versionCode`, process state;
  order by `errorReportCount` or `distinctUsers`; page size up to 1000; hour-aligned UTC interval.

### 3.2 Play Console reports in Cloud Storage

- Private bucket per developer account: `gs://pubsite_prod_rev_<number>`; Google's way to get the id is the "Copy Cloud
  Storage URI" button on the Play Console reports pages. **No API call to discover it was found**, so it is a new user input
  (**UNVERIFIED** that none exists).
- Access: Play Console permissions control it. Bulk reports need **View app information** at Global scope (the
  account-level "View app information and download bulk reports (read-only)"); financial reports (sales, earnings)
  need **View financial data** at Global scope. For programmatic access Google says to use a service account with the
  read-only Cloud Storage scope (`devstorage.read_only`). Whether anything must also be granted on the bucket itself is
  **UNVERIFIED**; support threads show "access denied" cases that were not resolved on the page read.
- Read path from TypeScript: Cloud Storage JSON API list (`storage.googleapis.com/storage/v1/b/{bucket}/o?prefix=`)
  and media download (`alt=media`), with the same JWT bearer grant at the new scope. No client library needed (**UNVERIFIED**
  against a real bucket).
- **One bucket per developer account, not per app** (Google's documentation: the reports of every app of the account are in the
  same private bucket, organised by package name). A workspace may hold apps of several accounts, so the repo resolves the bucket per
  app: the app's own setting (`analytics_app_config.play_bucket_id`, App settings), else the Play credential's
  (`analytics_credential_config`, migration 42, optional), else the workspace default (`analytics.playBucketId`). A package that is
  nowhere in the bucket (`package_not_in_bucket`, found by listing `stats/<report>/<report>_<package>_` without a month) means the
  bucket is another account's. Where the user finds the id: Play Console, Download reports, then Reviews, Statistics or Financial,
  the "Copy Cloud Storage URI" button next to the section header; the URI starts with `gs://pubsite_prod_rev_` and digits.
- **Why Android Insights showed vitals but no downloads**: Reporting API vitals need no bucket and arrive on their own; installs and
  ratings exist only in these CSV files, so until a bucket id is set nothing reads them. The sync reported this as an _optional_ setup
  step, collapsed under "Sources and sync". Insights now says it where the numbers would be, and offers the import of a Play Console
  statistics CSV (Download reports, Statistics) as the way in that needs no Cloud Storage access at all (**UNVERIFIED** that the console
  export has the same columns as the bucket files: the import matches by header name and refuses a file it cannot map).
- What the empty state tells the user to grant is **UNVERIFIED**: (1) the Play Console permission "View app information and download
  bulk reports (read-only)" for the service account, and (2) Storage Object Viewer on the bucket in Google Cloud. Google's pages read
  do not say whether (1) alone suffices or whether (2) can be granted on a bucket Google owns; the test button of the app answers
  with `bucket_forbidden` so the first real attempt settles it.
- Files are **monthly CSVs**. Most data is captured daily and posted within 3 to 7 days. Re-read the current month's
  file on each sync (the exact cumulative behaviour is **UNVERIFIED**). Earnings and invoice billing files are monthly and
  usually there by the 5th of the next month. Google advises not depending on an exact update time. Retention is not stated.
  Encoding: Google's BigQuery note says the files need converting from UTF-16 to UTF-8, so decode with
  `TextDecoder('utf-16le')` after checking for a byte order mark (**UNVERIFIED** for every file type).

| Report            | Path pattern                                                               | Columns (Google's help page)                                                                                                | Dimensions                                                                                                     |
| ----------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Installs          | `stats/installs/installs_<pkg>_yyyyMM_<dimension>.csv`                     | Daily Device Installs, Uninstalls, Upgrades, Current/Total/Daily User Installs, User Uninstalls, installs on active devices | app version, carrier, country, device, language, OS version (an `overview` file is not listed: **UNVERIFIED**) |
| Ratings           | `stats/ratings/...`                                                        | Daily Average Rating, Total Average Rating                                                                                  | same family                                                                                                    |
| Crashes           | `stats/crashes/...`                                                        | Daily Crashes, Daily ANRs                                                                                                   | app version, device, OS version                                                                                |
| Store performance | `stats/store_performance/store_performance_<pkg>_<yyyyMM>_<breakdown>.csv` | not documented on the page read (**UNVERIFIED**)                                                                            | country, traffic source; from March 2021                                                                       |
| Reviews           | `reviews/reviews_<pkg>_YYYYMM.csv`                                         | per review                                                                                                                  | Gives history beyond the 7 days of the Android Publisher API.                                                  |
| Estimated sales   | `sales/salesreport_YYYYMM.zip`                                             | buyer-paid amounts before taxes and fees                                                                                    | monthly                                                                                                        |
| Earnings          | `earnings/earnings_YYYYMM.zip`                                             | payout and transaction lines                                                                                                | monthly; Google's recommended accounting source. Its Fee Description column gets new values from October 2026. |
| Subscriptions     | `financial-stats/subscriptions/...`                                        | aggregated                                                                                                                  | country                                                                                                        |

The acquisition exports of retained installers and buyers were removed after August 2021.

### 3.3 Android Publisher API

The v3 reference has **no ratings, statistics or reports resource**. `reviews.list` (already used) returns only
reviews created or changed in the last 7 days, only those with a comment, 200 GET requests per hour per app (from
the connector's own header notes of Google's reply guide). It cannot give a rating average or count.

### 3.4 Store listing visitors and the June to July 2026 metric change

- Google's help defines **store listing visitors** (users who viewed the listing without the app on any device) and
  **store listing acquisitions** (visited, then installed, for the first time).
- In 2026 Play Console moved to click-based metrics: unique user clicks on Install, Open or Pre-register, a
  click-through rate that replaces the old conversion rate, and a "reach" metric. Google's page says the primary store
  listing metric is based on clicks from June 2026 (a trade article gives a 10 July cutover). Acquisitions stay in
  Statistics and in downloadable reports.
- **Google's help states that the legacy Cloud Storage CSV reports support only the original acquisition metrics.**
  So: visitors and acquisitions (and a derived conversion) may be available from the `store_performance` CSV;
  clicks, CTR and reach are **not** in any export or API found. Whether Google keeps filling the legacy visitors column
  after the change is **UNVERIFIED** and is the main risk for the Android funnel.
- Impressions: none. (A third-party tool exposes newer visitor and click fields from 2026-08-01; those are not an official
  API and are not relied on here.)
- Acquisition and retention report (installers retained 7 and 30 days, buyers): removed from export in 2021, console only.

## 4. Verdict table by metric

Effort assumes the shared work is done (section 6): S under a day, M one to three days, L more than three days. All
rows need a place to store daily facts (see 6.3).

### 4.1 Apple (iOS and macOS)

| Metric                                                     | Source: API / report                                                                    | Granularity                                    | Delay                             | Retention at source                                       | Access                                                                   | Effort                                       | Risks                                                                                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Impressions                                                | Analytics Reports: App Store Discovery and Engagement, Event = Impression               | day, week, month; by source, territory, device | up to 3 days                      | 35 days per instance; history from 2024-01-01 by snapshot | ADMIN to create the request; ADMIN, SALES_AND_REPORTS or FINANCE to read | L (request lifecycle, gzip CSV, latest-wins) | Admin key; 1 to 2 day wait for first data; Detailed rows under 5 users are dropped and noised (whether Standard is noised is UNVERIFIED). |
| Product page views                                         | same report, Event = Page view (Counts and Unique Counts)                               | same                                           | same                              | same                                                      | same                                                                     | S after the above                            | Page Type includes non-product pages: filter to Product page.                                                                             |
| Downloads                                                  | Analytics Reports: App Store Downloads (first-time, redownload)                         | day (week, month Detailed)                     | up to 2 days                      | same                                                      | same                                                                     | S after the above                            | Updates are in the same table: filter by Download Type. Not the same as Sales units.                                                      |
| Conversion                                                 | derived: first-time downloads over unique page views (or impressions)                   | day                                            | max of both                       | n/a                                                       | same                                                                     | S                                            | May not equal the console number (UNVERIFIED); label as derived.                                                                          |
| Units and proceeds, by day and country                     | `GET /v1/salesReports` SALES/SUMMARY                                                    | day, week, month, year                         | next day, about 8 a.m. PT         | 1 year (10 for yearly)                                    | SALES_AND_REPORTS key; vendor number                                     | M                                            | Vendor number is a new input; proceeds in mixed currencies; estimates; Pacific time; query parameters UNVERIFIED on the page.             |
| Sales and proceeds in USD, paying users, by source         | Analytics Reports: App Store Purchases                                                  | day                                            | up to 2 days                      | same                                                      | same as impressions                                                      | S after the pipeline                         | Paid apps and IAP only; Detailed is noised; paying users not summable.                                                                    |
| Final proceeds                                             | `GET /v1/financeReports`                                                                | fiscal month                                   | first Friday of next fiscal month | 10 years                                                  | Admin, Finance (not Sales and Reports)                                   | M                                            | Parameters UNVERIFIED; fiscal calendar; skip until asked.                                                                                 |
| Subscriptions (active, events)                             | salesReports SUBSCRIPTION, SUBSCRIPTION_EVENT (1_3), Analytics Subscription State/Event | day                                            | next day                          | 1 year                                                    | SALES_AND_REPORTS                                                        | M                                            | Out of MVP.                                                                                                                               |
| Crashes by version                                         | Analytics Reports: App Crashes                                                          | day                                            | up to 5 days                      | same                                                      | same                                                                     | S after the pipeline                         | Opted-in users only (a sample, scale with App Store Opt-in); no rate without a denominator; includes macOS.                               |
| Crash rate proxy                                           | App Crashes (crashes, unique devices) over App Sessions (unique devices)                | day                                            | 5 days                            | same                                                      | same                                                                     | M                                            | Both are opted-in samples. Present as "crashes per 1000 sessions", not "crash-free users".                                                |
| Launch, hang, memory, disk, battery, hitch rate by version | `GET /v1/apps/{id}/perfPowerMetrics`                                                    | per app version, percentiles                   | days after release                | latest versions                                           | key that can read the app (role UNVERIFIED)                              | M                                            | JSON, not CSV; iOS proven, macOS UNVERIFIED; needs enough users.                                                                          |
| Sessions, installs, deletes                                | Analytics Reports: App Sessions, Installations and Deletions                            | day                                            | 5 days                            | same                                                      | same                                                                     | S after the pipeline                         | Opted-in users only.                                                                                                                      |
| Rating average and count over time                         | none in the API                                                                         | n/a                                            | n/a                               | n/a                                                       | n/a                                                                      | M (own snapshot of `itunes-rating.ts` daily) | History starts the day we begin snapshotting; iTunes fields UNVERIFIED.                                                                   |
| Rating text summary                                        | `customerReviewSummarizations`                                                          | on demand                                      | unknown                           | unknown                                                   | UNVERIFIED                                                               | S                                            | Stub documentation, text only.                                                                                                            |
| Retention (D1, D7, D30)                                    | **not available**                                                                       |                                                |                                   |                                                           |                                                                          |                                              | See section 7.                                                                                                                            |

### 4.2 Google Play (Android)

| Metric                                                            | Source: API / report                                                       | Granularity                           | Delay                                              | Retention at source                     | Access                                                                                                             | Effort                                              | Risks                                                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Crash rate and ANR rate (user-based), by version, device, country | Reporting API `crashRateMetricSet`, `anrRateMetricSet` query               | day (PT), hour (UTC)                  | about a day (`freshnessInfo`; no figure published) | "three years" in 2022 post (UNVERIFIED) | scope `playdeveloperreporting`; Play permission View app information (read-only), API enabled in the Cloud project | M (new host, new scope, JSON)                       | Small apps may return no rows (thresholds UNVERIFIED); unit to confirm; distinctUsers is rounded.              |
| Slow start, slow rendering, wakeups, memory kills                 | other `vitals.*` metric sets                                               | day, hour                             | about a day                                        | see above                               | same                                                                                                               | S after crash rate                                  | Optional charts.                                                                                               |
| Crash and ANR counts                                              | Cloud Storage `stats/crashes` or `vitals.errors.counts`                    | day in a monthly file, or day via API | 3 to 7 days (CSV)                                  | not stated                              | CSV: View app information Global; API: as above                                                                    | S to M                                              | Counts are not normalized.                                                                                     |
| Error issues and stack traces                                     | `vitals.errors.issues.search`, `reports.search`                            | issue, hour-aligned interval          | about a day                                        | not stated                              | same as Reporting API                                                                                              | M                                                   | Stack traces may contain app data: treat as sensitive.                                                         |
| Anomalies                                                         | `anomalies.list`                                                           | event                                 | n/a                                                | n/a                                     | same                                                                                                               | S                                                   | Response shape not read in detail.                                                                             |
| Installs, uninstalls, upgrades, active installs                   | Cloud Storage `stats/installs` (by country, version, device, OS, language) | day in monthly files                  | 3 to 7 days                                        | not stated                              | View app information Global; bucket id; `devstorage.read_only`                                                     | L (bucket access, listing, UTF-16 CSV, month merge) | New credential input; encoding and file names UNVERIFIED; no data for the current day.                         |
| Store listing visitors and acquisitions, conversion (derived)     | Cloud Storage `store_performance` (legacy metrics)                         | day by country or traffic source      | 3 to 7 days                                        | from March 2021                         | same                                                                                                               | M after installs                                    | Column names unverified; June to July 2026 change may thin or stop the legacy fields.                          |
| Impressions, reach, clicks, CTR                                   | **not available**                                                          |                                       |                                                    |                                         |                                                                                                                    |                                                     | Console only.                                                                                                  |
| Rating average over time                                          | Cloud Storage `stats/ratings` (Daily and Total Average Rating)             | day                                   | 3 to 7 days                                        | not stated                              | same                                                                                                               | S after installs                                    | No count, no histogram. Fine as a trend line.                                                                  |
| Reviews                                                           | Android Publisher `reviews.list` (last 7 days, with comment)               | review                                | live                                               | 7 days                                  | already granted                                                                                                    | done                                                | For history use the Cloud Storage `reviews` CSV (M).                                                           |
| Sales and earnings                                                | Cloud Storage `sales/`, `earnings/` zips                                   | month                                 | by the 5th of next month                           | not stated                              | View financial data Global                                                                                         | M                                                   | Currency mix; zip handling (`node:zlib` cannot read zip archives, only gzip, so a small zip reader is needed). |
| Retention                                                         | **not available**                                                          |                                       |                                                    |                                         |                                                                                                                    |                                                     | See section 7.                                                                                                 |

## 5. Risks that cut across stores

1. **Persistence is not optional for Apple.** Instances vanish after 35 days; Sales reports after a year. Collect from
   day one and run the one-time snapshot early.
2. **Opted-in samples.** Apple sessions, installs and crashes, and Apple perf metrics, cover only users who share data;
   Google rates are for users in the OS public cohort. Never show them as totals; show the Opt-in share next to them.
3. **Privacy noise and thresholds.** Small apps will see gaps (rows under 5 are dropped, no usage report when under 5
   users). The UI needs an "insufficient data" state, not zeros.
4. **Different definitions between stores.** Apple downloads, Apple units, Google device installs and Google user installs
   are different things. Show per store; do not add them up.
5. **Time zones.** Apple sales days and Google daily vitals are Pacific Time; hourly Google is UTC; the Apple analytics Date
   time zone is not stated (**UNVERIFIED**).
6. **Credential change.** Apple analytics needs ADMIN to start. Google needs a second API enabled, two new token scopes and
   a bucket id. `docs/credentials.md` must say so and the credential test (`docs/api/credential-tests.md`) should check each.
7. **Moving ground.** The Apple `INSTALLS` change (2026-11-04) and Google's 2026 store listing change both happened in
   the last six months. Keep each source behind a feature flag and degrade to "not available" on schema change; read
   columns by name.
8. **Reviews rate budget.** Apple's hourly budget is per key and shared; analytics adds about 20 calls per app per day.

## 6. Implementation notes (TypeScript, `fetch`, no new dependency)

### 6.1 Shared infrastructure (do first, about 2 to 3 days)

- `StoreHttp`: add a `sendBytes` (or a `responseType`) path, an option to skip the default headers for a pre-signed URL,
  a size cap, and keep the redaction (the pre-signed query string is a secret: add it to `known`).
- `GoogleTokenProvider`: take the scope in the constructor; build one provider per scope from the same key.
- A `delimited.ts` parser (quotes, BOM, delimiter sniff, header-name access) plus `gunzip` and UTF-16 decode helpers.
- Fixtures per report, like the existing `*.fixtures.ts` files, so tests run offline.

### 6.2 Per source

- Apple Analytics: a small state machine per app and platform record: `ensureRequest` (list, create `ONGOING` if none,
  re-create when `stoppedDueToInactivity`), `listReports` (once a day, cache by name), per wanted report
  `listInstances(DAILY)` newest first, `listSegments`, download within the 5 minute window, parse, upsert by
  (report, date, dimensions) taking the highest `processingDate`. Checksum check is optional (algorithm **UNVERIFIED**).
- Apple salesReports: one call per day and report type; gzip; parse TSV; filter by Apple Identifier.
- Google Reporting: `POST` query per metric set with `DAILY`, `versionCode` (and `countryCode` on request), page with
  `nextPageToken`; call `get` for `freshnessInfo` first.
- Google Cloud Storage: list prefix, pick the latest month files, download, decode, parse, upsert by date.

### 6.3 Storage

One narrow fact table in `packages/db` (store, app, platform, source report, metric, date, dimension key, value,
processing date, fetched at) with an upsert keyed on all but value. Keep the raw report name for traceability. Do not store
detailed Apple rows with user-related fields beyond what a chart needs.

## 7. Recommended MVP: six charts

1. **Downloads over time** (per store): Apple first-time downloads and redownloads (App Store Downloads); Google user
   installs (`stats/installs`). Two series per app, not summed. Filter by platform (iOS, macOS) via the Device column.
2. **Store funnel**: Apple impressions, product page views, first-time downloads and the derived conversion (Discovery and
   Engagement plus Downloads). Google: store listing visitors and acquisitions from `store_performance`, with a clear
   "legacy metric" caption and a hidden state if the column is empty.
3. **Proceeds and units**: Apple from `salesReports` (units, proceeds by currency) or the USD estimate from the Purchases
   report; Google estimated sales monthly in a later phase.
4. **Stability by version**: Google crash rate and ANR rate by version code (Reporting API); Apple crashes per version
   (App Crashes) with crashes per 1000 sessions. Link each release in the release manager to its version row, since that is
   this tool's strength.
5. **Ratings trend**: Google `stats/ratings` average; Apple from our own daily snapshot, flagged "since we started tracking".
6. **Performance by version** (Apple perf metrics: launch, hangs; Google slow start and rendering): launch time p50 and
   p90 per version.

## 8. Phased plan

- **Phase 0, spike (1 to 2 days, needs a real Apple Admin key and a Play account):** run each of the UNVERIFIED calls
  once, save redacted fixtures, record the real column names, delimiter, encoding, unit and the exact permissions. Decide the
  Admin key question (a one-time "enable analytics" action with an Admin key that is not stored, or a documented
  requirement). Create the Apple `ONGOING` request as early as possible, because data only accumulates from then
  (and request one snapshot for backfill).
- **Phase 1 (about 1 week):** shared infrastructure (6.1), Apple Analytics pipeline (downloads, discovery, purchases,
  crashes, sessions), Google Reporting API crash and ANR. Charts 1 (Apple), 2 (Apple), 4. Add the credential tests and the
  `docs/credentials.md` text.
- **Phase 2 (about 1 week):** Cloud Storage reader with the bucket id field: Google installs, ratings, store performance,
  crashes; Apple `salesReports` with the vendor number; daily rating snapshots. Charts 1 (Google), 2 (Google), 3, 5.
- **Phase 3 (optional):** `perfPowerMetrics` and Google slow start and rendering (chart 6); Google earnings and
  subscription stats; Apple finance reports; Google review history from the `reviews` CSV; error issues and stack
  traces for a release page; anomalies as alerts.

## 9. Not possible with the official APIs (as far as found)

- **Retention** (day-N retention, cohorts) on either store. Apple's reports hold sessions and deletions only; the
  "App Download Date" column (filled only for downloads in the previous 30 days) allows a rough, unofficial proxy at best.
  Google's retained-installer analysis is console-only; its export ended in 2021.
- **Impressions, reach, clicks and CTR for Google Play.** Console only.
- **Rating counts, histograms and a rating history** on either store through an API (Google offers only the average, via CSV).
- **Crash-free users for Apple.** Only opted-in crash counts and metric percentiles by version.
- **A Google store listing funnel with the 2026 click metrics** from any API or export found.
- **Real-time or intraday data** (Apple is daily with a 2 to 5 day completeness window; Google vitals refresh about daily).
- **Apple history before 2024-01-01** in Analytics Reports, and more than one year of daily Sales and Trends.
- **Per-keyword or search-term data**, and ad attribution (separate ads APIs, out of scope).
- **Per-user data** of any kind (not offered, and not wanted).
- **Reviews older than 7 days** from the Android Publisher API (the Cloud Storage `reviews` CSV is the only route).

## 10. UNVERIFIED list (to settle in Phase 0)

1. Whether a Sales and Reports key can read analytics reports in practice after an Admin key created the request.
2. Behaviour of a second `POST /v1/analyticsReportRequests` for the same app; the inactivity limit before
   `stoppedDueToInactivity`; the category and name filter parameters on the reports list.
3. Analytics segment delimiter, checksum algorithm, Date time zone, and the Device strings that identify a Mac.
4. `salesReports` query parameters, response encoding, how to find the vendor number, and how to isolate macOS rows.
5. `financeReports` parameters.
6. `perfPowerMetrics` metric type values, macOS support, role needed; shapes of `performanceOverviews` and
   `customerReviewSummarizations`; whether segment downloads count against the hourly limit.
7. The exact Play Console permission names for vitals, whether the bucket needs its own IAM grant, how to find the
   bucket id from the API, file encodings, `overview` file names, `store_performance` columns, and whether the
   month files are cumulative.
8. Crash rate unit (fraction vs percent), Reporting API history depth, latency and thresholds for small apps.
9. Whether Google still populates legacy store listing visitors after the June to July 2026 change.
10. iTunes lookup rating fields (already UNVERIFIED in `itunes-rating.ts`).

## 11. Sources checked (2026-11-19)

Apple:

- https://developer.apple.com/documentation/appstoreconnectapi/analytics
- https://developer.apple.com/documentation/appstoreconnectapi/downloading-analytics-reports
- https://developer.apple.com/documentation/appstoreconnectapi/post-v1-analyticsreportrequests
- https://developer.apple.com/documentation/appstoreconnectapi/get-v1-analyticsreports-_id_-instances
- https://developer.apple.com/documentation/appstoreconnectapi/get-v1-analyticsreportinstances-_id_-segments
- https://developer.apple.com/documentation/analytics-reports (index, privacy, data completeness, and the
  Discovery and Engagement, Downloads, Purchases, Sessions, Installs, Crashes, Crashes Expanded and Opt-in pages)
- https://developer.apple.com/documentation/appstoreconnectapi/get-v1-salesreports
- https://developer.apple.com/documentation/appstoreconnectapi/get-v1-financereports
- https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-perfpowermetrics (and the build, overview and
  "power and performance" pages)
- https://developer.apple.com/documentation/appstoreconnectapi/identifying-rate-limits
- https://developer.apple.com/documentation/appstoreconnectapi/app-store-connect-api-4-4-release-notes (and 4.5, 4.6)
- https://developer.apple.com/help/app-store-connect/view-sales-and-trends/download-and-view-reports
- https://developer.apple.com/help/app-store-connect/reference/reporting/sales-and-trends-reports-availability
- https://developer.apple.com/help/app-store-connect/reference/reporting/summary-sales-report
- https://developer.apple.com/help/app-store-connect/getting-paid/download-financial-reports

Google:

- https://developers.google.com/play/developer/reporting (overview, `metricset-intro`, `limits`, REST reference,
  `vitals.crashrate`, `vitals.crashrate/query`, `vitals.anrrate`, `vitals.errors.counts`, `vitals.errors.issues/search`,
  `anomalies/list`, `apps/search`, `FreshnessInfo`)
- https://android-developers.googleblog.com/2022/03/play-developer-reporting-API.html
- https://support.google.com/googleplay/android-developer/answer/6135870 (reports in Cloud Storage)
- https://support.google.com/googleplay/android-developer/answer/139628 and 9859173 (store listing metrics) and 6263332 (acquisition)
- https://developers.google.com/android-publisher/api-ref/rest (resource list; no ratings, statistics or reports resource)
- https://static.aso.dev/google-play/permissions/ (third party, used only for the permission label question)
