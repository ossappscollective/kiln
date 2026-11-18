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
   code sees the normalized lifecycle in `@mrm/core`.
2. **Change sets are the only way to write.** UI edits, repo commits and, in V2, assistant
   suggestions all create a change set with a diff that a person approves. Today this is built for
   GitHub repositories only (an admin or owner approves; apply opens a pull request). No store
   write exists yet.
3. **Every write is audited**, with the actor type (user, token, assistant, system).
4. **Secrets are encrypted before they reach the database** and bound to their owner.
5. **Read before write.** No phase writes to a store until the read-only sync matches the console.
   The store connectors in `@mrm/connectors` contain no write call.
6. **Portable data model.** Text ids, epoch-millisecond times and JSON as text, so Postgres and
   SQLite share one model.

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
  server unless `MRM_WORKER=off`; handlers are registered in `apps/server/src/index.ts`.
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
- **Client address and `MRM_TRUST_PROXY`**: the client address is the socket address by default.
  With `MRM_TRUST_PROXY=1` it is the last `X-Forwarded-For` entry; set it only with exactly one
  proxy you control in front. Limits reset on restart and are not shared between instances.
- **Request limits and headers**: bodies capped at 1 MB (256 KB on sign-in, setup and invitation
  routes, `413 payload_too_large`); every response carries a Content-Security-Policy with
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and a
  Referrer-Policy. No HSTS from the server; the proxy sets it. TLS is terminated outside.
- **Writes**: cookie sessions stored hashed, a same-origin check on state-changing requests, an
  invitation stops working when its creator loses the right to invite.
- **Deployment defaults**: the container runs as the unprivileged `node` user and writes only to
  `/data`; compose publishes 8787 on `127.0.0.1` unless `MRM_BIND` says otherwise. Not verified:
  the image has never been built.
- **Desktop**: single-user mode adds loopback bind, a Host allowlist and a single-use launch secret
  ([ADR 0003](adr/0003-single-user-mode.md)).

## Automation surface

How scripts, CI and assistants use the server. Details: [tokens](api/tokens.md),
[events](api/events.md), [webhooks](api/webhooks.md), [OpenAPI](api/openapi.md).

- **Authentication** (`apps/server/src/bearer.ts`): `/api/workspaces/*` and `/api/openapi.json` take
  a session cookie, or `Authorization: Bearer mrm_...` when there is no cookie. A token is looked up
  by the SHA-256 of what was presented, belongs to one workspace, and acts for its creator with a
  role ceiling (never owner), optionally some apps and some actions. Token requests carry no cookie,
  so they skip the same-origin check that guards cookie writes; they have their own rate limit.
- **Default deny for tokens**: the operation registry (`services/api-operations.ts`) lists every
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
- [ADR 0004](adr/0004-desktop-sidecar.md): how the desktop app ships the server (proposed, not built
  into an app)
- Spikes with what was and was not verified: [docs/spikes](spikes/store-api-conventions.md)
  (store API conventions, repo conventions, Expo store config, dual dialect, sidecar, credential
  guides)
- API notes: [apps](api/apps.md), [listing](api/listing.md), [repositories](api/repositories.md), [members](api/members.md),
  [credential tests](api/credential-tests.md), [tokens](api/tokens.md), [events](api/events.md),
  [webhooks](api/webhooks.md), [OpenAPI](api/openapi.md)
- Decisions waiting for a person: [open-decisions.md](open-decisions.md)
