# ADR 0034: In-app purchases and subscriptions: read, plus one gated text write

Status: implemented and tested against fakes; **never run against App Store Connect or Google Play** (the fields that are not
verified are listed [below](#unverified-check-with-a-real-account) and in [api/products](../api/products.md#unverified-check-with-a-real-account)).

## Context

A release depends on in-app products: a price or a name that is wrong ships with the build. The app had no view of them, so a
person had to open two consoles. Prices and availability can lose real money and cannot be undone by this tool, so the first
round is deliberately small: read everything, write only the text a person sees.

## Decision

1. **Capability `inAppPurchases`** in `packages/core/src/platform.ts`, one boolean per platform row. Code asks
   `supports(platform, 'inAppPurchases')`, never the platform name. All three platforms (iOS, macOS, Android) support it now.
2. **A normalized model** (`packages/connectors/src/store-products-types.ts`): a product has a kind (`consumable`, `non_consumable` or
   `subscription`), a reference name, a state (the store's own state kept as `rawState` next to a small normalized one),
   localizations, prices per territory in **minor units as strings** (BigInt arithmetic, never a float), availability, plans
   and offers. Both stores map into it; the web app and the server never see a store shape.
3. **Read connectors** for Apple (App Store Connect: `/v1/apps/{id}/inAppPurchasesV2` and the subscription groups of the app, with
   localizations, price schedules and availability) and Google (`androidpublisher/v3` `monetization.subscriptions` and `oneTimeProducts`). Reads
   follow the stores' pagination up to a cap; a read that did not finish is marked `complete: false` with warnings.
4. **The snapshot is stored**, not read live on every page: `store_products`, `store_product_localizations`,
   `store_product_prices` and `store_product_sync` ([migration 45](#migration-45)). `POST .../products/sync` reads the store and
   replaces the snapshot in one transaction. An incomplete read replaces only the products it listed, so a cap never deletes a
   product that was merely not reached. A failed sync keeps the old snapshot and records the failure.
5. **Reads and the sync are not behind a switch.** They change nothing in a store. Listing and detail need `apps.read`, the sync
   needs `apps.sync` and shares the per-workspace app-sync limiter (a slot is taken only after the app is found).
6. **One write: the display name and description of one locale of one existing product**
   (`PUT .../products/{productId}/localizations/{locale}`). It does not edit a price or availability, does not create or delete a
   product, and does not add a locale (a locale the store does not list is `404 locale_not_found`). Gated exactly like the other
   reversible store writes ([ADR 0008](0008-store-rollout-writes.md), [0009](0009-staged-store-drafts.md),
   [0031](0031-create-app-store-version.md)):
   - **Switch** `KILN_STORE_PRODUCT_WRITE_ENABLED` (default `false`). Off: `409 store_product_write_disabled` with `envName`, after the
     rights check and before anything else. Reads and the sync do not depend on it.
   - **Right** `monetization.write`: owner and admin. For an API token it is **explicit-only**: a token acts on it only when its
     action list names it (the same class as `releases.rollout`).
   - **Step-up** reuses the action `store.push_draft` of [step-up](0019-step-up-confirmation.md), checked first in the apply path,
     with the `previewHash` as the bound hash. No new action name was added: the write is the same kind of act (a reversible text
     edit in a store) and a workspace that asked for confirmation of draft pushes should be asked here too. Splitting it later is
     one entry in the step-up table.
   - **Preview, then apply with a hash.** A preview (`apply: false`) reads the store and returns the current and proposed texts, which
     of them change, and a SHA-256 `previewHash` over the app, the product, the locale, the store's current texts and the proposed
     texts. An apply (`apply: true`) needs that hash; the connector's `guard` re-reads the store immediately before the write, and any
     difference is `409 state_changed` with the current texts and a new `previewHash`. Nothing is written in that case.
   - **One write in flight per app**, in `store_product_claims` (primary key `app_id`, status `writing` or `unknown`, a TTL longer than
     the write timeout). A second write gets `409 write_in_progress`.
   - **Never retried.** After a timeout or a 5xx the texts are read back: the asked texts show (`200`, `confirmedByReread: true`), or
     the old ones show or the read failed (`409 outcome_unknown`, the claim is kept as `unknown`), or other texts show
     (`409 state_changed`). Old texts are never taken as proof that the write failed, because a store can be slow to show a change.
     A successful preview read clears an `unknown` claim: the person sees where the store stands and decides again.
   - **Unchanged texts are refused** (`422 no_change`): an apply of what the store already shows is not a write.
   - **Audit rows hold ids and hashes, never the texts**: `monetization.localization_changed` and
     `monetization.localization_failed` (`outcome` `refused`, `failed`, `unknown` or `diverged`). The sync writes
     `monetization.synced` with counts only. No event is added.
   - **Text rules** are checked before any store call: the name is 1 to 200 characters on one line, the description at most 2000,
     control characters are refused, line breaks are normalized to `\n`. The stores' own limits differ and are not verified; a
     store refusal is surfaced as `422 invalid_product` or `422 store_rejected`.
7. **Secrets**: the credential is decrypted only inside the connector call, with purposes `products.sync` and `monetization.write`,
   and every error and message is passed through the redaction of the store errors. No key appears in a log, response or audit row.
8. **No platform branch in the server.** The module picks the connector through `connectorFactory` by credential kind; the macOS
   record reuses the App Store connector and the reviews-style sharing of the macOS record, as the other App Store features do.

## Migration 45

`packages/db/src/migrations-monetization.ts` (spliced into `migrations.ts`; ids stay contiguous): five tables, all keyed by
`app_id` and removed by `deleteApp`:

| Table                        | Primary key                                  | Holds                                                  |
| ---------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| `store_products`             | `app_id, product_id`                         | kind, reference name, state, group, period, base territory |
| `store_product_localizations` | `app_id, product_id, locale`                | name and description per locale                        |
| `store_product_prices`       | `app_id, product_id, plan_id (''), territory` | currency, minor-unit amount string, display price      |
| `store_product_sync`         | `app_id`                                     | last attempt and success, failures, count, `complete`, warnings |
| `store_product_claims`       | `app_id`                                     | the write in flight (`writing` or `unknown`)           |

Times are epoch milliseconds (`BIGINT` in Postgres, `INTEGER` in SQLite), JSON is text. The drizzle schemas for both dialects are
extended and the schema-drift test covers them.

## Not built, on purpose

- **Price changes** are the next step and need their own design, not a wider text write. Money on a live product is a different
  risk: a wrong price is charged to real customers at once and cannot be called back. The design to follow:
  - a **separate switch** (`KILN_STORE_PRICE_WRITE_ENABLED`, off by default) and a **separate right** (explicit-only for tokens),
    so turning on text edits never turns on price edits;
  - **step-up on every apply**, with a **typed phrase** (as for a release) and no way to skip it for a token;
  - a **preview of revenue impact**: for each territory the old and new price, the change in percent, and an estimate from the
    sales the analytics module already holds (units over the last 30 days times the difference), with an explicit "estimate"
    label and a refusal above a configurable relative change without a second confirmation;
  - the hash covers the full price set as read, and the store is re-read right before the write (the same `guard` pattern);
  - store specifics settled first: Apple price points and schedules are per base territory with equalization, Google needs
    `regionsVersion` and `otherRegionsConfig`; both must be exercised against a test account.
- **Availability changes**, **creating or deleting products** and **adding a locale**: not offered, and the connectors have no call
  that could.
- **A periodic sync and the alert `monetization.sync_failing`**: the sync is started by a person. An alert needs a scheduler for
  it, which was more than the small addition the alert was meant to be, so it is skipped. `docs/alerts.md` is unchanged.
- **Events and MCP tools**: only audit rows exist. The MCP tool list is an explicit list in the repo and no tool was added. The four
  routes are in the operations registry, so tokens and the OpenAPI document cover them.

## Consequences

- The web "Products" section of an app (`apps/web/src/lib/components/products/`) shows the table, the sync status and warnings,
  and a per-locale text editor that previews, then applies with the step-up prompt when the workspace asks for it.
- The snapshot can be stale: it shows when it was last read, and after an apply the text is re-read by the apply itself, but the
  rest of the snapshot is only refreshed by a sync.
- A store credential for sync and for the write needs the store's own rights, and the stores do not document which role covers
  in-app product edits.

## Unverified: check with a real account

Everything below follows the stores' public documentation as far as it goes and is only tested against fakes.

- **Apple**
  - whether `include` on `GET /v2/inAppPurchases/{id}` still returns the localizations on the current API version (the
    subscription localization endpoints are deprecated since API 4.4.1, which is why they are read through `include`);
  - whether the localization ids that `include` returns are the ids `PATCH /v2/inAppPurchaseLocalizations/{id}` takes;
  - the format of `customerPrice` in price points, the meaning of a 404 for a product without a price schedule, and the meaning of
    `preserved` price points;
  - subscription plan type values other than `UPFRONT`;
  - whether the texts of an approved product can be edited, the length limits, and which API key role is needed.
- **Google Play**
  - whether an app that is not migrated to the new monetization API shows its products in `oneTimeProducts`;
  - that a body with `listings` only is accepted with `updateMask=listings`;
  - that the `regionsVersion` that `convertRegionPrices` returns is accepted by a subscription patch;
  - which Play Console permission the service account needs;
  - consumable versus non-consumable is **guessed** from `multiQuantityEnabled`; prices in `otherRegionsConfig` are omitted.
