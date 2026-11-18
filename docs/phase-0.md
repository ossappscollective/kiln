# Phase 0: foundations

**Exit gate:** the stack starts with one command, and the sidecar and dual-dialect spikes have a
recorded outcome.

## Done in this scaffold

- [x] pnpm monorepo, TypeScript strict, Biome, `.editorconfig`, CI workflow
- [x] Apache-2.0 `LICENSE` and `NOTICE`
- [x] `docker-compose.yml` (app plus Postgres) and a `Dockerfile`
- [x] `@mrm/core`: release lifecycle state machine and change set types, with tests
- [x] `@mrm/vault`: AES-256-GCM secret encryption bound to an owner, with tests
- [x] `@mrm/db`: Postgres and SQLite schemas, one `Sql` interface over both, SQL migrations
      applied at boot, SQLite through `node:sqlite` ([ADR 0002](adr/0002-node-sqlite-and-sql-migrations.md))
- [x] `@mrm/connectors`: store and repo interfaces, stubs that fail loudly
- [x] `@mrm/server`: config validation, `/api/health`, static serving of the web UI
- [x] Accounts and sessions: first-run registration, login with a rate limit, logout, cookie
      sessions stored hashed, same-origin check on writes
- [x] Workspaces and roles (`owner`, `admin`, `member`, `viewer`) with one permission table in
      `@mrm/core`; non-members see 404
- [x] Credential endpoints: encrypted through `@mrm/vault`, bound to workspace and id, secrets
      never returned, every change in the audit log
- [x] Audit log endpoint
- [x] Web UI: first-run setup, sign-in, credentials (add, replace secret, delete) and the audit log,
      with controls that follow the member's role
- [x] The API refuses a secret that cannot be right for its kind (`checkSecret` in `@mrm/core`,
      shared with the UI)
- [x] Database-backed job queue and worker (retries with backoff, stale-job recovery), started
      in-process unless `MRM_WORKER=off`
- [x] `@mrm/web`: Svelte 5 shell that reads `/api/health`
- [x] `@mrm/desktop`: Tauri shell that opens the web UI

## Verified so far

Run on Node 22.23 (Linux): `tsc` clean and `node --test` green for `core`, `vault`, `connectors`,
`db` and `server` (see counts below), plus `svelte-check` clean and 11 tests for the web client
library. That includes the API through Hono's in-process client, the
migrations and the job queue on SQLite.

Latest run: core 34, vault 8, connectors 87, db 26 (18 Postgres cases skipped), server 74
(53 Postgres cases skipped), web client 11, `svelte-check` clean.

## Not verified yet

Dependencies could not be installed where this was written, so these have never run:

- [ ] `pnpm install`, then commit `pnpm-lock.yaml`
- [ ] `pnpm lint`, `pnpm typecheck` across every package
- [ ] `pnpm test` for `apps/server/src/app.test.ts` (needs Hono installed)
- [ ] `pnpm dev` and `docker compose up --build`, then open `/api/health`
- [ ] `pnpm --filter @mrm/web build`, and a click-through of the UI in a browser. The Svelte
      components compile and type-check, but nothing has rendered them yet
- [ ] `pnpm --filter @mrm/desktop dev` (needs icons and Rust)

## Still to build

- [x] Single-user mode for the desktop app: launch secret, localhost-only host guard
      ([ADR 0003](adr/0003-single-user-mode.md)). The Tauri shell that starts the server is written
      but has never been compiled
- [ ] Invitations, so a second person can join (registration closes after the first account)
- [ ] Run the Postgres test cases. They exist (`MRM_TEST_POSTGRES_URL`, `docker-compose.test.yml`,
      a service in `docs/ci.yml.example`) but have never run: 71 db and server cases are skipped here
- [ ] OpenAPI generation from the route definitions
- [ ] Sidecar spike: [docs/spikes/sidecar.md](spikes/sidecar.md)
- [ ] Dual-dialect spike: [docs/spikes/dual-dialect.md](spikes/dual-dialect.md)
- [ ] Choose the project name, then rename the `@mrm` scope, the Tauri identifier and the title
- [ ] Desktop icons

## Known divergence from the design

The lifecycle in `@mrm/core` has a tenth state, `propagating`, used only on Android between
releasing and rolling out. The design document describes it in text but not in its diagram.
