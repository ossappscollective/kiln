# ADR 0058: Apple Ads, read only

Status: connector, credential, link, sync, storage, API and web implemented and tested against **hand-written fixtures**; **never run against a real Apple Ads account and never looked at in a browser** (see UNVERIFIED at the end).
API: [api/apple-ads](../api/apple-ads.md), credential: [credentials](../credentials.md#apple-ads-api-user-key). Builds on [ADR 0057](0057-keyword-estimates.md) (the keyword estimates, whose "Next" asked for this) and [ADR 0050](0050-sync-pipeline.md) (the sync plan). Two migrations (62, 63).

## Context

Apple Ads is the one place Apple shows what people typed before they tapped an ad, and the only place its 0 to 100 search popularity exists. A team that runs campaigns already has this data. Kiln reads it, next to the keywords it tracks, and never changes anything in Apple Ads:
no campaign, ad group, keyword, bid or budget is ever created or edited, and there is no code path that could (see "Read only by construction").

## What the official documentation says (researched first)

Confirmed on Apple's developer documentation while building this (the pages are linked from the credential guide):

- The **Apple Ads Platform API v1** (`https://api.ads.apple.com/v1`, released in 2026) replaces the **Campaign Management API v5** (`https://api.searchads.apple.com/api/v5`, the "Search Ads" name), which Apple announced as sunset on **26 January 2027**. Kiln is built against v1 only, so it does not depend on a version that is going away. Where the task description named v5 and `orgId`, v1 differs (below).
- **Authentication** is OAuth 2.0 client credentials with a **client secret that is a JWT signed with ES256** by the team's own private key: header `alg: ES256`, `kid` = key id; payload `sub` = client id, `iss` = team id, `aud` = `https://appleid.apple.com`, `iat`, `exp` (at most 180 days). It is exchanged at `https://appleid.apple.com/auth/oauth2/token` (`grant_type=client_credentials`, `scope=searchadsorg`) for a bearer token valid one hour. The public key is pasted into Apple Ads (Account Settings, API) by an API user; Apple then shows the client id, team id and key id.
- **Scope of a request** is the ad account: the header `X-AP-Context: adAccountId=<id>` (v1), not the v5 `orgId`. `GET /v1/acls` lists the accounts and roles of the user, `GET /v1/ad-accounts/{id}` gives the name, currency and time zone. The read-only roles are **API Account Read Only** and **Limited Access: API Read Only**.
- **Reports** are `POST` queries: `/v1/reports/apps/campaigns/query`, `.../keywords/query`, `.../searchterms/query`, with a `timeRange` (`start`, `end`, `timeZone` `ORTZ` or `UTC`, granularity `DAILY`), `pageSize` up to 5000 and `pagination.offset`. A daily report may span at most 90 days. Money comes as `{ amount: "string decimal", currency }`. Terms with very few impressions are not reported (low-volume suppression).
- **Popularity is exposed**: `POST /v1/insights/apps/search-term-popularity/query` returns `searchPopularity1to100` / `1to5` and `rankInGenre` per term, filtered by `countryOrRegion`, `genre` and `searchTerm`, for a `WEEKLY_SUN_SAT` or `MONTHLY` period. ADR 0057 said no popularity API exists; that was true of the v5 API and the public web, and is not true of the Platform API.
- **Rate limits** are answered with `RateLimit-*` headers and `Retry-After` on `429`.

## Decision

### 1. Read only by construction

`packages/connectors/src/apple/ads-client.ts` exposes exactly two verbs: `get` (the paths `/me`, `/acls`, `/ad-accounts/{id}`) and `query` (an allow list of report and insight paths, which are `POST`s because Apple takes the query in the body but change nothing). There is no generic request function, no `PUT`, `PATCH` or `DELETE`, and the path allow lists are tested. The hosts are constants (`appleid.apple.com`, `api.ads.apple.com`), redirects are refused, responses are size capped and every request has a timeout. Recommended role: **API Account Read Only**; Kiln cannot tell the role, so the credential guide says so and the test lists the roles Apple reports.

### 2. Credential kind `apple_ads` and the link

Four fields (client id, team id, key id, private key PEM, P-256 only) stored encrypted like every credential; the **private key is never logged, returned or put in an error** (errors are fixed sentences with a `coding.code`; the identifiers allowlist shows only the three ids). **Test connection** signs a secret, gets a token and lists the ad accounts, nothing else. A per-app **link** (`app_ads_links`) names the credential, the ad account (name, currency and time zone as Apple said) and the **Apple id** of the promoted app (default: the store id of the record). Only App Store records can be linked.

### 3. Sync (`ads.sync`)

A job like the others (priority 4, heavy, last in the sync plan, also `POST /apps/{id}/ads/sync` and the `ads` kind of "Sync everything"; **no scheduler** yet). It reads the last 14 days (30 on the first sync) ending yesterday UTC, the campaign report of the account, then the search term and keyword reports of the campaigns whose promoted app is the linked one (at most 25 campaigns, 120 requests), and stores **daily rows**:
`ads_campaign_daily` and `ads_term_daily` (money as **integer micro-units**, parsed from Apple's decimal strings without floats), kept 90 days. A range is replaced per campaign in one transaction, so a rerun is idempotent. Only rows in the **currency of the ad account** are stored; another currency is counted in a warning and never added in. A failed read keeps the last good rows, records a fixed sentence and a failure streak (a `429` is not a failure of the key). Apple's own popularity (`ads_term_popularity`) is read for the tracked keywords of the app (at most 3 storefronts and 40 terms) for the last full week; a failure there is a warning, never a failed sync.

### 4. The estimate

Search term impressions from the team's own campaigns are a new input of the **popularity estimate**: reason `ads_impressions` (weight 3, `log10(impressions + 1) / 5` of 100), origin `ads_data`, shown as **"from your data (Apple Ads)"**; the "From your data" filter includes it. It counts as strong evidence from 100 impressions. A keyword that never appeared in a report has **no** ads input (absent is `null`, never 0), and an own Play file still wins the origin. App Store keywords only. Apple's **own popularity score is not blended in**: it is shown beside the estimate in the keyword detail ("Apple Ads", per genre, with its rank) and the estimate keeps saying it is an estimate.

### 5. Surface

Insights gets an **Ads** tab (`?view=ads`, `aso.read`, App Store records only), the page hierarchy of every page: header (scope, Sync), range bar and "Updated" line, then a rail (`?section=`): **Overview** (totals against the period before, per day bars and a table, every ratio a dash when there is nothing to divide by), **Campaigns**, **Search terms** (sortable `table.fit`, left aligned, filter, pages of 50, "Track keyword" that adds the term to the tracker, a flag for the terms already tracked), **Keywords** (the keywords bid on) and **Account** (the link form, what the last read covered, warnings). Not linked: one setup card with the steps and the link form. The same link form is in the app Settings, Integrations. No alerts were added.

## Consequences

- A team with Apple Ads sees spend and search terms next to the keywords, and its own impressions sharpen the popularity estimate, labelled as theirs.
- Kiln holds a second private key per Apple Ads account. It is the same class of secret as the other credentials and is handled the same way; a read only role keeps a leak from being able to spend money.
- v5 is not supported, on purpose. If Apple delays the v5 sunset it changes nothing for Kiln.

## Next

- A schedule (the sync is manual and part of "Sync everything" only), and an alert on a failed streak.
- Reports by ad group, creative or country; custom date ranges beyond a year.
- An "Apple popularity" column in the estimates table (today it is in the detail only).

## UNVERIFIED

No Apple Ads account or network was available: **nothing here was ever sent to Apple**. The code follows Apple's documentation as read, and the tests use fixtures written from it. Specifically unconfirmed: that the Platform API v1 base URL and paths are exactly as above on a live account; the exact shape of rows with `groupBy` and of the keyword report metadata; that the campaign report's `promotedObjectId` is the app's Apple id (the match used to find "your" campaigns); which popularity rows come back without a `genre` filter and the genre ids; the `scope` value and the token answer fields; the role names as the console shows them and that API Account Read Only may call `acls`, the three reports and the insight; the 429 `Retry-After` semantics; that a `timeZone` of `ORTZ` is accepted only for search terms; whether low-volume suppression also hides keywords. The screens were checked by `svelte-check` and unit tests only, not in a browser.
