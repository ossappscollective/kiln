# ADR 0039: RevenueCat next to the store products

Status: built (v1), tested with fixtures and an injected `fetch` only. Nothing has run against a real RevenueCat project; what the code
assumes beyond RevenueCat's published pages is listed under "UNVERIFIED". The proposal and its reading of the API are in
[spikes/revenuecat-integration.md](../spikes/revenuecat-integration.md); this ADR records what v1 does.

## Context

Many apps sell through RevenueCat. The Products page ([ADR 0034](0034-in-app-products.md)) shows what the store says about a product;
RevenueCat holds the other half: which products the app really sells, the entitlements they unlock, and the offerings and packages
that put them in front of customers. Most "the paywall shows nothing" problems are a mismatch between the two. The owner decided:
RevenueCat comes before store price writes (nothing is written anywhere), v1 covers Apple (iOS and macOS) and Google Play only, and the
revenue and metrics strip is **v2, not built**.

## Decision

1. **A credential kind `revenuecat`.** The secret is a V2 secret API key (`sk_...`), stored as one string, encrypted and bound to its
   workspace like every credential. The guide says to create a key with **read permissions on the project configuration only** (never
   write; customer information and charts off). The connection test asks which projects the key sees and how many apps each has
   (`GET /v2/projects`, `GET /v2/projects/{id}/apps`). The key is never returned, logged or put in an error; every use is a
   `credential.use` audit row with its purpose (`revenuecat.detect`, `.link`, `.sync`).
2. **A connector `packages/connectors/src/revenuecat/`**, modelled on Expo's: fixed sentence per error kind (RevenueCat's own text is
   never copied), key redaction, no redirects, 2 MB answer cap, time limit, no retries, `Retry-After` / `backoff_ms` read into a calm
   "wait". The client counts its requests (45 per read, under the 60 a minute of the Project Configuration limit) and keeps a reserve so
   a long product list cannot starve the entitlement and offering reads. A read that hits a cap is `complete: false` with a sentence.
3. **A link per app record** (migration 48, table `app_revenuecat_links`): the credential, the project and the RevenueCat app, with the
   names, app type and bundle id or package name RevenueCat reported (what RevenueCat said, not what was typed). Routes in
   [api/revenuecat](../api/revenuecat.md): rights reuse `apps.read` (read), `apps.write` (link, unlink, detect) and `apps.sync` (read
   RevenueCat); no new action. `PUT` asks RevenueCat before saving. Audited `revenuecat.link_set`, `.link_remove`, `.synced`.
4. **A stored copy** (`revenuecat_products`, `revenuecat_entitlements`, `revenuecat_offerings`, `revenuecat_sync`, same migration):
   products of the linked RevenueCat app only, entitlements and offerings of the project with the packages that hold those products.
   Replaced in one transaction by a good read; a failed read keeps the old copy and records a fixed sentence and a failure count.
   `deleteApp` removes the link and the copy. Deleting a credential leaves the link, which then says `credentialAvailable: false`.
5. **A second step of "Sync products".** `POST .../products/sync` reads the store as before, then, when the app is linked, RevenueCat. The
   steps are independent: a RevenueCat failure never touches the store snapshot, and a store failure does not stop the RevenueCat step.
   The response carries `revenuecat: null | { ok: true, ... } | { ok: false, code, message }` (also in the body of a store failure), and
   the page shows both results side by side. `POST .../revenuecat/sync` runs only the second step, for a retry.
