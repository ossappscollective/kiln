# Phase 2: store connectors and sync

**Goal:** read what is in the stores (versions, review state, staged rollout) into the database,
so the portfolio and release screens can show it, with **no write to a store**. Principle: read
before write. No phase writes to a store until the read-only sync matches the console.

**Where it stands:** the connectors, tables, API and job are built and tested against hand-written
fixtures on SQLite. Nothing has talked to a live store. The portfolio list, app page, a board view
and a release page show the result; none of those screens has been rendered in a browser.

## Done and tested

- [x] Read-only App Store Connect connector (`AppStoreConnectConnector`): ES256 JWT, apps,
      versions, builds, error and rate-limit handling, and a credential verifier
- [x] Read-only Google Play connector (`GooglePlayConnector`): service-account JWT, one edit per
      read (always deleted, never committed), tracks, bundles, APKs, listings, and a credential
      verifier. No write call exists in either connector
- [x] Normalized status mappings, table-driven (`packages/connectors/src/mappings.ts`); a state
      with no mapping stays `null` and the raw state is kept
- [x] Migration 6: `apps` and `app_releases` tables (SQLite and Postgres schema files)
- [x] Apps API ([docs/api/apps.md](api/apps.md)): add, list, read and delete apps; sync
      inline (`POST /apps/:id/sync`) or as a background job (`?background=true`, queue `app.sync`).
      A failed sync keeps the last good snapshot and stores a redacted error. Rights `apps.read`,
      `apps.write`, `apps.sync`. Sync is rate limited (10 per minute per workspace) and audited
      (`app.sync`, `credential.use`)
- [x] Store API conventions written down with what was and was not verified
      ([docs/spikes/store-api-conventions.md](spikes/store-api-conventions.md))

## Not verified

- **No live run.** Fixtures are hand-written from vendor pages; several error bodies and enum
  values are from memory. Apple's `AppVersionState` values come from a secondary source.
- **Postgres.** Migration 6 and the sync code have only run on SQLite.
- The iOS `build` shown for a version is a heuristic (the newest uploaded build with the same
  version string); the version-to-build link is not read from Apple.
- A phased release on iOS is not read, so it shows as `live`, not `rolling_out`.
- Play `userFraction` semantics, and what the edits API returns for halted or invalidated edits.
- The sync handler's retry behaviour with real transient failures.

## To build

- [x] Portfolio list and app detail screens in the web UI (`apps/web/src/components/Portfolio.svelte`
      and `components/portfolio/`). Written and unit tested, **never rendered in a browser**
