# ADR 0057: Keyword popularity and difficulty estimates

Status: model, collection, API and web implemented and tested against hand-written fixtures; **never run against Apple's real services and not looked at in a browser** (see the end).
API: [api/aso](../api/aso.md#estimates). Builds on [ADR 0011](0011-aso-keywords-competitors.md) (tracked keywords, rank checks, the rate-limited SSRF-safe Apple reads) and the Google Play search terms import. One migration (61).

## Context

People tracking a keyword want to know whether it is worth the effort: is it searched, and is it hard to rank for? Apple has no public popularity API: the 0 to 100 popularity score exists only inside Apple Ads
(a separate backlog item). Google Play offers nothing. Any number Kiln shows is therefore an **estimate** from public signals, and must never look like Apple's or Google's figure.
Open Screenshot Generator (MIT) was read for comparison: its Keywords tool tracks ranks only and makes no volume claim, and says plainly how close its ranks are to the App Store's. We keep that honesty; no code or text was taken from it.

## Decision

### 1. The model (v1, core `keyword-estimate.ts`)

A pure function from signals to `{ popularity, difficulty, opportunity }`, each with a 0 to 100 `score` or `null`, a `confidence` (low, medium, high), an `origin` (`own_data` or `public_signals`) and `reasons`: the list of inputs with their parameters, the 0 to 100 each alone suggests and its weight.
The web shows that list, so a number can always be checked. The formula, the weights and the thresholds are written in [api/aso](../api/aso.md#estimates) and are constants in one file; `KEYWORD_ESTIMATE_MODEL = 'v1'` is stored with each row for information.

| Signal                                          | Feeds                    | Source                                                                  |
| ----------------------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| Own visitors for the term (a lower bound)       | popularity, strongest    | Google Play search terms file, already imported by the team             |
| Position in the App Store search hints          | popularity               | `search.itunes.apple.com` hints, public                                 |
| Rating counts of the first results              | popularity (weak), difficulty | the iTunes search of the rank check, public, no extra request      |
| Words of the term in the first results' names   | difficulty               | the same results                                                        |
| Result count against the depth asked            | difficulty (minor)       | the same results                                                        |
| Rank volatility over the last checks            | difficulty (minor)       | our own rank history                                                    |

Honest rules, enforced by tests: no signal is `null` ("No estimate"), never 0; Google Play keywords get a popularity only from the team's own file and never a difficulty; public signals alone never give `high`; difficulty never gives `high`; every sentence in the web says "estimate".

### 2. Collection

The rank check already searches Apple and keeps the first results; their ids, names and rating counts are now also saved as a signal (no extra request). After the checks and the competitors, a refresh reads the **hints** of at most 10 terms
(`AsoLimits.maxSignalTerms`, default 10; oldest first, so the rest queue for the next refresh), once per term, storefront and day, through the same SSRF-safe fetch (the host `search.itunes.apple.com` joins the allow list; the only extra request header is
`X-Apple-Store-Front`), the same per-process rate limit and cool-down and the same cache. A limit makes the refresh `deferred`, never failed. A storefront with no known id is not asked.
Rows live in `aso_keyword_signals` (workspace, store, storefront, normalised term, day), 90 days, pruned (with rows of terms no longer tracked) by the refresh. **The estimate is not stored**: it is recomputed on every read from the signals, the rank checks and the own file, so a model change needs no migration.

### 3. Surface

Insights, Keywords: under the tracked keywords, an "Estimates" table (`table.fit`, left aligned, no sideways scroll) with Popularity (est.), Difficulty (est.) and Opportunity (est.): a bar, the number and three dots for the confidence (shape and text, not colour alone), "from your data" when
own numbers took part, "No estimate" with its reason otherwise. Sort (opportunity, popularity, easiest, A to Z), text filter and a filter by estimate. A "How this is estimated" popover lists the inputs and limits; a detail panel per keyword shows both input lists, the hints with their order, the apps in the first results with their rating counts and the trend of both estimates.
"Related terms" lists the hints that are not tracked yet, with a Track button (the existing add-keyword request, `aso.write`). No tab or rail was added (the Insights hierarchy, [ux-ia 0e](../ux-ia.md#0e-tabs-rail-scope-sync-the-one-hierarchy-of-a-page)): it is part of the Keywords page.
Why a separate table and not two columns in the tracked table: that table already has eight columns and scrolls; the estimates need a bar, a number and a confidence each.

### 4. Privacy and limits

Only keywords the team tracks are asked, as public queries; no credential or cookie is sent; nothing is sent to an AI; terms never appear in logs, errors or audit rows (the audit detail has counts only). Rate: the hints share Apple's documented
"approximately 20 calls per minute" budget with the searches; at most 10 hint requests per refresh. Terms are read once a day, so a hot term's popularity moves only daily.

## Limits (what the numbers are not)

The hints order and the result order are what Apple's public services return and may differ from the App Store app. A hint position is a hint of popularity, not a search count. Rating counts show age and size of the apps, not demand. Your own visitors only count people who reached
your listing. Difficulty ignores paid ads, relevance of your app and the language of the storefront. Opportunity multiplies three estimates and is the least certain number; it is a place to look.

## Next

- Import the Apple Ads popularity score (0 to 100) where the team has an Apple Ads account (the separate "Apple Ads" backlog item): it would be an `own_data`-style input labelled as Apple's, beside the estimate and never merged into it.
- Google Play: nothing public exists; the Play Console search terms file stays the only input. App Store Connect search term data, if the analytics reports expose it, would be the Apple counterpart of the own signal.
- Hints of prefixes of the term (a second request per term) to separate "popular" from "long tail".

## UNVERIFIED

No network was available: the hints endpoint (URL, XML property list answer, `X-Apple-Store-Front` header, storefront ids, ordering by popularity) is written from how the service is widely observed to behave and is not documented by Apple; the parser accepts an answer with no hint and the code treats "no hints"
as a (weak, low) signal. The weights and thresholds of v1 are judgements, not fitted to real data. The screens were checked by `svelte-check` and unit tests only, not in a browser.
