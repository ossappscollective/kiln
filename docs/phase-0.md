# Phase 0: foundations

**Exit gate:** the stack starts with one command, and the sidecar and dual-dialect spikes have a
recorded outcome.

**Where it stands:** the code for everything below exists and its automated tests pass on SQLite.
The exit gate is **not met**: the one-command start (`pnpm dev`, `docker compose up --build`) has not
been run, the dual-dialect spike has no Postgres run, and the sidecar spike has a proposal
([ADR 0004](adr/0004-desktop-sidecar.md)) that is not built into an app.

## Done and tested

- [x] pnpm monorepo, TypeScript strict, Biome, `.editorconfig`, CI workflow. `pnpm-lock.yaml` is
      committed; the `Dockerfile` installs with `--frozen-lockfile`
- [x] Apache-2.0 `LICENSE` and `NOTICE`
- [x] `@kiln/core`: release lifecycle state machine, change set types, roles and member rules,
      credential kinds and guides, listing model, with tests
- [x] `@kiln/vault`: AES-256-GCM secret encryption bound to an owner (16-byte auth tag pinned), with tests
- [x] `@kiln/db`: Postgres and SQLite schemas, one `Sql` interface over both, SQL migrations
      applied at boot, SQLite through `node:sqlite` ([ADR 0002](adr/0002-node-sqlite-and-sql-migrations.md))
- [x] `@kiln/server`: config validation, `/api/health`, static serving of the web UI
- [x] Accounts and sessions: first-run registration, login with rate limits, logout, cookie
      sessions stored hashed, same-origin check on writes
- [x] Workspaces and roles (`owner`, `admin`, `member`, `viewer`) with one permission table in
      `@kiln/core`; non-members see 404
- [x] Credential endpoints: encrypted through `@kiln/vault`, bound to workspace and id, secrets
      never returned, every change in the audit log
- [x] Credential connection tests, before or after saving
      ([docs/api/credential-tests.md](api/credential-tests.md)). Tested against fixtures only
- [x] Audit log endpoint
- [x] Invitations and member management ([docs/api/members.md](api/members.md)): single-use
      7-day links, role rules in `@kiln/core`, no email delivery. A second person can join
- [x] The API refuses a secret that cannot be right for its kind (`checkSecret` in `@kiln/core`,
      shared with the UI)
- [x] Database-backed job queue and worker (retries with backoff, stale-job recovery; a job
      finishes only for the attempt that claimed it), started in-process unless `MRM_WORKER=off`
- [x] Single-user mode for the desktop app: launch secret, localhost-only host guard
      ([ADR 0003](adr/0003-single-user-mode.md)). Server side and web client are tested
- [x] Hardening of the hosted server: login limiter gaps closed, body limits, security headers,
      `MRM_TRUST_PROXY`, non-root container, loopback publish by default
      ([docs/deployment.md](deployment.md)). The headers and limits are tested in-process; the
      container changes are not (no Docker build ran)

## Written but never run

- [ ] Web UI screens: first-run setup, sign-in, credentials, members and invitations, audit log,
      repositories, with a design system ([docs/design-system.md](design-system.md)). The client
      library is tested; the components compile as far as was checked, but **no browser has
      rendered them**
- [ ] `@kiln/desktop`: Tauri shell that starts the server and opens the web UI
      (`apps/desktop/src-tauri/src/main.rs`). **Never compiled**

## Verified so far

Linux arm64, Node 22.23. `tsc` is clean for `core`, `vault`, `db`, `connectors` and `server`.
`node --test` passes: core 67, vault 10, connectors 250, db 26 (18 Postgres cases skipped),
server 200 (170 Postgres cases skipped), web client library 73. That includes the API through Hono's
in-process client, the migrations and the job queue on SQLite.

`svelte-check` was clean when the earlier screens were written. In the latest environment it and
`pnpm lint` could not run (platform-specific native binaries missing), so they are not re-confirmed.

## Not verified yet

- [ ] `pnpm lint` across every package (not runnable in the last environment)
- [ ] `svelte-check` on the current web code (see above)
- [ ] `pnpm dev` and `docker compose up --build`, then open `/api/health`. The Dockerfile and compose
      file have never been built
- [ ] `pnpm --filter @kiln/web build`, and a click-through of the UI in a browser
- [ ] `pnpm --filter @kiln/desktop dev` (needs icons and Rust), and any Rust compilation
- [ ] The Postgres test cases: they exist (`MRM_TEST_POSTGRES_URL`, `docker-compose.test.yml`, a
      service in [ci.yml.example](ci.yml.example)) but have never run, so 18 db cases and 170
      server cases are skipped
- [ ] CI: `.github/workflows/ci.yml` has never run, and still uses plain `pnpm install` where its
      own comment says to switch to `--frozen-lockfile` now that the lockfile exists

## Still to build

- [ ] OpenAPI generation from the route definitions
- [ ] Sidecar spike outcome: ADR 0004 proposes the Node sidecar; accepted only after the first real
      bundle on macOS ([docs/spikes/sidecar.md](spikes/sidecar.md))
- [ ] Dual-dialect spike: needs a green Postgres run ([docs/spikes/dual-dialect.md](spikes/dual-dialect.md))
- [ ] Choose the project name, then rename the `@kiln` scope, the Tauri identifier and the title
- [ ] Desktop icons
- [ ] First-run owner claim on a fresh hosted instance: see [open-decisions.md](open-decisions.md)

## Known divergence from the design

The lifecycle in `@kiln/core` has a tenth state, `propagating`, used only on Android between
releasing and rolling out. The design document describes it in text but not in its diagram.
