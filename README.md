<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo.svg">
  <img alt="Kiln" src="docs/assets/logo.svg" width="240">
</picture>

**Release, list and grow your iOS, macOS and Android apps from one self-hosted place.**

[![CI](https://github.com/ossappscollective/kiln/actions/workflows/ci.yml/badge.svg)](https://github.com/ossappscollective/kiln/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/ossappscollective/kiln?include_prereleases&sort=semver)](https://github.com/ossappscollective/kiln/releases)
[![License: Apache-2.0](https://img.shields.io/github/license/ossappscollective/kiln)](LICENSE)
[![Docker image](https://img.shields.io/badge/ghcr.io-ossappscollective%2Fkiln-2496ED?logo=docker&logoColor=white)](https://github.com/ossappscollective/kiln/pkgs/container/kiln)
[![Website](https://img.shields.io/badge/website-ossappscollective.github.io%2Fkiln-e8590c)](https://ossappscollective.github.io/kiln/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

[Website](https://ossappscollective.github.io/kiln/) ·
[Docs](#documentation) ·
[Download](#desktop-app) ·
[Self-host](#docker) ·
[Contributing](#contributing)

</div>

> **Status: pre-release.** Kiln is built and tested against fixtures and simulated stores, not yet validated against real store accounts. See [Status](#status) before you trust it with a production app.

## What is Kiln

Kiln is an open-source (Apache-2.0) tool for the work around shipping a mobile app: releases and store submissions, store listings and graphics, ASO, reviews, analytics, and Expo (EAS). It runs as a server you host (Docker, SQLite or Postgres) or as a desktop app, and it orchestrates: **your CI builds and signs, Kiln manages everything around it.**

**Why Kiln**

- **One place** for App Store Connect, Google Play, GitHub repositories (fastlane and Expo projects), RevenueCat and Expo, instead of five consoles.
- **Safe by default.** Every write to a store is off until the operator switches it on, previewed, role-checked, and audited.
- **Yours.** Self-hosted, no account with us, store credentials encrypted at rest with a key only you hold.
- **Try before you connect.** `pnpm demo` runs the whole product on simulated stores.

## Features

Everything below is implemented and tested against fakes or fixtures; see [Status](#status). Each line links to its design record or API page under [docs/](docs/).

<details open>
<summary><b>Releases and submissions</b></summary>

- Prepare a release step by step, create App Store versions, read builds and version codes ([ADR 0014](docs/adr/0014-release-management.md), [ADR 0031](docs/adr/0031-create-app-store-version.md)).
- Submit a pushed draft for review, release an approved version, run staged rollouts (Google Play share, halt, resume, complete; App Store phased release) ([ADR 0010](docs/adr/0010-store-submit.md), [ADR 0008](docs/adr/0008-store-rollout-writes.md), [ADR 0029](docs/adr/0029-direct-play-release.md)).
- Test builds from CI artifacts, TestFlight links and Google Play internal sharing ([API](docs/api/builds.md)); TestFlight feedback and crashes in one inbox ([ADR 0049](docs/adr/0049-testflight-feedback.md)).
</details>

<details open>
<summary><b>Store listing, diff and the pending-changes cart</b></summary>

- Edit listing texts and keywords per locale; changes are staged, never sent straight to a store ([ADR 0009](docs/adr/0009-staged-store-drafts.md), [ADR 0026](docs/adr/0026-keywords-and-listing-editor.md)).
- A cart collects every pending change of an app (listing, graphics, release fields, review replies, prices); review a text diff or image comparison, then publish all or part with one typed confirmation ([ADR 0054](docs/adr/0054-pending-cart.md), [ADR 0067](docs/adr/0067-diff-and-preview.md), [ADR 0015](docs/adr/0015-pending-and-batch-publish.md)).
- Listing fixes proposed by checks go through the same cart ([ADR 0059](docs/adr/0059-listing-fixes-via-cart.md)).
</details>

<details>
<summary><b>Graphics</b></summary>

- Two-way sync of store graphics (screenshots, Google Play graphics) with a repository and the stores, plus a release asset proposal ([ADR 0012](docs/adr/0012-assets-two-way-sync.md), [ADR 0063](docs/adr/0063-release-asset-proposal.md)).
</details>

<details>
<summary><b>ASO</b></summary>

- Keyword ranks and competitors from public store data, keyword estimates, competitor listing watch ([ADR 0011](docs/adr/0011-aso-keywords-competitors.md), [ADR 0057](docs/adr/0057-keyword-estimates.md), [ADR 0056](docs/adr/0056-competitor-listing-watch.md)).
- Read-only Apple Ads reports and store experiments (Apple product page optimisation, plus a manual tracker for Google Play) ([ADR 0058](docs/adr/0058-apple-ads.md), [ADR 0048](docs/adr/0048-store-experiments.md)).
- Google Play ASO reads unofficial public pages, so it is off unless you accept that risk (`KILN_ASO_PLAY_UNOFFICIAL_ENABLED`).
</details>

<details>
<summary><b>Reviews and AI (opt-in, with privacy controls)</b></summary>

- A reviews inbox with summaries, competitor reviews, release-note translation, and gated public replies ([ADR 0007](docs/adr/0007-review-replies.md), [ADR 0055](docs/adr/0055-review-summary-and-competitor-reviews.md), [ADR 0028](docs/adr/0028-release-notes-translation.md)).
- An AI assistant for reviews, listings and ASO. Off by default at the server (`KILN_AI_ENABLED`) and again per workspace; it only suggests, a person accepts, and Settings shows what is sent per task. Per-app review privacy controls ([docs/ai-features.md](docs/ai-features.md), [ADR 0016](docs/adr/0016-ai-foundation.md), [ADR 0065](docs/adr/0065-ai-review-privacy-and-competitor-schedule.md)).
</details>

<details>
<summary><b>Insights and analytics</b></summary>

- App Store Connect and Google Play analytics, sales, earnings and subscription metrics, RevenueCat metrics, ratings health, a timeline and reports ([ADR 0017](docs/adr/0017-analytics-foundation.md), [ADR 0038](docs/adr/0038-sales-analytics.md), [ADR 0042](docs/adr/0042-earnings-and-subscription-metrics.md), [ADR 0043](docs/adr/0043-revenuecat-metrics.md), [ADR 0051](docs/adr/0051-insights.md), [ADR 0052](docs/adr/0052-ratings-health.md), [ADR 0053](docs/adr/0053-timeline-and-reports.md)).
</details>

<details>
<summary><b>Expo (EAS)</b></summary>

- Link an app to its Expo project: build and submit status, EAS workflows, EAS Update channels and gated rollout ([ADR 0033](docs/adr/0033-eas-integration.md), [ADR 0035](docs/adr/0035-eas-workflows.md), [ADR 0036](docs/adr/0036-eas-build-submit-status.md), [ADR 0037](docs/adr/0037-eas-update.md)). Expo `store.config.json` is read, validated and written back.
</details>

<details>
<summary><b>In-app products and price changes with safety gates</b></summary>

- Read in-app purchases and subscriptions, compare with RevenueCat, edit localized names ([ADR 0034](docs/adr/0034-in-app-products.md), [ADR 0039](docs/adr/0039-revenuecat.md)).
- Price changes are the strictest write: two off-by-default switches (`KILN_PRICE_WRITES_ENABLED` and a workspace setting), a dedicated role right, step-up confirmation, change-size limits that need acknowledgement, and a typed phrase in the cart ([docs/price-writes.md](docs/price-writes.md), [ADR 0062](docs/adr/0062-price-writes.md)).
</details>

<details>
<summary><b>Automation, webhooks and alerts</b></summary>

- Alerts (rejected version, broken credential, falling rating, failing sync) to an inbox, email, desktop notification and signed webhook ([docs/alerts.md](docs/alerts.md)); Slack and Microsoft Teams ([docs/chat-integrations.md](docs/chat-integrations.md)).
- Event stream, API tokens, outbound webhooks and an OpenAPI document ([API](docs/api/events.md), [tokens](docs/api/tokens.md), [webhooks](docs/api/webhooks.md), [openapi](docs/api/openapi.md)).
- An MCP server (off by default) so assistants such as Claude or Cursor can read a workspace and preview, never apply, store actions ([docs/mcp.md](docs/mcp.md)).
</details>

<details>
<summary><b>Security, roles, approvals and audit</b></summary>

- Roles `owner`, `admin`, `member`, `viewer`; invitations by single-use link; an audit log of every write.
- Store credentials encrypted with AES-256-GCM, never returned or logged ([docs/credentials.md](docs/credentials.md)).
- Step-up confirmation (passkey or password) for hard actions, optional TOTP and emailed codes ([ADR 0019](docs/adr/0019-step-up-confirmation.md), [ADR 0021](docs/adr/0021-two-factor-and-smtp.md)).
- Repository edits become change sets that an admin approves and that land as a branch and pull request, never a push to the default branch ([docs/api/repositories.md](docs/api/repositories.md)).
</details>

<details>
<summary><b>Desktop app and languages</b></summary>

- A Tauri desktop shell that runs Kiln in single-user mode, no login, loopback only ([ADR 0003](docs/adr/0003-single-user-mode.md), [ADR 0004](docs/adr/0004-desktop-sidecar.md)).
- Web app, server messages and the desktop menu in **English, French, Spanish and German** ([docs/i18n.md](docs/i18n.md)).
</details>

## Architecture

One TypeScript codebase, one deployable. Builds stay in your CI. More in [docs/architecture.md](docs/architecture.md).

```mermaid
flowchart LR
  subgraph Clients
    WEB["Web UI<br/>(Svelte 5)"]
    DESK["Desktop shell<br/>(Tauri)"]
    AUTO["API tokens, webhooks,<br/>MCP assistants"]
  end
  subgraph Server["Kiln server (Hono)"]
    API["API and modules"]
    SCHED["Scheduler and job queue"]
    VAULT["Vault<br/>(AES-256-GCM)"]
  end
  DB[("Database<br/>SQLite default / Postgres")]
  subgraph Connectors
    ASC["App Store Connect"]
    GP["Google Play"]
    RC["RevenueCat"]
    EXPO["Expo (EAS)"]
    REPO["GitHub repos<br/>(fastlane, Expo)"]
    AI["AI providers (opt-in)"]
  end
  WEB --> API
  AUTO --> API
  DESK -->|"starts, single-user mode"| API
  API --> DB
  API --> VAULT
  SCHED --> API
  SCHED --> DB
  API --> ASC & GP & RC & EXPO & REPO & AI
```

## Screenshots

| | |
| --- | --- |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/02-app-overview-dark.png"><img alt="App overview with the app tint, next step and navigation" src="docs/assets/screenshots/02-app-overview-light.png" width="420"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/04-store-listing-dark.png"><img alt="Store listing text tab with the locales table" src="docs/assets/screenshots/04-store-listing-light.png" width="420"></picture> |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/06-pending-changes-dark.png"><img alt="Pending changes with one row expanded to a diff" src="docs/assets/screenshots/06-pending-changes-light.png" width="420"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/08-reviews-inbox-dark.png"><img alt="Reviews inbox filtered to one app" src="docs/assets/screenshots/08-reviews-inbox-light.png" width="420"></picture> |

They are generated from the demo, so they are reproducible. The full set (13 shots, dark and light) goes to [`docs/assets/screenshots/`](docs/assets/screenshots/) with a `manifest.json` that the website reads:

```sh
pnpm demo:reset                                                          # terminal 1: seeded demo on http://localhost:8788
cd scripts/screenshots && npm install && npx playwright install chromium # once
pnpm screenshots                                                         # from the repo root, terminal 2
```

Options (`--only 02,06`, `--themes dark`, `--scale 2`, `--reset`) are in [`scripts/screenshots/README.md`](scripts/screenshots/README.md). The images are committed after a run; until then the pictures above are empty.

## Quick start

### Docker

Needs Docker. The master key encrypts your store credentials: generate it once and **keep it**, because losing it means re-entering every credential. This runs Kiln with SQLite in the `kiln-data` volume; the env file keeps the key for restarts and upgrades:

```sh
printf 'KILN_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" > kiln.env
docker run -d --name kiln --env-file kiln.env -p 127.0.0.1:8787:8787 -v kiln-data:/data \
  ghcr.io/ossappscollective/kiln:latest
```

**Docker Compose (with Postgres).** The repository's [docker-compose.yml](docker-compose.yml) builds the image from source and runs it against its own Postgres container:

```sh
git clone https://github.com/ossappscollective/kiln.git && cd kiln
printf 'KILN_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" > .env
docker compose up -d --build
```

Then open <http://localhost:8787>. The first visit asks you to create the owner account and a workspace; registration closes after that and others join by invitation link. **Claim a fresh instance before exposing it.**

- Port 8787 is published on `127.0.0.1` only (`KILN_BIND`). The server speaks plain HTTP: put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front, forward `X-Forwarded-Proto` and the original `Host`, and set `KILN_PUBLIC_ORIGIN` and, if exactly one proxy you control is in front, `KILN_TRUST_PROXY=1`. Read [docs/deployment.md](docs/deployment.md) first.
- Data lives in the `/data` volume (SQLite file, uploads, git clones); with compose, also the `pg-data` volume. Back both up, and the master key.
- Compose keeps the legacy names `mrm-data`, `pg-data` and the Postgres user `mrm` on purpose: renaming them would start an empty database ([ADR 0040](docs/adr/0040-rename-to-kiln.md)).
- **Upgrade.** Back up first. Migrations run at start. `docker run`: `docker pull ghcr.io/ossappscollective/kiln:latest`, `docker rm -f kiln`, run again with the same volume and key. Compose: `git pull && docker compose up -d --build`.

### Desktop app

Download from [Releases](https://github.com/ossappscollective/kiln/releases). Artifacts are named `kiln_<version>_<os>_<arch>.<ext>`; the exact list and how they are built is in [docs/releasing.md](docs/releasing.md).

| Platform | Look for |
| --- | --- |
| macOS, Apple Silicon | `kiln_<version>_macos_arm64.*` |
| macOS, Intel | `kiln_<version>_macos_x64.*` |
| Windows | `kiln_<version>_windows_x64.*` |
| Linux | `kiln_<version>_linux_x64.*` |

> Unsigned builds trigger warnings. **macOS Gatekeeper:** right-click the app, choose Open, then confirm (or allow it under System Settings, Privacy and Security). **Windows SmartScreen:** choose More info, then Run anyway. Only install builds you downloaded from this repository's Releases page.

The desktop app bundles its own Node and runs in single-user mode: no login, loopback only, data stays on your machine. Its menu is translated; see [apps/desktop/README.md](apps/desktop/README.md).

### Demo mode

Try the whole product with no account and no network. Stores, GitHub, AI and analytics are simulated and nothing leaves your machine (see [docs/demo.md](docs/demo.md)):

```sh
pnpm install && pnpm demo        # builds the web app, seeds "Demo Studio", serves http://localhost:8788
```

Open <http://localhost:8788/demo/login>. `pnpm demo:reset` wipes the demo data and seeds again.

## Build from source

<details open>
<summary><b>Prerequisites</b></summary>

| Tool | Version | Needed for |
| --- | --- | --- |
| Node.js | 22.18 or newer (`.nvmrc` says 22) | everything; the server runs TypeScript directly, no server build step |
| pnpm | 10.28.0 (pinned in `packageManager`), via `corepack enable` | everything |
| Rust + Tauri system dependencies | stable | **desktop app only**: see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for macOS, Windows and Linux |
| git | 2.34 or newer | reading repositories from a local clone (otherwise the GitHub API is used) |
| Docker | any recent | optional: image build, Postgres for tests |
| Postgres | 17 used in compose | optional: SQLite is the default |
</details>

```sh
git clone https://github.com/ossappscollective/kiln.git && cd kiln
corepack enable
pnpm install                   # or: pnpm install --frozen-lockfile
cp .env.example .env           # then set KILN_MASTER_KEY=$(openssl rand -base64 32)
```

| Task | Command |
| --- | --- |
| Run in development | `pnpm dev` (API on :8787, web UI on :5173 with an `/api` proxy; open <http://localhost:5173>) |
| Build the web UI | `pnpm build` (output in `apps/web/dist`) |
| Run the production build | from the repository root: `node --disable-warning=ExperimentalWarning --env-file-if-exists=.env apps/server/src/index.ts` (the server serves `apps/web/dist`; this is what the Dockerfile runs) |
| Build the Docker image | `docker build -t kiln .` |
| Build the desktop app | `pnpm build`, then `pnpm --filter @kiln/desktop build` (stages the Node sidecar, then `tauri build`); details in [apps/desktop/README.md](apps/desktop/README.md) |
| Desktop in development | `pnpm dev` in one terminal, `pnpm --filter @kiln/desktop dev` in another |
| Tests (all packages) | `pnpm test` |
| One package | `pnpm --filter @kiln/core test` (also `@kiln/server`, `@kiln/web`, `@kiln/db`, `@kiln/vault`, `@kiln/connectors`) |
| Typecheck | `pnpm typecheck` |
| Lint and format (Biome) | `pnpm lint` / `pnpm format` |
| Translations | `node scripts/i18n.mjs check --strict` (also `pnpm i18n:check`, `pnpm i18n:fix`, `pnpm i18n:scan`) |
| Demo | `pnpm demo`, `pnpm demo:reset` |

**Postgres tests.** The Postgres cases are skipped unless `KILN_TEST_POSTGRES_URL` is set:

```sh
docker compose -f docker-compose.test.yml up -d --wait
KILN_TEST_POSTGRES_URL=postgres://kiln_test:kiln_test@localhost:55432/kiln_test pnpm test
docker compose -f docker-compose.test.yml down
```

**Database.** With no `DATABASE_URL` the server uses SQLite at `./.kiln-data/kiln.db` (in Docker, `/data/kiln.db`). Set `DATABASE_URL=postgres://...` for Postgres. SQL migrations in `packages/db` run automatically at server start; SQLite and Postgres share one data model.

## Configuration

Set variables in `.env` (see [.env.example](.env.example), which documents every one) or the container environment. Only `KILN_MASTER_KEY` is required. Every store-write switch is **off by default**.

<details>
<summary><b>Environment variables</b></summary>

**Core**

| Variable | Default | Description |
| --- | --- | --- |
| `KILN_MASTER_KEY` | none, **required** | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts credentials at rest. |
| `DATABASE_URL` | SQLite `./.kiln-data/kiln.db` | `postgres://...` for Postgres. Docker image: `file:/data/kiln.db`. |
| `PORT` | `8787` | HTTP port. |
| `KILN_DATA_DIR` | `./.kiln-data` | Uploads, graphics and (by default) clones. Docker: `/data`. |
| `KILN_WEB_DIST` | `apps/web/dist` | Built web UI, relative to the working directory. |
| `KILN_MODE` | `multi` | `multi` (accounts) or `single_user` (desktop). |
| `KILN_PUBLIC_ORIGIN` | request origin | Origin for passkeys and links in emails, e.g. `https://kiln.example.com`. |
| `KILN_TRUSTED_ORIGINS` | none | Extra origins allowed to send writes (comma separated). |
| `KILN_TRUST_PROXY` | `0` | `1` when exactly one reverse proxy you control sets `X-Forwarded-For`. |
| `KILN_BIND` | `127.0.0.1` | docker compose only: address port 8787 is published on. |
| `KILN_LAUNCH_SECRET`, `KILN_ALLOWED_HOSTS` | none | `single_user` only; the desktop shell sets them itself. |

**Background work and schedules** (minutes; `0` is off where stated; only where `KILN_WORKER=inline`)

| Variable | Default | Description |
| --- | --- | --- |
| `KILN_WORKER` | `inline` | `inline` runs the job worker in the server, `off` disables it. |
| `KILN_JOB_CONCURRENCY`, `KILN_SYNC_APPLE_CONCURRENCY`, `KILN_SYNC_GOOGLE_CONCURRENCY` | `4` | Jobs at once, and requests in flight per store. |
| `KILN_SYNC_INTERVAL_MINUTES` | `30` | Scheduled read-only sync of every app; `0` off, otherwise 5 to 10080. |
| `KILN_REMINDER_INTERVAL_MINUTES`, `KILN_RELEASE_WATCH_INTERVAL_MINUTES` | `15` | Plan reminders and release watch events; `0` off. |
| `KILN_REVIEW_SYNC_INTERVAL_MINUTES` | `0` (off) | Read reviews from the stores (15 to 10080). Use 360 or less for Android. |
| `KILN_REVIEW_RETENTION_DAYS` | `365` | Days stored reviews are kept; `0` keeps all. |
| `KILN_LISTING_INTERVAL_MINUTES` | `0` (off) | Scheduled store listing reads (30 to 10080). |
| `KILN_ANALYTICS_INTERVAL_MINUTES` | `360` | Analytics reads (15 to 10080, `0` never); also needs the workspace setting. |
| `KILN_EAS_STATUS_INTERVAL_MINUTES` | `30` | EAS build/submit status reads (5 to 10080, `0` never). |
| `KILN_ASO_INTERVAL_MINUTES` | `0` (off) | Keyword and competitor checks (60 to 10080). |
| `KILN_ASO_RETENTION_DAYS` | `365` | Days rank checks and snapshots are kept; `0` keeps all. |
| `KILN_ASO_MAX_KEYWORDS_PER_APP`, `KILN_ASO_MAX_COMPETITORS_PER_APP`, `KILN_ASO_MAX_CHECKS_PER_RUN`, `KILN_ASO_RANK_DEPTH` | `50`, `10`, `25`, `50` | ASO limits. |
| `KILN_ASO_CACHE_MINUTES`, `KILN_ASO_APPLE_CALLS_PER_MINUTE`, `KILN_ASO_PLAY_CALLS_PER_MINUTE`, `KILN_ASO_HEARTBEAT_DAYS` | `60`, `10`, `4`, `7` | ASO caching, rate limits and competitor refresh. |

**Store writes and feature switches** (all `false` unless noted)

| Variable | Default | Description |
| --- | --- | --- |
| `KILN_STORE_DRAFT_WRITE_ENABLED` | `false` | Push staged listing changes to a store draft. |
| `KILN_STORE_SUBMIT_ENABLED` | `false` | Submit the pushed draft for review (irreversible from Kiln). |
| `KILN_STORE_RELEASE_ENABLED` | `false` | Release an approved version (irreversible from Kiln). |
| `KILN_STORE_ROLLOUT_ENABLED` | `false` | Change a live rollout. |
| `KILN_STORE_PUBLISH_BATCH_ENABLED` | `false` | One confirmation for several steps; does not enable the steps. |
| `KILN_STORE_PRODUCT_WRITE_ENABLED` | `false` | Edit localized in-app product names and descriptions. |
| `KILN_PRICE_WRITES_ENABLED` | `false` | Price changes (also needs a workspace setting). |
| `KILN_PRICE_MAX_RELATIVE_CHANGE_PERCENT`, `KILN_PRICE_MAX_ABSOLUTE_CHANGE`, `KILN_PRICE_MAX_TERRITORIES` | `50`, `100`, `50` | Price change guard rails. |
| `KILN_REVIEW_REPLY_ENABLED` | `false` | Public replies to reviews. |
| `KILN_EAS_UPDATE_ROLLOUT_ENABLED` | `false` | Raise an EAS Update rollout. |
| `KILN_BUILDS_DOWNLOAD_ENABLED` | `false` | Download CI artifacts and share one-time links. |
| `KILN_BUILDS_DOWNLOAD_MAX_MB` | `500` | Largest downloadable artifact (1 to 4096). |
| `KILN_PLAY_INTERNAL_SHARING_ENABLED` | `false` | Upload a build to Google Play internal app sharing. |
| `KILN_ASO_PLAY_UNOFFICIAL_ENABLED` | `false` | Read public Google Play pages (unofficial, may breach Google's terms). |
| `KILN_AI_ENABLED` | `false` | Allow AI features at all; workspaces still opt in. |
| `KILN_MCP_ENABLED` | `false` | Serve MCP at `POST /mcp`. |

**Repositories and git**

| Variable | Default | Description |
| --- | --- | --- |
| `KILN_READS` | `auto` | `auto`, `clone` or `api`: how repositories are read. |
| `KILN_CLONE_DIR` | `<KILN_DATA_DIR>/clones` | Where clones are cached. |
| `KILN_CLONE_TTL_SECONDS`, `KILN_CLONE_MAX_BYTES`, `KILN_CLONE_IDLE_DAYS`, `KILN_CLONE_SWEEP_INTERVAL_MINUTES` | `60`, `2g`, `30`, `360` | Clone freshness and clean-up. |
| `KILN_GIT_PATH` | `git` | The git program. |
| `KILN_LOCAL_REPO_ROOTS` | unset (off) | Folders that may hold local clones to read. |
| `KILN_LOCAL_REPO_WRITE` | `false` | Apply change sets as a commit on a new branch of a local clone. |
| `KILN_GIT_AUTHOR_NAME`, `KILN_GIT_AUTHOR_EMAIL` | the applying person | Author of those commits. |
| `KILN_GIT_SIGN`, `KILN_GIT_SIGNING_KEY`, `KILN_GIT_SIGNING_PROGRAM`, `KILN_GIT_GNUPGHOME` | `off` | Sign those commits with `ssh` or `gpg`. |

**Network safety and mail**

| Variable | Default | Description |
| --- | --- | --- |
| `KILN_WEBHOOKS_ALLOW_PRIVATE` | `0` | `1` allows webhooks to private and loopback addresses. |
| `KILN_TRANSLATE_ALLOW_PRIVATE_URLS` | `false` | Allow a LibreTranslate server on a private address. |
| `KILN_AI_ALLOW_PRIVATE_URLS` | `false` | Allow a local model server (Ollama, LM Studio, vLLM). |
| `KILN_SMTP_HOST`, `KILN_SMTP_PORT`, `KILN_SMTP_SECURE`, `KILN_SMTP_USER`, `KILN_SMTP_PASSWORD`, `KILN_SMTP_FROM` | unset, `587`, `starttls` | Outgoing mail; unset, an admin can enter it in Settings. |
| `KILN_SMTP_ALLOW_PRIVATE_HOSTS` | `false` | Allow a mail server on a private address. |

**Demo, desktop and tests**

| Variable | Default | Description |
| --- | --- | --- |
| `KILN_DEMO`, `KILN_DEMO_PORT`, `KILN_DEMO_DIR`, `KILN_DEMO_FORCE` | set by `pnpm demo`, `8788` | Demo mode; see [docs/demo.md](docs/demo.md). |
| `KILN_LANG`, `KILN_NODE`, `KILN_USE_PACKAGED_SERVER` | unset | Desktop development: UI language, Node binary, run the staged server. |
| `KILN_URL`, `KILN_TOKEN` | unset | Used by the MCP stdio bridge ([docs/mcp.md](docs/mcp.md)). |
| `KILN_TEST_POSTGRES_URL` | unset | Enables the Postgres test cases. |
</details>

## Project layout

```
apps/
  server/      Hono API, job worker and scheduler; serves the built web UI
  web/         Svelte 5 single-page app (Vite), locales in apps/web/locales
  desktop/     Tauri v2 shell that runs the server in single-user mode
packages/
  core/        Release lifecycle, change sets, roles, platforms, listing model (pure)
  connectors/  App Store Connect, Google Play, GitHub, Expo, RevenueCat, AI and translation clients
  db/          Portable SQL migrations, SQLite (node:sqlite) and Postgres adapters
  vault/       AES-256-GCM encryption for credentials
docs/          Architecture, ADRs, API pages, guides
scripts/       i18n tooling, email preview, stabilisation run
```

## Documentation

| Topic | Where |
| --- | --- |
| Architecture and rules | [docs/architecture.md](docs/architecture.md), [ADRs](docs/adr/) |
| Pages and navigation | [docs/ux-ia.md](docs/ux-ia.md), [docs/design-system.md](docs/design-system.md) |
| Deploying and operating | [docs/deployment.md](docs/deployment.md), [docs/troubleshooting-analytics.md](docs/troubleshooting-analytics.md) |
| Credentials for each service | [docs/credentials.md](docs/credentials.md) |
| Store write gates | [docs/price-writes.md](docs/price-writes.md), [.env.example](.env.example) |
| AI, MCP, alerts, chat | [docs/ai-features.md](docs/ai-features.md), [docs/mcp.md](docs/mcp.md), [docs/alerts.md](docs/alerts.md), [docs/chat-integrations.md](docs/chat-integrations.md) |
| HTTP API (one page per feature) | [docs/api/](docs/api/), [OpenAPI](docs/api/openapi.md) |
| Demo mode | [docs/demo.md](docs/demo.md) |
| Translating | [docs/i18n.md](docs/i18n.md), [docs/translating.md](docs/translating.md), [glossary](docs/i18n-glossary.md) |
| Releasing Kiln | [docs/releasing.md](docs/releasing.md) |
| The website | [docs/website.md](docs/website.md) |
| Open questions | [docs/open-decisions.md](docs/open-decisions.md) |
| Working with AI agents | [docs/agent-guide.md](docs/agent-guide.md) |

## Security

Kiln holds credentials that can publish apps, so it is built defensively: credentials are encrypted with AES-256-GCM under your master key, never returned or logged; every write is audited; store writes are off until enabled; hard actions can require a passkey or password. Keep `KILN_MASTER_KEY` out of version control and run the server behind TLS.

**Report vulnerabilities privately** through [GitHub security advisories](https://github.com/ossappscollective/kiln/security/advisories/new), not a public issue. Details in [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome and are licensed under Apache-2.0. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

```sh
pnpm install && pnpm dev     # develop
pnpm lint                    # Biome
pnpm typecheck
pnpm test                    # add a test with every change to core, vault, db or connectors
node scripts/i18n.mjs check --strict
```

- Commits: short imperative subject, optionally prefixed `feat(web):`, `fix(server):` or `docs:`.
- **Every user-facing string needs English, French, Spanish and German.** Add keys to all four catalogs; `i18n check` fails otherwise ([docs/i18n.md](docs/i18n.md)).
- Keep TypeScript to erasable syntax with `.ts` extensions in relative imports.

## Status

Honest summary of what is verified:

- A stabilisation run on a developer Mac (`scripts/stabilise.sh`, 2026-11-20) passed install, typecheck, lint, web build, the test suite on SQLite and on Postgres, `docker compose config`, a Docker image build, the desktop sidecar staging and `cargo check`.
- **Not yet validated against live services.** App Store Connect, Google Play, GitHub, RevenueCat, Expo, Apple Ads and AI providers are tested against hand-written fixtures and fakes; the demo uses simulated stores. Several API details are from documentation and marked UNVERIFIED in the ADRs and API pages. Test with a real account and a test app before relying on any store write.
- Many screens have not been reviewed in a real browser or desktop bundle, and macOS signing, notarization and the Windows and Linux bundles are untried ([ADR 0004](docs/adr/0004-desktop-sidecar.md)).

Expect rough edges; issues and real-account reports are the most useful contribution right now.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Kiln is an independent project and is not affiliated with, endorsed by or sponsored by Apple, Google, Expo or RevenueCat. App Store, TestFlight, Google Play, Expo, EAS, RevenueCat and other names are trademarks of their respective owners.

## Acknowledgements

Built on [Hono](https://hono.dev), [Svelte](https://svelte.dev), [Tauri](https://tauri.app), [Drizzle ORM](https://orm.drizzle.team), [Biome](https://biomejs.dev) and [Vite](https://vite.dev). Some ideas and logic are adapted from Open Screenshot Generator (MIT), see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
