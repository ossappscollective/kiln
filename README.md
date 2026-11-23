# Kiln

A self-hostable, Apache-2.0 mobile release manager: iOS, macOS and Android app releases,
store listings and ASO from one place, with GitHub, fastlane and Expo (EAS) integration.

**Status: early, pre-release. Phases 0 and 1 are mostly built, Phase 2 is under way.** Most of it
has only run against SQLite, in-process tests and hand-written fixtures. Nothing has been run against
a live App Store Connect, Google Play or GitHub account, against Postgres, in a browser, or inside a
built Docker image or desktop bundle. Read [What is verified](#what-is-verified) before relying on
anything here.

- [docs/phase-0.md](docs/phase-0.md): foundations (accounts, credentials, jobs, desktop shell)
- [docs/phase-1.md](docs/phase-1.md): GitHub, fastlane and Expo repositories, change sets
- [docs/phase-2.md](docs/phase-2.md): read-only store sync and the portfolio screens
- [docs/open-decisions.md](docs/open-decisions.md): decisions that wait for a person
- [docs/ux-ia.md](docs/ux-ia.md): the shell, the pages and their views (including workspace Settings in four views)
- [docs/alerts.md](docs/alerts.md): alerts, the inbox, email, desktop and webhook delivery ([API](docs/api/alerts.md))
- [docs/chat-integrations.md](docs/chat-integrations.md): alerts, release events and a daily summary in Slack and Microsoft Teams ([API](docs/api/chat-integrations.md), [ADR 0047](docs/adr/0047-chat-integrations.md))
- [docs/api/two-factor.md](docs/api/two-factor.md) and [docs/api/mail.md](docs/api/mail.md): authenticator app and email codes, and the SMTP server they use
- [docs/mcp.md](docs/mcp.md): connect Claude, Cursor and other AI assistants ([API](docs/api/mcp.md))
- [docs/ai-features.md](docs/ai-features.md): the AI assistant for reviews, listings and ASO ([API](docs/api/ai.md))
- [docs/api/analytics.md](docs/api/analytics.md): store analytics, including the Google Play reports bucket
- [docs/api/builds.md](docs/api/builds.md): test builds from CI artifacts, TestFlight and Google Play internal sharing
- [docs/demo.md](docs/demo.md): demo mode, the whole product on simulated stores
- [docs/i18n.md](docs/i18n.md): localisation of the web app (English, French, Spanish, German): runtime, conventions, tooling; [docs/translating.md](docs/translating.md) for translators and Weblate, [docs/i18n-glossary.md](docs/i18n-glossary.md) for the terms ([ADR 0044](docs/adr/0044-localisation.md))

## What works today

"Works" means: covered by automated tests that pass in a development environment, not proven in
production.

- Accounts and sessions (first-run owner registration, login with rate limits, cookie sessions),
  workspaces, roles (`owner`, `admin`, `member`, `viewer`) and an audit log.
- Invitations: an admin creates a single-use link (7 days), the invited person accepts it.
  The link is copied by hand; it is not emailed ([docs/api/members.md](docs/api/members.md)).
- Credentials: encrypted at rest (AES-256-GCM, bound to workspace and id), never returned, with
  in-app how-to guides and a "test connection" check
  ([docs/credentials.md](docs/credentials.md), [docs/api/credential-tests.md](docs/api/credential-tests.md)).
- Repositories: connect a GitHub repository, detect fastlane and Expo projects, read the fastlane
  listing, and turn edits into a change set that an admin approves and that is applied as a branch
  and pull request, never as a push to the default branch
  ([docs/api/repositories.md](docs/api/repositories.md)).
- Expo `store.config.json`: read, validate and write back in `@kiln/connectors`, and used as the App
  Store listing source by the server and the repositories screen when a repo has one.
- Read-only store sync: apps are bound to an App Store Connect or Google Play credential, and a
  sync (inline, or as a background job) stores a snapshot of their versions and tracks
  ([docs/api/apps.md](docs/api/apps.md)). The sync itself never writes to a store; store writes are separate and off by default.
- A database-backed job queue with retries; SQLite through `node:sqlite` or Postgres.
- Security hardening of the hosted server: login rate limits, request body caps, security headers,
  non-root container, loopback-only default publish ([docs/deployment.md](docs/deployment.md)).
- An MCP server (off by default, `KILN_MCP_ENABLED`) so AI assistants such as Claude and Cursor can read a workspace through an API token and
  preview, never apply, store actions; "Connect an AI assistant" under Settings, AI, shows how ([docs/mcp.md](docs/mcp.md),
  [docs/api/mcp.md](docs/api/mcp.md)). Tested against a fake client only.
- Two-factor confirmation: an authenticator app (TOTP) or an emailed code as extra ways to confirm hard actions and, optionally, to
  sign in, plus one-time recovery codes. Emailed codes need a mail server (SMTP, set under Settings, Security); without one everything
  else works ([docs/api/two-factor.md](docs/api/two-factor.md), [docs/api/mail.md](docs/api/mail.md)).
- Alerts: a store rejected a version, a credential stopped working, a rating fell, a sync keeps failing. They arrive in the inbox (the
  bell), by email, as a desktop notification and as a signed webhook; each person picks their own channels, admins set the workspace
  defaults ([docs/alerts.md](docs/alerts.md)).
- An AI assistant for reviews, the store listing and ASO: suggestions and reports a person reads, never an action on a store; the provider
  and key are set under Settings, AI, which also shows what is sent per task ([docs/ai-features.md](docs/ai-features.md)).
- Analytics: App Store Connect and Google Play numbers. For Google Play the monthly reports come from a Cloud Storage bucket, set once for
  the workspace (Settings, Analytics) or per app ([docs/api/analytics.md](docs/api/analytics.md)). Besides installs, ratings and sales it shows Google
  Play monthly earnings (net of Google's fees and taxes, per currency) and subscription counts (active, new, cancelled) for both stores.
- RevenueCat: link an app to its RevenueCat project to compare the store's products with RevenueCat's configuration, and see RevenueCat's own
  active subscriptions, active trials, MRR and 28-day revenue (all stores of the project, visible to every member) on the Products page
  ([docs/api/revenuecat.md](docs/api/revenuecat.md)).
- Apple Ads (read only): link an App Store app to its Apple Ads account to see spend, campaigns and the search terms that led to taps and installs in Insights, Ads, and to sharpen
  the keyword popularity estimate with your own impressions. Kiln only reads reports, with a read-only API user ([docs/api/apple-ads.md](docs/api/apple-ads.md)).
- Test builds: find the builds a CI run produced, share a TestFlight link or a Google Play internal sharing link, and download an artifact
  ([docs/api/builds.md](docs/api/builds.md)).
- Demo mode: `pnpm demo` seeds "Demo Studio" on simulated stores, with alerts in the inbox, so the whole app can be tried without any
  account and nothing leaves the machine ([docs/demo.md](docs/demo.md)).
- Workspace Settings has four views (General, Analytics, Security, AI), each with its own address, for example `#/settings?view=security`
  ([docs/ux-ia.md](docs/ux-ia.md)).
- Web UI screens written: setup, sign-in, credentials, members and invitations, audit log,
  repositories. See below for what is not verified about them.

## In progress or not built

- Release workflow screens beyond the Portfolio list and app detail, which are written but have never
  been rendered in a browser.
- Bundling the server into the desktop app: [ADR 0004](docs/adr/0004-desktop-sidecar.md) proposes
  how (the official Node binary as a Tauri sidecar plus the server as resources) and a staging
  script exists, but the Tauri app has never been compiled or bundled, so **the desktop app does
  not yet ship the server**. In development it starts the server from the repository checkout.
- Store writes (listing drafts, submit, release, rollout, replies) exist behind off-by-default switches and, like everything else
  here, have only run against fakes and the demo's simulated stores ([docs/ux-ia.md](docs/ux-ia.md) section 5 lists the switches).
- A project name.

The tool orchestrates. It does not build or sign apps; your CI does.

## What is verified

Last run in a Linux arm64 development environment, Node 22.23: `tsc` is clean for `core`, `vault`,
`db`, `connectors` and `server`, and `node --test` passes: core 67, vault 10, connectors 250, db 26
(18 skipped), server 200 (170 skipped), web client library 109. The skipped cases are the Postgres cases.

Not verified, so treat as unknown:

- **Postgres.** The cases exist (`KILN_TEST_POSTGRES_URL`, [CONTRIBUTING.md](CONTRIBUTING.md)) but
  have never run.
- **Live services.** Every App Store Connect, Google Play and GitHub call is tested against
  hand-written fixtures. Several error bodies and enum values are from memory
  ([docs/spikes/store-api-conventions.md](docs/spikes/store-api-conventions.md),
  [docs/spikes/repo-conventions.md](docs/spikes/repo-conventions.md)).
- **The web UI in a browser.** The Svelte components were type-checked when written, but nothing has
  rendered them, `pnpm --filter @kiln/web build` has not produced a bundle in this environment, and
  `svelte-check` and `pnpm lint` could not be re-run there (missing platform binaries).
- **Docker.** The `Dockerfile` and `docker-compose.yml` have never been built or started.
- **Desktop.** `main.rs` has never been compiled; macOS signing, notarization, Windows and Linux
  bundles are untried ([ADR 0004](docs/adr/0004-desktop-sidecar.md)).

## Layout

```
apps/
  server/     Hono API: auth, credentials, members, repositories, apps and sync, job worker,
              serves the web UI
  web/        Svelte 5 single-page app (Vite)
  desktop/    Tauri shell that starts the server in single-user mode (no Electron)
packages/
  core/       Release lifecycle, change sets, roles, credential guides, listing model (pure, tested)
  vault/      AES-256-GCM encryption for store credentials (tested)
  db/         Portable SQL migrations, SQLite (node:sqlite) and Postgres adapters, Drizzle schemas
  connectors/ GitHub, App Store Connect, Google Play, fastlane and Expo store config files,
              translation providers. Store reads by default; every store write (review replies,
              rollout, staged draft push, submit) is off until its KILN_*_ENABLED flag is set
docs/         Architecture, ADRs, spikes, API notes, phase checklists, open decisions
```

## Run it

You need Node 22.18 or newer and pnpm 10. TypeScript runs directly through Node's type
stripping, so there is no build step for the server. `pnpm-lock.yaml` is committed.

**Development (SQLite, nothing else to install)**

```sh
cp .env.example .env          # then set KILN_MASTER_KEY: openssl rand -base64 32
pnpm install
pnpm dev                      # API on :8787, web UI on :5173
```

- `.env` is git-ignored. `KILN_MASTER_KEY` is required; losing it means re-entering every stored
  credential.
- With no `DATABASE_URL`, the server uses SQLite at `./.kiln-data/kiln.db`. Postgres is opt-in:
  set `DATABASE_URL=postgres://...` (but note it has never been tested here, see above).

Open http://localhost:5173. The first visit asks you to create the owner account and a workspace;
registration closes after that. Whoever reaches a fresh instance first becomes the owner, so do not
expose a new instance before you have claimed it (see [docs/open-decisions.md](docs/open-decisions.md)).

For scripting, the same steps are `POST /api/auth/register` and `POST /api/auth/login`.

**Hosted (Docker Compose, Postgres)**

```sh
cp .env.example .env          # set KILN_MASTER_KEY
docker compose up --build     # http://localhost:8787
```

- The compose file runs the app against its own Postgres container.
- Port 8787 is published on **127.0.0.1 only** by default (`KILN_BIND`). The server speaks plain
  HTTP; put a TLS-terminating reverse proxy in front before exposing it, and read
  [docs/deployment.md](docs/deployment.md) first. Setting `KILN_BIND=0.0.0.0` sends passwords and
  session cookies unencrypted unless something else terminates TLS.
- Behind a reverse proxy you control, set `KILN_TRUST_PROXY=1` so login rate limits see the real
  client address (details and the risk of setting it wrongly are in the deployment notes).
- The image runs as the unprivileged `node` user and writes only to `/data`.

**Desktop (Tauri)** needs Rust. Generate icons once, then start it with the dev servers running:

```sh
pnpm --filter @kiln/desktop tauri icon path/to/app-icon.png
pnpm dev                                  # in one terminal
pnpm --filter @kiln/desktop dev            # in another
```

In development the shell starts the server from this checkout with your own `node`. It does not yet
ship the server: [ADR 0004](docs/adr/0004-desktop-sidecar.md) proposes how (a Node sidecar plus the
server as bundled resources), and [apps/desktop/README.md](apps/desktop/README.md) describes the
staging script. The proposal is neither built into an app nor compiled; see the
[sidecar spike](docs/spikes/sidecar.md).

## Checks

```sh
pnpm test        # node:test, no extra test runner
pnpm typecheck
pnpm lint        # Biome
pnpm i18n:check  # translation catalogs and the keys used in the web source (also run by pnpm test)
```

Postgres cases run only when `KILN_TEST_POSTGRES_URL` is set; otherwise they show as skipped. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Security notes

See [SECURITY.md](SECURITY.md) and [docs/deployment.md](docs/deployment.md). Store credentials are
encrypted with the master key from the environment; keep that key out of version control.

## License

[Apache-2.0](LICENSE).

Try it without any account: `pnpm demo` (see [docs/demo.md](docs/demo.md)).
