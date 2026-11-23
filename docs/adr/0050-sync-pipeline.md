# 0050. The store sync pipeline

Status: accepted. Related: [0030](0030-workspace-sync-setting.md), [0049](0049-testflight-feedback.md). Logic for worker pools, independent feeds and
critical-first ordering is adapted from Open Screenshot Generator (MIT), see THIRD_PARTY_NOTICES.md.

## Why

Syncing felt slow. Reading the code, the time went here, in order of weight:

1. **One job at a time.** The worker (`jobs.ts`) ran a single job per process, so every `app.sync`, `listing.read`, `review.sync`,
   `analytics.sync`, `aso.refresh` and `eas.status` of every app waited for the one before. Queue order was creation order, so a heavy
   analytics read could sit in front of every app's release state.
2. **Sequential feeds inside a job.** The analytics job read its sources (up to eight per app) one after another, and `readStore` read versions,
   builds and version-to-build links one after another.
3. **Reads of one credential were forced into a single file** (`serialized(credentialId)` in reviews and analytics), which would have cancelled any
   gain from running several jobs.
4. **A Google token exchange per connector.** Each module builds its own connector, so one Play sync round exchanged the same service account
   assertion several times (Apple JWTs are signed locally, about a millisecond, and were not a cost).
5. **"Sync all" in the web app was one app after another.**

Already fine (kept): page size 200 on Apple lists, incremental reviews (`since` / cursor), the listing read shared between `app.sync` and the
scheduled listing job (a recent read from any path is not started again), 429 with Retry-After honoured and bounded in `StoreHttp`.

## What changed

- `KILN_JOB_CONCURRENCY` (default 4; 1 is the old behaviour): the worker runs several jobs, each claimed by exactly one slot.
- **Critical first**: `claimNext` ranks due jobs by queue: `app.sync` and `listing.read`, then `review.sync`, then `eas.status`, then `analytics.sync` and
  `aso.refresh`. Unknown queues (webhooks, mail, chat) rank first. Analytics and ASO are "heavy" and fill at most `concurrency - 1` slots. A job never runs
  before its `run_at`.
- **Per host limits** (`services/sync-pipeline.ts`): one gate in front of `globalThis.fetch` limits requests in flight to App Store Connect
  (`KILN_SYNC_APPLE_CONCURRENCY`, 4) and to Google (`KILN_SYNC_GOOGLE_CONCURRENCY`, 4) separately. A 429 sets a shared pause for that host (the
  Retry-After, at most 120 s, 5 s without one), so parallel work cannot become a burst; `StoreHttp` still waits and retries as before. Other hosts pass through.
- **Credential lanes**: two reads of one credential at once instead of one.
- **Independent feeds**: the analytics sources of an app run three at a time; each keeps its own run record and state, one failing never stops another.
  `readStore` reads versions, builds and links side by side.
- **One Google token per account and scope**, shared by every connector of the process until a minute before expiry (hash key, redacted like a minted one;
  dropped on 401).
- **Visible progress**: `GET /workspaces/{id}/sync/activity` (feeds being read, jobs waiting) and a small "Syncing now" line on the apps overview. "Sync all"
  syncs three apps at once; the workspace budget of 10 syncs a minute still counts each.

- **One Sync per app (2026-11-23)**: `POST /apps/:id/sync-all` queues one job per kind the app has (`app.sync`, `review.sync`, `eas.status`, `analytics.sync`),
  in the order the worker ranks them, answers `202` with a plan (a skipped kind says why: `forbidden`, `not_linked`, `off`, `not_ready`, `already_queued`) and
  counts as one sync of the workspace budget. It reads no store. The web header Sync uses it (with `?without=app`, having run the app sync directly) so the
  per-page sync buttons are gone; the Status popover lists each source and its progress from the sources' stored status. Products and TestFlight feedback
  still have no queue; the browser runs their own routes after the plan. Moving them to jobs is a follow-up.
  The header Sync is page-scoped (`lib/sync-plan.ts`): the web app asks for `?kinds=` (and `?sources=` for a retry of failed analytics sources, carried in the
  job payload) so one press reads only what the page needs; "Sync everything" in its menu is the old whole run.

## Measured (fake store, not real timings)

`sync-pipeline-bench.test.ts` runs the real worker, host gate and pool against a fake store answering after 8 ms: 6 apps, each with an app sync (3 reads),
a review sync (1) and an analytics sync (5 sources x 3 reads); analytics queued first, the worst case. Same 114 requests in both runs.

| | whole round | release state of all apps stored by |
|---|---|---|
| before (1 job at a time, sequential feeds) | 989 ms | 989 ms |
| after (4 jobs, host limit 4, priority, parallel sources) | 244 ms | 46 ms |

About 4x for the round, bounded by the host limit of 4, and about 20x for the first useful data. These numbers show the shape of the pipeline. They say
nothing about real Apple or Google latency, whose requests are slower and rate limited.

## Not verified (no real store accounts)

- Real timings, and whether 4 requests in flight per host stays within Apple's hourly budget for a large account (the gate and `KILN_SYNC_*_CONCURRENCY`
  are the knobs; lower them first if 429s appear). Google Play per-app quotas under parallel analytics sources.
- Apple `If-None-Match` / `If-Modified-Since` support on the App Store Connect API was not verified, so no conditional requests were added.
- The `include=build` read in `listVersionBuilds` stays "unverified against the live API", as before.

## Follow-ups

Read Apple analytics report files ahead (`readAhead` exists and is tested, not yet wired), the per-locale screenshot reads of the listing (two requests per
locale, in turn), Sales and Trends days in a pool of four as Open Screenshot Generator does, and a scheduler that queues the feeds of one app together.
