# Architecture

One TypeScript codebase and one deployable. Clients call one API. The API talks to the
database, asset storage, the stores and GitHub. Builds stay in the team's own CI.

```
Web UI · Tauri shell · CLI and webhooks
                 |
        Core service (one codebase)
   API server · Domain modules · Job worker
       Database · Asset storage
                 |
   App Store Connect · Google Play (read-only) · GitHub
                 |
   Apple API · Google Play API · your CI (fastlane or EAS)
```

## Rules the code follows

1. **Connectors hide the stores.** Apple and Google model releases differently (separate review
   resources versus one transactional Play edit). Only connectors know that. The rest of the
   code sees the normalized lifecycle in `@kiln/core`.
2. **Change sets are the only way to write.** UI edits, repo commits and, in V2, assistant
   suggestions all create a change set with a diff that a person approves. Today this is built for
   repositories only (an admin or owner approves; apply opens a pull request on GitHub, or, opt-in,
   commits to a new branch of a local clone and optionally pushes it). No store write exists yet.
3. **Every write is audited**, with the actor type (user, token, assistant, system).
4. **Secrets are encrypted before they reach the database** and bound to their owner.
5. **Read before write.** No phase writes to a store until the read-only sync matches the console.
   The store connectors in `@kiln/connectors` contain no write call.
6. **Portable data model.** Text ids, epoch-millisecond times and JSON as text, so Postgres and
   SQLite share one model.

## Code layout

- **Server modules.** A feature that can be added or removed (`aso`, `analytics`, `reviews`, `alerts`,
  `ci`, `builds`, `listing`, `publish`, `planning`, `ai`) is a folder under `apps/server/src/modules/<id>/` with `index.ts` (its
  `Deps` type and the `ServerModule` that mounts it), routes, service, `operations.ts` and tests.
  `app.ts` lists the modules; removing one means removing its line and its folder. The module
  contract is in `modules/module.ts`.
- **Expo (EAS).** `modules/eas/` links an app record to its EAS project with an Expo access token (credential kind `expo`, client in
  `packages/connectors/src/expo/`); EAS features add their parts there ([ADR 0033](adr/0033-eas-integration.md)).
- **In-app products.** `modules/monetization/` reads in-app purchases and subscriptions into a stored snapshot (capability
  `inAppPurchases`) and has one gated write, the display name and description of one locale; prices and availability are read-only
  ([ADR 0034](adr/0034-in-app-products.md), [api/products](api/products.md)).
- **Store experiments.** `modules/experiments/` reads Apple's Product Page Optimization experiments and custom product pages into a stored
  snapshot (capability `storeExperimentsApi`; read only) and keeps a manual tracker for what no API exposes (Google Play)
  ([ADR 0048](adr/0048-store-experiments.md), [api/experiments](api/experiments.md), [spike](spikes/store-experiments.md)).
- **TestFlight feedback.** `modules/testflight/` reads Apple's beta feedback and crash reports into a stored copy (capability
  `testflightFeedbackApi`; read only), groups crashes by signature, triages them like reviews and raises `testflight.feedback` and
  `testflight.crash` alerts; the read rides on the review job ([ADR 0049](adr/0049-testflight-feedback.md),
  [api/testflight-feedback](api/testflight-feedback.md), [spike](spikes/testflight-feedback.md)).
- **Store writes.** `modules/publish/` holds everything that writes to a store: staged changes, the draft push,
  version, submit, release, rollout and the pending/publish batch. Each step keeps its own switch, right and
  test seams (`PublishDeps`); the listing module reads staged state from it.
- **Operations layer.** `apps/server/src/operations/` holds the OpenAPI/token/MCP registry. Each
  feature owns an operations array (in its module, or `operations/<name>.ts` for the rest);
  `registry.ts` only joins them.
- **Platforms are data.** `packages/core/src/platform.ts` has one row per platform with its facts and
  a `capabilities` record. Code asks `supports(platform, capability)` or `byFamily`, never
  "is it iOS"; a new platform is a new row plus a connector (ADR 0032).
- **Same grouping elsewhere.** Web `lib/` and `components/`, `@kiln/core` and `@kiln/connectors` group
  files by feature folder (`aso/`, `analytics/`, `listing/`, `apple/`, `google/`, ...).

## What runs where

- `apps/server`: Hono API (`routes/`), services (`services/`), the job worker (`jobs.ts`), and the
  static web UI. Routes: auth, workspaces and credentials, credential tests, members and
  invitations, repositories and change sets, apps and sync, audit.
- `packages/connectors`: GitHub (App or token), fastlane and Expo store config files, and the
  read-only App Store Connect and Google Play connectors with their status mappings.
- `packages/db`: portable SQL migrations applied at boot (migration 6 adds `apps` and
  `app_releases`), SQLite through `node:sqlite` or Postgres.

## Store sync and the job queue

An **app** is one store listing (iOS or Android) bound to a stored credential; a **sync** reads its
versions and tracks and replaces a snapshot in `app_releases` (rows are updated in place, new ones
added, ones the store no longer reports removed). It is read-only toward the store
([docs/api/apps.md](api/apps.md)).

- Inline: `POST /apps/:id/sync` runs the sync in the request (60 second default limit).
- As a job: `POST /apps/:id/sync?background=true` enqueues an `app.sync` job and returns `202`.
  The worker is the database-backed queue in `jobs.ts` (no Redis): claiming is optimistic and
  portable, delivery is at least once, stale running jobs are recovered, temporary failures retry
  with backoff, and a job finishes only for the attempt that claimed it. The worker runs inside the
  server unless `KILN_WORKER=off`; handlers are registered in `apps/server/src/index.ts`.
