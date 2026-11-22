# Spike: RevenueCat next to the store products

**Question:** how should RevenueCat appear on the Products page ([ADR 0034](../adr/0034-in-app-products.md))?

**Status:** v1 built, see [ADR 0039](../adr/0039-revenuecat.md) and [api/revenuecat](../api/revenuecat.md) (the overview and metrics strip of
sections 1 and 5 is v2 and not built; no store price writes, section 6). The spike below is the proposal as approved, written from RevenueCat's REST API v2 docs read on 2026-11-21 (pages under
https://www.revenuecat.com/docs/api-v2/ and the guides cited below). Everything not on a page I read is marked **UNVERIFIED** and
collected in section 8. Like ADR 0034, nothing here has run against a real RevenueCat project.

## Recommendation

Add RevenueCat as a **read-only second source** on the existing Products tab: a new credential kind `revenuecat`, a per-app link
to a RevenueCat project and app (same shape as the Expo link, [ADR 0033](../adr/0033-eas-integration.md)), a cached copy of the
project configuration (products, entitlements, offerings, packages), and a join to `store_products` by store product id. v1 is badges,
a detail section and mismatch warnings. Revenue numbers (v2) are project-wide and come after the join is proven. No writes.

## 0. What the docs confirm (API v2)

Base `https://api.revenuecat.com/v2`, `Authorization: Bearer <secret key>`; v1 keys do not work. All lists take `limit` (default 20) and
`starting_after`, answer `{ object: "list", items, next_page?, url }` and forward-paginate only. Errors carry `type`, `param`, `message`,
`retryable`, `doc_url`; types include `authentication_error`, `authorization_error`, `rate_limit_error`, `resource_missing`.
Rate limits are per domain and per key (per developer for developer-level keys): Project Configuration 60/min, Customer Information
480/min, Charts & Metrics 25/min. Successful answers carry `RevenueCat-Rate-Limit-Current-Usage` and `-Current-Limit`; a 429 carries
`Retry-After` (seconds) and a body `backoff_ms`.

| Need                                           | Endpoint (all under `/projects/{project_id}`)                                                                    | Permission                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Projects the key sees                          | `GET /projects` (no prefix)                                                                                      | `project_configuration:projects:read`                               |
| Apps (store type, bundle id or package name)   | `GET /apps`                                                                                                      | `project_configuration:apps:read`                                   |
| Products                                       | `GET /products` (`expand=app`, `indicative_price`)                                                               | `project_configuration:products:read`                               |
| Entitlements, with products                    | `GET /entitlements` (`expand=items.product`), `GET /entitlements/{id}/products`                                  | `...:entitlements:read` (+ `products:read` to expand)               |
| Offerings, with packages and products          | `GET /offerings` (`expand=items.package`, `items.package.product`)                                               | `...:offerings:read` (+ `packages:read`, `products:read` to expand) |
| Packages of an offering, products of a package | `GET /offerings/{id}/packages`, `GET /packages/{id}/products`                                                    | `...:packages:read`                                                 |
| Overview metrics                               | `GET /metrics/overview` (`currency`)                                                                             | `charts_metrics:overview:read`                                      |
| Revenue for a range                            | `GET /metrics/revenue` (`start_date`, `end_date`, `currency`, `revenue_type`)                                    | `charts_metrics:overview:read`                                      |
| Time series                                    | `GET /charts/{name}` (`filters`, `selectors`, `segment`, `resolution`, `currency`), `GET /charts/{name}/options` | `charts_metrics:charts:read`                                        |
| One subscriber                                 | `GET /customers/{id}`, `GET /subscriptions?store_subscription_identifier=`                                       | `customer_information:*:read`                                       |

Objects, as documented:

- **Product:** `id`, `store_identifier`, `type` (`subscription`, `one_time`, `consumable`, `non_consumable`,
  `non_renewing_subscription`), `state` (`active`, or `inactive` = archived), `app_id`, `display_name` (nullable),
  `subscription { duration, grace_period_duration, trial_duration }` (ISO 8601, nullable), `one_time { is_consumable }`,
  `indicative_price { currency, country, amount_micros }` (only when requested), `created_at`.
