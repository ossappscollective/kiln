# ADR 0011: ASO, keyword ranks and competitors from public store data

Status: implemented and tested against fakes on SQLite (Postgres paths are written and share the migration and
drift tests, but were not run here). **Never run against the real Apple or Google services**: the test environment had
no network. The facts that were not verified are listed under [UNVERIFIED](#unverified) and in
[api/aso](../api/aso.md#unverified).

## Context

App Store Optimization (ASO) is the work of choosing the words a store listing is found by and watching how it fares:
where the app shows up for a search term in a storefront, what the competing apps say about themselves, and whether
the own listing contains the words the team cares about. The tool already holds the live listing of every app
(`listing_snapshots`), so the missing pieces are the **search results** of a store and the **public data of other apps**.

The two stores differ completely in what they offer:

- **Apple** has a public, documented search service (the iTunes Search and Lookup APIs, no login) and states a rate: "approximately
  20 calls per minute (subject to change)", asking larger users to cache.
- **Google Play has no official API** for search results or for the public data of an app. The Play Developer API this
  tool already uses is for the organisation's own apps. The only way to see a rank is to read the public web pages
  of the store, which is unofficial, fragile and may be against its terms of service.

## Decision

### 1. What v1 is

Keyword rank tracking, competitor tracking, keyword ideas and listing keyword fit, all **read-only toward the stores**: no
credential is used, nothing is ever written to a store, nothing is scraped behind a login.

| Piece                  | What it does                                                                                                                                                             | Where                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Tracked keywords       | A term in a storefront (country) and locale, with a tag, a note and a priority. A check records the position of the app in the results or "not in the first N".          | `aso_keywords`, `aso_rank_checks`             |
| Competitors            | Apps the team follows, with a public snapshot (name, version, price, rating, description excerpt, screenshots) stored on the first look, on a change and as a heartbeat. | `aso_competitors`, `aso_competitor_snapshots` |
| Keyword fit            | Which tracked keywords the own live listing covers, per locale (strong, covered, partial, description only, missing), and the budget of the iOS keyword field.           | core `listingFit`                             |
| Ideas                  | Phrases mined from the own listing and the followed competitors' stored texts, by frequency.                                                                             | core `mineIdeas`                              |
| Coverage gaps          | What competitors put in their names that the own listing does not have.                                                                                                  | core `coverageGaps`                           |
| Competitor suggestions | Apps that appear in the top results of several tracked keywords, for a person to confirm. Nothing is followed automatically.                                             | core `suggestCompetitors`                     |
| Per market view        | The same term in several countries and locales as one row.                                                                                                               | core `termsAcrossMarkets`                     |
| Caching                | A search or lookup is reused for `KILN_ASO_CACHE_MINUTES` and a call in flight is shared.                                                                                | `services/aso-net.ts`                         |

Pure logic lives in `packages/core/src/aso/aso.ts` (ES2017-safe so the web can share it), the two sources in
`packages/connectors` (`apple-search.ts`, `play-public.ts`), the services and routes in `apps/server`.

### 2. Apple: the documented API, and what is not documented

Read through `GET https://itunes.apple.com/search` and `/lookup`. The parameters (`term`, `country`, `media`,
`entity`, `limit` 1 to 200, `lang`) and the rate statement are on Apple's pages and were checked on 2026-11-18. The
connector keeps the server **below** the documented rate (default 10 calls a minute per process, `KILN_ASO_APPLE_CALLS_PER_MINUTE`, at most 20),
caches, and backs off.

Not on those pages, and therefore UNVERIFIED: that the order of the results is the order of the App Store's own
search, so a **rank here is a position in this API's results, a proxy**, and every screen and field says so; the field names of
a software result; the `country` parameter on a lookup; that no subtitle is in the reply. The parser takes the absence of any
optional field, so a change on Apple's side gives less data, not an error.

**Apple's search hints (autocomplete) endpoint is not built.** It is not part of the documented API, so using it would
mean relying on an undocumented service. It stays off the list until Apple documents it.

### 3. Google Play: unofficial, opt-in, quiet

`KILN_ASO_PLAY_UNOFFICIAL_ENABLED`, default **`false`**. While it is off, no Play request is ever made: refresh and
competitor routes answer `409 play_unofficial_disabled`, the scheduler skips Android apps, and keywords can still be kept.
The warning is shown in this ADR, in [api/aso](../api/aso.md#google-play-is-unofficial), in the startup log when it is on, and in
`GET /aso/config` (`play.notice`) for the web to show next to the switch.

What the operator accepts by turning it on: reading the public pages of `play.google.com` from a program **may be against
Google Play's Terms of Service or Google's Terms of Service**. This was not checked by a lawyer, and nothing here is legal
advice. It can stop working at any time.

How it is kept as unobtrusive as it can be:

- **Public pages only.** Two kinds of GET (`/store/search`, `/store/apps/details`), no login, no cookie, no API key, no
  JavaScript, no form posts. A redirect (such as a consent page) is not followed: it is "unavailable".
- **An identifying User-Agent** (`kiln (self-hosted ASO read of public store pages)`), not a browser's.
- **Conservative rate** (default 4 calls a minute per process, at most 20), a cache (default an hour), a per workspace limit on manual
  refreshes, a cap on checks per run, and a **cool-down** after any `429`/`403` (the `Retry-After` is honoured when it is a number of seconds; otherwise 60 s).
  A page that asks for a robot check is "unavailable/blocked" and stops the run.
- **Tolerant parsing, a clear "unavailable".** Several independent signals per field, each optional. When the layout changes (a search
  page with no result link, an app page with no name) the answer is `unavailable/layout_changed`. It is **never** recorded as "not ranked": the
  keyword keeps its last known state with an `error` code, and the run stops instead of asking for each keyword.
- **Fixed host, size cap, timeout**, through the same SSRF-safe GET the app icon lookup uses.

### 4. No search volume, no popularity, no difficulty

No free, official source provides them. Tools that show a "popularity" get it from their own data or from estimates. This feature
does not invent one: `Idea.localScore` is a frequency in the texts the tool holds and is described that way in the API and in
the UI. Nothing here is ever sorted by a made-up importance except what the person set (`priority`).

### 5. Limits and retention (all in configuration)

| Variable                                                             | Default    | Meaning                                                                                                                                                  |
| -------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KILN_ASO_INTERVAL_MINUTES`                                          | `0` (off)  | Scheduled refresh of every app; 0 or 60 to 10080.                                                                                                        |
| `KILN_ASO_RETENTION_DAYS`                                            | `365`      | Rank checks and competitor snapshots older than this are deleted, bounded per run; `0` keeps them. The newest snapshot of a competitor is never deleted. |
| `KILN_ASO_MAX_KEYWORDS_PER_APP`                                      | `50`       | 1 to 500.                                                                                                                                                |
| `KILN_ASO_MAX_COMPETITORS_PER_APP`                                   | `10`       | 1 to 50.                                                                                                                                                 |
| `KILN_ASO_MAX_CHECKS_PER_RUN`                                        | `25`       | Keyword checks in one refresh, the oldest first; the rest stays due.                                                                                     |
| `KILN_ASO_RANK_DEPTH`                                                | `50`       | Results read to find the app (Apple up to 200, Google Play at most 50).                                                                                  |
| `KILN_ASO_CACHE_MINUTES`                                             | `60`       | 0 turns the cache off.                                                                                                                                   |
| `KILN_ASO_APPLE_CALLS_PER_MINUTE` / `KILN_ASO_PLAY_CALLS_PER_MINUTE` | `10` / `4` | Per process; Apple documents about 20.                                                                                                                   |
| `KILN_ASO_HEARTBEAT_DAYS`                                            | `7`        | A competitor with no stored snapshot for this long gets one anyway.                                                                                      |
| `KILN_ASO_PLAY_UNOFFICIAL_ENABLED`                                   | `false`    | See above.                                                                                                                                               |

What is stored is **public data about apps and the team's own choices**: a term, a rank, the public name, version, price, rating,
the first 1000 characters of a competitor's description (written by its developer, so untrusted text that the web must show as
plain text), and the number and a hash of screenshot addresses. No customer data. The retention exists so that a long
running instance does not grow without end.

### 6. Refresh: claim, cap, stop rules, backoff

- **One refresh per app at a time**, across processes: an atomic claim row in `aso_app_state` with a time to live (15 minutes; a stale
  claim is taken over), plus an in-process check. The scheduler also skips an app that has a job queued or running or a live claim,
  so a keyword is not checked twice. (Same idea as the review schedule.)
- **Which keywords**: those never checked or older than the interval when the scheduler asks; **all** (up to the cap) when a person asks. The oldest first,
  so a cap never starves the same keywords.
- **Stop rules.** A store's own `429` stops the run and is a failure with a backoff; our own limit stops the run as "later" and is **not** a failure;
  an unavailable source stops the run; three failures in a row stop it; so does the time limit (4 minutes). A run
  that stopped early says so (`deferred`, `stoppedBecause`) and the rest stays due.
- **Backoff.** A run that tried and got nothing counts as a failure: `backoff_until` grows 15 minutes, doubling, to 6 hours, and the scheduler waits for it. A manual refresh ignores the
  backoff (a person asked), a success resets it.
- **Shared searches.** The same term in the same storefront is one request however many apps track it.

### 7. Events, audit, privacy of the trail

- `aso.rank_changed`: a move of at least `aso.rankMoveThreshold` places (workspace setting, default 5), or an app entering or leaving the results **within the top 10**.
  Never on the first check; never for "same"; flickering at positions 40 and 50 raises nothing.
- `aso.competitor_changed`: a notable change (version, name, subtitle, price, description, media, screenshots, or a rating moved by 0.2 stars or more). The rating
  count drifting alone is stored but raises nothing.
- Both carry **ids, numbers and field names only**, never a keyword, a competitor's name or a text. Audit entries carry ids and counts (`aso.keyword_add`
  has the ids and a number, not the terms). A test checks that no term, note or store text is in the audit log, the events or the job payloads.
- Roles are enforced by the actions below; webhooks and the event stream see the two event types like any other.

### 8. Roles

Three new actions:

| Action       | Who                              | Used for                                                                            |
| ------------ | -------------------------------- | ----------------------------------------------------------------------------------- |
| `aso.read`   | viewers, members, admins, owners | Every `GET`, including the views that are worked out from stored data.              |
| `aso.write`  | members, admins, owners          | Add, change and delete keywords and competitors, and refresh **one app**.           |
| `aso.manage` | admins, owners                   | Refresh **every** app of the workspace; change the setting `aso.rankMoveThreshold`. |

Why: this is public data with no credential and no store write, so the people who work on a listing every day (members) should not need an admin
to add a keyword. The limits (keywords and competitors per app, checks per run, per workspace rate) bound what one member can ask of a store.
What an admin decides is what **spends the stores' goodwill across the whole workspace** (all apps at once) and what changes the noise for everybody
(the event threshold). Viewers read, as they do for reviews, listings and plans. An API token can hold any of the three; an app-limited token
reaches only the per app routes of its apps.

### 9. Not done, and possible later

- **LLM-assisted suggestions** (keyword ideas, competitor descriptions) are out of scope for v1. A later change could add an optional provider behind
  a workspace setting and a vault credential (the way review translation does), off by default, sending only public terms and public texts, never
  anything else. Local n-gram mining is the v1 substitute and is labelled as a frequency.
- A per keyword manual check, a workspace wide overview, a CSV export, and storefront specific Play language handling.
- Stemming beyond English plurals, and stop words beyond en, de, fr, es, it, pt and nl (a language without a list simply has none).
- The metadata of competitors' in-app events, ratings by version, and review counts over time.

## Consequences

- One migration (25) adds five tables (`aso_keywords`, `aso_rank_checks`, `aso_competitors`, `aso_competitor_snapshots`, `aso_app_state`), in the
  two schema files; deleting an app deletes its ASO rows (`deleteAsoData`), and the scheduler's upkeep removes orphans.
- `safe-fetch.ts` got an optional `userAgent` and returns the `Retry-After` of a refusal; both are additive.
- The web has two event types to add (`aso.rank_changed`, `aso.competitor_changed`) and a new set of routes ([api/aso](../api/aso.md)). There
  is no screen yet.

## UNVERIFIED

Everything below is either not stated on an official page that was checked, or not run against the real service.

- **Apple**: that result order equals App Store search order (so "rank" is a proxy); the software field names; `country` on a lookup; no subtitle in the reply;
  that the rate statement still holds ("subject to change"). Nothing was fetched from the live service.
- **Google Play**: all of the markup assumptions (links to `/store/apps/details?id=`, JSON-LD `SoftwareApplication`, `og:` tags, `data-g-id="description"`, `data-screenshot-index`,
  `aria-label` of the rating); that a search page shows at least `PLAY_MAX_SEARCH_LIMIT` results; its terms of service as they apply. The fixtures are synthetic.
- **Which fields a store searches** (iOS name, subtitle and the keyword field and not the description; Google Play title, short and full description): widely documented by the
  community, not checked on a store page. The fit result carries these as `assumptions`; `description_only` on iOS depends on it. The 100 byte budget of the iOS keyword field is likewise unchecked.
- **Text handling**: plural folding is English only; stop words exist for seven languages; CJK is split by character class and not by a word list.
- **Postgres**: the migration and queries were written for both dialects and the drift tests pass, but the ASO tests ran on SQLite only (`KILN_TEST_POSTGRES_URL` was not set).
- **A legal reading of any terms of service.** Apple's terms for the Search API were not checked beyond its published rate and caching advice.
