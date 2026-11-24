# ADR 0062: Price changes of in-app purchases and subscriptions, staged through the cart

Status: core, connectors, server and web implemented and tested against **fakes**; **not viewed in a browser, no real store call was made**.
Every store API detail that was not confirmed in the stores' documentation is listed in [UNVERIFIED](#unverified-check-with-a-real-account).
Migration 66. API: [api/products](../api/products.md), [api/pending](../api/pending.md). Operator and security summary: [price-writes](../price-writes.md).
Builds on [ADR 0034](0034-in-app-products.md) (products, the text write), [ADR 0054](0054-pending-cart.md) (the cart) and the step-up of [ADR 0019](0019-step-up-confirmation.md).

## Context

A price is the one thing in this app that changes what customers pay. A wrong price is not a draft that someone reviews in a store console: it
is revenue, refunds and sometimes a legal problem (a wrong currency, a wrong country, a subscription that rises for people who never agreed).
It is also easy to get wrong by habit: a spreadsheet of 170 regions, a price that was right last month, a button pressed twice.
So it is the most conservative write path of the app, and it is built so that every mistake that can be prevented by the program is prevented.

## Decision

1. **Staged, never sent from the product page.** "Edit price" saves a draft in Kiln's own table `staged_price_changes` (one per product and plan). It
   appears in the pending cart as an item of kind `price` with risk `financial` that always `needsApproval`. The draft push of staged listing
   changes never touches it (a separate table on purpose: there is no code path from the draft push to a price). Sending is the cart's publish.
2. **Gates, in this order**, each with its own code and each tested: the server env switch `KILN_PRICE_WRITES_ENABLED` (default `false`), the
   workspace setting `prices.writeEnabled` (default `false`; turning it ON is a step-up `flags` action), the right `monetization.price`
   (owner and admin; an API token only when its actions name it), step-up class `store.price` (covered by default, unlike a draft push), the
   typed phrase, a claim, a live re-read with a re-validation, the guarded write, a read back.
3. **The typed phrase** is `CHANGE <n> PRICE(S) MAX <p>%`: the number of products and the largest change, rounded up. It cannot be typed by
   habit because it changes with the selection. The server computes it from the items it loads for the request, checks it for exactly the price
   items that would be sent, and does so BEFORE anything is sent (a mismatch is `422 confirmation_mismatch` and nothing, of any kind, is sent). One
   phrase per record, because a publish is one request per record.
4. **The server is the author.** The request carries territories and new amounts only (strict body: a client-supplied currency or current price is
   refused). The current price and currency come from the stored snapshot; `seenSyncedAt` must equal the snapshot (`409 stale_snapshot`). The
   same validation runs at staging, in the dry run and right before the write against a LIVE read (`stale_price`, `currency_mismatch`).
5. **Money is text and BigInt.** Amounts are minor units as digit strings; percent is in basis points, computed with BigInt (no floating point,
   no `bigint` literals). A typed amount is read exactly (`4.99` is 499; more decimals than the currency has is refused, never rounded). Amounts
   of different currencies are never added anywhere; summaries count lines per currency.
6. **Apple price points.** Apple only sells at fixed tiers. An amount that is not a price point of the territory is refused with the nearest
   points; the screen offers them, Kiln never rounds for the person. Each Apple line carries the price point id.
7. **Guard rails with acknowledgements.** A change over 50% either way (configurable), a change over a number of major units per currency
   (default 100, with built-in higher defaults for currencies with small units such as JPY), and moving existing subscribers each need their own
   acknowledgement, which the server demands from the numbers (not from what the client claims). At most 50 territories per change; no price above
   100000 major units whatever the acknowledgements.
8. **Existing subscribers default to PRESERVE.** Apple: `preserve | apply`; Google Play: `preserve | opt_in | opt_out`. Anything but `preserve`
   needs the `existing_subscribers` acknowledgement, and the screen writes the consequence next to the choice in plain words.
9. **One failure never blocks the others.** Price items are independent per product (a subset is allowed). Per item the result says
   `ok` or `failed` with a code, and per territory `applied | already_applied | failed | unknown | not_sent`. One price write is in flight per app
   (the claim `store_price_claims`, status `writing` or `unknown`).
10. **Confirmed versus assumed.** After every write Kiln reads the prices back. "Confirmed by the store" is shown only when the read back shows the
   asked prices; if it shows other prices the item says what the store shows ("Store shows $4.99 for USA, not $5.99"); if the read back fails it
   says "not verified". A lost answer is never retried: the claim stays `unknown`, new sends are refused (`409 outcome_unknown`) until a dry run
   reads the store, and the draft is kept.