- **App:** `id`, `name`, `type` (`app_store`, `mac_app_store`, `play_store`, `stripe`, `rc_billing`, `amazon`, `roku`, `paddle`,
  and in responses `test_store`, `external`, `galaxy`), and a nested object by type: `app_store.bundle_id`,
  `mac_app_store.bundle_id`, `play_store.package_name`. Store credentials are returned only as booleans (`..._configured`).
- **Entitlement:** `id`, `lookup_key`, `display_name`, `state`, `products`. **Offering:** `id`, `lookup_key`, `display_name`, `is_current`,
  `state` ("inactive offerings are not returned by the SDK"), `metadata`, `packages`. **Package:** `id`, `lookup_key`, `position`,
  `products.items[] { product, eligibility_criteria: all | google_sdk_lt_6 | google_sdk_ge_6 }`.
- **Subscription:** `status` (`trialing`, `active`, `expired`, `in_grace_period`, `in_billing_retry`, `paused`, `unknown`,
  `incomplete`; the docs say more may come), `gives_access`, `product_id` (the RevenueCat product id), `store`.
- **Overview card definitions** (dashboard docs): Active Trials and Active Subscriptions are current counts, MRR is current,
  Revenue (gross, before store fees and taxes), New Customers and Active Customers are 28-day windows. The API returns metrics as
  `{ id, name, description, unit, period (P0D | P28D), value, last_updated_at }` plus one top-level `currency`.

**Not found in the docs I read:** a per-product subscriber count (the customer and subscription pages list none; subscription
search takes only `store_subscription_identifier`), and the metric ids of the overview beyond the sample `active_trials`.

## 1. What is useful next to a store product

Ordered by value for a release manager, who cares whether a product they are about to ship is wired up:

1. **Is it in RevenueCat, and active?** Product `state`, `type`, trial and grace durations. Cheap, config only.
2. **Entitlements it grants.** From `GET /entitlements?expand=items.product`, inverted to product -> entitlement names.
3. **Offerings and packages it sits in**, including whether the offering is current and the package `eligibility_criteria`
   (a Play product sold only to `google_sdk_ge_6` is a real finding).
4. **Mismatches** between the store snapshot and RevenueCat (section 5).
5. **Project metrics strip** (v2): active subscriptions, active trials, MRR, 28-day revenue, with `last_updated_at`. These are
   project-wide, not per product or per app: label them so (see section 4 on per-product numbers).
6. **Per-product active subscribers / revenue** (v3, optional): only through `charts` with a `segment` by product, which is
   UNVERIFIED (the segment names come from `/charts/{name}/options`). Do not scan customers: 480/min, personal data, no count.
7. **Trial conversion:** chart names `trial_conversion_rate` and `trial_conversion` exist; whether they segment by product is UNVERIFIED.

Not worth it: customer lists, subscriber lookups, paywalls, experiments, virtual currencies, `indicative_price` as a price source of
truth (country and rounding unclear; use it only as a hint in a mismatch warning).

## 2. The credential