- The secret is decrypted for one call, never returned or logged, and its use is audited
  (`credential.use`). A failed sync keeps the last good snapshot and records a redacted error on the
  app. Syncs of one app do not overlap (`409 sync_in_progress`) and are rate limited per workspace.
- A job's audit actor is `system`; the user who queued it is recorded as `requestedBy`
  ([open-decisions.md](open-decisions.md)).
- Only SQLite has run this, against fixtures ([docs/phase-2.md](phase-2.md)).

## Security hardening of the hosted server

Summary; the operator-facing detail is in [docs/deployment.md](deployment.md).

- **Rate limits** (`apps/server/src/limiter.ts`): in-memory, per process, counted before the slow
  password hash runs so parallel guesses cannot all pass. Separate instances for sign-in per email
  address, sign-in per client address (looser), and bad invitation tokens, so one cannot evict the
  others. Credential tests and app syncs have their own per-workspace limits (10 per minute each).
- **Client address and `KILN_TRUST_PROXY`**: the client address is the socket address by default.
  With `KILN_TRUST_PROXY=1` it is the last `X-Forwarded-For` entry; set it only with exactly one
  proxy you control in front. Limits reset on restart and are not shared between instances.
- **Request limits and headers**: bodies capped at 1 MB (256 KB on sign-in, setup and invitation
  routes, `413 payload_too_large`); every response carries a Content-Security-Policy with
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and a
  Referrer-Policy. No HSTS from the server; the proxy sets it. TLS is terminated outside.
- **Writes**: cookie sessions stored hashed, a same-origin check on state-changing requests, an
  invitation stops working when its creator loses the right to invite.
- **Deployment defaults**: the container runs as the unprivileged `node` user and writes only to
  `/data`; compose publishes 8787 on `127.0.0.1` unless `KILN_BIND` says otherwise. Not verified:
  the image has never been built.
- **Desktop**: single-user mode adds loopback bind, a Host allowlist and a single-use launch secret
  ([ADR 0003](adr/0003-single-user-mode.md)).

## Naming

The product is **Kiln**: packages are `@kiln/*`, environment variables `KILN_*`, the session cookie
`kiln_session`, API tokens `kiln_...`, local data `.kiln-data` and `kiln.db`. No earlier name is read
anywhere. The few old labels that are kept because they key stored or derived data are listed in
[ADR 0040](adr/0040-rename-to-kiln.md).

## Automation surface

How scripts, CI and assistants use the server. Details: [tokens](api/tokens.md),
[events](api/events.md), [webhooks](api/webhooks.md), [OpenAPI](api/openapi.md).

- **Authentication** (`apps/server/src/bearer.ts`): `/api/workspaces/*` and `/api/openapi.json` take
  a session cookie, or `Authorization: Bearer kiln_...` when there is no cookie. A token is looked up
  by the SHA-256 of what was presented, belongs to one workspace, and acts for its creator with a
  role ceiling (never owner), optionally some apps and some actions. Token requests carry no cookie,
  so they skip the same-origin check that guards cookie writes; they have their own rate limit.
- **Default deny for tokens**: the operation registry (`operations/registry.ts`) lists every
  documented route with its permission and risk. A token may call only listed routes whose action
  tokens may hold, never token, member, credential-value or webhook management. The registry also
  produces `GET /api/openapi.json`; tests check it against the routes the app really has.
- **Audit**: a token request records the actor as `token` (id and name) with the creator in
  `detail.onBehalfOf`. The routes did not change for this: `recordAudit` reads the token from the
  request's async context (`AsyncLocalStorage`).
- **Events** (`services/events.ts`): `emitEvent(sql, ...)` writes a row to `events` (pass the
  transaction, so the event exists only if the change does) and queues webhook deliveries. Change
  set and credential-test events are derived inside `recordAudit`; sync events are emitted by
  `syncApp`. Read by cursor (`GET /events`) or live (`GET /events/stream`, server-sent events with
  `Last-Event-ID`, a heartbeat, a cap of 5 streams per person, closed at shutdown).
- **Webhooks** (`services/webhooks.ts`, `webhook-transport.ts`): one delivery row and one job per
  matching endpoint, HMAC-SHA256 signed, retried by the job queue, logged. The transport is the
  SSRF boundary: public addresses only, checked after resolving and again after connecting, no
  redirects, bounded time and size.

## Release lifecycle

`draft → build_chosen → ready → in_review → approved → rolling_out → live`

with `rejected` looping back to `draft` through a fix, `halted` reachable from `rolling_out`,
and Android passing through `propagating` after release. Blocked is a flag on any state.
The dashboard groups states into preparing, in review, ready to release and live.

## Decisions

- [ADR 0001](adr/0001-stack-and-license.md): stack, license, packaging
- [ADR 0002](adr/0002-node-sqlite-and-sql-migrations.md): `node:sqlite` and SQL migrations
- [ADR 0003](adr/0003-single-user-mode.md): single-user mode for the desktop app
- [ADR 0004](adr/0004-desktop-sidecar.md): how the desktop app ships the server (Node binary plus one
  esbuild bundle; not built into an app yet)
- Spikes with what was and was not verified: [docs/spikes](spikes/store-api-conventions.md)
  (store API conventions, repo conventions, Expo store config, dual dialect, sidecar, credential
  guides)
- API notes: [apps](api/apps.md), [listing](api/listing.md), [assets](api/assets.md), [repositories](api/repositories.md), [members](api/members.md),
  [credentials](api/credentials.md), [credential tests](api/credential-tests.md), [tokens](api/tokens.md), [events](api/events.md),
  [webhooks](api/webhooks.md), [OpenAPI](api/openapi.md)
- Decisions waiting for a person: [open-decisions.md](open-decisions.md)