11. **A dry run** (`POST /apps/{id}/prices/dry-run`) reads the store and shows per item the issues against the live prices and what a send would
    do (Apple subscriptions: the store's own `subscriptionPriceChangePreviews`; otherwise the exact requests). It writes nothing, takes no claim and
    works while the switches are off (it says whether a send would be allowed).
12. **Nothing is deleted in a store.** A price Apple already scheduled is never removed; a clash is refused (`price_change_not_allowed`). Discarding a
    price in the cart removes only Kiln's draft.
13. **Audit only, no webhook event.** `price.staged`, `price.changed`, `price.change_failed`, `price.discarded` and `price.dry_run` carry the
    product, store, plan, territory, currency, before and after amounts, the choice for existing subscribers, the date and the actor. Never the store's
    text or a secret. No alert and no webhook were added: a price change is something a person does and sees, not a signal.
14. **RevenueCat is read only.** The Products page says so. RevenueCat picks a changed price up from the store.

## What is confirmed and what is assumed

Confirmed from the stores' public documentation (and tested against fakes): Apple subscription prices are set by `POST /v1/subscriptionPrices` with
`preserveCurrentPrice` and `startDate`, `subscriptionPriceChangePreviews` exists as a store-side check, in-app purchase prices are a price schedule
with a base territory and manual prices; Google Play prices are `Money` (`units`, `nanos`), a patch needs `regionsVersion`, `convertRegionPrices`
derives regional prices, and `migratePrices` exists for subscription price changes with a state for existing subscribers.
Assumed (unverified, listed below): the exact bodies and ids of the Apple price schedule, where the preview puts its answers, the whole-list
`updateMask` patch of Play, the effect of a plain Play patch on older subscriber cohorts, tax handling, per-currency store limits and the API key
roles. A first run against a real account should be a dry run of one product you can afford to change, then one real change of the smallest size.

## Threat and abuse analysis

| Risk | How it could happen | Controls |
| --- | --- | --- |
| Accidental mass change | A paste of 170 regions, a wrong percent, a script | Off by default (two switches); at most 50 territories per change; the relative and absolute guard rails with their own acknowledgements; the typed phrase names the count and the largest percent; the dry run; a subset by product; a per-item result and audit. |
| Wrong currency | Amount typed in another currency; a territory whose currency changed | The currency comes from the stored snapshot, never the client (strict body refuses it); re-checked against a live read right before the write (`currency_mismatch`); a converted Play price in another currency is dropped by the screen; currencies are never summed. |
| Wrong territory | A region the plan lacks; Apple vs Play codes | Territory shapes are checked per store (`USA` vs `US`); a territory without a current price is refused (`unknown_territory`); Play refuses regions the plan does not have; a base-territory change that would move unnamed Apple territories is refused. |
| Replay | The same publish sent twice; a retry after a lost answer | One claim per app; a draft is deleted only when confirmed; a lost answer leaves the claim `unknown` and blocks new sends until a read; a repeated request finds `already_applied` lines instead of writing; the typed phrase and the step-up grant are per request. |
| Stale price | Someone changed the price in the store console, or another sync ran | `seenSyncedAt` at staging (`stale_snapshot`); a live re-read before the write compares every line with the price it was staged against (`stale_price`, nothing is written); the cart marks a draft `invalid` when the snapshot moved. |
| Compromised session or token | A stolen cookie or an API token | A token needs `monetization.price` in its explicit action list; step-up (`store.price`, covered by default) asks for a second factor at publish and is required before anything is read; the typed phrase is computed server-side and must be typed by hand; turning the workspace switch ON is itself a step-up action; the server env switch cannot be changed from the app at all. |
| A second person approving | Two-person approval | Not built: this app has no second-person approval feature. Step-up plus the typed phrase stands in for it, and it is said so here instead of implied. |
| Lost or misread answer | A timeout, a 5xx after the store applied the change | Never retried; read back; `unknown` status; the dry run is how a person finds out where it stands. |
| Hidden consequences for subscribers | Choosing "apply" without understanding | `preserve` is the default; changing it needs an acknowledgement; the consequence is written next to the choice. |
| Information leak | Secrets or store text in logs | The audit holds ids and amounts only; the connector never logs a body; errors are translated to codes with a fixed sentence. |

## Consequences

- Price writes need a one-time operator step (`KILN_PRICE_WRITES_ENABLED=true`) and an owner or admin turning the workspace setting on. Both are
  visible on the product page with their reason while off.
- The cart grows a fifth kind and a risk `financial`; items of other kinds are untouched and keep their bundles.
- A price change is never an alert and never a webhook; `docs/alerts.md` is unchanged.
- A real account may show that a body or an id assumed here is wrong. The connector tests are against fakes only; the first real run is a dry run.

## UNVERIFIED: check with a real account

Apple: the body and the `${tmp}` ids of the in-app purchase price schedule and whether it replaces all manual prices (Kiln resends the existing
ones and refuses a base-territory change that would move unnamed territories); where `subscriptionPriceChangePreviews` puts its per-territory
results (`changeResults`) and whether it requires a `startDate`; the meaning of a scheduled-price clash; the API key role needed for prices;
whether preserving existing subscribers applies to decreases.
Google Play: that a `basePlans` or `purchaseOptions` patch with the whole list sent back as read is accepted; the `migratePrices` path (opt-in and
opt-out, increases only); whether a plain patch leaves older subscriber cohorts on the old price; whether `regionalConfigs` prices are tax
inclusive or exclusive for each region; per-currency store minimums and maximums; that Play cannot schedule a price by date; `planType` handling;
the required Play Console permission.
