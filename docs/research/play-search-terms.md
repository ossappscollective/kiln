# Research: Google Play search terms (what a developer can export)

Date: 2026-11-19. Scope: what Play Console lets a developer see and export about the **search terms** people used before they
opened the app's store listing, so that an import can map it. Research only. Sources are Google's help pages and the
research study in [analytics-apis.md](analytics-apis.md); **nothing was exported from a real Play Console account**, so every
column name and file shape below that a help page does not state is marked **UNVERIFIED**.

## 0. Headlines

1. **Search terms are a console report, not an API.** The Play Developer Reporting API (vitals) and the Android Publisher API have
   no search term data. The only machine-readable routes are a file the developer downloads: the **Export report** button on the
   store listing pages, and the monthly CSV files in the developer's Cloud Storage bucket.
2. **A search term exists only for Google Play search traffic.** Google's CSV documentation says the field is "only available for
   Google Play search". Other traffic (third-party referrals, Play explore) has no term.
3. **Small terms are grouped.** Play shows an `Other` row for terms that "did not have enough visitors or acquisitions over time to
   be reported individually". No number is published for the threshold. A small app may therefore see few terms, or only `Other`.
4. **Two metrics per term, plus a rate:** store listing visitors, store listing acquisitions (a first install by a user who had no
   other device with the app) and the store listing conversion rate (the share of visitors who installed).
5. **The legacy metrics are at risk.** In June and July 2026 Play Console moved its store listing reports to click based
   metrics (unique user Install, Open and Pre-register clicks, a click-through rate that replaces the conversion rate). Google states
   that "legacy CSV downloadable reports in Cloud Storage will continue to support the original (acquisitions) metrics only".
   Whether visitors and acquisitions per search term keep being filled is **UNVERIFIED** and is the main risk of this feature.
6. **No country in the term export of Cloud Storage.** The `traffic_source` file has no country column, and the `country` file has
   no search term. A per country term list can only come from the console's own export with a country filter (**UNVERIFIED**).

## 1. Where it is in Play Console

| Fact                                                                                                                                           | Source                                                    | State                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| Search term is a dimension of the store listing reports: "The term that the user searched for before navigating to your Store Listing."        | Play Console Help, store listing metrics (answer 9859173) | Stated                                                      |
| Path: Grow users, Store performance, Conversion analysis, breakdown "Search term"                                                              | third party guide (uptika.app)                            | UNVERIFIED (not on the help page read)                      |
| The conversion analysis page filters by traffic source, store listing, country, language, UTM source, UTM campaign and acquisition state       | answer 9859173                                            | Stated; whether "search term" can be a filter is not stated |
| An `Other` row groups terms that are too small to report                                                                                       | answer 9859173                                            | Stated; no threshold                                        |
| How many terms are listed, how long they are kept, the allowed date range for terms                                                            | not on any page read                                      | UNVERIFIED                                                  |
| Older route: the user acquisition report had a "search" row that opened the aggregate search terms and "which terms lead to the most installs" | Android Developers Blog, 2018-08                          | Stated (historic)                                           |
| Country means "the country or region where the user's Google account is registered"                                                            | answers 9859173, 6135870                                  | Stated                                                      |
| Statistics date range: chosen at "Configure report"; hourly only for 30 days or fewer                                                          | answer 139628                                             | Stated for Statistics; not for terms                        |

## 2. What can be exported

### 2.1 "Export report" on a store listing page

Google: "Use the **Export report** button on Store listing pages to download the data currently displayed in the chart and table."
So the file follows the filters and the breakdown on screen (the period, a country, the breakdown "Search term").

- File type, column names, encoding, whether several files come in a zip, the date format and the locale of the numbers: **UNVERIFIED**.
  The help page for Statistics says a chart "can be exported as a CSV file by selecting Export report next to the title of the chart".
- Whether the file has one row per day, or one row per term for the whole period: **UNVERIFIED**. Both are handled by the import:
  a `Date` column gives days; without one the person gives the period.
- Whether column headers follow the language of the console (they probably do for the UI export): **UNVERIFIED**. The mapping
  therefore reads headers by name from a list of synonyms; for any other language, switch the console to English before exporting.

### 2.2 Monthly CSV files in Cloud Storage (`store_performance`)

Documented (Play Console Help, "Download and export monthly reports", answer 6135870):

