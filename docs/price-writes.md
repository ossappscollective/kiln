# Price writes: who can send a price, what stops a mistake, what is recorded

Changing the price of an in-app purchase or subscription is the most conservative write in Kiln. This page is the operator's and reviewer's
summary of its gates. The reasoning and the threat analysis are in [ADR 0062](adr/0062-price-writes.md); the routes are in
[api/products](api/products.md) and [api/pending](api/pending.md). **Not run against a real store**: see the UNVERIFIED list in the ADR.

## Turning it on (two switches, both off by default)

1. The server: `KILN_PRICE_WRITES_ENABLED=true` ([deployment](deployment.md)). Only the operator can change it; there is no screen for it.
2. The workspace: the setting `prices.writeEnabled` (an owner or admin, on the product page or in the settings API). Turning it **on** is a
   step-up `flags` action; turning it off is free.

While either is off, nothing can be staged or sent (`409 price_writes_disabled`). The product page keeps the prices visible and says which switch
is off. Reading products, price points, the conversion and the dry run keep working.

## Who can do it

| Step | Right | Notes |
| --- | --- | --- |
| Stage, price points, convert, dry run | `monetization.price` | Owner and admin. An API token only when its list of actions names it (explicit-only, like `monetization.write`). |
| Send (cart publish) | `monetization.price` | Plus step-up class `store.price` (in the default list) and the typed phrase. |
| Discard a staged price | `changesets.write` | Removes only Kiln's draft. |

There is no second-person approval in Kiln. The step-up (a second factor, passkey or code) and the typed phrase take its place; the ADR says so
rather than implying more.

## What stops a mistake

- **Typed phrase**: `CHANGE <n> PRICE(S) MAX <p>%`, computed by the server from the items in the request, per record, checked before anything is sent.
- **Guard rails** (each needs its own acknowledgement the server derives from the numbers): a change above `KILN_PRICE_MAX_RELATIVE_CHANGE_PERCENT`
  (50), above `KILN_PRICE_MAX_ABSOLUTE_CHANGE` major units (100, higher built-in defaults for currencies with small units), and moving existing
  subscribers. At most `KILN_PRICE_MAX_TERRITORIES` (50) territories per change; never a price above 100000 major units.
- **Existing subscribers keep their price** (`preserve`) unless changed on purpose and acknowledged.
- **Currency and current price come from the stored snapshot**, never from the request; a stale snapshot (`stale_snapshot`) or a price that moved in the
  store (`stale_price`) refuses the change, and the store is read again right before the write.
- **Apple price points** are never rounded to for the person; nearest points are offered.
- **One price write at a time per app**, never retried; a lost answer is `outcome_unknown` until a dry run reads the store.
- **Verified**: after a write the prices are read back; the item says "confirmed by the store", or "store shows X", or "not verified".
- **Independent items**: a subset by product, and one failure never blocks another.

## What is recorded

Audit entries `price.staged`, `price.changed`, `price.change_failed`, `price.discarded`, `price.dry_run`: the product, store, plan, per territory
the currency and the before and after amounts (minor units), the choice for existing subscribers, the date, the outcome code, and the actor. Never
store text, a credential or a secret. No webhook event and no alert were added.

## RevenueCat

Read only. A price changed in a store shows in RevenueCat after its next read; Kiln never writes to RevenueCat.
