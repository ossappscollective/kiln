# ASO: keyword ranks and competitors

Reference for the routes under `/api/workspaces/{workspaceId}/` that track keyword ranks, follow competitors and work out ideas
and gaps from public store data. Everything is also in `GET /api/openapi.json` (tag `aso`). The decisions behind it are in
[ADR 0011](../adr/0011-aso-keywords-competitors.md).

**What it reads.** Apple: the public iTunes Search and Lookup APIs (documented, no login). Google Play: its public web pages, which is
**unofficial and off by default** ([see below](#google-play-is-unofficial)). No credential of the vault is used, nothing is written to a store.

**What a "rank" is.** The 1-based position of the app in the results the source returned for the term in a storefront. For Apple that is a position in
the Search API's results, **a proxy for the App Store's own search** (UNVERIFIED that the two orders agree). `rank: null` with `state: "not_ranked"` means "not within
the first `total` results" (the rank depth, default 50), not "does not rank". A source that could not be read is **never** `not_ranked` (see [errors](#errors)).

**What there is not.** No search volume, popularity or difficulty: no free official source provides them. `localScore` of an idea is a frequency in
the texts the server holds.

## Rights

| Action       | Who                              | Routes                                                               |
| ------------ | -------------------------------- | -------------------------------------------------------------------- |
| `aso.read`   | viewers, members, admins, owners | every `GET` (including search terms and rank versus downloads)       |
| `aso.write`  | members, admins, owners          | add, change, delete keywords and competitors; refresh one app        |
| `aso.manage` | admins, owners                   | `POST /aso/refresh` (every app); the setting `aso.rankMoveThreshold` |

Non-members and members of another workspace get `404 { "error": "not_found" }`; a member without the right gets `403 { "error": "forbidden" }`.
An API token may hold any of the three. An app-limited token reaches only the routes with `/apps/{id}` of its apps (`GET /aso/config` and `POST /aso/refresh` are workspace wide and are closed to it).
Writes are audited with ids and counts only (`aso.keyword_add`, `aso.keyword_update`, `aso.keyword_delete`, `aso.competitor_add`, `aso.competitor_remove`, `aso.refresh`, `aso.refresh_all`).

## Google Play is unofficial

Google Play has no official API for search results or for the public data of an app. When the operator sets `KILN_ASO_PLAY_UNOFFICIAL_ENABLED=true` the server reads the **public pages** of
`play.google.com`. That **may be against the Google Play Terms of Service or Google's Terms of Service**, was not checked by a lawyer, can stop working whenever Google changes its pages,
and is the operator's decision and risk. It is quiet by design: no login, no cookie, an identifying User-Agent, 4 calls a minute per process, a one hour cache, a cool-down after a refusal.
While it is off, an Android app's keywords can be kept, but refresh and competitor routes answer `409 play_unofficial_disabled` and **no request is made**.
`GET /aso/config` returns the warning text in `play.notice` for the UI to show next to the status.

## Configuration

### `GET /aso/config`

`aso.read`. What is on, the limits, and the warning:

```json
{
  "apple": { "enabled": true, "source": "iTunes Search API", "documentedCallsPerMinute": 20 },
  "play": {
    "enabled": false,
    "unofficial": true,
    "notice": "Google Play has no official ...",
    "howToEnable": "The operator sets KILN_ASO_PLAY_UNOFFICIAL_ENABLED=true on the server."
  },
  "schedule": { "intervalMinutes": 0 },
  "retentionDays": 365,
  "limits": {
    "maxKeywordsPerApp": 50,
    "maxCompetitorsPerApp": 10,
    "maxChecksPerRun": 25,
    "rankDepth": 50,
    "maxKeywordsPerRequest": 50
  },
  "rankMoveThreshold": 5
}
```

`rankMoveThreshold` is the workspace setting `aso.rankMoveThreshold` (integer 1 to 100, default 5, changed with `PUT /settings`, needs `aso.manage`).

## Keywords

A keyword is a term in a storefront (`country`, two letters) and a `locale` (a language tag such as `en-US`). The same term in `us` and `de` is two keywords. Two spellings with
the same folded words (`Water  Reminder`, `water-reminder`) are one keyword.

```json
{
  "id": "…",
  "appId": "…",
  "platform": "ios",
  "country": "us",
  "locale": "en-US",
  "term": "water reminder",
  "key": "water reminder",
  "tag": "core",
  "notes": null,
  "priority": 2,
  "createdBy": "…",
  "createdAt": 1760000000000,
  "updatedAt": 1760000000000,
  "lastCheckedAt": 1760003600000,
  "state": "ranked",
  "rank": 12,
  "total": 50,
  "previous": { "state": "ranked", "rank": 15 },
  "change": { "kind": "up", "delta": 3, "from": 15, "to": 12 },
  "error": null
}
```

`state` is `null` until the first successful check. `change.kind` is `first`, `same`, `up`, `down`, `entered`, `dropped` or `still_unranked`. `error` is a short code of the latest failed
attempt (`rate_limited`, `unavailable_layout_changed`, `server`, ...) and is cleared by the next success; `rank` and `state` keep the last known value meanwhile.

| Route                                                           | Needs       | Does                                                                             |
| --------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `GET /apps/{id}/aso/keywords?country=&locale=&tag=`             | `aso.read`  | `{ keywords, limits: { maxKeywordsPerApp } }`, ordered by term.                  |
| `POST /apps/{id}/aso/keywords`                                  | `aso.write` | Add up to 50.                                                                    |
| `PATCH /apps/{id}/aso/keywords/{keywordId}`                     | `aso.write` | Change `tag`, `notes`, `priority` (the term, country and locale cannot change).  |
| `DELETE /apps/{id}/aso/keywords/{keywordId}`                    | `aso.write` | `204`; deletes its checks.                                                       |
| `GET /apps/{id}/aso/keywords/{keywordId}/history?limit=&since=` | `aso.read`  | `{ keyword, checks, trend }`; `limit` 1 to 1000 (default 100), `since` epoch ms. |

**Add.** Body (strict): `{ "keywords": [ { "term": "water reminder", "country": "us", "locale": "en-US", "tag": "core", "notes": "…", "priority": 3 } ] }`, 1 to 50 items; only `term` is required
(`country` defaults to `us`, `locale` to the storefront's main language, `priority` to 2; 1 low, 2 normal, 3 high; tag at most 40 characters, notes at most 500). Each item is judged on its own:

```json
{
  "results": [
    { "index": 0, "status": "created", "keyword": {} },
    { "index": 1, "status": "exists", "keyword": {} },
    { "index": 2, "status": "invalid", "message": "A keyword is not empty." },
    {
      "index": 3,
      "status": "limit",
      "message": "An app tracks at most 50 keywords (KILN_ASO_MAX_KEYWORDS_PER_APP)."
    }
  ],
  "summary": { "created": 1, "exists": 1, "invalid": 1, "limit": 1 }
}
```

`201` when at least one was created, else `200`. A keyword is **not checked** when it is added (no store is contacted); the next refresh does it.

**History.** `checks` is oldest first (`[{ id, checkedAt, rank, total, source }]`, `source` is `apple_search` or `play_public`); only successful checks are stored.
`trend` is `{ direction: up|down|flat|unknown, delta, latest, best, worst, samples }`; "not ranked" counts as one past the deepest result seen.

## Competitors

```json
{
  "id": "…",
  "appId": "…",
  "store": "app_store",
  "externalId": "1500000002",
  "country": "us",
  "name": "Habit App 2",
  "addedBy": "…",
  "addedAt": 1760000000000,
  "lastCheckedAt": 1760003600000,
  "state": "ok",
  "error": null,
  "latest": {
    "id": "…",
    "checkedAt": 1760003600000,
    "kind": "change",
    "version": "2.1",
    "rating": 4.6,
    "ratingCount": 1200,
    "price": "Free",
    "currency": "USD",
    "title": "Habit App 2",
    "subtitle": null,
    "descriptionExcerpt": "…first 1000 characters…",
    "screenshotCount": 5,
    "changes": [{ "field": "version", "from": "2.0", "to": "2.1" }]
  }
}
```

`state` is `ok`, `not_found` (the store no longer has it) or `unavailable` (the last look failed; `error` is the code). `descriptionExcerpt` and every text are written by the competitor: **untrusted plain text**, never HTML.
`changes[].field` is one of `version`, `title`, `subtitle`, `price`, `description`, `media`, `screenshots`, `rating`, `ratingCount`; `from` and `to` are present for short public values and absent for the description and the media (they are compared by hash).

| Route                                                          | Needs       | Does                                                                                                                                                                                   |
| -------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /apps/{id}/aso/competitors`                               | `aso.read`  | `{ competitors, limits: { maxCompetitorsPerApp } }`.                                                                                                                                   |
| `GET /apps/{id}/aso/competitors/search?q=&country=` | `aso.write` | **Search the App Store by name** (the add dialog). Reads Apple's public search once through the shared cache, rate limit and cool-down, plus the per workspace lookup limit; stores nothing, no audit. `q` 2 to 100 characters, `country` two letters (default `us`). `200 { country, cached, results: [ { externalId, name, developer, category, iconUrl (https or null), ratingAverage, ratingCount, price, state: available / followed / own } ] }`, at most 10, text plain and capped. `409 search_app_store_only` for an Android app: Google Play has no official search and Kiln does not scrape it, so paste the package name or a play.google.com address to `POST`. |
| `POST /apps/{id}/aso/competitors`                              | `aso.write` | Follow. Body `{ "externalId": "id1500000002", "country": "us" }`. **Reads the store once**; rate limited per workspace. `201 { competitor }`.                                          |
| `DELETE /apps/{id}/aso/competitors/{competitorId}`             | `aso.write` | `204`; deletes its snapshots.                                                                                                                                                          |
| `GET /apps/{id}/aso/competitors/{competitorId}/history?limit=` | `aso.read`  | `{ competitor, snapshots, diff }`, snapshots newest first (`limit` 1 to 500, default 50); `diff` is the newest snapshot that recorded changes: `{ from, to, at, changes }`, or `null`. |

`externalId`: iOS accepts the numeric App Store id, `id123` or an `apps.apple.com` address; Android accepts a package name or a `play.google.com` address with `?id=`. A snapshot is stored on the first look, when something changed, and every `KILN_ASO_HEARTBEAT_DAYS` (7) as a heartbeat (`kind` is `first`, `change` or `heartbeat`).
Errors: `422 invalid_external_id`, `invalid_country`, `own_app`, `not_found` (the store has no such app); `409 already_followed`, `limit_reached`, `play_unofficial_disabled`.

## Refreshing

### `POST /apps/{id}/aso/refresh?scope=all|keywords|competitors&background=true`

`aso.write`. Reads the public store: Apple Search API for iOS apps, the public pages for Android apps (only when switched on). **Read-only toward the stores.** What a refresh does:

- checks up to `KILN_ASO_MAX_CHECKS_PER_RUN` keywords (the oldest first) and every followed competitor; **a person asking checks everything up to the cap**, the scheduler only what is due;
- shares one search per term and storefront and reuses cached answers;
- stops early when a store says to slow down, is unavailable, fails three times in a row, or the time (4 minutes) is up. What is left stays due.

Answer (`200`; `202 { "jobId" }` with `?background=true`):

```json
{
  "result": {
    "at": 1760003600000,
    "keywords": {
      "due": 40,
      "checked": 25,
      "ranked": 12,
      "notRanked": 13,
      "failed": 0,
      "cached": 3,
      "moved": 2
    },
    "competitors": { "due": 3, "checked": 3, "changed": 1, "notFound": 0, "failed": 0 },
    "deferred": true,
    "stoppedBecause": "cap",
    "errors": [],
    "warnings": []
  },
  "state": {
    "lastAttemptAt": 1760003600000,
    "lastSuccessAt": 1760003600000,
    "lastError": null,
    "consecutiveFailures": 0,
    "backoffUntil": null,
    "lastResult": {}
  }
}
```

`stoppedBecause`: `cap`, `time`, `rate_limit`, `unavailable`, `errors`. `retryAfterSeconds` is set for `rate_limit`. A run that **only hit our own local limit** is a normal `200` with `deferred: true`.
A run that tried and **got nothing** answers `502 refresh_failed` with `{ "result": … }` in the body, and sets a backoff.

### `POST /aso/refresh`

`aso.manage`. Queues a refresh job for every app of the workspace that has keywords or competitors (at most 25, spaced 20 seconds apart). Answer `202 { queued, skipped: { alreadyQueued, notReady, playOff, capped } }`. Audited as `aso.refresh_all`.

### Scheduling

`KILN_ASO_INTERVAL_MINUTES` (default `0`, off; otherwise 60 to 10080) makes the scheduler queue `aso.refresh` jobs for apps that are due, a few per pass and spaced. An app is due an interval after its last attempt (30 minutes
when the last run left work over), not while a backoff or a claim holds, not twice. Android apps are skipped while Google Play is off and iOS apps that were never synced (no App Store id) are skipped. The same service runs it as the route.

## Views worked out from stored data

None of these contacts a store (a test checks that), so they are cheap and do not need the Play switch. They are **suggestions**: nothing here changes a listing, a keyword or a competitor.
`locale` (a language tag) defaults to the locale most tracked keywords use.

| Route                                                | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /apps/{id}/aso/summary`                         | `{ app, keywords: { total, ranked, notRanked, unchecked, failing, top3, top10 }, movers (the five biggest moves), competitors: { total, notFound, changedRecently }, state }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /apps/{id}/aso/fit?locale=`                     | Per locale of the tracked keywords: how well the **stored live listing** covers them. `{ readAt, error, locales: [ { locale, listingLocale, channel, keywords, fit } ], indexedFields, assumptions }`. `fit` is `null` when no listing text is stored for that language (sync the app).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET /apps/{id}/aso/ideas?locale=&limit=`            | Phrases that occur at least twice in the own listing and the followed competitors' stored texts and are not tracked: `{ locale, basedOn: { ownListing, competitors }, ideas: [ { term, words, occurrences, sources, localScore } ], notes }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /apps/{id}/aso/gaps?locale=&limit=`             | **Coverage gap**: terms competitors use in their names, subtitles or descriptions that the own listing lacks: `{ locale, competitors, gaps: [ { term, origin: tracked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | idea, inTitle: [competitorId], inDescription: [competitorId], ourStatus } ], notes }`. |
| `GET /apps/{id}/aso/suggestions?minKeywords=&limit=` | **Competitor discovery**: apps in the stored top results of at least `minKeywords` (default 2) tracked keywords, per country, without the own app and the ones already followed: `{ suggestions: [ { externalId, country, name, keywordCount, bestRank, averageRank, keywordIds } ], basedOnKeywords, notes }`. `name` is `null` for Google Play (its results carry none). A person confirms with `POST /competitors`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /apps/{id}/aso/coach`                           | **Next steps**: up to 8 ranked actions worked out from stored data (core `buildCoach`): `{ actions: [ { id, kind, position, title, detail, items, more, link: { to, locale?, label } } ], basedOn: { keywords, competitors, listingLocales, lastCheckAt, listingReadAt } }`. `kind` is `track_keywords`, `check_ranks`, `rank_dropped`, `not_in_listing`, `untracked_set_keywords` (App Store keyword field entries no tracked keyword covers; Google Play has none), `competitor_above`, `keyword_field_waste`, `unused_characters`, `untapped_locale` or `follow_competitors`, always in that order. Every number is a count from the data; no volume, no predicted gain. `link.to` is an ASO view (`keywords`, `keywords_add`, `listing_keywords`, `competitors`) or `listing` (with `locale`).                                                                      |
| `GET /apps/{id}/aso/listing-keywords`                | **Terms the listing sets**: the stored text of every locale (the live copy when there is one) under `locales: [ { locale, fields } ]` (`title`, `subtitle`, `keywords`, `shortDescription`, `description`; the App Store description is left out because the store does not search it), `readAt`, `error`, `indexedFields`. Nothing is contacted. The web works the terms out with core `listingRows` (`aso-listing-terms.ts`): App Store keyword field entries split on commas (with bytes) plus the significant words of name and subtitle; Google Play has no keyword field, so its terms are **extracted** from title and short description (and, on request, frequent words of the full description). Tracked or not is matched per locale and storefront (the one with most tracked keywords for the locale, else the usual one of the language) on folded words. |
| `GET /apps/{id}/aso/markets`                         | **One term across markets**: `{ terms: [ { key, term, bestRank, markets: [ { country, locale, id, rank, state, checkedAt } ] } ] }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Fit.** `fit.keywords[].status`: `strong` (the phrase is in the name or subtitle; Android: title or short description), `covered` (every word is in the searched fields, not as a phrase in a high weight field), `partial`, `description_only` (iOS: only
in the description, which the store may not search; UNVERIFIED), `missing`. `fit.counts` counts them, `fit.gaps` lists the ones not strong or covered, worst first (priority, then status, then the rank). For iOS `fit.keywordField` measures the hidden keyword field against its 100 byte budget:
`bytes`, `remaining`, `overBudget`, `duplicates`, `inTitleOrSubtitle`, and `compacted` with the bytes it would save. `assumptions` lists which fields count; they are **UNVERIFIED**.
Each locale also carries `fields`, the stored listing text the fit was worked out from (`title`, `subtitle`, `keywords`, `shortDescription`, `description`; `null` when none is stored), and the response has `listingLocales`, every locale the stored listing has text for. The web uses them for the keyword budget meters.

**Budgets and the coach (core `listingBudget`, `buildCoach`).** Per locale: used and limit of each field (App Store name and subtitle 30 characters, keyword field 100 bytes; Google Play title 30, short 80, full description 4000 characters), which tracked keywords sit in which field, waste in the keyword field (spaces around commas, empty, repeated and plural entries, entries whose words the name or subtitle already hold), words found in several fields, words no tracked keyword uses, tracked keywords in none of the searched fields, and untapped locales (a tracked locale with no listing text, a locale with an empty keyword field). **UNVERIFIED**: that the App Store ignores a word repeated across name, subtitle and keyword field; that singular and plural are one word (English plurals are folded here); whether commas count toward the 100 bytes (the whole field is measured); and which other locales a storefront reads. The storefront list in `REPORTED_EXTRA_LOCALES` is what ASO tools report (aso.dev, 2026-11-19), not Apple, and is only ever shown as a hint marked UNVERIFIED.

## Search terms (Google Play, from a file)

The terms people searched on Google Play and then opened the app's store listing from, imported from a Play Console file
(`POST /apps/{id}/analytics/search-terms/import`, see [analytics](analytics.md#import-google-play-search-terms); needs `analytics.manage`). Nothing is read from Google.
They are **not** search volume: terms nobody opened the listing from are absent, and terms too small to report are grouped by Google into `Other`.

`GET /apps/{id}/aso/search-terms?from=&to=&country=&locale=&sort=installs|visitors&limit=` (`aso.read`; `422 not_google_play_app` for an iOS or macOS app; `400 invalid_request` for a bad query; `limit` 1 to 200, default 50).
Without `from` and `to` the whole stored period is used (at most 400 days). `country` limits to a storefront (rows with no country are left out of a country view).

```json
{
  "appId": "...",
  "platform": "android",
  "from": "2026-10-01",
  "to": "2026-10-31",
  "country": null,
  "sort": "installs",
  "locale": "en-US",
  "listingLocale": "en-US",
  "listingReadAt": 1763500000000,
  "imported": {
    "at": 1763500000000,
    "periodFrom": "2026-10-01",
    "periodTo": "2026-10-31",
    "imports": 1
  },
  "stored": { "from": "2026-10-01", "to": "2026-10-31", "countries": [], "rows": 120 },
  "terms": [
    {
      "key": "coffee timer",
      "term": "coffee timer",
      "visitors": 84,
      "installs": 11,
      "conversion": 0.131,
      "countries": [],
      "rows": 2,
      "trackedKeywordId": "...",
      "trackedCountries": ["us"],
      "listing": "in_listing",
      "inFields": ["title"],
      "hint": null
    }
  ],
  "termCount": 3,
  "other": { "visitors": 90, "installs": 3 },
  "totals": { "visitors": 216, "installs": 16 },
  "notes": [{ "code": "not_search_volume", "message": "..." }]
}
```

`imported` and `stored` are `null` when nothing was imported (the web then shows how to export a file). `conversion` is installs divided by visitors when both are known, else the file's own rate. `listing` is
`in_listing`, `partly`, `not_in_listing` or `unknown` (no listing text stored for `locale`), worked out like the fit (core `fitKeyword`) against the stored Google Play title, short description and full description. `hint` is
`add_to_listing` when a term **brought installs and is not fully in the listing text**: a suggestion for a person to weigh, not a finding that adding it brings installs (no AI, no prediction). `trackedKeywordId` is a tracked keyword of the
same words in the chosen storefront (any storefront when none is chosen). The note codes are `not_search_volume`, `other_grouped`, `legacy_metrics_unverified`, `overlapping_periods`, `period_rows_dropped`, `rows_capped`, `no_listing_text`.
**UNVERIFIED**: the shape of the console's own export, and whether visitors and acquisitions per term are still filled after Google's 2026 change to click metrics ([research](../research/play-search-terms.md)).

## Rank versus downloads

`GET /apps/{id}/aso/rank-vs-downloads?platform=&country=&keywords=&from=&to=` (`aso.read`). The rank history of chosen tracked keywords of **one storefront** laid on the days of the app's downloads, rank moves marked, and the downloads before and
after each big move. It reads this server's database only (no store, works with whatever analytics source is on). `platform`, when given, must be the app's own (`400` otherwise); `country` defaults to the storefront with most tracked keywords;
`keywords` is up to 5 keyword ids of that storefront (default: the three with most checks); `from` and `to` default to the 90 days ending yesterday (at most 400 days, `to` not after today).

Downloads: iOS and macOS use **first-time downloads** (Apple Analytics Reports), else the **units of Sales and Trends** (a different measure, labelled as such); Android uses **user installs** of the Play reports, else device installs. The first metric with a day in the range wins.

Answer (core `buildRankVsDownloads`): `{ appId, platform, country, countries, available: [ { id, term, locale, priority, checks, lastCheckedAt } ], selected, from, to, days: [ day ], keywords: [ { id, term, samples: [ { rank, total } | null ], checkDays } ],
downloads: { metric, label, source: apple|play, delayDays, values: [ number | null ], settledThrough, days } | null, markers: [ { keywordId, day, previousDay, kind, from, to, delta } ],
comparisons: [ { marker, status: ok|waiting|too_few_days, before: { from, to, days, total, perDay }, after, changePercent, checkGapDays, overlapsOtherMove, settledNeededThrough } ],
coverage: { rankDays, downloadDays, minDays }, enough, missing: turn_on_analytics|no_downloads|no_rank_checks|null, threshold, windowDays, notes }`.

- A rank is put on its **UTC day** (the last check of the day); a day with no check is `null`, never "not ranked" and never zero. A marker is a move of at least the setting `aso.rankMoveThreshold` places (or entering or leaving the top 10), dated by the **later** check.
- **Delay.** Apple's numbers arrive about 2 days late and Play CSV files 3 to 7 days late, so the newest `delayDays` days are not settled (`settledThrough` is today minus the delay). A move whose 7 days after are not all settled is `waiting`, not computed on partial days. Ranks are UTC days and the stores use their own (UNVERIFIED which), so a move can sit a day off.
- **Before and after.** The 7 days ending on the earlier check against the 7 days starting the day after the later check, as the average downloads per day; each window needs at least 5 days with a number (`too_few_days` otherwise); `changePercent` is `null` when there were no downloads before. Moves that share days are flagged (`overlapsOtherMove`).
- **Hidden with fewer than 14 days of either series** (`enough: false`, no markers or comparisons). `missing` says what is lacking in a fixed vocabulary: `turn_on_analytics` (analytics is off and nothing is stored), `no_downloads`, `no_rank_checks`.
- **Always a correlation.** `notes` carries `correlation_not_proof`, `downloads_delay`, `time_zones`, `few_checks` and `other_causes`; the web labels every comparison "Correlation, not proof" with the number of days compared. Nothing here says that a rank move changed downloads: a release, a campaign, a holiday or a rating moves downloads too.

## Events and webhooks

| Type                     | When                                                                                                                                                                                                                       | Payload                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `aso.rank_changed`       | A keyword moved by at least `aso.rankMoveThreshold` places between two checks, or the app entered or left the results **within the top 10**. Never on the first check.                                                     | `appId, keywordId, platform, country, locale, from, to, delta?, change (up, down, entered, dropped), threshold` |
| `aso.competitor_changed` | A notable change of a followed competitor: version, name, subtitle, price, description, media, screenshots, or a rating moved by 0.2 stars or more. Never on the first look; a drifting rating count alone raises nothing. | `appId, competitorId, store, country, fields`                                                                   |

The subject is the app (`subject.appId`). **Neither carries the term, a competitor's name or a text**: read them with the ids. Both are visible to whoever holds `aso.read`.

## Errors

| Status | `error`                                                                                                      | Meaning                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`                                                                                            | The body or a query parameter is wrong (`issues` lists them).                                                                                                    |
| 404    | `not_found`                                                                                                  | No such app, keyword or competitor in this workspace.                                                                                                            |
| 409    | `play_unofficial_disabled`                                                                                   | Google Play reading is off (`KILN_ASO_PLAY_UNOFFICIAL_ENABLED`). No request was made.                                                                            |
| 409    | `refresh_in_progress`                                                                                        | Another refresh of the app holds the claim.                                                                                                                      |
| 409    | `already_followed`, `limit_reached`, `search_app_store_only`                                                                        | Competitors.                                                                                                                                                     |
| 422    | `invalid_keyword` (PATCH), `invalid_external_id`, `invalid_country`, `own_app`, `not_found`, `invalid_input` | The value is not accepted.                                                                                                                                       |
| 422    | `not_google_play_app`                                                                                        | Search terms are for Google Play apps only.                                                                                                                      |
| 429    | `rate_limited`                                                                                               | Our per workspace limit, or a store's. `Retry-After` and `retryAfterSeconds` say when.                                                                           |
| 502    | `refresh_failed`, `source_unavailable`, `source_failed`                                                      | The store could not be read; `reason` is `layout_changed`, `redirect` or `blocked` for an unavailable Google Play page. **Nothing is recorded as "not ranked".** |
| 504    | `source_timeout`                                                                                             | The store did not answer in time.                                                                                                                                |

Error messages never contain a search term or a store address.

## Data and retention

Five tables (migration 25): `aso_keywords`, `aso_rank_checks`, `aso_competitors`, `aso_competitor_snapshots`, `aso_app_state`. Rank checks and snapshots older than `KILN_ASO_RETENTION_DAYS` (365; `0` keeps them) are deleted by the
scheduler, bounded per run and once an hour; the newest snapshot of each competitor is kept. Search terms imported from a Play Console file live in `play_search_terms` and `play_search_term_imports` (migration 32); they are not kept by the retention job and go with the app. Deleting an app deletes its ASO data. Stored: terms and notes the team typed, ranks, and public data of other apps; no customer data.
Network: outbound https to `itunes.apple.com` and, only when switched on, `play.google.com`.

## UNVERIFIED

Not on a page that was checked, or not run against the real service (no network was available):

- Apple: that the Search API's order equals the App Store's (a "rank" is a proxy); the field names of a software result; `country` on a lookup; no subtitle in a reply; that "approximately 20 calls per minute" still holds. **The undocumented search hints endpoint is not used.**
- Google Play: all markup assumptions (result links, JSON-LD, `og:` tags, description, screenshots, rating label); that a search page shows `rankDepth` results; the terms of service. Fixtures are synthetic.
- Which fields each store searches (`indexedFields`, `assumptions`), and the 100 byte iOS keyword budget.
- Search terms: the shape of the Play Console export, the column names outside English, whether visitors and acquisitions per term survive Google's 2026 change to click metrics, and the time zone of the dates ([research](../research/play-search-terms.md)).
- Rank versus downloads: the time zone of the stores' days, and how long Play CSV files really take to arrive.
- Text handling: English plural folding only; stop words for en, de, fr, es, it, pt, nl.
- Postgres: written for it, tested on SQLite only.

Reviews of followed App Store competitors (Apple only, on demand): see [competitor-reviews.md](competitor-reviews.md).