- [x] Discovery: add apps from a credential instead of typing them. `POST /apps/discover` finds the
      apps behind an App Store Connect key (or verifies Google Play package names one by one, since
      Play cannot list an account's apps) and `POST /apps/import` adds the chosen ones in one
      transaction; the Add app dialog has an "Import from a credential" path. Unit and API tested
      with fake connectors, **never rendered in a browser**, never run against a live account
- [x] A board view of the portfolio (a List and Board toggle, remembered in `localStorage`): one
      column per dashboard bucket (Preparing, In review, Ready to release, Live) from
      `dashboardBucket`, one card per app (iOS and Android of one identifier are two cards) with the
      version, status, last sync, a blocked flag with its reason, the deadline and a next action
      derived from the lifecycle (`apps/web/src/components/dashboard/`, `lib/dashboard.ts`).
      Unit tested (the columns, the next action for every state and platform, blocked and deadline
      sorting), **never rendered in a browser**
- [x] A release page at `#/portfolio/<appId>/release/<version>` (`components/release/`): the
      lifecycle timeline and store state per platform (the iOS and Android apps of one product side
      by side), Android's staged rollout beside Apple's phased release (read only, labelled as
      observed from the store, no control), and the plan below. It is a screen of the portfolio view
      next to the app page, not a tab of it, because it can show two apps. Apple's phased release is
      still not read (see above), so an iOS release shows no share. **Never rendered in a browser**
- [ ] Verify the whole slice on Postgres (`MRM_TEST_POSTGRES_URL`)
- [ ] Record real store responses from a test App Store Connect key and a Play service account,
      and replace the hand-written fixtures
- [ ] Play review states through `GET /applications/{package}/tracks/{track}/releases`
      (`releaseLifecycleState`), which needs no edit. A track read through edits never yields
      `in_review`, `rejected`, `approved` or `propagating`. Likely: use both endpoints
- [ ] Read the iOS phased release resource and the version-to-build link
- [ ] Settle the mapping and policy decisions in [open-decisions.md](open-decisions.md): Apple state
      mappings, non-iOS platforms, a dedicated Play service account, the app name, the audit
      actor for background syncs
- [x] Scheduled sync (`MRM_SYNC_INTERVAL_MINUTES`, off by default; 5 to 10080): a scheduler in the
      job queue enqueues `app.sync` per app whose last attempt is older than the interval, with
      jitter, skipping apps already queued or attempted recently, sharing the sync route's rate
      limiter, with an injected clock in tests ([docs/api/ci.md](api/ci.md#scheduled-sync)). The
      sync also reads the store listing, so that is refreshed on the same schedule; the repository
      side of the listing is still read only on demand. Unit tested on SQLite; **never run against
      a live store or for a long time**, so the interval and jitter defaults are untried

## Release planning (groundwork for Phase 4, no store write)

Our own planning data, kept in our database and shown beside the read-only store state. It writes
nothing to a store and sends no reminder or event; it only prepares the ground for the phases that
build and submit releases. API: [docs/api/plans.md](api/plans.md).

- [x] Tables `release_plans`, `checklist_items`, `release_notes`, `checklist_templates` (migration 11
      at the time of writing) with SQLite and Postgres schema files. Postgres has **not** run them
- [x] Plans per app and version: target date with `dueSoon` and `overdue` flags from an injectable
      clock, a blocked flag with a reason, a computed readiness (every required item done, release
      notes for every locale within the store limit), at most one plan per app and version
- [x] Checklist: add, edit, reorder, tick (who and when kept), required marker, templates. Three
      templates ship in `@mrm/core` (first iOS release, first Android release, routine update); a
      workspace can save its own
- [x] Release notes per locale, checked against the limits of the listing rules (4000 characters on
      iOS, 500 on Android, 500 for a plan on both platforms)
- [x] Rights `plans.read` (viewers and above) and `plans.write` (members and above); every change
      audited; non-members get 404; cross-workspace isolation and body limits tested
- [x] Web: the editors on the release page (checklist with move up and down buttons, a template
      picker, release notes per locale with a live character count, a date picker, a blocked toggle
      with a reason). **Never rendered in a browser**; no drag and drop (keyboard buttons only)
- [ ] Remove a deleted app's plans in the same transaction (`purgePlansOfApp` exists, the app
      deletion does not call it yet; the plans are hidden meanwhile)
- [ ] Reminders and notifications for deadlines (out of scope here; the flags are data only)
- [ ] Staged rollout steps as planning data (a plan of "10%, then 50%, then 100%"): not built
- [ ] Verify the planning tables and routes on Postgres

## Store listing read side (groundwork for Phase 3, no store write)

The listing (name, subtitle, description, keywords and the other per-locale texts) as the store has
it, compared with the repository, with a history per field. This is the read half of the ASO work
planned for Phase 3: it shows drift **before** anything is pushed, and writes nothing to a store. API:
[docs/api/listing.md](api/listing.md); what was verified about the store calls:
[docs/spikes/store-api-conventions.md](spikes/store-api-conventions.md).

- [x] Connectors: `readListing` on both. App Store Connect reads `appInfos`, `appInfoLocalizations`,
      `appStoreVersions` and `appStoreVersionLocalizations` (GET only, documented parameters only,
      checked by a request-allowlist test) for the live and the editable version; Google Play reads
      `edits.listings.list` through a read-only edit (inserted, read, deleted, never committed). Both map
      into the `@mrm/core` listing model; fields a store lacks stay absent. Hand-written fixtures only
- [x] Table `listing_snapshots` (a row only when a value changed, by hash) and `app_listing_status`
      (last read, last error of the store and of the repository), with SQLite and Postgres schema files
      (migration 9 at the time of writing). Postgres has **not** run them
- [x] The app sync also reads the listing, best effort: a failure is stored as `listing_error` and never
      fails the release sync. It reuses the sync's connector and credential use
- [x] Repository values are recorded when the linked repository is read (`POST /apps/:id/listing/repo-refresh`);
      change sets record their proposed values once they are applied
- [x] `GET /apps/:id/listing/live`, `/listing/drift` (three-way per locale and field: identical,
      repo-ahead, store-ahead, diverged, missing-in-one, with the editor's character limits) and
      `/listing/history` (paged). Right `listing.read` (viewers and up); non-members get 404
- [x] Web: a Listing tab on the app page: Repository, Last synced and Live store side by side per
      locale and field with status, character counts, an inline word diff, "Refresh from store" (runs
      the sync), "Read repository" and a history drawer per field. **Never rendered in a browser**;
      no push control toward a store exists (see the pull action below)
- [ ] Record real store responses and replace the fixtures; settle which Apple states are "live" and
      "editable" (named, not described, on Apple's pages)
- [ ] Categories, age rating, screenshots, Apple's privacy choices URL and Play changelogs are not read
- [x] "Pull from the store into the repository" (`POST /apps/:id/listing/pull`): the store's text of the
      fields where the store is ahead or the two diverged becomes a **draft** change set in the repository's
      listing files (Expo `store.config.json` or fastlane, by the same source rule as a read), then the
      usual review, approval and apply, which opens a pull request on GitHub. Per-field, per-locale and
      bulk actions in the Listing tab. It is Phase 3 read-side groundwork: nothing is written to a
      store. Tested with fakes on SQLite; **no real store, GitHub or Postgres call, and never rendered in a
      browser**
- [x] Commit a pulled listing to a branch of a local clone instead of a pull request, with an optional push
      and pull request: the change set is applied with `mode: "local_branch"`
      ([phase 1](phase-1.md), [ADR 0005](adr/0005-local-clone-reads.md)). Opt-in, **not run against real
      GitHub, on macOS or in a browser**
- [x] Open the pulled change set directly from the toast: "Review the draft" records the intent
      (`lib/repository-intent.ts`); the Repositories screen takes it once its list has loaded, opens that
      repository on its Change sets tab with the change set open. Unit tested (the resolver); never
      rendered in a browser
- [ ] Scheduled listing reads (a listing is read only when an app is synced by hand or by job)
- [ ] Connector warnings (a version in no known state, an editable version without its own app info) are
      returned but not stored or shown
- [x] The listing routes are in the OpenAPI registry (`services/api-operations.ts`), so an API token can read
      them (`listing.read`) and they appear in `/api/openapi.json`; their bodies and answers are described in part
- [ ] Verify the listing tables and routes on Postgres

## Automation surface (tokens, events, webhooks, OpenAPI)

How scripts, CI and assistants use the server without a person's session. It adds no store write: a
token can only do what its role allows, and the only way to write to a repository is still a
change set that a person (or an admin token) approves. Docs: [tokens](api/tokens.md),
[events](api/events.md), [webhooks](api/webhooks.md), [OpenAPI](api/openapi.md);
design: [architecture.md](architecture.md#automation-surface).

- [x] API tokens: `mrm_` plus 256 bits, only the SHA-256 stored, shown once, last-used time, optional
      expiry, revocation, a role ceiling (viewer, member or admin; never owner, never above the
      creator), optional app list and action list, Bearer next to cookies with a per-token rate limit
      and a bad-token limiter. Tokens can never manage tokens, members, credential values or webhooks.
      Default deny: a route is open to tokens only if it is in the operation registry. Audit actor type
      `token`. Migration 8 at the time of writing
- [x] Events: table `events`, `emitEvent`, `GET /events` (cursor) and `GET /events/stream` (SSE with
      `Last-Event-ID`, heartbeat, per-person cap, ends at shutdown). Types: `app.synced`,
      `app.release.status_changed`, `changeset.created|approved|applied|failed`,
      `credential.test_failed`
- [x] Webhooks: URL, vault-encrypted secret, event types, enabled; HMAC-SHA256 over timestamp and body;
      job-queue delivery with retry and backoff; delivery log, redelivery and a test event; SSRF
      protection (public https only, every resolved address checked, pinned connection, no redirects)
- [x] OpenAPI 3.1 generator and registry written in the repo (no dependency), a structural validator,
      `GET /api/openapi.json` for signed-in callers. A test fails when a route has no registry entry
- [x] Web: **API tokens** and **Webhooks** screens for owners and admins (create with limits, one-time
      secret with copy, revoke, delivery log with redelivery); audit log sentences for the new actions
- [x] Tested on SQLite: token rules and role ceilings, app and action limits, cross-workspace
      isolation, body limits, SSE (resume, filters, cap, heartbeat, shutdown, revocation), retries,
      signing, redelivery, SSRF address cases and a local receiver, OpenAPI validity and coverage
- [ ] **Never run**: a webhook against a real HTTPS receiver or real DNS; the SSE stream through a
      reverse proxy; the two screens in a browser (compiled and type-checked, logic unit tested)
- [ ] Postgres: migration 8, the `events` identity column and the new queries have not run on Postgres
- [ ] The OpenAPI bodies and answers of the plan, listing and CI routes are `partial` (loose objects)
- [ ] An outbound request allow-list per webhook, mutual TLS or a second signing secret during
      rotation: not built (rotation cuts over at once)
- [ ] Scope tokens to a repository (today only to apps and actions); a token's rate limit and the
      bad-token limiter are per process