- **Kind `revenuecat`**, one field `apiKey` (`secret: true`), stored as one string like `github_token` and `expo`
  (`packages/core/src/credentials.ts`, `checkSecret` rejects whitespace; a warning, not an error, when it does not start `sk_`: the prefix is from
  RevenueCat's authentication page, which says secret keys are `sk_` and project-wide).
  Verifier name `verifyRevenueCatCredential` added to `verifierNames` in `services/credential-tests.ts`.
- **Key type:** a **V2 secret API key** (the dashboard asks for version `V2` and "set your permissions"). Secret keys are
  project-wide and are created and revoked by project Admins. So **one credential per RevenueCat project**.
- **Least privilege for v1, read only:** `project_configuration`: projects, apps, products, entitlements, offerings, packages, all
  `read`. For v2 add `charts_metrics:overview:read` (and `charts_metrics:charts:read` for v3). **No `customer_information`**, no
  `read_write` anywhere: a leaked key then cannot grant entitlements, refund or delete (those are `read_write` operations in the
  docs). UNVERIFIED: how the dashboard presents these scopes (the docs name the permission strings per endpoint but I found no
  page that lists the dashboard's checkboxes), and whether read-only per resource can be chosen or only per domain. If only
  per domain, the guide must say the key will be broader than needed.
- **Test connection:** `GET /projects?limit=20`. Success names the project(s) and how many apps each has: `details`
  `Project: <name>`. Then, per project the key can see, nothing more (the link step reads apps). A key without
  `projects:read` gets an authorization error: the message says which permission to add. Map errors to the connector vocabulary
  (`auth`, `forbidden`, `rate_limited`, `server`, `network`) with fixed sentences, never RevenueCat's text, as `ExpoError` does.
  UNVERIFIED: the HTTP statuses used for `authentication_error` and `authorization_error` (assume 401 and 403).
- **Guide text** (`credential-guides.ts`, `docs/credentials.md`): steps: (1) open the RevenueCat dashboard, pick the project;
  (2) API keys, then **+ New secret API key**; (3) choose version V2, name it "Kiln", enable only the read
  permissions listed above, nothing with write; (4) copy the key, it starts `sk_`; (5) paste and Test connection.
  Warnings: do not use the public SDK key (it is not a credential for this API); the key is project-wide so keep it out of the
  app; rotate when someone who knew it leaves (RevenueCat: a revoked key is invalid immediately). Troubleshooting rows: "not
  authorized" (a permission missing), "V1 key" (v1 keys do not work with v2), "429" (wait; limits are per key).
- **Never call** `GET /apps/{id}/public_api_keys` (returns real SDK keys), or the StoreKit config endpoint.
- Rights: `credentials.write` to save and test, as for every credential. Use is audited as `credential.use` with purposes
  `revenuecat.link` and `revenuecat.sync`.

## 3. Mapping RevenueCat products to `StoreProduct` rows

Key: `(store, store product id)` within one linked RevenueCat **app** (so `products` are filtered client-side by `app_id`; the
list endpoint's own filters are not documented, UNVERIFIED).

| Store                       | RevenueCat `store_identifier`                                                                                                                                                                          | Our `StoreProduct`                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Apple IAP and subscriptions | the App Store product id "exactly as it appears in the store" (guide)                                                                                                                                  | `productId`                       |
| Play one-time               | the product id (SKU, per the create-request text)                                                                                                                                                      | `productId`                       |
| Play subscription           | `<subscription_id>:<base_plan_id>` for products set up after Feb 2023, bare `<subscription_id>` before; migrated May 2022 subscriptions may carry a duration id such as `P1Y` (Android products guide) | `productId` + one of `plans[].id` |

So the join is **one StoreProduct to zero or more RevenueCat products**: Play subscriptions have one RevenueCat product per base
plan. Matching rule: exact match on `productId`; else split on the first `:` and match `productId` and a base plan id from
`plans`; an unprefixed legacy id matches the subscription product (all its plans). The `P1Y` style cannot be matched by id and is shown as "RevenueCat product
with an unmatched id".

Edge cases to design for:

- **Linking the app:** `GET /apps` lists RevenueCat apps with `bundle_id` or `package_name`; offer the one equal to `apps.identifier`
  (for the iOS record `app_store`, for Android `play_store`, for macOS `mac_app_store`), one click like Expo's detect. A project with
  Stripe, Web Billing or Test Store apps: ignore those apps and say so (their ids are not store ids).
- **macOS and universal purchase:** whether a macOS record maps to `mac_app_store` (documented as legacy) or to the same `app_store`
  app is UNVERIFIED.
- **Archived** RevenueCat products (`state: inactive`) are kept and shown "archived in RevenueCat", not dropped.
- **Auto-created products:** the docs say a purchase of a product RevenueCat does not know creates it automatically. So a
  RevenueCat product can exist for a store product that was never configured: it shows as in RevenueCat but in no entitlement or offering.
- **Case and whitespace:** match exactly; a case-only difference is its own warning (Apple ids are case sensitive as written).
- **Incomplete store snapshot** (`complete: false`, ADR 0034): never raise "not found in the store" then.
- **Multiple projects or two credentials for one app:** the link holds one project and one RevenueCat app per app record.
- **Test Store / sandbox:** `test_store` apps and `environment` are not in the join; no sandbox data is read.
- **Unknown enums:** a new `type`, `store` or `status` value is kept as raw text with a neutral badge (the ADR 0034 `rawState` idea).

## 4. Data model, refresh, rate limits

**Cache, not live reads** (same reason as ADR 0034: a Products page that depends on a third-party API being up and under 60/min is
worse). New migration (next free id), both schema files, `deleteApp` clears them. Sketch only:

| Table                             | Key                                  | Holds                                                                                                                 |
| --------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `app_revenuecat_links`            | `app_id`                             | credential id, project id and name, RevenueCat app id, name, type, linked at (like `app_expo_links`, no foreign keys) |
| `revenuecat_products`             | `app_id, rc_product_id`              | `store_identifier`, type, state, display name, durations, `indicative_price` (optional), hash                         |
| `revenuecat_entitlements`         | `app_id, rc_entitlement_id`          | lookup key, display name, state                                                                                       |
| `revenuecat_entitlement_products` | `app_id, entitlement, product`       | the attachment                                                                                                        |
| `revenuecat_offering_packages`    | `app_id, offering, package, product` | offering lookup key, `is_current`, state, package lookup key, `eligibility_criteria`                                  |
| `revenuecat_sync`                 | `app_id`                             | last attempt and success, failures, `complete`, warnings (same shape as `store_product_sync`)                         |
| `revenuecat_overview` (v2)        | `app_id`                             | metrics JSON, currency, `last_updated_at`, fetched at                                                                 |

Entitlements, offerings and packages belong to the RevenueCat **project**, not the app: they are stored per linked app record,
filtered to the products of that app. (Two records of one project each hold a copy; storage is small.)

**Refresh:**

- v1 sync is **a second step of the existing "Sync products" button** (`POST .../products/sync`) when a link exists: store first,
  then RevenueCat, each reporting its own result. A RevenueCat failure never fails or rolls back the store snapshot. A separate
  `POST .../revenuecat/sync` also exists so a person can retry only that half. Rights `apps.sync`, the same per-workspace limiter.
- Calls per sync with expands: products (pages of 20 unless `limit` allows more, max UNVERIFIED), entitlements with
  `items.product`, offerings with `items.package.product`, apps once. Typically 4 to 8 calls, far under 60/min. Whether the
  expanded nested lists are complete or carry their own `next_page` (a Package object has `products.next_page`) is UNVERIFIED;
  if a nested `next_page` is set, fall back to `GET /entitlements/{id}/products` and `GET /packages/{id}/products` for that
  object, and mark the sync incomplete if a cap is hit.
- Honour `Retry-After` / `backoff_ms`: do not retry in-process; answer `rate_limited` like the stores (ADR 0034 treats a store
  rate limit as "wait", not as a failed sync). Cap pages per resource (say 20) and use the response rate headers only for display.
- v2 overview: one `GET /metrics/overview` per linked **project** (not per app) per sync, 25/min domain budget. Dedupe by
  `(credential, project)` when several app records link to one project. Show `last_updated_at`; never recompute or sum
  across currencies.
- No scheduler in v1 (ADR 0034 has none for products). If one is added later, copy `queueEasStatusSyncs`
  (`modules/eas/status-sync.ts`): only linked apps are queued.
- **Webhooks: not in any phase.** RevenueCat posts to a public URL with an optional authorization header, at-least-once, 5 retries
  over roughly 80 minutes, and events are customer events (`INITIAL_PURCHASE`, `PRODUCT_CHANGE`, ...), not configuration changes
  (the docs list no event for product or offering edits). A self-hosted or desktop install usually has no public URL. They would
  only give "last purchase seen", which is not the question.

## 5. Where it fits in the Products page

Existing: `apps/web/src/components/products/ProductsTab.svelte` (table: Product, Type, Status, Price, Languages, Actions) and
`ProductDetail.svelte` (badges, texts, prices). Additions, all hidden when the app has no RevenueCat link (a workspace without it
sees nothing new, as with Expo):

- **Link card** in app Settings next to the Expo card: pick credential, project, RevenueCat app (prefilled by bundle id / package
  name), "Test and save", unlink. Rights `apps.read` to see, `apps.write` to change (as `app_expo_links`).
- **Column "RevenueCat"** in the table: one `Badge`: `In RevenueCat` (good), `Not in RevenueCat` (warn), `Archived` (neutral),
  `Id not matched` (warn), or empty when the app is unlinked or the RevenueCat sync never ran. Under it, entitlement names
  (first two, "and 3 more").
- **Detail drawer section "RevenueCat"** (below Prices): RevenueCat product id(s) and state, type and trial / grace durations;
  entitlements list; offerings and packages as "Offering `default` (current), package `$rc_monthly`, sold to all SDKs"; for Play
  subscriptions one row per base plan with its match; a "Last read" line with the sync status; a hint where RevenueCat's
  `indicative_price` differs from the store price (v2, labelled hint).
- **Overview strip (v2)** above the table: four tiles (Active subscriptions, Active trials, MRR, Revenue last 28 days), the
  currency, "as of <last_updated_at>", and the words "all apps in this RevenueCat project". Role: see open questions.
- **Two extra lists** below the table, in a `Disclosure`: "In RevenueCat, not in the store" (RevenueCat products with no store row)
  and "Entitlements without an active product".

**Warnings** (computed on read from the two snapshots, not stored; each has a code, severity and a one-line fix):

| Code                                     | When                                                                                             | Severity                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------- |
| `store_product_not_in_revenuecat`        | store state `active` or `in_review`, no matching RevenueCat product                              | warn (not for `draft`, `removed`) |
| `revenuecat_product_not_in_store`        | RevenueCat product `active`, no `StoreProduct` match, store snapshot `complete`                  | warn                              |
| `product_not_sellable`                   | in RevenueCat, in no package of an active offering                                               | info                              |
| `entitlement_without_active_product`     | active entitlement with no attached product that is active in RevenueCat and active in the store | warn                              |
| `store_removed_but_active_in_revenuecat` | store state `removed` or `inactive`, RevenueCat product `active` and in an active offering       | bad                               |
| `play_base_plan_not_in_revenuecat`       | a store base plan with state `ACTIVE`, product mapped, that plan missing                         | info                              |
| `price_differs_hint` (v2)                | RevenueCat `indicative_price` and store price differ for the same country                        | info, labelled hint               |
| `revenuecat_read_incomplete`             | a cap or rate limit ended the read                                                               | info                              |

Status mismatches only compare what both sides expose: the API shows RevenueCat product `state` (active or archived), not the
store validation status RevenueCat's dashboard shows (UNVERIFIED that no API field exists for it: none is in the Product object).

## 6. Writes

**None in v1, and none planned.** The API has them (attach products to entitlements, create a RevenueCat product, `create_in_store`
that pushes a product to the stores, grant or revoke entitlements, refund, cancel), all `read_write` permissions. The tool should
refuse to hold such a key by never asking for those scopes, and the guide says so. Admin work belongs in RevenueCat's dashboard.
Money-moving or access-granting calls (refund, grant, cancel, `create_in_store`) are out of scope permanently. If the owner
later wants "create the RevenueCat product for a store product" or "attach to an entitlement", gate exactly as ADR 0034's text
write: a new switch `KILN_REVENUECAT_WRITE_ENABLED` (default off), a new right (`revenuecat.write`, owner and admin, explicit-only for
tokens), step-up, preview then apply with a SHA-256 hash and a re-read guard, one write in flight per app, never retried, audit
rows with ids and hashes only. It also needs a second credential (or a second key) because v1's key has no write scope.

## 7. Phases (rough sizes; one agent plus review, counting tests and docs)

| Phase         | Scope                                                                                                                                                                                                                                                                                                                                                                    | Size                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| v1            | Credential kind, guide, verifier; `packages/connectors/src/revenuecat/` client (typed errors, redaction, no redirects, size cap, no retry) and read of products, apps, entitlements, offerings; link table, routes, sync step, warnings; web link card, column, detail section, lists; ADR, `docs/api/revenuecat.md`, `docs/credentials.md`; operations registry entries | M to L: about 25 files, 1800 to 2500 lines with tests, one migration |
| v2            | `metrics/overview` read and table, overview strip, price hint, refresh dedupe by project, viewer-role decision, optional alert `revenuecat.mismatch`                                                                                                                                                                                                                     | S to M: about 8 files                                                |
| v3 (optional) | Per-product subscribers or trial conversion through `charts` segments (needs a real project to learn segment names), scheduler, webhook "last purchase" (probably never), one gated write                                                                                                                                                                                | M each, and only after v1 has run on a real account                  |

Verify on a real project before v2: the overview metric ids, the max `limit`, expanded-list pagination, and the key-scope UI.

## 8. Risks, UNVERIFIED list, open questions

**Risks.** The join is by string; Play base plan ids and legacy ids are the weakest part and a wrong match produces a false warning
(mitigation: warnings only for clear cases, an "id not matched" badge rather than "missing"). RevenueCat's API is a v2 that is
still growing (staff said the overview endpoint is an initial version and will become more granular), so unknown fields and enums
must degrade. A project-wide secret key is high value even when read-only (it reveals revenue): encrypt as every credential,
redact, audit use. 60/min Project Configuration limit is shared by anything else using the same key (CI, dashboards): rate
limit errors must be a calm "wait". Revenue visibility may be sensitive inside a workspace.

**UNVERIFIED (check with a real account or the OpenAPI file at https://www.revenuecat.com/docs/api-v2-beta):**

1. Overview metric ids and units (only `active_trials` appears in the docs I read) and whether `currency` supports all ISO codes.
2. The dashboard's permission options for a V2 key: per domain or per resource, and exact wording; HTTP statuses of the two auth errors.
3. Maximum `limit` on list endpoints, whether lists filter by `app_id`, whether `expand` nested lists paginate fully.
4. How a Play subscription appears in the product list for each age of product (`id:plan`, bare id, `P1Y`), and what the SDK-side
   webhook `product_id` carries (the webhook page says only "product identifier of the subscription").
5. macOS and universal-purchase app mapping (`mac_app_store` is documented as legacy).
6. Whether any API field exposes RevenueCat's store validation status of a product.
7. Per-product chart segments (`actives`, `mrr`, `trial_conversion_rate` with `segment`) and whether they match store product ids.
8. What `indicative_price` `country` is when several prices exist.
9. Whether developer-level keys exist for this use and their exact rate-limit accounting (the page says per developer).
10. Behaviour on archived apps and on a deleted RevenueCat project (404 vs empty list).

**Open questions for the owner.**

1. Is RevenueCat common enough among the target users to build before price writes (ADR 0034 "Not built")? v1 is not small.
2. Credential per RevenueCat project is forced by project-wide keys. Acceptable, or should one workspace credential list several
   projects (not possible with one key)?
3. Who may see revenue numbers: everyone with `apps.read`, or only owner and admin (a new read right)? Default proposed: hide the strip for `viewer`.
4. Should the overview strip be hidden for projects that span several apps, since it cannot be split per app?
5. Is a 28-day-only gross revenue (before store fees) the right headline, or MRR only?
6. Do you want an alert `revenuecat.mismatch` in v2, or warnings on the page only?
7. Any appetite for writes at all (section 6)? If not, the guide can tell people never to grant write scopes.
8. May v1 stay Apple and Google only (ignoring Stripe, Web Billing, Amazon, Roku, Paddle apps), as proposed?
