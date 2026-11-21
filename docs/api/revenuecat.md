# RevenueCat of an app

The link between an app record and its RevenueCat project and app, the stored copy of the project configuration, and the joined view the
Products page draws ([ADR 0039](../adr/0039-revenuecat.md)). It needs a credential of the kind `revenuecat` (a V2 secret API key with read
permissions on the project configuration, see [credentials](../credentials.md#revenuecat-secret-api-key)). One link per app record: an iOS
and an Android record of the same product each have their own. **Configuration facts only: no money amount and no customer data is read,
stored or returned. Nothing in RevenueCat or a store is ever changed by these routes.** Covers Apple (iOS and macOS) and Google Play;
RevenueCat apps of any other store are listed as "not mapped" and ignored.

**UNVERIFIED:** tested with fixtures and an injected `fetch` only, never against a real RevenueCat project (list in the ADR).

| Route | Right | What it does |
| --- | --- | --- |
| `GET /api/workspaces/:workspaceId/apps/:appId/revenuecat` | `apps.read` | `{ supported, link, sync }`. Database only. |
| `GET /api/workspaces/:workspaceId/apps/:appId/revenuecat/products` | `apps.read` | The store products joined to the stored RevenueCat copy, with warnings. Database only. |
| `PUT /api/workspaces/:workspaceId/apps/:appId/revenuecat` | `apps.write` | Links the app (or changes the link). Asks RevenueCat first. |
| `DELETE /api/workspaces/:workspaceId/apps/:appId/revenuecat` | `apps.write` | Removes the link and the stored copy. `204`; `404` when there was none. |
| `GET /api/workspaces/:workspaceId/apps/:appId/revenuecat/detect?credentialId=&projectId=` | `apps.write` | READS RevenueCat: the projects the key sees and, for one, its apps. Saves nothing. |
| `POST /api/workspaces/:workspaceId/apps/:appId/revenuecat/sync` | `apps.sync` | Reads the project configuration and replaces the stored copy (the second step of the products sync, alone). |

`apps.write` is owners and admins. A token limited to some apps may use these routes for those apps only. Non-members and apps of another
workspace are `404`. `supported` is `false` for a platform whose store RevenueCat does not serve here (the platform capability `revenueCat`;
iOS, macOS and Android have it). Every route is in the [operation registry](openapi.md).

## The link

`GET .../revenuecat` answers `{ supported, link, sync }`; `link` is `null` without one, `sync` is `null` before the first RevenueCat read.

```json
{
  "link": {
    "appId": "…",
    "credentialId": "…",
    "credentialLabel": "RevenueCat read key",
    "credentialAvailable": true,
    "projectId": "proj1a2b3c4d",
    "projectName": "Trail Notes",
    "revenueCatAppId": "app1a2b3c4d",
    "revenueCatAppName": "Trail Notes iOS",
    "revenueCatAppType": "app_store",
    "revenueCatIdentifier": "com.example.trail",
    "identifierMatches": true,
    "verifiedAt": 1760000000000,
    "linkedBy": "user id",
    "createdAt": 1760000000000,
    "updatedAt": 1760000000000
  }
}
```

`credentialAvailable` is `false` (and `credentialLabel` `null`) when the credential was deleted: the link stays; choose another credential
with `PUT`. The names, type and identifier are what RevenueCat reported when the link was saved, never what was typed.
`identifierMatches` compares RevenueCat's bundle id or package name with the app's own (case-insensitive for Apple, exact for Android) and
is `null` when RevenueCat gave none; a difference is shown, not refused (a universal purchase may differ).

## Which RevenueCat app an app record may use

From the platform capabilities in `packages/core/src/platform.ts`, never from a platform name: iOS `app_store`; macOS `mac_app_store` (a
legacy Mac app) or `app_store` (the shared app of a universal purchase); Android `play_store`. Every other RevenueCat app type (`amazon`,
`stripe`, `rc_billing`, `paddle`, `roku`, anything new) is **not mapped**: listed by `detect` with `mapped: false`, `linkable: false` and
the note "Not mapped: ...", refused by `PUT` with `422 revenuecat_app_not_mapped`, never a server error.

## `PUT .../revenuecat`

Body (strict): `{ credentialId, projectId, revenueCatAppId }`. Reads the project and the app with the credential, checks that the app
fits the platform (above), stores what RevenueCat answered. Audit `revenuecat.link_set`; the use of the key is a `credential.use` with the
purpose `revenuecat.link`. Answers `{ link }`.

## `GET .../revenuecat/detect`

Query: `credentialId` (required), `projectId` (optional: a V2 key sees one project, so it is usually implied). Answers
`{ options: { projects, projectId, apps, complete } }`; `apps` is `null` when several projects were seen and none chosen, else a list of
`{ id, name, type, mapped, linkable, identifier, matches, suggested, note }`. `suggested` marks the linkable app whose identifier is the
app's own (the most specific type for the platform wins). `complete: false` means a list stopped at a cap. `Cache-Control: no-store`.

## `GET .../revenuecat/products`

Computed on every read from the two stored copies; asks neither the store nor RevenueCat.

```json
{
  "supported": true,
  "link": { "…": "as above, or null" },
  "sync": { "lastAttemptAt": 1760000000000, "lastSyncedAt": 1760000000000, "lastError": null, "failures": 0,
            "productCount": 4, "otherAppProductCount": 2, "complete": true, "warnings": [] },
  "products": {
    "pro_monthly": {
      "status": "in_revenuecat",
      "products": [{ "rcProductId": "prod1", "storeIdentifier": "pro_monthly", "planId": null, "planInStore": null, "type": "subscription",
                     "state": "active", "displayName": "Pro monthly", "duration": "P1M", "gracePeriod": null, "trialDuration": "P1W" }],
      "entitlements": [{ "id": "entl1", "lookupKey": "pro", "displayName": "Pro", "state": "active" }],
      "offerings": [{ "id": "ofrng1", "lookupKey": "default", "isCurrent": true, "state": "active",
                      "packages": [{ "id": "pkg1", "lookupKey": "$rc_monthly", "rcProductId": "prod1", "eligibility": "all" }] }]
    }
  },
  "unmatched": [],
  "warnings": [{ "code": "store_product_not_in_revenuecat", "severity": "warn", "message": "…", "storeProductId": "x", "rcProductId": null, "entitlementId": null }]
}
```

- `products` is keyed by the store product id and is empty before the first RevenueCat read (nothing is claimed then). `status` is
  `in_revenuecat`, `archived` (every matched product is archived), `not_in_revenuecat`, or `id_not_matched` (an id that differs only by
  letter case: not a match).
- Matching is by the store product id, exactly. Google Play subscriptions are `subscription_id:base_plan_id` (one store product, several
  RevenueCat products, each with its `planId` and `planInStore`) or a legacy bare `subscription_id`. **UNVERIFIED** on a real project.
- `unmatched` lists RevenueCat products of the linked app that match no store product.
- `warnings` (worst first is for the client to do; `severity` is `info`, `warn` or `bad`): `store_product_not_in_revenuecat`,
  `revenuecat_product_not_in_store`, `revenuecat_product_case_differs`, `product_not_sellable` (in no package of an active offering),
  `entitlement_without_active_product`, `store_removed_but_active_in_revenuecat`, `play_base_plan_not_in_revenuecat`,
  `revenuecat_read_incomplete`. Each `message` is one sentence with the fix. "Not found" is not claimed from an incomplete read.

## `POST .../revenuecat/sync` and the products sync

Right `apps.sync`; shares the per-workspace app-sync limit (`429 rate_limited` with `Retry-After`). `422 revenuecat_not_linked` without a
link. Reads `products`, `entitlements` (with their products) and `offerings` (with their packages and products) of the project, keeps the
products of the linked app, and replaces the stored copy in one transaction. At most 45 requests per read; a read that hits a cap is
`complete: false` with a sentence. A failed read keeps the previous copy and records a fixed sentence in `sync.lastError` (RevenueCat's own
text is never copied) and `failures`. Answers `{ sync: { products, entitlements, offerings, otherAppProducts, complete, warnings, syncedAt } }`.
Audit `revenuecat.synced` (counts only). Timeout `504 timeout`.

`POST /apps/:appId/products/sync` ([products](products.md)) runs this as its **second step** when the app is linked, after the store step.
The steps are independent. Its body is `{ sync, revenuecat }` where `revenuecat` is `null` (no link), `{ ok: true, products, entitlements,
offerings, otherAppProducts, complete, warnings, syncedAt }`, or `{ ok: false, code, message, retryAfterSeconds? }`. A store failure keeps
its status and body and adds `revenuecat` when the app is linked. A RevenueCat failure never changes the store snapshot or the status of the
sync.

## Errors

`401`/`403`/`404` as everywhere. Codes: `credential_not_found`, `credential_kind` (not a RevenueCat credential), `credential_unreadable`,
`invalid_request`, `invalid_reference` (project or app unknown to RevenueCat), `revenuecat_auth` (key not accepted), `revenuecat_forbidden`
(key may not read this), `revenuecat_not_found`, `revenuecat_app_missing`, `revenuecat_app_not_mapped`, `revenuecat_not_supported` (the
platform has no RevenueCat support), `revenuecat_not_linked`, `rate_limited` (`429`, with `Retry-After`), `timeout` (`504`),
`revenuecat_unavailable` (`502`). The messages are fixed sentences; the key never appears in a message, a log or an audit row.
