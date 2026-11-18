# API: CI workflows, runs and builds

Phase 1 (GitHub Actions), tied to the Phase 2 app sync. Everything is under
`/api/workspaces/:workspaceId`, needs a session, and follows the usual rules: a non-member (or an
unknown workspace, repository or app) gets `404 {"error":"not_found"}`, a member without the right
gets `403 {"error":"forbidden"}`, a bad body or query gets `400
{"error":"invalid_request","issues":[...]}`. Times are epoch milliseconds.

**What this does and does not do.** The tool never builds anything. It asks the team's own CI to run
a workflow (`workflow_dispatch`), follows the runs, and shows which run made which store build. It
does not upload to or change any store. Starting a workflow does run the team's CI with the team's
secrets, so it is its own right (`ci.dispatch`), rate limited and audited.

**Never run against live GitHub.** Everything below was built and tested against a fake GitHub
(fixtures written from GitHub's REST documentation, [phase-1.md](../phase-1.md)). The shapes GitHub
returns for workflow runs and the compare API have not been checked against the real service.

## Rights

| Action | viewer | member | admin / owner |
| --- | --- | --- | --- |
| `repositories.read` / `apps.read`: read stored runs and builds | yes | yes | yes |
| `repositories.scan`: anything that asks GitHub (list workflows, workflow inputs, refresh runs, what changed) | no | yes | yes |
| `ci.dispatch`: start a workflow | no | yes | yes |
| `apps.sync`: link a build to a run by hand, remove such a link | no | yes | yes |

`ci.dispatch` is a member right because a member can already create change sets and sync apps; a
viewer only reads. It is a separate action (not folded into `repositories.scan`) so that a
workspace that wants only admins to run CI can change the role table in `@mrm/core` in one place.

## Workflows

- `GET /repositories/:id/workflows` returns `{ workflows: [{ id, name, path, state }], cached }`.
  `state` is GitHub's word (`active`, `disabled_manually`, ...). Kept for 60 seconds per repository
  in server memory; `cached: true` says so. Needs `repositories.scan`.
- `GET /repositories/:id/workflows/:workflow/inputs?ref=` returns the `workflow_dispatch` inputs the
  workflow file declares. `:workflow` is the file name (`ios.yml`) or the numeric id. The inputs are
  read from the YAML file at `ref` (default: the default branch) because GitHub's API does not
  return them. Needs `repositories.scan`. Cached 60 seconds per workflow and ref.

```json
{ "workflow": { "id": "1", "name": "iOS release", "path": ".github/workflows/ios.yml", "state": "active" },
  "ref": "main", "dispatchable": true, "parsed": true, "cached": false,
  "inputs": [
    { "name": "build_number", "required": true, "type": "string", "description": "Build number to upload" },
    { "name": "track", "required": false, "type": "choice", "options": ["internal", "beta"], "default": "internal" },
    { "name": "dry_run", "required": false, "type": "boolean", "default": "false" }
  ] }
```

  `type` is `string`, `boolean`, `choice`, `number` or `environment`; defaults are always text.
  `dispatchable` is `false` when the file has no `workflow_dispatch` trigger and `null` when that is
  unknown. The file is read by a small built-in YAML reader (there is no YAML dependency). When it
  cannot read the file (anchors, aliases, tags, multiple documents) the answer is `"parsed": false`
  with an empty `inputs` list, and the web dialog falls back to typed `name=value` lines. A workflow
  that GitHub does not list is `404 workflow_not_found`.

## Dispatch

`POST /repositories/:id/workflows/:workflow/dispatches` needs `ci.dispatch`.

```json
{ "ref": "main", "inputs": { "build_number": "241", "track": "beta" }, "appId": "…" }
```

- `ref` (optional): a branch or tag, default the repository's default branch.
- `inputs` (optional): at most 25. Names are letters, digits, `_` and `-`; values are sent to GitHub
  as text (numbers and booleans are converted).
- `appId` (optional): the app this run builds. It must be an app of this workspace that is linked to
  this repository (`422 app_not_found`, `422 app_repository_mismatch` otherwise). The run is then
  tied to the app, and its inputs let it be matched to that app's builds.

`202` answers `{ dispatched: true, runKnown, run }`. GitHub's dispatch endpoint does not say which
run it started, so the tool stores a **pending run** (`id` starts with `pending-`, `status`
`pending`) at once and `ci.poll` replaces it with the real run when GitHub lists a `workflow_dispatch` run of the same
workflow and branch that was created after the dispatch (a minute of clock difference is allowed;
the run keeps the inputs and the app). A pending run that GitHub never shows is
dropped after 10 minutes. `runKnown` is `true` only when GitHub did name the run.

```json
{ "dispatched": true, "runKnown": false,
  "run": { "id": "pending-d09d0bef-…", "repositoryId": "…", "appId": "…", "workflow": "ios.yml",
           "workflowPath": "ios.yml", "title": null, "status": "pending", "conclusion": null,
           "active": true, "headSha": null, "commitMessage": null, "branch": "main",
           "event": "workflow_dispatch", "runNumber": null, "url": null,
           "inputs": { "build_number": "241", "track": "beta" }, "dispatchedBy": "…",
           "startedAt": 1731900000000, "updatedAt": 1731900000000, "syncedAt": 1731900000000 } }
```

Limits and failures: at most **10 dispatches per workspace per minute** (`429 rate_limited` with
`Retry-After`; a refused request counts too). GitHub refusing the dispatch (no `workflow_dispatch`
trigger, a bad input, a missing ref) is `422 github_invalid` with GitHub's message; other GitHub
errors are `422 github_auth | github_forbidden | github_not_found`, `502 github_unavailable`, and
`504 timeout`. After a timeout the workflow **may still have started**: the message says to look at
the runs before trying again. Every dispatch is audited as `ci.dispatch` (workflow, ref, the
**names** of the inputs, never their values, the app, `ok`, the run id when known, or the error
`code`) and the credential use as `credential.use` (purpose `ci.dispatch`).

## Runs

Runs live in the `workflow_runs` table (migration 10). Reads of the list and of one run come from
that table, so every member can read them and GitHub is not asked.

- `GET /repositories/:id/workflows/runs` needs `repositories.read`. Query: `limit` (1 to 100,
  default 30), `workflow` (name or file), `branch`, `appId`, `active=true` (only runs that have not
  finished), `refresh=true` (read GitHub first; needs `repositories.scan`, else `403`). Answer:
  `{ runs, active, refreshed, refreshedAt }`. `active` is how many runs of the repository have not
  finished (the web panel polls while it is above zero). Newest first.
- `GET /repositories/:id/workflows/runs/:runId?refresh=true` returns `{ run }` from the table; when
  the run is not stored (or `refresh=true`) a member reads it from GitHub, and it is stored.
  A viewer gets `404` for a run that is not stored. `422 run_not_found` is used by build linking.

A run:

| Field | Meaning |
| --- | --- |
| `id` | GitHub's run id, or `pending-…` for a dispatch GitHub has not named yet |
| `workflow`, `workflowPath` | the workflow's name and file |
| `title` | the run's `run-name`, else GitHub's default (the commit or pull request title) |
| `status`, `conclusion` | GitHub's words, kept verbatim: `queued`, `in_progress`, `completed`, `waiting`, ...; `success`, `failure`, `cancelled`, ...; `pending` is ours |
| `active` | the run has not finished (`queued`, `in_progress`, `waiting`, `requested`, `pending`) |
| `headSha`, `commitMessage` | the commit (first line of its message) |
| `branch`, `event`, `runNumber`, `url` | as GitHub reports them |
| `inputs`, `dispatchedBy`, `appId` | set when this tool started the run |
| `startedAt`, `updatedAt`, `syncedAt` | run times from GitHub, and when we last read it |

**How the table is kept fresh.** `refresh=true` reads the repository's 50 most recent runs; any
stored run that is still active but missing from them (a busy repository) is asked for one by one
(at most 10). Reads of one repository are **at least 8 seconds apart whoever asks**, two at once
share one request, and a read that is too soon returns the stored rows with `"refreshed": false`.
The `ci.poll` job follows a repository while a run is active: first poll 5 seconds after a
dispatch, then a growing delay (`min(10 s × 1.5^attempt, 60 s)`), until no run is active or **3
hours** after the first poll. A GitHub rate limit waits for what GitHub asks; a temporary failure
(`502`, `504`) retries through the job queue's backoff; a permanent one (bad credential, no access)
is audited once as `ci.poll` with the error `code` and ends the chain. The reads are audited as
`credential.use` (purpose `ci.poll`). Runs older than 90 days are dropped unless they explain a
build link. Disconnecting a repository, or deleting an app, removes its rows on the next scheduler
tick. Every call to GitHub has the same 90 second timeout as the other repository calls, and is aborted
when it runs out.

## Builds of an app

The builds of an app are the build numbers the **last store sync** stored: an iOS build number per
version (the newest processed build of that version string) and the Android version codes of each
track's release. A build that no version points to is not listed. A sync replaces the snapshot, so
a build that has left the store reports disappears here too (its stored link stays until the app is
deleted, and is shown if the build comes back).

- `GET /apps/:id/builds` needs `apps.read` and reads only our own tables. Answer:
  `{ app, repository, matchers, builds }`. `repository` is `{ id, owner, repo }` or `null` (an app
  that is not linked to a repository lists its builds, all unlinked). `matchers` lists the
  matchers in use, in order. Builds are sorted by platform, then the highest number first.

```json
{ "platform": "ios", "buildNumber": "240", "version": "2.4.0", "tracks": [],
  "status": "rolling_out", "rawState": "READY_FOR_SALE", "uploadedAt": 1731900000000, "syncedAt": 1731900100000,
  "linkState": "linked",
  "link": {
    "state": "linked", "source": "run_title", "manual": false,
    "reason": "title \"Release 2.4.0 (build 240)\" (build N)", "candidates": 1,
    "linkedAt": null, "linkedBy": null,
    "run": { "id": "1001", "workflow": "iOS release", "title": "Release 2.4.0 (build 240)",
             "status": "completed", "conclusion": "success", "active": false,
             "url": "https://github.com/acme/app/actions/runs/1001", "branch": "main",
             "startedAt": 1731900000000, "updatedAt": 1731900060000 },
    "commit": { "sha": "3333…", "shortSha": "3333333", "message": "Second change",
                "url": "https://github.com/acme/app/commit/3333…" } } }
```

An unlinked build has `"linkState": "unlinked", "link": null`. `link.run` is `null` when the run
has left the table and no address was kept; with a kept address `run.status` is `"unknown"`.
`link.manual` is `true` for a link made by hand; `source` is `manual` or the matcher's id.

### Build-number conventions

A build is linked to a run **by its number, never by guessing** from time or branch. A run carries
a build number in one of these ways; a team picks whichever fits its workflow, and the matchers are
tried in this order (the first that finds any run wins; among its runs, a successful one beats a
failed one, then the newest):

1. **`dispatch_input`**: the run was started with an input that names the number: `build_number`,
   `build` or `build_no` (either platform), `ios_build_number`, `ios_build`, `cf_bundle_version` or
   `bundle_version` (iOS), `version_code`, `android_version_code`, `android_build_number` or
   `android_build` (Android). Names compare
   without case, dashes or underscores; the value must equal the build number exactly. This is
   the most reliable one, and works for runs this tool dispatches with that input.
2. **`run_title`**: the run's title (the workflow's `run-name:`) says `build 240`, `Build #240`,
   `build_number=240`, `iOS build 240`, `Android versionCode 241`, `version code: 241`,
   `2.4.0 (240)` or `2.4.0+240`. A title equal to the commit message is ignored (so "fix build 3
   failures" never links build 3), a bare version (`Build 2.4.0`) is not a number, and a platform
   prefix limits the match to that platform. A `run-name` is evaluated when the run starts, so it
   can only hold a number known then: a dispatch input, the run number, or a counter the team keeps.
3. **`run_number`** (not on by default): the build number equals the workflow's run number plus an
   offset, as with fastlane's `increment_build_number(build_number: ENV["GITHUB_RUN_NUMBER"])`. Run
   numbers are per workflow and collide easily, so it needs the workflows it applies to named
   (`runNumberMatcher` in `services/build-links.ts`); there is no setting for it yet.

A run without a commit never links a build. Matchers are a plain list (`BuildMatcher`), so another
convention is one more object in `createCiContext(..., { matchers })`. Links found by a matcher are
stored on every refresh (`build_links`, `source` the matcher id), so they survive the run leaving
the table. **A manual link beats every matcher and is never replaced by one.**

### Link by hand

- `PUT /apps/:id/builds/:platform/:buildNumber/link` with `{ "runId": "1000" }` needs `apps.sync`.
  The run must belong to the app's repository (stored, or read from GitHub now) and have a commit.
  Answer `{ build }` (a build as above). Audit `build.link` (platform, build number, run id, sha).
- `DELETE /apps/:id/builds/:platform/:buildNumber/link` removes the manual link only; what the
  matchers find applies again. `404` when there is no manual link. Audit `build.unlink`.

Errors (all `422` unless noted): `no_repository` (the app has no repository), `build_not_found` (the
app has no such build; sync first), `run_not_found` (GitHub has no such run in this repository),
`run_without_commit`, plus the GitHub errors above. A bad `platform` (not `ios` or `android`), build
number or `runId` is `400`.

## What changed

`GET /apps/:id/builds/changes?platform=ios&build=240&base=238` needs `repositories.scan` (it calls
GitHub's compare API). `base` is optional: by default the build before `build` on the same platform
that is linked to a commit. Both builds need a link; the commits compared are the runs' `headSha`.

```json
{ "platform": "ios",
  "base": { "buildNumber": "238", "version": "2.2.0", "sha": "1111…", "shortSha": "1111111" },
  "head": { "buildNumber": "240", "version": "2.4.0", "sha": "3333…", "shortSha": "3333333" },
  "status": "ahead", "aheadBy": 2, "behindBy": 0, "totalCommits": 2, "truncated": false,
  "url": "https://github.com/acme/app/compare/1111111...3333333",
  "commits": [
    { "sha": "3333…", "shortSha": "3333333", "title": "Second change", "message": "Second change",
      "author": "Grace", "date": 1731900200000, "url": "https://github.com/acme/app/commit/3333…" },
    { "sha": "2222…", "shortSha": "2222222", "title": "First change", "message": "First change\n\nbody",
      "author": "Ada", "date": 1731900100000, "url": "https://github.com/acme/app/commit/2222…" }
  ] }
```

`status` is GitHub's word (`ahead`, `behind`, `identical`, `diverged`); `commits` are **newest
first**. At most 100 commits are listed: when GitHub reports more, `truncated` is `true` and the
newest are kept. Two builds made from one commit answer `identical` without asking GitHub. The
answer for a pair of commits is cached for 10 minutes. Audit: `credential.use` (purpose
`ci.compare`). Errors: `404 build_not_found`, `422 build_not_linked` (the build or the `base` has
no commit), `422 no_base_build` (no earlier linked build), `422 no_repository`, and the GitHub
errors above.

## Scheduled sync

There is no cron and no extra process: a small scheduler runs where the job worker runs
(`MRM_WORKER=inline`, the default) and only **queues jobs**; the worker runs them through the normal
handlers, so a sync keeps its audit trail and retries.

- **`MRM_SYNC_INTERVAL_MINUTES`** (default `0`, off): queue an `app.sync` job for every app whose
  last sync attempt, successful or not, is older than this. `0`, or a value from `5` to `10080`
  (one week); anything else stops the server at start. It is off by default because a sync reads the
  stores with the stored credentials.
- The scheduler ticks every minute (first tick 10 seconds after start). Each queued job gets a
  **random delay** of up to a tenth of the interval (at most 5 minutes), so a workspace does not
  sync all its apps in the same second. An app with a sync job already waiting or running is
  skipped, and so is one attempted recently (a failing credential is retried once per interval,
  not once per tick).
- It **takes slots from the same rate limiter as `POST /apps/:id/sync`** (10 per minute per
  workspace), so scheduled and manual syncs share one budget; when a workspace is out of slots its
  remaining apps wait for the next tick. A tick also queues at most 5 apps per workspace and 100 in
  total, longest-waiting first.
- Every tick, whether or not the interval is set, queues a `ci.poll` for each repository that has a
  run still active (started within the last 3 hours) and no poll waiting: a safety net for a
  restart or a failed job ending a poll chain. It also deletes `workflow_runs` and `build_links`
  rows whose repository or app is gone.
- The audit actor of a scheduled sync is `system`, like any background sync.

## Stored data

Migration 10 adds `workflow_runs` (one row per run: unique on repository and run id; indexed on
repository and start time) and `build_links` (one row per app, platform and build number). Neither
has a foreign key to repositories or apps, the scheduler cleans orphans. Run inputs are stored as
sent (they are values a person typed into a dispatch; do not put secrets in workflow inputs).
**Postgres:** the migration, the tables and the SQL have run only on SQLite; the test suite runs
them on Postgres when `MRM_TEST_POSTGRES_URL` is set.

## Error codes

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | a bad body or query (`issues` say which) |
| 403 | `forbidden` | the role lacks the right, or `refresh=true` without `repositories.scan` |
| 404 | `not_found` | not a member, or an unknown repository, app or run; `workflow_not_found`, `build_not_found` have their own codes |
| 422 | `ci_unsupported` | the connection cannot read CI runs |
| 422 | `app_not_found`, `app_repository_mismatch` | `appId` of a dispatch |
| 422 | `no_repository`, `build_not_found`, `build_not_linked`, `no_base_build`, `run_not_found`, `run_without_commit` | builds, links, changes |
| 422 | `github_auth`, `github_forbidden`, `github_not_found`, `github_invalid` | GitHub refused (`message` says what) |
| 429 | `rate_limited` | too many dispatches; `Retry-After`, `retryAfterSeconds`; or GitHub's own limit |
| 502 | `github_unavailable` | GitHub could not be reached |
| 504 | `timeout` | GitHub did not answer in time |
