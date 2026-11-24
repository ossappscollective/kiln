# In-app purchases and subscriptions (read, one gated text write, staged price changes)

Lists the in-app products and subscriptions of an app as the store has them, and lets an owner or admin change the **display name and
description of one locale** of one product, and stages **price changes** that are sent from the pending cart. Design and the arguments: [ADR 0034](../adr/0034-in-app-products.md).

Capability `inAppPurchases` (every platform has it now; a platform without it gets `supported: false` on the list and `422
products_not_supported` on a sync). Apple records (iOS and macOS) use App Store Connect, Android records use Google Play.

**Not run against a real account**: the calls follow the stores' public documentation and are tested against fakes. See
[UNVERIFIED](#unverified-check-with-a-real-account).

Routes are under `/api/workspaces/{workspaceId}`. A non-member gets 404, a member without the right gets 403.

## Sales next to the products (read from analytics)

The Products page shows a **Sales (28 days)** column and a small Sales section in the open product, from the stored analytics of the app
(`GET /apps/{appId}/analytics/product-sales`, [analytics](analytics.md#sales); no store is called on page load). It matches a product by its
`productId` (Apple SKU, Google Play SKU ID). Units and one amount per currency, never added; `—` when there is no number. The tooltip says what the
number is: Apple developer proceeds, or a Google Play **estimate of what buyers paid** (tax included, Google's fee not deducted, refunds taken off; not
proceeds). Only roles with `analytics.read` get the column, and it is hidden until the app has a stored sales day; then one line says how to turn it on
(Apple vendor number; Google bucket id and the Play Console permission View financial data). Apple in-app products are matched to the sales rows by SKU
(UNVERIFIED).

## What is not here

No availability edit, no creating or deleting a product, no new locale. Prices are changed in [Price changes](#price-changes) (staged, then sent
from the pending cart); RevenueCat stays read only.

## `GET /apps/{appId}/products`

Right `apps.read`. Reads the **stored snapshot**; it does not call the store. Returns:

| Field        | Meaning                                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`        | `{ id, name, platform, store }`.                                                                                                                                                                                 |
| `supported`  | `false` when the platform has no in-app purchases here (the list is empty).                                                                                                                                      |
| `products[]` | `productId`, `kind` (`consumable`, `non_consumable`, `subscription`), `referenceName`, `state` and `rawState`, `group`, `period`, `name`, `locales[]`, `price` (a headline price), `territoryCount`, `syncedAt`. |
| `sync`       | `null` before the first sync, else `lastAttemptAt`, `lastSyncedAt`, `lastError`, `failures`, `productCount`, `complete`, `warnings[]`.                                                                           |
| `write`      | `{ enabled, envName }`: whether the text write is switched on on this server.                                                                                                                                    |

Prices are `{ planId, territory, currency, amount, display }`. `amount` is a **string in minor units** (`999` is 9.99 USD), never a number.

## `GET /apps/{appId}/products/{productId}`

Right `apps.read`. `{ app, product, sync }`. The product adds `baseTerritory`, `localizations[]` (`locale`, `name`, `description`), `prices[]`,
`availability` (`territories[]`, `availableInNewTerritories`), `plans[]` and `offers[]`. `404 product_not_found` when the id is not in the
snapshot (sync first).

## `POST /apps/{appId}/products/sync`

Right `apps.sync`. READS the store and replaces the stored snapshot; it writes nothing to the store. Shares the per-workspace app-sync
limit (`429 rate_limited` with `Retry-After`; an unknown app is a 404 and costs no slot). Returns `{ sync: { app, products, complete,
warnings, syncedAt } }`. Not behind the write switch.

- A read that hit a cap or a missing sub-resource is `complete: false` with `warnings`; it replaces only the products it listed.
- A failed read keeps the previous snapshot and records `lastError` and `failures` (the message has no secret in it).
- Audit `monetization.synced` (counts only). Timeout 180 s (`504 timeout`).
- **Second step, RevenueCat.** When the app is linked to a RevenueCat project ([api/revenuecat](revenuecat.md)), the sync then reads RevenueCat and
  the answer also carries `revenuecat` (`null` without a link, `{ ok: true, ... }` or `{ ok: false, code, message }`). The steps are independent: a RevenueCat
  failure never touches the store snapshot or the status of this call, and a store failure does not stop the RevenueCat step (its result is in the error
  body). The joined view is `GET /apps/{appId}/revenuecat/products`; this page's list is unchanged. The RevenueCat step also reads RevenueCat's metrics overview (`revenuecat.metrics`, its own `ok` or `code` and `message`; a failure there, such as a key without the metrics permission, never makes the step fail); the figures are `GET /apps/{appId}/revenuecat/metrics` ([ADR 0043](../adr/0043-revenuecat-metrics.md)).

## `PUT /apps/{appId}/products/{productId}/localizations/{locale}`

Body (strict): `{ apply, name, description, previewHash? }`. `locale` is a tag such as `en-US` (the store's spelling is returned).

### The gate

- **Switch**: `KILN_STORE_PRODUCT_WRITE_ENABLED=true` (default `false`). While off the route answers `409 store_product_write_disabled`
  with `envName`, after the rights check; no store is contacted. Reads and the sync are not affected.
- **Right**: `monetization.write` (owner and admin). An API token needs the action **named** in its list.
- **Step-up**: an apply is the `store.push_draft` action of [step-up](step-up.md): a workspace that covers it asks for the person's
  confirmation (a grant in the `x-step-up-grant` header, bound to the app and the `previewHash`). A preview stays free.

### Preview: `apply: false`

READS the product in the store and writes nothing. A successful read also settles an earlier `outcome_unknown`. Returns `{ preview }`:

| Field                  | Meaning                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `app`, `product`       | Which record and product (`productId`, `kind`, `referenceName`).                         |
| `locale`               | The locale as the store writes it.                                                       |
| `current`, `proposed`  | `{ name, description }` as the store has them, and as asked (line breaks normalized).    |
| `changes`, `unchanged` | Which of the two texts differ; `unchanged` is true when nothing does.                    |
| `previewHash`          | SHA-256 over the app, product, locale, the store's current texts and the proposed texts. |
| `warnings`, `readAt`   | Notes from the store read, and when it was read.                                         |

### Apply: `apply: true`

Needs the switch, the right, the step-up grant when covered, and the `previewHash` of a preview of exactly these texts (`400
invalid_request` without it).

1. The product is **read again** right before the write. Other texts than the previewed ones are `409 state_changed` with `current`,
   `proposed`, `changes` and a new `previewHash`. Nothing is written.
2. One write: the localization PATCH (Apple) or the `listings` patch (Google). Nothing else of the product is sent.
3. **One write in flight per app**: `409 write_in_progress`.
4. **Never retried.** After a timeout or a 5xx the texts are read back: the asked texts show (`200` with `confirmedByReread: true`);
   the old texts show, or the read failed (`409 outcome_unknown`; look in the store, then preview again; a preview clears it); other
   texts show (`409 state_changed`).
5. Returns `{ result }`: `app`, `product`, `locale`, `before`, `after`, `changes`, `confirmedByReread`, `appliedAt`, `note`.

Audit: `monetization.localization_changed` or `monetization.localization_failed` (`outcome` `refused`, `failed`, `unknown`, `diverged`),
with ids and hashes only. The texts are never in the audit log.

### Text rules

Name 1 to 200 characters on a single line; description at most 2000; no control characters; CRLF becomes LF. Failing any is `422
invalid_text`. The stores' own limits may be tighter and are not verified: their refusal comes back as `422 invalid_product`.

## Price changes

Design, gates and the threat analysis: [ADR 0062](../adr/0062-price-writes.md); operator summary: [price writes](../price-writes.md). A price change is
**staged** here (Kiln's own table, nothing is sent to a store) and **sent** from the pending cart (`POST /apps/{appId}/pending/publish`, see
[pending](pending.md#price-items-price-kind-risk-financial)). Capability `priceWrite` (Apple and Google Play).
`GET /apps/{appId}/products` carries `priceWrite`: `enabled` (both switches on), `envName` (`KILN_PRICE_WRITES_ENABLED`), `workspaceEnabled`,
`reason` (`server_switch`, `workspace_setting` or null), `limits` (`relativeChangePercent`, `absoluteChangeMajor`, `maxTerritories`) and `staged`
(the staged changes of the app).

| Route | Needs | Does |
| --- | --- | --- |
| `GET /apps/{appId}/products/{productId}/price-points?territory=USA` | `monetization.price` | Apple: the price points of one territory, lowest first (a store READ). Google Play: `applicable: false`. |
| `POST /apps/{appId}/products/{productId}/price-convert` | `monetization.price` | Google Play: `{ planId, baseTerritory, amount }` returns the regional prices Google derives from one base price, in each region's own currency (a store READ; stages nothing). `422 not_applicable` for Apple. |
| `PUT /apps/{appId}/products/{productId}/prices/staged` | `monetization.price` | Stages (replaces) the change of one product and plan. Returns `{ staged }`. |
| `POST /apps/{appId}/prices/dry-run` | `monetization.price` | `{ ids? }` (cart ids `price:…`; all when omitted). Reads the LIVE prices, runs every rule again, shows what a send would do. Writes nothing, no claim, no phrase, no step-up; works while the switches are off (`writesEnabled` says whether a send would be allowed). |

`PUT …/prices/staged` body (strict; unknown fields, including a currency or a current price, are refused):

```json
{ "planId": null,
  "lines": [ { "territory": "USA", "newAmount": "599", "pricePointId": "…" } ],
  "effectiveDate": null,
  "existingSubscribers": "preserve",
  "acknowledgements": [],
  "seenSyncedAt": 1767225600000 }
```

`newAmount` is minor units, digits only (599 is 5.99; no rounding anywhere). `planId`: Google Play, the base plan or purchase option (required);
Apple subscription, the plan type (`MONTHLY`, `UPFRONT`) or null; Apple in-app purchase, null. `pricePointId`: Apple only, required, and the amount
must be that price point's (an amount that is not a price point is `422 invalid_price` with the nearest points in `issues[].detail.nearest`).
`effectiveDate`: `YYYY-MM-DD`, Apple only, not in the past; null is as soon as the store allows. `existingSubscribers`: `preserve` (default and the
safe choice), `apply` (Apple), `opt_in` or `opt_out` (Google Play), `not_applicable` (not a subscription). `acknowledgements` must contain every
one the numbers need: `large_change` (a line changed by more than the relative limit, default 50% either way), `large_absolute` (more than the
absolute limit in major units of the line's currency, default 100, higher built-in defaults for JPY and the like) and `existing_subscribers`
(anything but `preserve`). `seenSyncedAt` is the product's `syncedAt` as the screen showed it.

The SERVER is the author: the current price and currency of each line come from the stored snapshot, and every rule runs again (positive whole
minor units, the currency of the territory, a territory the plan has a price in, at most `maxTerritories`, no price above 100000 major units, a
line that actually changes the price). Failures: `409 price_writes_disabled` (carries `envName`; either switch), `409 stale_snapshot`, `404
product_not_found`, `422 invalid_price` with `issues` (`{ code, territory?, detail? }`: `amount_not_price_point`, `currency_mismatch`,
`ack_required`, `unknown_territory`, `no_change`, `effective_date_past`, `effective_date_unsupported`, `subscriber_rule_invalid`,
`too_many_territories`, `stale_price` and the others of the core `PriceIssueCode`), `422 not_applicable`, `403 forbidden`. Audit `price.staged`
(the before and after amounts, the actor), `price.discarded`, `price.dry_run`. No webhook event.

## Errors

| Status | `error`                                                                                 | When                                                                      |
| ------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 400    | `invalid_request`                                                                       | Body not valid, or `previewHash` missing on an apply.                     |
| 403    | `forbidden`, `step_up_required`                                                         | No right; or the workspace asks for a confirmation (see step-up).         |
| 404    | `not_found`                                                                             | Not a member, no such workspace or app.                                   |
| 404    | `product_not_found`                                                                     | The product is not in the snapshot, or the store does not have it.        |
| 404    | `locale_not_found`                                                                      | The store lists no such locale for the product (a locale is never added). |
| 409    | `store_product_write_disabled`                                                          | The switch is off. Carries `envName`.                                     |
| 409    | `price_writes_disabled`, `stale_snapshot`                                               | Price changes: a switch is off; the product was synced again.             |
| 422    | `invalid_price`, `confirmation_mismatch`, `not_applicable`                              | Price changes: a rule is broken (`issues`); the typed phrase; Apple/Play. |
| 409    | `state_changed`                                                                         | The store shows other texts than the previewed ones.                      |
| 409    | `write_in_progress`                                                                     | Another text change of this app is running.                               |
| 409    | `outcome_unknown`                                                                       | The write may or may not have reached the store.                          |
| 422    | `invalid_locale`, `invalid_text`                                                        | The locale or a text breaks the rules above.                              |
| 422    | `no_change`                                                                             | The store already shows these texts.                                      |
| 422    | `products_not_supported`                                                                | The platform has no in-app purchases here.                                |
| 422    | `credential_not_found`, `credential_kind`, `credential_unreadable`, `app_not_synced`    | The app's credential or store id is not usable.                           |
| 422    | `store_auth`, `store_forbidden`, `store_not_found`, `invalid_product`, `store_rejected` | The store refused; the message has no secret.                             |
| 429    | `rate_limited`                                                                          | Sync limit, or the store's own limit (`Retry-After`).                     |
| 502    | `store_unavailable`, `store_failed`                                                     | The store could not be reached or answered with an error.                 |
| 504    | `timeout`                                                                               | The store did not answer in time (a write is then read back, see above).  |

## Credentials

The same credentials as the app's sync (App Store Connect API key, Google service account). The stores do not document which role or
permission covers editing in-app product texts; give the key or account the right to manage in-app products and test a preview and an
apply on a product you can afford to change.

## UNVERIFIED: check with a real account

For price changes see the list in [ADR 0062](../adr/0062-price-writes.md#unverified-check-with-a-real-account); nothing was run against a real store.
Texts:

Apple: whether `include` still returns subscription localizations (their own endpoints are deprecated since API 4.4.1); whether the
localization ids from `include` are the ids the v2 `PATCH /v2/inAppPurchaseLocalizations/{id}` takes; the format of `customerPrice`; what
a 404 for a missing price schedule means; the meaning of `preserved` prices; plan types other than `UPFRONT`; whether the texts of an
approved product are editable; length limits; the required key role.

Google Play: whether an app not migrated to the new monetization API shows products under `oneTimeProducts`; that a patch with
`updateMask=listings` and a `listings`-only body is accepted; that the `regionsVersion` from `convertRegionPrices` is accepted for a
subscription patch; the required Play Console permission. Consumable versus non-consumable is guessed from `multiQuantityEnabled`, and
`otherRegionsConfig` prices are not shown.
