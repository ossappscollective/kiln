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
- `analytics.appleVendorNumber` (string, 5 to 12 digits): turns on `apple_sales` for iOS and macOS apps.
- `analytics.playBucketId` (string, `pubsite_prod_rev_` and digits): the Cloud Storage bucket of the monthly CSV reports, for the whole workspace. The narrower places below win; prefer them.

`MRM_ANALYTICS_INTERVAL_MINUTES` (default 360; `0` off; 15 to 10080) sets how often the scheduler queues a sync. See [deployment](../deployment.md).

## Endpoints

| Method and path                                       | Needs  | Purpose                                                                                                    |
| ----------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `GET overview?platform&from&to&granularity&breakdown` | read   | series for one app                                                                                         |
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
`granularity`: `day` (default), `week`, `month`. `breakdown`: one of `territory`, `source_type`, `app_version`, `currency`.

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
come one **per currency** (`id: "sales_proceeds:EUR"`, `currency: "EUR"`); nothing is converted or added across currencies. `derived`
series (`product_page_conversion`, `impression_tap_rate`) are computed from two others and are null where the denominator is missing.
`breakdown` (top 10 values) is present only when asked and the source has the dimension. `coverage.state`: `complete`, `partial`, `none`.

Coverage note codes (`coverageNoteCodes`, with the sentence in `message`): `apple_usage_opt_in_only`, `apple_privacy_thresholds`,
`apple_counts_not_unique`, `apple_usage_sample_not_total`, `apple_estimates`, `apple_pacific_time`, `apple_proceeds_per_currency`,
`apple_in_app_not_included`, `apple_rating_history_not_available`, `apple_impressions_only_via_reports`, `google_unit_unverified`,
`google_legacy_store_listing`, `google_no_impressions`, `google_rating_average_only`, `google_monthly_files`, `derived`, `imported`,
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
    "vendorNumberSet": true
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

Times are epoch milliseconds. `apple` is null for Android, `google` null for iOS and macOS. `apple.mode`: `off`, `ongoing`, `import`.
Source `state`: `off` (workspace setting off), `needs_setup`, `waiting` (set up; Apple has made no report yet, which takes a day or two),
`error`, `ready`. `setup` when not ready: `{ code, nextStep, alternatives[], optional, message }`. Run `trigger`: `schedule`, `manual`,
`enable`, `import`.

Setup codes (`analyticsSetupCodes`): `turn_on_analytics`, `create_report_request`, `role_required`, `waiting_first_data`,
`request_stopped`, `vendor_number_missing`, `sales_forbidden`, `bucket_id_missing`, `bucket_forbidden`, `reporting_api_not_enabled`,
`play_permission_missing`, `credential_problem`, `first_sync_pending`. Next steps (`analyticsNextSteps`): `turn_on_analytics`,
`enable_apple_analytics`, `import_apple_report`, `ask_apple_admin`, `set_vendor_number`, `set_bucket_id`, `grant_play_permission`,
`enable_reporting_api`, `fix_credential`, `sync_now`, `wait`.

### `POST sync`

Needs `analytics.enabled`. Body optional: `{ "sources": [...] }` (sources of the app's platform: `apple_analytics`, `apple_sales`,
`play_vitals`, `play_reports`). A store failure is **not** an HTTP error: the answer is 200 and each source says what happened.

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
`reports_not_found`, `store_auth`, `store_forbidden`, `store_not_found`, `rate_limited`, `store_unavailable`, `timeout`,
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
