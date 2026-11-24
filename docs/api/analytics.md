# Analytics API

Daily store numbers for one app, read into one table and served with their source, delay and coverage. See
[ADR 0017](../adr/0017-analytics-foundation.md). **No store was contacted while this was built: what is marked UNVERIFIED in
[the study](../research/analytics-apis.md) still is** (see the end of this page).

All routes are under `/api/workspaces/:workspaceId/apps/:id/analytics/`. Every route is about one app, so a token restricted to apps
only reaches its apps. Reading needs `analytics.read` (every role); sync, enable, import and the settings need `analytics.manage`
(owners and admins; for API tokens it must be granted **explicitly**, and a token that has only `analytics.manage` cannot read).

Errors are flat: `{ "error": "<code>", "message": "..." }` (a 400 is `{ "error": "invalid_request", "issues": [...] }`). Codes are a fixed
vocabulary; switch on `error`, not on `message`. Too many syncs, previews or enables in a minute: `429 rate_limited` with `retryAfterSeconds`.

## Switching it on

Workspace settings (see [settings](settings.md)), all written with `analytics.manage`:

- `analytics.enabled` (boolean, default `false`): syncing, the scheduled job and the Apple enable action need it. Reading and **importing** do not.
- `analytics.appleVendorNumber` (string, 5 to 12 digits): turns on `apple_sales` (units and proceeds, also by product) for iOS and macOS apps.
- `analytics.playBucketId` (string, `pubsite_prod_rev_` and digits): the Cloud Storage bucket of the monthly CSV reports, for the whole workspace. The narrower places below win; prefer them. The estimated sales, monthly earnings and subscription statistics files are in the same bucket and also need the Play Console permission **View financial data** (Global) for the service account.
  The same bucket also holds the Google Play **estimated sales** reports, the monthly **Earnings** report and the **subscription statistics**: they turn on
  `play_sales`, `play_earnings` and `play_subscriptions` with no further setting, but need the Play Console permission **View financial data** (set to Global) for the
  service account. See [Sales](#sales), [Earnings](#earnings-google-play-monthly) and [Subscriptions](#subscriptions).
- The vendor number also turns on `apple_subscriptions` (the Subscription and Subscription Event reports of Sales and Trends). See [Subscriptions](#subscriptions).

`KILN_ANALYTICS_INTERVAL_MINUTES` (default 360; `0` off; 15 to 10080) sets how often the scheduler queues a sync. See [deployment](../deployment.md).

## Endpoints

| Method and path                                       | Needs  | Purpose                                                                                                    |
| ----------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `GET overview?platform&from&to&granularity&breakdown` | read   | series for one app                                                                                         |
| `GET product-sales?from&to`                           | read   | sales of one app by store product (SKU), from stored analytics; see [Sales](#sales)                        |
| `GET status`                                          | read   | what is set up, what is missing, last runs                                                                 |
| `POST sync`                                           | manage | read the stores now (body optional `{ "sources": [...] }`)                                                 |
| `GET apple/enable[?backfill=true]`                    | manage | preview of the Apple report request (reads Apple, changes nothing)                                         |
| `POST apple/enable`                                   | manage | create it (`{ "confirmHash", "backfill"? }`)                                                               |
| `GET play-bucket`                                     | read   | where the Google Play reports bucket of an Android app is set                                              |
| `PUT play-bucket`                                     | manage | set or clear it (`{ "bucket", "scope"? }`)                                                                 |
| `POST play-bucket/test`                               | manage | can the service account list this app's report files?                                                      |
| `POST import/preview?fileName=`                       | manage | check a report file: Apple report, or for Android a Play Console statistics CSV (the raw file is the body) |
| `POST import?fileName=&confirmHash=`                  | manage | store it (the same raw file again)                                                                         |

### `GET overview`

`platform` must equal the app's platform. `from` and `to` are `YYYY-MM-DD` (default: the 28 days up to yesterday; at most 400 days).
`granularity`: `day` (default), `week`, `month`. `breakdown`: one of `territory`, `source_type`, `app_version`, `currency`, `product`.

```json
{
  "appId": "...",
  "platform": "ios",
  "from": "2026-10-22",
  "to": "2026-11-18",
  "granularity": "day",
  "series": [
    {
      "id": "impressions",
      "metric": "impressions",
      "label": "Impressions",
      "unit": "count",
      "aggregation": "sum",
      "source": "apple_analytics",
      "derived": false,
      "currency": null,
      "delayDays": 5,
      "total": 1234,
      "points": [{ "date": "2026-10-22", "value": 40 }, { "date": "2026-10-23", "value": null }],
      "coverage": {
        "state": "partial",
        "firstDay": "2026-10-25",
        "lastDay": "2026-11-16",
        "days": 23,
        "gapDays": 2,
        "notes": [{ "code": "recent_days_incomplete", "message": "..." }]
      },
      "breakdown": { "dimension": "territory", "items": [{ "value": "US", "total": 500 }] }
    }
  ],
  "notes": [{ "code": "google_no_impressions", "message": "..." }]
}
```

`value` is `null` where the store gave nothing: **null is not zero**; draw a gap. `unit`: `count`, `ratio`, `rating`, `money`.
`aggregation` (`sum` or `mean`) says how days combine into a week or month; `total` is the sum or the mean over the range. Money series
come one **per currency** (`id: "sales_proceeds:EUR"` for Apple, `id: "sales_gross:EUR"` for Google Play, `currency: "EUR"`); nothing is converted or added across currencies. `derived`
series (`product_page_conversion`, `impression_tap_rate`) are computed from two others and are null where the denominator is missing.
A series with `"cadence": "monthly"` (Google Play earnings) is reported once a month: each point is a month, dated the first of it, and `coverage` counts months
(`days` is a count of months, `gapDays` of months missing, no `gaps` or `recent_days_incomplete` note); read it with `granularity=month`. A daily or weekly read of
it is mostly gaps. Subscription counts (`subscriptions_*`, `play_subscriptions_*`) are `unit: "count"`: counts of subscriptions on a day (levels: `aggregation: "mean"`) or
events (sums), never people, never money.
`breakdown` (top 10 values) is present only when asked and the source has the dimension. With `breakdown=product` the sales series list the top products
(store product ids); a money series lists only the products of its own currency. `coverage.state`: `complete`, `partial`, `none`.

Coverage note codes (`coverageNoteCodes`, with the sentence in `message`): `apple_usage_opt_in_only`, `apple_privacy_thresholds`,
`apple_counts_not_unique`, `apple_usage_sample_not_total`, `apple_estimates`, `apple_pacific_time`, `apple_proceeds_per_currency`,
`apple_in_app_not_included`, `apple_rating_history_not_available`, `apple_impressions_only_via_reports`, `google_unit_unverified`,
`google_legacy_store_listing`, `google_no_impressions`, `google_rating_average_only`, `google_monthly_files`, `play_estimated_sales_gross`,
`play_sales_latency`, `play_sales_utc`, `play_sales_per_currency`, `play_earnings_monthly`, `play_earnings_net`, `play_earnings_per_currency`,
`play_earnings_pacific`, `apple_subscription_counts`, `apple_subscription_events`, `play_subscription_stats`, `apple_product_sales_include_in_app`, `sales_products_capped`, `derived`, `imported`,
`recent_days_incomplete`, `gaps`, `source_not_connected`, `no_data_yet`, `only_since_connected`.

### `GET status`

```json
{
  "appId": "...",
  "platform": "ios",
  "enabled": true,
  "schedule": { "intervalMinutes": 360 },
  "apple": {
    "mode": "ongoing",
    "requests": [
      { "accessType": "ONGOING", "status": "active", "createdAt": 0, "lastCheckedAt": 0 }
    ],
    "vendorNumberSet": true,
    "vendorNumberSource": "credential",
    "vendorNumber": "85123456"
  },
  "google": null,
  "sources": [
    {
      "source": "apple_analytics",
      "label": "...",
      "state": "ready",
      "setup": null,
      "lastAttemptAt": 0,
      "lastOkAt": 0,
      "lastError": null,
      "firstDay": "2026-10-25",
      "lastDay": "2026-11-16"
    }
  ],
  "runs": [
    {
      "source": "apple_analytics",
      "trigger": "schedule",
      "status": "ok",
      "errorCode": null,
      "pointsWritten": 120,
      "reportsRead": 4,
      "startedAt": 0,
      "finishedAt": 0
    }
  ]
}
```

Times are epoch milliseconds. `apple` is null for Android, `google` null for iOS and macOS. For Android `google` is
`{ bucketIdSet, bucketSource, bucketId, severalPlayAccounts, serviceAccountEmail }`: the bucket the app reads (a name, not a secret) and where it
came from (`app`, `account`, `workspace`), whether the workspace holds more than one Play credential (a workspace-wide bucket cannot fit them all), and the
`client_email` of the app's service account, the address to invite in Play Console (not a secret; read from the credential without logging a use of
the key). `apple.vendorNumberSource` is `credential` (the number of the app's App Store Connect credential, one Apple team), `workspace` (the
workspace setting `analytics.appleVendorNumber`, the default) or null. `apple.mode`: `off`, `ongoing`, `import`.
Source `state`: `off` (workspace setting off), `needs_setup`, `waiting` (set up; Apple has made no report yet, which takes a day or two),
`error`, `ready`. `setup` when not ready: `{ code, nextStep, alternatives[], optional, message }`. Run `trigger`: `schedule`, `manual`,
`enable`, `import`.

Setup codes (`analyticsSetupCodes`): `turn_on_analytics`, `create_report_request`, `role_required`, `waiting_first_data`,
`request_stopped`, `vendor_number_missing`, `sales_forbidden`, `vendor_number_invalid`, `bucket_not_found`, `package_not_in_bucket`,
`play_sales_forbidden`, `bucket_id_missing`, `bucket_forbidden`, `reporting_api_not_enabled`,
`play_permission_missing`, `credential_problem`, `first_sync_pending`. Next steps (`analyticsNextSteps`): `turn_on_analytics`,
`enable_apple_analytics`, `import_apple_report`, `ask_apple_admin`, `set_vendor_number`, `set_bucket_id`, `grant_play_permission`,
`grant_play_financial_permission`, `enable_reporting_api`, `fix_credential`, `sync_now`, `wait`.

### Why a source fails: error classes

The stored error of a source (`lastError.code`) is one code of a fixed vocabulary; the server never keeps the store's text. The classes that matter
for Sales and Play reports (see also [Troubleshooting analytics sources](../troubleshooting-analytics.md)):

| Code                                   | Cause                                                                                                                                                                                                              | Fix                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `vendor_number_missing`                | No vendor number for the Apple team of the app (optional source).                                                                                                                                                  | Enter it: `PUT apple-vendor`.                            |
| `vendor_number_invalid`                | Apple answered HTTP 400 about the vendor number (another team's, or mistyped).                                                                                                                                     | Check it in Payments and Financial Reports.              |
| `sales_forbidden`                      | Apple answered 403 on Sales and Trends: the key's role (needs Sales, Finance, Admin or Account Holder) or a vendor number of another team.                                                                         | Fix the role or the number.                              |
| `bucket_missing` / `bucket_id_missing` | No Cloud Storage bucket id for the app.                                                                                                                                                                            | Set it (`PUT play-bucket`).                              |
| `bucket_forbidden`                     | Google answered 403 on the whole reports bucket: another Play account's bucket, or the service account was not invited in Play Console (View app information and download bulk reports).                           | Check the bucket id, then the invitation.                |
| `play_sales_forbidden`                 | The statistics folder can be read but a financial folder (`sales/`, `earnings/`, `financial-stats/`) cannot: Play Console permission View financial data, orders and cancellation survey responses, set to Global. | Grant it; up to 24 to 48 hours.                          |
| `bucket_not_found` / `bucket_invalid`  | The bucket id does not exist or is not `pubsite_prod_rev_<number>`.                                                                                                                                                | Copy it again from Play Console.                         |
| `package_not_in_bucket`                | The bucket is readable but holds nothing of this package: another account's bucket.                                                                                                                                | Set the bucket of the owning account.                    |
| `store_rejected`                       | The store answered an HTTP 4xx that has no meaning of its own (not an outage).                                                                                                                                     | Check credential, vendor number, bucket id; test access. |
| `store_unavailable`                    | Network failure, timeout or HTTP 5xx.                                                                                                                                                                              | The next sync tries again.                               |

Not failures (the read succeeds, nothing is stored): Apple 404, or 400 about the report date (no report for that day); a month with no Play file yet
(`sales/salesreport_YYYYMM.zip` appears during the month, `earnings/earnings_YYYYMM.zip` about the 5th of the next month); a readable bucket with no
file of the app yet. Apple sales days run on Pacific Time: the newest day asked for is yesterday in Pacific Time.

### `PUT apple-vendor`

Body `{ "vendorNumber": "85123456" | null }` (digits, 5 to 12; `422 vendor_number_invalid` otherwise; `null` clears). Stored per App Store Connect
credential (`analytics_credential_config.apple_vendor_number`, migration 58), so apps of two Apple teams do not share one number; without one the
workspace setting `analytics.appleVendorNumber` applies. Needs `analytics.manage`. Contacts no store. Audited as `analytics.vendor_number_set`
(ids only).

### `POST access-test`

Body `{ "source": "apple_sales" | "apple_subscriptions" | "play_reports" | "play_sales" | "play_earnings" | "play_subscriptions" }`. One cheap call, nothing
stored: Apple asks for one daily report of two days ago (Pacific Time); Google lists one object of the folder of the bucket (`stats/installs/`,
`sales/`, `earnings/`, `financial-stats/subscriptions/`). Answer `200`:
`{ "result": { "source", "ok", "code", "message", "serviceAccountEmail"? } }` with `code` `ok`, `no_report_yet` (works, no file yet) or an error
code above (`vendor_number_missing`, `bucket_missing`, ... included). A refused financial folder is told from a refused bucket by listing the
statistics folder too. Needs `analytics.manage`; rate limited per workspace.

### `POST sync`

Needs `analytics.enabled`. Body optional: `{ "sources": [...] }` (sources of the app's platform: `apple_analytics`, `apple_sales`, `apple_subscriptions`,
`play_vitals`, `play_reports`, `play_sales`, `play_earnings`, `play_subscriptions`). A store failure is **not** an HTTP error: the answer is 200 and each source says what happened.

```json
{
  "sync": {
    "at": 0,
    "pointsWritten": 120,
    "sources": [
      {
        "source": "apple_analytics",
        "status": "ok",
        "points": 120,
        "reports": 4,
        "dayFrom": "2026-11-14",
        "dayTo": "2026-11-16"
      }
    ]
  },
  "status": { "...": "as GET status" }
}
```

Per source: `status` is `ok`, `partial`, `failed` (then `errorCode` and `transient`: a later sync will try again) or `skipped` (cannot run
yet; `setup` is a string saying why, a setup code, or `import_only` when the Apple mode is `import`, which is **not** in the code list).
HTTP errors: `404 not_found`, `409 analytics_disabled`, `409 sync_in_progress` (one sync per app at a time), `502 sync_failed`.

Error codes (`analyticsErrorCodes`): `analytics_role_required`, `analytics_request_missing`, `analytics_request_stopped`,
`report_not_ready`, `segment_expired`, `segment_too_large`, `file_too_large`, `bad_gzip`, `bad_format`, `unknown_report`,
`missing_columns`, `no_rows`, `vendor_number_missing`, `vendor_number_invalid`, `sales_forbidden`, `play_reporting_not_enabled`,
`play_permission_missing`, `play_app_not_found`, `play_vitals_bad_request`, `play_vitals_no_data`, `bucket_missing`, `bucket_invalid`, `bucket_forbidden`, `bucket_not_found`,
`reports_not_found`, `play_sales_forbidden`, `store_auth`, `store_forbidden`, `store_not_found`, `rate_limited`, `store_unavailable`, `timeout`,
`credential_unreadable`, `credential_not_found`, `app_not_synced`, `sync_failed`. Messages carry no URL, token, report row or store text.

### Google Play reports bucket

Installs, ratings and store listing numbers of an Android app are not in the Reporting API (it holds crash and ANR data only). Google
publishes them as monthly CSV files in a **private Cloud Storage bucket, one per Play developer account** (`gs://pubsite_prod_rev_<number>`;
the reports inside are organised by package name). Without a bucket an Android app shows vitals only: Insights says so, with the steps.
A workspace can hold apps of **several Play accounts**, so the bucket is resolved per app, the narrowest first:

1. the **app** (`scope: "app"`, the default of `PUT`; shown in App settings),
2. the **Play credential** (`scope: "account"`, optional: every Android app that uses that credential),
3. the **workspace default**, the setting `analytics.playBucketId` (Settings, Analytics).

The sync and the status use the resolved bucket of each app. An app never reads another app's bucket: an app of a second Play account
needs its own, because its package is not in the workspace default's bucket. Then the read ends with `package_not_in_bucket` (the bucket can
be listed, but no report of this package exists in it at all), which is a different step from `reports_not_found` (no file for these months yet).

- `GET play-bucket` answers `{ "playBucket": { bucketId, source, app, account, workspace, inherited: { bucketId, source }, credentialId, sharedWith } }`.
  `bucketId` is the one the app reads now (no `gs://`), `source` is `app`, `account` or `workspace` (null when none is set), `inherited` is
  what it would read without its own override ("Use the workspace default" shows it), `sharedWith` counts the Android apps on the same
  credential. `422 not_an_android_app` for iOS and macOS apps.
- `PUT play-bucket` takes `{ "bucket": "gs://pubsite_prod_rev_01234567890/" | "pubsite_prod_rev_01234567890" | null, "scope": "app" | "account" }`
  (`scope` defaults to `app`; `null` clears the override and the app inherits). `400 invalid_request`, `422 bucket_invalid`,
  `422 not_an_android_app`, `404`. Contacts no store. Audited as `analytics.play_bucket_set` with ids, the scope and whether it was
  cleared (the bucket id itself is not logged). Deleting the Play credential removes its bucket id; deleting the app removes its own.
- `POST play-bucket/test` takes an optional `{ "bucket" }` (a value to try before saving it; otherwise the resolved one is used), lists the
  report files of the app for the previous and the current month (nothing is stored) and always answers 200 with
  `{ "result": { ok, code, message, months } }`. The codes are a fixed vocabulary, never Google's text: `ok`, `no_reports_yet` (readable, no
  file yet: `ok: true`), `package_not_found` (readable, but this package is not in the bucket: another account's bucket), `not_set`,
  `bucket_invalid`, `bucket_forbidden`, `bucket_not_found`, `credential_problem`, `unreachable`. Rate limited like the sync.

`GET status` carries `google: { bucketIdSet, bucketSource }` for Android apps (`bucketSource`: `app`, `account` or `workspace`).

### Sales

Two different things share the sales charts, and the API never calls the Google one "proceeds" (ADR [0038](../adr/0038-sales-analytics.md)).

|             | Apple (`apple_sales`, iOS and macOS)                                                                    | Google Play (`play_sales`, Android)                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Needs       | `analytics.appleVendorNumber`; the key's role Sales and Reports or higher (`sales_forbidden` otherwise) | the reports bucket id (above) and the Play Console permission **View financial data**, Global (`play_sales_forbidden` otherwise)                                                     |
| Source file | Sales and Trends daily summary (`GET /v1/salesReports`), next day, Pacific Time                         | `sales/salesreport_YYYYMM.zip` in the reports bucket: ALL apps of the account, filtered by `Package ID`; extended daily with charged and refunded orders, up to a few days late, UTC |
| Metrics     | `sales_units` (net: refunds are negative), `sales_proceeds:<CUR>` (developer proceeds)                  | `sales_gross:<CUR>` (what the **buyer paid**, tax included, Google's fee NOT deducted), `sales_refunds:<CUR>` (refunded, positive), `sales_orders` (charged orders)                  |
| Currency    | `Currency of Proceeds`                                                                                  | `Currency of Sale`                                                                                                                                                                   |
| Notes       | `apple_estimates`, `apple_proceeds_per_currency`, `apple_pacific_time`, `apple_in_app_not_included`     | `play_estimated_sales_gross`, `play_sales_per_currency`, `play_sales_latency`, `play_sales_utc`                                                                                      |

A day without a row is `null` (a gap), not 0. A month without a file yet is normal (the sync is `ok` with no data); the monthly **Earnings** report (net figures)
is read as its own source, below. The Estimated sales report is "not recommended for accounting" (Google): treat it as a trend, not as revenue.

### Earnings (Google Play, monthly)

ADR [0042](../adr/0042-earnings-and-subscription-metrics.md). Source `play_earnings` (Android). The Google Play **Earnings** report is a monthly statement, net of
Google's fees and taxes: the figure for accounting, where the estimated sales above are what buyers paid.

|                   |                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs             | the reports bucket id (above) and the Play Console permission **View financial data**, Global. A refused folder is `play_sales_forbidden` (the same code and next step `grant_play_financial_permission` as the sales; the statistics of the same bucket keep working)    |
| Source file       | `earnings/earnings_YYYYMM*.zip` in the reports bucket: ALL apps of the account, filtered by `Package ID`. Google generates it once a month, typically by the 5th of the following month. The sync reads the current and the previous month (six months on the first read) |
| Not available yet | A month with no file is **not an error**: it is skipped, the series has no point for it (`null`, not 0), and the status says nothing failed. The current month never has a file                                                                                           |
| Stored            | on the **first day of the month of the file**, never on a transaction date (the days in the file are Pacific Time, every other series is UTC), per merchant currency (`currency` dimension, `<CUR>:<product id>` per product)                                             |
| Metrics           | `earnings_net:<CUR>` (the signed sum of every line of the app), `earnings_charges:<CUR>`, `earnings_taxes:<CUR>`, `earnings_fees:<CUR>` (the lines of one family, as signed), `earnings_orders` (number of `Charge` lines)                                                |
| Currency          | `Merchant Currency` with `Amount (Merchant Currency)`, the currency you are paid in. Per currency, never converted or added                                                                                                                                               |
| Notes             | `play_earnings_monthly`, `play_earnings_net`, `play_earnings_per_currency`, `play_earnings_pacific`                                                                                                                                                                       |

Gross and net are two separate series of the same currency and month (`earnings_charges:EUR` and `earnings_net:EUR`); neither is derived from the other. Read them with
`granularity=month`. The Insights card is "Earnings (net, monthly)"; it has its own twelve-month range and the same currency tabs as the sales cards.

### Subscriptions

ADR [0042](../adr/0042-earnings-and-subscription-metrics.md). Counts of subscriptions (unitless: not people, not money), per day.

|            | Apple (`apple_subscriptions`, iOS and macOS)                                                                                                                                                                             | Google Play (`play_subscriptions`, Android)                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs      | `analytics.appleVendorNumber`; the key's role Sales and Reports or higher (`sales_forbidden` otherwise)                                                                                                                  | the reports bucket id and View financial data, Global (`play_sales_forbidden` otherwise)                                                       |
| Source     | `GET /v1/salesReports` with `SUBSCRIPTION` (a snapshot of the day) and `SUBSCRIPTION_EVENT`, `SUMMARY`, `DAILY`, version `1_3`. The per-subscriber `SUBSCRIBER` report is **not** read                                   | `financial-stats/subscriptions/subscriptions_<package>_<product>_YYYYMM_<dimension>.csv` in the reports bucket, one file per product and month |
| Metrics    | `subscriptions_active` (standard price), `subscriptions_active_trial` (free trial offers), `subscriptions_active_offer` (paid offers), `subscriptions_new`, `subscriptions_cancelled`, `subscriptions_trial_conversions` | `play_subscriptions_active`, `play_subscriptions_new`, `play_subscriptions_cancelled`                                                          |
| Dimensions | none (the app), `product` (the store product id), `duration` (Apple: `1 Month`)                                                                                                                                          | none (the app), `product`                                                                                                                      |
| Notes      | `apple_subscription_counts`, `apple_subscription_events`                                                                                                                                                                 | `play_subscription_stats`                                                                                                                      |

`breakdown=product` lists the products of `subscriptions_active` and the other series. Apple's and Google's counts are different measures and never mixed. The Insights card is
"Subscriptions": active (with trials), new and cancelled, and the active ones by product. A day without a report is `null`, not 0.

**By product.** The same facts are also stored under the dimension `product` (`breakdown=product`): the value is the store product id (Apple SKU, Google SKU ID),
and for money `<CUR>:<product id>`, so the currency is part of the key. At most **200 distinct products per app and source** are stored (known ones stay, new ones
are taken by volume; the totals are never dropped; `sales_products_capped` says so) and an id over 90 characters is skipped. Apple per-product numbers also
include in-app purchases and subscriptions of the app (matched by `Parent Identifier` = the app's SKU, or by a SKU of the stored Products snapshot), while the
total chart (`sales_units`, `sales_proceeds`) still counts the app itself only, so products can add up to more than the total.

`GET product-sales?from&to` (right `analytics.read`, default the last 28 days, at most 400; no store is contacted) answers

```json
{
  "appId": "...",
  "platform": "android",
  "from": "2026-10-22",
  "to": "2026-11-18",
  "source": "play_sales",
  "measure": "google_buyer_paid_estimate",
  "unitsKind": "orders",
  "hasSalesData": true,
  "enabled": true,
  "sales": {
    "source": "play_sales",
    "label": "...",
    "state": "ready",
    "setup": null,
    "lastOkAt": 0,
    "lastError": null
  },
  "products": [
    {
      "productId": "coins_100",
      "units": 2,
      "days": 1,
      "amounts": [{ "currency": "EUR", "amount": 4.74, "refunds": 2.37 }]
    }
  ],
  "notes": [{ "code": "play_estimated_sales_gross", "message": "..." }]
}
```

`measure`: `apple_proceeds` (`amount` is developer proceeds, already net of refunds, `refunds` null) or `google_buyer_paid_estimate` (`amount` is the sum charged,
`refunds` the refunded sum; show `amount - refunds` as a net estimate). `units`: Apple net units, Google charged orders (null: no count). `amounts` has one entry per
currency and is never added up. `hasSalesData` is false until a sales day is stored: a client then hides its sales UI and shows `sales.setup` (vendor number for Apple;
bucket id and View financial data for Google). The Products page ([products](products.md)) reads this route.

### Apple enable

`GET apple/enable` returns what exists at Apple and what would be created. It changes nothing at Apple.

```json
{
  "plan": {
    "appId": "...",
    "platform": "ios",
    "roleCheck": "ok",
    "steps": [{ "accessType": "ONGOING", "action": "create" }],
    "willSend": ["..."],
    "notes": ["..."]
  },
  "confirmHash": "sha256...",
  "canCreate": true
}
```

`roleCheck`: `ok` or `role_required`. `action`: `create`, `adopt` (Apple already has one; it is kept) or `exists`. `POST apple/enable`
with `{ "confirmHash" }` (and optional `"backfill": true`, which adds one ONE_TIME_SNAPSHOT) answers 201
`{ "enabled": { "appleMode": "ongoing", "steps": [...] } }`. Errors: `409 plan_changed` (the body carries the new plan; confirm again),
`422 analytics_role_required` with `nextStep: "import_apple_report"` (the key's role may not create report requests; Apple lists the Admin
role), `409 analytics_disabled`, `422 not_apple_app`, `422 app_not_synced`, `422 credential_not_found`, `422 credential_unreadable`,
and a store code from the list above (422, or 429, 502, 504). Audited as `analytics.enable` (ids only).

### Import

For when the key cannot create a request, or a report was exported by hand. **Android:** the file is a Play Console statistics CSV
(Play Console, Download reports, Statistics: installs, ratings or store listing, the same columns as the monthly files of the reports bucket,
matched by name; rows of another package are left out). It is stored as source `play_reports`, so it is the way to get installs before the
bucket is set up. A file that is no such report is `422 unknown_report`. The **raw file** is the request body (any content type;
`.tsv`, `.csv` or the `.gz` as downloaded), at most 10 MiB (64 MiB unpacked, 400,000 rows, 80 columns). Columns are matched by name; the
report name in `fileName` (at most 200 characters) picks the mapping, else the header does.

- `POST import/preview` stores nothing and answers `{ "plan": { source, report: {kind,label}, platform, stats: {rowsRead,rowsUsed,rowsUnreadable,rowsFiltered}, dateFrom, dateTo, days, points, metrics: [{metric,label,days,total}], sample: [...], notes: [] }, "confirmHash" }`.
- `POST import?confirmHash=` stores it and answers 201 `{ "imported": { source, points, written, unchanged, dateFrom, dateTo } }`.
  The same file again gives `written: 0`; a value the API already read is never replaced by an imported one.
- Errors: `409 confirm_mismatch` (the body is not the previewed file), `413 payload_too_large`, `422 app_not_synced`, `422` with `bad_gzip`, `bad_format`, `missing_columns`, `unknown_report`, `file_too_large` or `no_rows`.
  Audited as `analytics.import`.

### Import Google Play search terms

A Google Play app's **search terms** (the terms people searched on Google Play before they opened the store listing) are not in any API; they
come from a file exported in Play Console ("Export report" on the store listing report, breakdown "Search term"). See
[the research](../research/play-search-terms.md) for what is known and what is **UNVERIFIED**. They do not fit `analytics_daily` (free text, and
possibly a period instead of a day), so they live in two tables of migration 32: `play_search_terms` and `play_search_term_imports`.
The terms are read back by `GET /apps/{id}/aso/search-terms` ([ASO](aso.md#search-terms-google-play-from-a-file)). Needs `analytics.manage`
(explicit-only for a token), like the other imports.

- `POST /apps/{id}/analytics/search-terms/import/preview?fileName=&from=&to=` and `POST .../search-terms/import?confirmHash=&fileName=&from=&to=`. The
  **raw file** is the body: `.csv` (UTF-8 or UTF-16), a `.gz`, or a `.zip` with `.csv` files inside (at most 10 MiB, 64 MiB unpacked, 400,000 rows). Columns are matched **by header name**
  (case, punctuation and order do not matter; English synonyms of `Search term`, `Store listing visitors`, `Store listing acquisitions`, `Store listing conversion rate`,
  `Date`, `Country/region`, `Traffic source`, `Start date`, `End date`). Rows of another traffic source than Google Play search are left out; the row `Other` is kept as "terms Google grouped", never as a term.
  A term is at most 100 characters; a control character makes the row unreadable.
- A file with **no date column** needs `from` and `to` (both, `YYYY-MM-DD`, at most 400 days, not in the future); the rows are then stored for that period. Without them: `422 period_required`.
- The preview stores nothing and answers `{ "plan": { platform, report, stats: {rowsRead,rowsUsed,rowsUnreadable,rowsFiltered,rowsOther}, dateFrom, dateTo, hasDates, period, days, rows, terms, countries, files, totals: {visitors,installs}, other, top: [ten terms], overlapsStored, notes }, "confirmHash" }`.
  The apply parses the file again and compares the hash (`409 confirm_mismatch`), then answers 201 `{ "imported": { rows, written, unchanged, dateFrom, dateTo } }`.
  The same file again gives `written: 0`; a corrected file replaces the numbers of the rows it holds. A file of days is never counted next to a period file of the same country (the period rows are left out, and the view notes it).
- Errors: `400 invalid_request` (a bad `from` or `to`), `409 confirm_mismatch`, `413 payload_too_large`, `422 import_not_supported` (an iOS app), `422` with `bad_gzip`, `bad_zip`, `bad_format`, `missing_columns`, `file_too_large`, `no_rows` or `period_required`.
  Error messages come from a fixed list and never carry a term.
- **Privacy:** a term is stored only in `play_search_terms` and returned only by the routes above and `GET .../aso/search-terms`. It is never written to a log, an audit row, an event, a job or a note.
  Audited as `analytics.search_terms_import` with counts and dates only (`rows`, `written`, `terms`, `countries`, `files`, `dateFrom`, `dateTo`). No event is raised.

## Event

`analytics.synced` (needs `analytics.read`; the subject carries `appId`): `{ appId, platform, trigger, pointsWritten, sources }`. Raised
only when a sync or import stored something new. Never rows, URLs or tokens. See [events](events.md).

## Not verified (UNVERIFIED)

The mapping is written from documentation; nothing was run against Apple or Google. To settle with a real account: the segment
delimiter, checksum and time zone of the date column; the Device strings for Mac; the `salesReports` parameters and answer encoding; the
Sales key's role after an Admin creates the request; what Apple answers to a duplicate request; the Reporting API field names,
`freshnessInfo` and the crash-rate unit (stored as sent); Play Console permission names; whether the Play Console permission alone lets the service account read the bucket or Storage Object Viewer must be granted on it (the empty state in Insights says both); bucket id discovery and IAM; CSV encodings and
file names; whether the Play Console statistics export has exactly the bucket's columns (the import assumes it); the `store_performance` columns and their fate after the June and July 2026 change; whether month files grow in place;
how far back vitals reach.

**Earnings (UNVERIFIED, see ADR 0042).** Confirmed from Google's help page (answer 6135870): the object `earnings/earnings_YYYYMM.zip`, generated by the 5th of the next month,
the Pacific Time transaction dates, the column names (Transaction Date, Transaction Type, Package ID, SKU ID, Merchant Currency, `Amount (Merchant Currency)`, ...), the types
`Charge`, `Google fee`, `Tax`, `Charge refund`, `Google fee refund`, `Charge rebill`, `Tax rebill`, `Google fee rebill` and `Adjustment`, and the permission. Not confirmed:
the **sign** of each type (`earnings_net` is a plain signed sum, so it is right only if Google writes fees and refunds as negative amounts and taxes with the sign that makes
the ledger add up; if not, the net is wrong and the families are the way to check); that the zip holds exactly one CSV and its encoding; the spelling of the types and the
columns (compared case-insensitively); whether a file can be split or suffixed (every object with the prefix is read; an identical copy is skipped); `Package ID` versus the
older `Product ID`; amounts with a thousands separator; the 10 MiB cap; what Cloud Storage answers when View financial data is missing (assumed 403).

**Subscriptions (UNVERIFIED, see ADR 0042).** Confirmed from Apple's field tables (read 2026-11-21) and Google's help page: the report types and version `1_3`, the Apple column
names, the Google object name and columns (Date, Package Name, Product ID, Country, New Subscriptions, Canceled Subscriptions, Active Subscriptions, Base Plan ID, Offer ID).
Not confirmed: Apple's count columns beyond the documented ones (matched by header text: `free trial` is a trial, `pay up front` and `pay as you go` are paid offers) and that they do
not overlap; the day and time zone of a Subscription report (the day asked for is used); the exact event names (new = `Subscribe`, `Opt-In` and `Start ...`; cancelled =
`Cancel...`; a trial conversion = `Paid Subscription from Introductory Offer` on a free-trial row; renewals, reactivations, refunds and billing events are not counted; new
includes trials started); that `Subscription Apple ID` is the `storeRef` the Products page stores; the `Desktop` device of a Mac subscription; Google's dimension suffix
(`country` documented, `overview` tried first), the date format, whether a file's rows overlap (summed as they are, which would double count) and what `Active Subscriptions`
includes (trials, grace period, paused).

**Sales (UNVERIFIED, see ADR 0038).** Confirmed from Google's help pages: the object name `sales/salesreport_YYYYMM.zip`, the column names (Order Number, Order Charged
Date, Financial Status, Product Title, Package ID, Product Type, SKU ID, Currency of Sale, Item Price, Taxes Collected, Charged Amount, Country of Buyer, ...), UTC days,
that the amounts are the buyer's and no tax or fee is deducted, and the permission View financial data (Global). Not confirmed: that the zip holds exactly one CSV and its
encoding (a byte order mark is honoured); the exact spelling of `Financial Status` (matched case-insensitively: `charged`, anything with `refund`; other values are left out);
the **sign** of a refund amount (the absolute value is used); whether a refund row carries the day of the refund or of the charge; whether the package column is `Package ID`
or the older `Product ID` (both are read); what Cloud Storage answers when View financial data is missing (assumed 403, reported as `play_sales_forbidden`); whether the
10 MiB file cap fits a large account's month; for Apple, that the SKU of an in-app row is the store product id, and that a row's `Parent Identifier` is the app's SKU
for every in-app type (Apple documents it as "SKU of the app associated with the In-App Purchase").

**Failure classes (UNVERIFIED, no real call was made).** The classification follows the vendors' documentation, not recorded answers: that Apple
answers a wrong or foreign vendor number with HTTP 400 naming `vendorNumber` (read as `vendor_number_invalid`) rather than 403 (read as
`sales_forbidden`, which names both the role and the number); that a report date Apple has no report for is a 404 or a 400 naming `reportDate`
(both read as "no report"); that Cloud Storage answers 403 for the whole reports bucket when the service account has no access, and that a refused
financial folder is told from it by the statistics folder still being listable (told apart by `PlayFinancialStorage`); that the Play Console
invitation alone gives access to the bucket (Google manages it for most accounts) and that Storage Object Viewer on it is only sometimes needed;
that `pubsite_prod_rev_<number>` carries the same number as the developer account in Play Console's address (used for the Users and permissions link).
Test fixtures for these classes are hand-written, not recordings.
