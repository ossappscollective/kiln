# Configuration

Kiln is configured with environment variables, usually in a `.env` file (`cp .env.example .env`). The file [`.env.example`](../../.env.example) is the complete reference, with a comment for every variable. This page is the short version: what you must set, and the switches that matter.

## Required

| Variable | What it does |
| --- | --- |
| `KILN_MASTER_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts store credentials at rest. Losing it means entering every credential again. |

## Storage and process

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | SQLite file in the data folder | A `postgres://` address for Postgres, or `file:` for SQLite. |
| `KILN_DATA_DIR` | `./.kiln-data` (`/data` in the image) | Screenshots, videos, icons and the SQLite file. |
| `PORT` | `8787` | The port the server listens on. |
| `KILN_WORKER` | `inline` | `inline` runs the background job worker inside the server; `off` disables it. |
| `KILN_MODE` | `multi` | `multi` is the server with accounts. `single_user` is the desktop app: no login, loopback only. |

## Network

| Variable | Default | What it does |
| --- | --- | --- |
| `KILN_BIND` | `127.0.0.1` | Compose only: the address port 8787 is published on. |
| `KILN_TRUST_PROXY` | `0` | `1` when exactly one reverse proxy you control sets `X-Forwarded-For`. |
| `KILN_PUBLIC_ORIGIN` | the request's origin | The origin passkeys are bound to, and the address in alert email buttons. |
| `KILN_TRUSTED_ORIGINS` | none | Extra origins allowed to send state-changing requests. Only needed when the UI is served from somewhere other than the server. |

## Store writes (all off by default)

Reading and syncing never depend on these. Each one enables one kind of write, and a person still confirms it in the app. Owners and admins only, and an API token only when its actions name the right permission.

| Variable | Enables |
| --- | --- |
| `KILN_STORE_DRAFT_WRITE_ENABLED` | Writing listing drafts to a store. |
| `KILN_STORE_SUBMIT_ENABLED` | Submitting a draft for store review. |
| `KILN_STORE_RELEASE_ENABLED` | Releasing a version. |
| `KILN_STORE_ROLLOUT_ENABLED` | Changing a live rollout (Google Play staged rollout, App Store phased release). |
| `KILN_STORE_PUBLISH_BATCH_ENABLED` | Publishing several steps at once. It turns no step on by itself: each step still needs its own switch. |
| `KILN_REVIEW_REPLY_ENABLED` | Public replies to customer reviews. A reply cannot be recalled. |
| `KILN_STORE_PRODUCT_WRITE_ENABLED` | Changing the name and description of in-app products. |
| `KILN_PRICE_WRITES_ENABLED` | Changing prices. Also needs a workspace setting, a permission, step-up confirmation where covered, and a typed phrase. |
| `KILN_EAS_UPDATE_ROLLOUT_ENABLED` | Raising the rollout percentage of an EAS Update. |
| `KILN_PLAY_INTERNAL_SHARING_ENABLED` | Uploading a CI build to Google Play internal app sharing. |
| `KILN_BUILDS_DOWNLOAD_ENABLED` | Downloading CI artifacts through the server. |

## Opt-in features

| Variable | Default | What it does |
| --- | --- | --- |
| `KILN_AI_ENABLED` | `false` | While false, nothing is ever sent to an AI provider. A workspace still has to choose a provider and add a key. |
| `KILN_MCP_ENABLED` | `false` | The MCP endpoint for AI assistants. Assistants preview store actions and never apply them. |
| `KILN_REVIEW_SYNC_INTERVAL_MINUTES` | `0` | How often reviews are read, in minutes. `0` is off; Google Play keeps only 7 days, so use 360 or less for Android. |
| `KILN_REVIEW_RETENTION_DAYS` | `365` | Days a stored review is kept. `0` keeps all. |
| `KILN_ASO_INTERVAL_MINUTES` | `0` | How often keywords and competitors are checked from public store data. |
| `KILN_ASO_PLAY_UNOFFICIAL_ENABLED` | `false` | Google Play has no official search API; this reads public pages, which may be against Google's terms. Read the comment in `.env.example` first. |
| `KILN_ANALYTICS_INTERVAL_MINUTES` | `360` | How often analytics are read. Analytics are also off per workspace until an admin turns them on. |

## Mail

`KILN_SMTP_HOST`, `KILN_SMTP_PORT`, `KILN_SMTP_SECURE`, `KILN_SMTP_USER`, `KILN_SMTP_PASSWORD` and `KILN_SMTP_FROM` set the mail server used for emailed confirmation codes and alert emails. It is optional. Without it, everything else works. An admin can also enter the server in the web app, where it is saved encrypted.

## Demo mode

`KILN_DEMO=true` (or `pnpm demo`) runs the simulated stores. It never reads your `.env` or your real data folder. See [the demo guide](../../docs/demo.md).