6. **A join, computed on every read, never stored** (`join.ts`, pure). By the store product id, exactly:
   - Apple, and Google Play one-time products: RevenueCat's `store_identifier` equals the product id.
   - Google Play subscriptions: `subscription_id:base_plan_id`; one store product then has several RevenueCat products. A bare
     `subscription_id` (older setup) is one product for the whole subscription. Both forms are from RevenueCat's Android products
     guide and are **UNVERIFIED** on a real project.
   - A case-only difference is never a match; it is its own warning (`revenuecat_product_case_differs`).
   - Warnings, each with one sentence of fix: store product not in RevenueCat; RevenueCat product not in the store; RevenueCat product
     in no package of an active offering, so the app cannot sell it (`product_not_sellable`, info); entitlement without an active product;
     store product removed but still offered by RevenueCat; Play base plan not in RevenueCat; read incomplete. "Not found" is never
     claimed from an incomplete read of either side, and nothing is claimed before the first RevenueCat read.
7. **macOS through platform capabilities.** `packages/core/src/platform.ts` gains the capability `revenueCat` and, per platform, the
   RevenueCat app types it may use: iOS `app_store`; macOS `mac_app_store` (a legacy Mac app) or `app_store` (the shared app of a
   universal purchase); Android `play_store`. Nothing checks a platform name. The bundle id is compared per the platform's
   `bundleIdentifier` capability (case-insensitive for Apple, exact for Android); a different identifier is shown, not refused,
   because a universal purchase may differ.
8. **Other RevenueCat stores are ignored, never an error.** Amazon, Stripe, Paddle, Web Billing, Roku (any other type) are listed
   with the note "Not mapped" and cannot be linked; their products are not read.
9. **The web.** In the existing Products table: a RevenueCat column (badge: In RevenueCat, Archived there, Id differs, Not in
   RevenueCat, Not read yet; the first two entitlement names), a RevenueCat section in the product detail (inside the same table row,
   plain text), a collapsed warnings list, a sync line, and a hint that says how to connect when the app is not linked. In the app
   Settings, a "RevenueCat project" card next to the Expo card. The page reads the joined view from `GET .../revenuecat/products` and
   merges by store product id, so the products list API is unchanged.
10. **Configuration facts only.** No money amount and no customer data is read, stored or shown. The key's permissions are asked to
    exclude them; the code never calls a customer, metrics or charts endpoint. The overview strip was built later ([ADR 0043](0043-revenuecat-metrics.md)); the configuration copy stays free of money.

## Not built

- The revenue and metrics strip: built in [ADR 0043](0043-revenuecat-metrics.md) (with the owner decision that viewers can see revenue and a read tool for MCP).
- Any write to RevenueCat or a store from this feature.
- Webhooks from RevenueCat, customer lookups, experiments, paywalls.

## UNVERIFIED (nothing ran against a real RevenueCat project)

1. How a Google Play subscription appears in the product list for each age of product (`id:plan`, bare id); the join assumes the two
   forms above.
2. How the dashboard groups the permissions of a V2 key (per domain or per resource); the guide says to choose read only either way.
3. The statuses RevenueCat pairs with each error type (`authentication_error`, `authorization_error`, `rate_limit_error`,
   `resource_missing`); the client trusts the type and falls back to 401, 403, 404, 429.
4. Whether list endpoints accept `app_id` (the filter is done here instead), the maximum `limit` (100 is used), and whether `expand`
   returns nested lists in full (a nested list that looks cut is read from its own endpoint).
5. The shape of the product inside entitlement and package items (an object, `{ product }` or an id): all three are read.
6. macOS: `mac_app_store` is documented by RevenueCat as legacy, and how a universal purchase appears (one `app_store` app) is inferred.
7. Behaviour on an archived app and on a deleted project (404 or an empty list).
8. Whether any field says that RevenueCat has validated a store product; none is shown.
9. The exact rate-limit accounting of a key shared with other tools (the guide says 60 a minute for the project configuration).

## Consequences

- One more credential per RevenueCat project (a V2 key is project-wide). A workspace with several projects adds several credentials.
- A key shared with CI or dashboards shares its 60 reads a minute; a rate-limit answer is a calm "wait", the old copy stays.
- The join is by string; a wrong match could raise a false warning. Warnings are raised only for clear cases and an id that differs
  only by case is "Id differs", never "missing".
