# In-app purchases and subscriptions (read, plus one gated text write)

Lists the in-app products and subscriptions of an app as the store has them, and lets an owner or admin change the **display name and
description of one locale** of one product. Design and the arguments: [ADR 0034](../adr/0034-in-app-products.md).

Capability `inAppPurchases` (every platform has it now; a platform without it gets `supported: false` on the list and `422
products_not_supported` on a sync). Apple records (iOS and macOS) use App Store Connect, Android records use Google Play.

**Not run against a real account**: the calls follow the stores' public documentation and are tested against fakes. See
[UNVERIFIED](#unverified-check-with-a-real-account).

Routes are under `/api/workspaces/{workspaceId}`. A non-member gets 404, a member without the right gets 403.

## What is not here

No price or availability edit, no creating or deleting a product, no new locale. Price changes are the planned next step with their own
switch, step-up and revenue preview (ADR 0034).

## `GET /apps/{appId}/products`

Right `apps.read`. Reads the **stored snapshot**; it does not call the store. Returns:

| Field       | Meaning                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `app`       | `{ id, name, platform, store }`.                                                                                                         |
| `supported` | `false` when the platform has no in-app purchases here (the list is empty).                                                              |
| `products[]`| `productId`, `kind` (`consumable`, `non_consumable`, `subscription`), `referenceName`, `state` and `rawState`, `group`, `period`, `name`, `locales[]`, `price` (a headline price), `territoryCount`, `syncedAt`. |
| `sync`      | `null` before the first sync, else `lastAttemptAt`, `lastSyncedAt`, `lastError`, `failures`, `productCount`, `complete`, `warnings[]`.   |
| `write`     | `{ enabled, envName }`: whether the text write is switched on on this server.                                                            |

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

## `PUT /apps/{appId}/products/{productId}/localizations/{locale}`

Body (strict): `{ apply, name, description, previewHash? }`. `locale` is a tag such as `en-US` (the store's spelling is returned).

### The gate

- **Switch**: `MRM_STORE_PRODUCT_WRITE_ENABLED=true` (default `false`). While off the route answers `409 store_product_write_disabled`
  with `envName`, after the rights check; no store is contacted. Reads and the sync are not affected.
- **Right**: `monetization.write` (owner and admin). An API token needs the action **named** in its list.
- **Step-up**: an apply is the `store.push_draft` action of [step-up](step-up.md): a workspace that covers it asks for the person's
  confirmation (a grant in the `x-step-up-grant` header, bound to the app and the `previewHash`). A preview stays free.

### Preview: `apply: false`

READS the product in the store and writes nothing. A successful read also settles an earlier `outcome_unknown`. Returns `{ preview }`:

| Field                | Meaning                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `app`, `product`     | Which record and product (`productId`, `kind`, `referenceName`).                                     |
| `locale`             | The locale as the store writes it.                                                                   |
| `current`, `proposed`| `{ name, description }` as the store has them, and as asked (line breaks normalized).                |
| `changes`, `unchanged`| Which of the two texts differ; `unchanged` is true when nothing does.                               |
| `previewHash`        | SHA-256 over the app, product, locale, the store's current texts and the proposed texts.            |
| `warnings`, `readAt` | Notes from the store read, and when it was read.                                                     |

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

## Errors

| Status | `error`                         | When                                                                                          |
| ------ | ------------------------------- | --------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`               | Body not valid, or `previewHash` missing on an apply.                                         |
| 403    | `forbidden`, `step_up_required` | No right; or the workspace asks for a confirmation (see step-up).                             |
| 404    | `not_found`                     | Not a member, no such workspace or app.                                                       |
| 404    | `product_not_found`             | The product is not in the snapshot, or the store does not have it.                            |
| 404    | `locale_not_found`              | The store lists no such locale for the product (a locale is never added).                     |
| 409    | `store_product_write_disabled`  | The switch is off. Carries `envName`.                                                         |
| 409    | `state_changed`                 | The store shows other texts than the previewed ones.                                          |
| 409    | `write_in_progress`             | Another text change of this app is running.                                                   |
| 409    | `outcome_unknown`               | The write may or may not have reached the store.                                              |
| 422    | `invalid_locale`, `invalid_text`| The locale or a text breaks the rules above.                                                  |
| 422    | `no_change`                     | The store already shows these texts.                                                          |
| 422    | `products_not_supported`        | The platform has no in-app purchases here.                                                    |
| 422    | `credential_not_found`, `credential_kind`, `credential_unreadable`, `app_not_synced` | The app's credential or store id is not usable. |
| 422    | `store_auth`, `store_forbidden`, `store_not_found`, `invalid_product`, `store_rejected` | The store refused; the message has no secret. |
| 429    | `rate_limited`                  | Sync limit, or the store's own limit (`Retry-After`).                                         |
| 502    | `store_unavailable`, `store_failed` | The store could not be reached or answered with an error.                                 |
| 504    | `timeout`                       | The store did not answer in time (a write is then read back, see above).                      |

## Credentials

The same credentials as the app's sync (App Store Connect API key, Google service account). The stores do not document which role or
permission covers editing in-app product texts; give the key or account the right to manage in-app products and test a preview and an
apply on a product you can afford to change.

## UNVERIFIED: check with a real account

Apple: whether `include` still returns subscription localizations (their own endpoints are deprecated since API 4.4.1); whether the
localization ids from `include` are the ids the v2 `PATCH /v2/inAppPurchaseLocalizations/{id}` takes; the format of `customerPrice`; what
a 404 for a missing price schedule means; the meaning of `preserved` prices; plan types other than `UPFRONT`; whether the texts of an
approved product are editable; length limits; the required key role.

Google Play: whether an app not migrated to the new monetization API shows products under `oneTimeProducts`; that a patch with
`updateMask=listings` and a `listings`-only body is accepted; that the `regionsVersion` from `convertRegionPrices` is accepted for a
subscription patch; the required Play Console permission. Consumable versus non-consumable is guessed from `multiQuantityEnabled`, and
`otherRegionsConfig` prices are not shown.
