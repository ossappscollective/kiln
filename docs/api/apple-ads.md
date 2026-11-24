# Apple Ads (read only)

The link between an App Store record and an Apple Ads ad account, the sync that reads its campaign, search term and keyword reports, and the views over the stored rows ([ADR 0058](../adr/0058-apple-ads.md)). It needs a credential of the kind `apple_ads` (an Apple Ads API user key, see [credentials](../credentials.md#apple-ads-api-user-key)).
**Nothing in Apple Ads is ever created or changed**: the only requests to Apple are token, `GET` of the account list and details, and report queries (`POST`s that read). Apple Ads exists for App Store records (`ios`, `macos`); the others answer `422 ads_not_supported`.
Built against the Apple Ads Platform API v1, not the Campaign Management API v5 (sunset January 2027). **Never run against a real account**: see the UNVERIFIED list of the ADR.

| Route (under `/api/workspaces/:workspaceId/apps/:appId`)                           | Right        | What it does                                                                                                                      |
| ---------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /ads`                                                                         | `apps.read`  | `{ supported, link, sync }`. Database only.                                                                                       |
| `GET /ads/accounts?credentialId=`                                                  | `apps.write` | The ad accounts and roles of the key (`{ accounts: [{ id, name, orgId, roles }] }`). Asks Apple once.                             |
| `PUT /ads`                                                                         | `apps.write` | `{ credentialId, adAccountId, adamId? }` links (or changes the link). Asks Apple for the account.                                 |
| `DELETE /ads`                                                                      | `apps.write` | Removes the link. `204`; `404` when there was none. Stored rows age out after 90 days.                                            |
| `POST /ads/sync`                                                                   | `apps.sync`  | Queues `ads.sync`. `202 { queued: true, jobId }`, or `200 { queued: false, reason: "already_queued" }`. Body `{ days? }` 1 to 90. |
| `GET /ads/overview?from=&to=`                                                      | `aso.read`   | `{ sync, overview }`: totals of the window against the window before, per day sums. Database only.                                |
| `GET /ads/campaigns?from=&to=`                                                     | `aso.read`   | `{ currency, window, sync, campaigns }`, most spend first.                                                                        |
| `GET /ads/terms?kind=&from=&to=&sort=&dir=&q=&country=&campaignId=&limit=&offset=` | `aso.read`   | Search terms (`kind=term`, default) or the keywords bid on (`kind=keyword`), grouped by term and storefront.                      |

`from` and `to` are `YYYY-MM-DD` (default: the 30 days ending at the last read); `from` before `to`, at most 366 days. `sort` is `impressions` (default), `taps`, `installs`, `spend`, `cpt`, `cpi`, `ttr` or `term`; `dir` `asc` or `desc`; `limit` at most 200. `q` is a text filter (a `%` is text). Non-members and apps of another workspace are `404`. A token limited to some apps works for those apps only.

## Money

Every amount is an **integer in micro-units** (`spendMicros: 10250000` is 10.25) of the **single currency of the ad account** (`currency`, as Apple said when linking). Rows in another currency are not stored (warning `currency_mismatch`). Cost per tap, cost per install, tap-through rate and conversion rate are `null` when there is nothing to divide by, never 0.

## The link and the sync state

```json
{
  "supported": true,
  "link": {
    "appId": "…",
    "credentialId": "…",
    "credentialLabel": "Apple Ads",
    "credentialAvailable": true,
    "adAccountId": "123456789",
    "adAccountName": "Acme",
    "orgId": "27154130",
    "currency": "EUR",
    "timezone": "America/New_York",
    "adamId": "1234567890",
    "verifiedAt": 1760000000000,
    "linkedBy": "…",
    "createdAt": 1760000000000,
    "updatedAt": 1760000000000
  },
  "sync": {
    "lastAttemptAt": 1760000000000,
    "lastSuccessAt": 1760000000000,
    "lastError": null,
    "lastErrorCode": null,
    "failureStreak": 0,
    "rangeStart": "2026-11-09",
    "rangeEnd": "2026-11-22",
    "campaigns": 1,
    "complete": true,
    "skipped": 0,
    "warnings": []
  }
}
```

`lastError` is a fixed sentence (never Apple's text) and `lastErrorCode` its code (`ads.auth`, `ads.forbidden`, `ads.rateLimited`, `ads.network`, ...). `warnings` are codes: `cap_campaigns` (only 25 campaigns read), `read_cut` (a cap or the request limit ended a read early), `currency_mismatch`, `no_campaign` (no campaign promotes the linked Apple id: check `adamId`), `popularity_failed`, `popularity_partial`.

## Sync

Reads the last 14 days (30 the first time) ending **yesterday in UTC**, replaces the rows of that range per campaign in one transaction (idempotent; a day or term Apple no longer reports goes away, rows outside the range stay), keeps 90 days. At most 25 campaigns and 120 requests per sync. Then Apple's own popularity of the app's tracked keywords for the last full week (3 storefronts, 40 terms). It is also the `ads` kind of `POST /apps/:id/sync-all` ([apps](apps.md)), last, and is skipped (`not_linked`) for an unlinked app. There is no schedule.
Audit: `ads.link_set`, `ads.link_remove`, `ads.synced` (counts only) and `credential.use` (purposes `ads.link`, `ads.accounts`, `ads.sync`); **never a key, a token or a term**.

## Errors

Codes in the problem body (`coding.code`, translated by the web): `ads.invalidKey`, `ads.auth` (Apple did not accept the key), `ads.forbidden`, `ads.notFound`, `ads.rateLimited` (`retryAfterSeconds`), `ads.server`, `ads.network`, `ads.unexpected`, `ads.invalidInput`, `ads.noAccount`, `ads.requestFailed`, `ads.timeout`, `ads.notLinked`, `ads.notSupported`, `ads.adamRequired`, `ads.accountMissing`, `credential.notAppleAdsKind`, `rate.ads`. See [troubleshooting](../troubleshooting-apple-ads.md).

## In the keyword estimates

`GET /apps/{id}/aso/keyword-estimates` uses the stored search term impressions as the popularity input `ads_impressions` with `origin: "ads_data"` ([aso](aso.md#estimates)); `GET /apps/{id}/aso/keywords/{keywordId}/estimate` adds `appleAds: { campaigns, popularity }` for App Store keywords: your campaigns' impressions, taps and installs for the term, and Apple's own 1 to 100 popularity per genre. Apple's score is **beside** the estimate, never blended into it.
