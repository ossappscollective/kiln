# Mobile Release Manager

Working title. A self-hostable, Apache-2.0 tool for managing iOS and Android app releases,
store listings and ASO from one place, with GitHub, fastlane and Expo integration.

**Status: Phase 0 (foundations).** There are no product features yet. This repository is the
skeleton the phases build on. See [docs/phase-0.md](docs/phase-0.md) for what is done and what
is left before Phase 1.

## What it will do

- Release management across iOS and Android: version history, build selection, status.
- Submission workflow: submit, track review, hold, publish, staged rollout.
- Test distribution: TestFlight groups and testers, Play internal and closed tracks.
- ASO and store assets: listings per locale, screenshots per device class, per-field history.
- GitHub as a source of truth: fastlane and Expo repos, edited as pull requests or in a local clone.
- A portfolio dashboard: which app is in review, ready to release, live or blocked.
- An AI assistant in V2, planned for now through typed operations and approval-gated change sets.

The tool orchestrates. It does not build or sign apps; your CI does.

## Layout

```
apps/
  server/     Hono API, config, health check, serves the web UI
  web/        Svelte 5 single-page app (Vite)
  desktop/    Tauri shell around the same UI (no Electron)
packages/
  core/       Release lifecycle state machine, change sets (pure, tested)
  vault/      AES-256-GCM encryption for store credentials (tested)
  db/         Drizzle schemas for Postgres and SQLite, connection helpers
  connectors/ Store and repo connector interfaces (stubs until Phase 1 and 2)
docs/         Architecture, ADRs, spikes, phase checklists
```

## Run it

You need Node 22.18 or newer and pnpm 10. TypeScript runs directly through Node's type
stripping, so there is no build step for the server.

**Development (SQLite, nothing else to install)**

```sh
cp .env.example .env          # then set MRM_MASTER_KEY: openssl rand -base64 32
pnpm install
pnpm dev                      # API on :8787, web UI on :5173
```

Open http://localhost:5173. The first visit asks you to create the owner account and a workspace;
registration closes after that.

For scripting, the same steps are `POST /api/auth/register` and `POST /api/auth/login`.

**Hosted (Docker Compose, Postgres)**

```sh
cp .env.example .env          # set MRM_MASTER_KEY
docker compose up --build     # http://localhost:8787
```

**Desktop (Tauri)** needs Rust. Generate icons once, then start it with the dev servers running:

```sh
pnpm --filter @mrm/desktop tauri icon path/to/app-icon.png
pnpm dev                                  # in one terminal
pnpm --filter @mrm/desktop dev            # in another
```

The desktop build does not bundle the server yet. That is the sidecar spike in
[docs/spikes/sidecar.md](docs/spikes/sidecar.md).

## Checks

```sh
pnpm test        # node:test, no extra test runner
pnpm typecheck
pnpm lint        # Biome
```

## First thing to do after cloning

Run `pnpm install` and commit the generated `pnpm-lock.yaml`. The Dockerfile and CI use a plain
`pnpm install` until a lockfile exists; switch both to `--frozen-lockfile` afterwards.

## License

[Apache-2.0](LICENSE).