- Path `gs://<developer bucket>/stats/store_performance/store_performance_<package>_<yyyyMM>_<breakdown>.csv`, one month and one breakdown per file. Available since March 2021.
- Breakdown `traffic_source`: **Date** (`YYYY-mm-dd`, "date the user visited your store listing"), **Package name**, **Traffic source**
  (`Google Play search`, `Third-party referrals`, `Google Play explore`, or `Other`), **Search term** (optional), **UTM source** and
  **UTM campaign** (optional, referrals only), **Store listing acquisitions**, **Store listing visitors**, **Store listing conversion rate**.
- Breakdown `country`: Date, Package name, Country, the same three metrics. No search term.
- Cells with a tab, newline, double quote or comma are wrapped in double quotes; double quotes are doubled.
- Encoding: the page's general tip says reports must be converted from UTF-16 to UTF-8 for BigQuery, which suggests UTF-16 files
  (UNVERIFIED for this report). The importer accepts UTF-8 and UTF-16 (byte order mark or NUL detection).
- Freshness: monthly files are "captured daily and posted within 3 to 7 days"; the data is in Pacific Time for installs and ratings
  (the time zone of this report is **UNVERIFIED**).
- A third party tool (AppTweak) shows keyword data "directly from your Google Play Console" with visitors, acquisitions and
  conversion per keyword, split into search and explore, and states that for existing integrations it only shows the source split up
  to 2023-07-30 (a hint that Google changed this data in 2023, UNVERIFIED).

The server can already read these monthly files for the installs and ratings reports (`play-reports`), but only when a bucket id is
set and the service account may read it. **This feature does not use that route**: the person uploads the file they exported. That
needs no new permission, works when the bucket is not set up, and works with the console export that carries a country filter.

## 3. What the import maps (and what it refuses)

Columns are matched by **normalised header name** (lower case, punctuation removed), never by position. Synonyms (UNVERIFIED, from the
documented names and likely console wordings): term (`search term`, `search terms`, `term`, `query`, `search query`, `keyword`),
visitors (`store listing visitors`, `visitors`, `listing visitors`, `unique visitors`), installs (`store listing acquisitions`,
`acquisitions`, `installs`, `first time installers`, `new users`), conversion (`store listing conversion rate`, `conversion rate`,
`conversion`), day (`date`, `day`), country (`country region`, `country`, `region`, `territory`), traffic source (`traffic source`,
`source`), and the period ends (`start date`, `end date`, `period start`, `period end`).

- A row whose traffic source is present and is not `Google Play search` is left out (counted). A row with no term and no `Other`
  marker is left out.
- `Other` (a localised word is **UNVERIFIED**) is kept as "terms grouped by Google", never as a term.
- A file with no `Date` column needs the period from the person (`from` and `to`); a file with no recognisable term, visitors and
  installs columns is `missing_columns`.
- A country that is not two letters is stored as "all countries" and the preview says so (the console may write names; **UNVERIFIED**).
- Numbers: `1,234`, `1.234`, `1 234` and `12.5%` or `12,5 %` are accepted; a value that is not a number leaves the row unreadable.

## 4. UNVERIFIED list (to settle with one real export)

1. The file type of the UI export (CSV, zip of CSVs), its encoding, delimiter, header row and the date and number formats.
2. Whether the UI export is per day or per term for the period, and whether it honours the country filter.
3. The exact column names, in English and in other console languages, and the word for `Other`.
4. Whether country is a code or a name, and whether the `Country/region` column is present in a term export.
5. The threshold for grouping terms into `Other`, how many terms are listed, how far back terms go.
6. Whether visitors and acquisitions per term are still filled after the June and July 2026 click metric change, and whether the
   Cloud Storage `traffic_source` file still carries `Search term` for it.
7. The time zone of the `Date` column (Pacific Time is assumed for Play statistics; the preview shows the dates as written).

## 5. Sources (read 2026-11-19)

- Play Console Help, "View app statistics": https://support.google.com/googleplay/android-developer/answer/139628
- Play Console Help, store listing reports, search term, Export report: https://support.google.com/googleplay/android-developer/answer/9859173
- Play Console Help, "Download and export monthly reports", the `store_performance` report: https://support.google.com/googleplay/android-developer/answer/6135870
- Android Developers Blog, "New organic acquisition insights now in Play Console" (2018-08): https://android-developers.googleblog.com/2018/08/new-organic-acquisition-insights-now.html
- Third party, used only for the console path and the traffic source split: https://uptika.app/en/guides/play-console-reports and https://help.apptweak.com/en/articles/4770836-analyze-your-google-play-console-google-keywords
