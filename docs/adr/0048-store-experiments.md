# ADR 0048: Store experiments and custom product pages: read from Apple, track by hand for Google Play, no store write yet

Status: implemented and tested against fakes; **never run against App Store Connect** (what is not verified is listed in
[api/experiments](../api/experiments.md#unverified-check-with-a-real-account) and in the [spike](../spikes/store-experiments.md)).

## Context

Apple's Product Page Optimization (tests of up to three treatments of the product page) and custom product pages, and Google Play's store
listing experiments and custom store listings, are the ASO levers that change conversion without a release. Kiln covers keywords and the
listing text; a person still has to open two consoles to see what is running. The [spike](../spikes/store-experiments.md) read the official
pages (2026-11-22) before any code.

## What the stores allow (verified on the official pages)

- **Apple** exposes experiments (`appStoreVersionExperiments` v2, tied to the app since API 2.4; v1 is deprecated), their treatments and
  treatment localizations, custom product pages with versions and localizations, and the media of a locale as App Asset Library
  _placements_ (the screenshot-set endpoints are deprecated). It has write endpoints for all of them. It has **no endpoint for results**
  (impressions, conversion, confidence): they are in App Store Connect only.
- **Google Play** has neither store listing experiments nor custom store listings in the Developer API (`androidpublisher` v3 lists no such
  resource). Nothing can be read or written.

## Decision

1. **Capability `storeExperimentsApi`** (`packages/core/src/platform.ts`): true for Apple (iOS, macOS), false for Google Play. Code asks
   `supports(platform, 'storeExperimentsApi')`.
2. **Read side, always on, read only toward the store.** `AppleExperimentsConnector` (`packages/connectors/src/apple/appstore-experiments.ts`)
   reads experiments (with `include` of the treatments), the locales of each treatment and, for iOS records, custom product pages with their
   versions and the locales of the version that counts, with media counted from placements. It follows Apple's paging (capped), keeps unknown
   fields out, and treats a refused part (403, 404) as a warning and an empty part unless both parts are refused (then the error is shown).
   A macOS record keeps the `MAC_OS` experiments and reads no custom pages (they are for iPhone and iPad).
3. **A stored snapshot**, like the in-app products ([ADR 0034](0034-in-app-products.md)): `store_experiments` (one row per experiment or page,
   the rest as JSON), `store_experiments_sync` ([migration 53](#migration-53)). `POST .../experiments/sync` replaces the parts it read in one
   transaction; a part Apple refused is left as it was, a cut list replaces only the items it lists, a failed sync keeps the last good copy and
   records the failure. Reading the list asks no store. Rights: `aso.read` to read, `apps.sync` to sync (the per-workspace app-sync budget),
   audit `experiments.synced` with counts only.
4. **Results are not shown.** The page says so and links to App Store Connect. The Analytics Reports API has a `Page Title` dimension in its
   detailed Discovery and Engagement report (impressions and taps by page name) that could give custom-page numbers, but whether it carries
   treatments, and whether it works for every app, is unverified: a follow-up, not guessed here.
5. **Google Play: a manual tracker and link-outs.** `store_experiment_notes` holds what a person writes down (kind, name, status, dates, link,
   the custom-listing parameter, a note), for any app. `aso.write` to write (members and up), audited without the text. The Experiments view
   explains that Google offers no API, links to the Play Console (the app-specific address needs ids the API does not give, see
   `store-links.ts`) and builds the public address of a custom store listing from the package name and the parameter, in Google's documented
   format. A note is never merged with or sent to a store.
6. **UI**: a view `Experiments` in Insights (`?view=experiments`, `requires: aso.read`, every platform), a state pill, dates, traffic and
   treatments per experiment, a custom-pages table with languages, media counts, deep link and open/copy of the address to share, empty states
   that name the requirements (Apple needs the app live; custom pages are for iOS; Google is a link-out). All strings in the `experiments`
   catalog in four languages; server texts through `coded()` (`experiments.*` in the errors catalog).
7. **No alert type was added.** An "experiment finished" alert needs the state transition to be observed between two syncs, and the sync is a
   manual action here (there is no scheduled experiments sync yet): an alert that cannot fire on its own would be misleading. See follow-ups.

## Write side: designed, not built

The endpoints exist and are listed in the spike. They were **not built** because the shapes cannot be checked without a real account and a wrong
call spends real traffic or review slots: a started test cannot be restarted, a custom page version goes to App Review, and the screenshot
path moved to the App Asset Library whose upload and placement endpoints were not readable from the reference. The safe slice, when an
account is available, is, in this order (each gated like the other store writes: `KILN_STORE_EXPERIMENT_WRITE_ENABLED` default off,
a `experiments.write` action for owner and admin and explicit-only for tokens, step-up on apply with the dry-run hash, an audit row with ids
and hashes, never texts, one write in flight per app through a claim row like `store_product_claims`, never retried after an unknown outcome):

1. **Custom product page promotional text** (`PATCH /v1/appCustomProductPageLocalizations/{id}`): one string of one locale of a version that
   is `PREPARE_FOR_SUBMISSION`. Dry run reads the localization and returns a diff and a hash; apply reads again (409 `state_changed`).
2. **Create a custom product page** (`POST /v1/appCustomProductPages` with a first version and localizations), then media through the App
   Asset Library, then submit for review (the review submission machinery of [ADR 0031](0031-create-app-store-version.md)).
3. **Create an experiment** (`POST /v2/appStoreVersionExperiments` with `name`, `platform`, `trafficProportion`, `app`; treatments with
   `POST /v1/appStoreVersionExperimentTreatments`; localizations; media) in `PREPARE_FOR_SUBMISSION`. No start.
4. **Start and stop** (`PATCH /v2/appStoreVersionExperiments/{id}` with `started`) last, each behind its own confirmation that says the traffic
   it will change and that a stopped test cannot be restarted. Deleting is allowed only before a start.

Before any of it: record real responses from a test account into fixtures and replace the UNVERIFIED notes.

## Migration 53

`packages/db/src/migrations-store-experiments.ts`: `store_experiments`, `store_experiments_sync`, `store_experiment_notes`, indexes on
`workspace_id` (and `app_id` for the notes). No foreign key to apps: `deleteApp` removes the rows. Both schema files and a migration test
(`migration-store-experiments.test.ts`) are in step. Id 52 is the chat integrations migration of a parallel branch.

## Consequences

- Apple apps get one place that lists what runs and what is in review, with the facts that matter for a person (traffic, treatments, media).
- Google Play apps get an honest explanation, links and a record, not a fake integration.
- The connector parses defensively, so Apple adding fields changes nothing; Apple changing the shape of the includes would show as a
  warning or an empty part, not a wrong row.
- Follow-ups: scheduled sync and an "experiment finished" alert; custom-page metrics from the Analytics Reports; the write slices above;
  macOS-specific treatment of custom pages if Apple adds them.
