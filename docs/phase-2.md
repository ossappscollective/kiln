# Phase 2: store connectors and sync

**Goal:** read what is in the stores (versions, review state, staged rollout) into the database,
so the portfolio and release screens can show it, with **no write to a store**. Principle: read
before write. No phase writes to a store until the read-only sync matches the console.

**Where it stands:** the connectors, tables, API and job are built and tested against hand-written
fixtures on SQLite. Nothing has talked to a live store, and no screen shows the result yet.

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
- [ ] A release screen beyond the app detail (the design canvas also has a kanban by dashboard bucket)
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
- [ ] Scheduled sync: none exists; a sync is started by a person, inline or as a queued job
