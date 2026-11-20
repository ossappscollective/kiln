# ADR 0032: Feature modules and platform metadata

Status: started. ASO, analytics and reviews are server modules; the rest follow one at a time.

## Context

A feature (ASO, analytics, reviews, alerts, ...) was spread over `routes/`, `services/`, flat test files in `src/`, and wired by hand
in `app.ts`. Removing or adding one meant editing a dozen places. Platform facts were repeated too: the store behind a platform was a
ternary in a dozen files and the literal union of store names was written out 25 times.

## Decision

1. **A server module is a folder**, `apps/server/src/modules/<id>/`: `routes.ts`, `service.ts` and the other services it owns, the
   tests next to the code, `test-helpers.ts`, and an `index.ts` that exports a `ServerModule` (`modules/module.ts`) and the module's
   `Deps` type (the seams tests replace). `createApp` mounts modules and passes `deps.<id>`; it does not know their insides.
2. **Moving is mechanical.** `node scripts/move-files.mjs <root> from=to ...` does `git mv` and rewrites every relative import; the
   type check and the tests are the proof. One module per commit.
3. **Platform facts live in `@mrm/core/platform.ts`.** `STORE_IDS` / `StoreId`, `PLATFORM_META[p].store` and `storeOf(p)` replace
   the literals and ternaries. A new platform is a new row there plus a connector; a branch that still says `=== 'android'` is a
   candidate for a capability flag on the row.
4. **Rows are read through `@mrm/db/row.ts`** (`nullableString`, `nullableNumber`, `oneOf`, ...), not cast.
5. **`assertNever`** closes every `switch` over a union.

6. **Store connectors come from one registry.** `StoreConnectorInput` and `connectorFactory({ app_store_connect, google_play })`
   (`packages/connectors/src/store-registry.ts`) build every capability (read, reviews, draft, submit, rollout, release). The record
   must name every `StoreCredentialKind`, so adding a store makes the compiler list each capability that still needs a builder.

7. **No `isApplePlatform` / `isGooglePlatform`.** Code asks what a platform can do: `supports(platform, capability)` over the exhaustive
   `capabilities` record on each `PLATFORM_META` row (`releaseTracks`, `approvalHold`, `screenshotsByDevice`, `keywordField`, ...),
   `listingStoreOf` for the listing format, or `byFamily(platform, { apple, google })` for per-family tables. A new platform answers
   every flag in its row; the compiler flags any it forgets.

## Not decided yet

The same folder layout for the web (`components/<module>` + `lib/<module>`), core and connectors; direct `=== 'android' / 'ios' / 'macos'` checks (about 135) still to move onto capabilities; `exactOptionalPropertyTypes` (about 150 errors to fix).
