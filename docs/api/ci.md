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
returns for workflow runs, the compare API, tags, commits and releases have not been checked
against the real service. In particular: GitHub does not document the order of `GET /tags` or
paging for `git/matching-refs`; whether `GET /tags` returns an annotated tag's commit (it is assumed
to, as it returns the tagged commit) is unverified, and a tag the tool cannot resolve is
reported, not guessed. The layout was modelled on a real fastlane lane, but only read, never run.

## Rights

| Action | viewer | member | admin / owner |
| --- | --- | --- | --- |
| `repositories.read` / `apps.read`: read stored runs and builds, and the "running now" list (stored runs, plus the job progress a member read lately) | yes | yes | yes |
| `repositories.scan`: anything that asks GitHub (list workflows, workflow inputs, refresh runs, the jobs of a run, the refresh behind "running now", what changed, read tags for the preview, re-run matching) | no | yes | yes |
| `repositories.write`: save the build-number conventions | no | no | yes |
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

**How the table is kept fresh.** `refresh=true` reads the repository's 50 most recent runs as a
**conditional request** when the connection supports it (the connector keeps the `ETag` of the last
read in memory and sends `If-None-Match`; GitHub answers `304`, which does not count against the rate
limit, while nothing changed, and then nothing is rewritten and no active run is asked for by id); any
stored run that is still active but missing from them (a busy repository) is asked for one by one
(at most 10). Reads of one repository are **at least 8 seconds apart whoever asks**, two at once
share one request, and a read that is too soon returns the stored rows with `"refreshed": false`.
The `ci.poll` job follows a repository while a run is active: first poll 5 seconds after a
dispatch, then a growing delay (`min(15 s × 1.5^attempt, 60 s)`: 15, 22, 34, 51, then 60 seconds),
until no run is active or **3 hours** after the first poll. A GitHub rate limit waits for what GitHub asks; a temporary failure
(`502`, `504`) retries through the job queue's backoff; a permanent one (bad credential, no access)
is audited once as `ci.poll` with the error `code` and ends the chain. The reads are audited as
`credential.use` (purpose `ci.poll`). Runs older than 90 days are dropped unless they explain a
build link. Disconnecting a repository, or deleting an app, removes its rows on the next scheduler
tick. Every call to GitHub has the same 90 second timeout as the other repository calls, and is aborted
when it runs out.

## Following runs: "running now" and jobs

A run started here or on GitHub is followed until it finishes. Two reads feed the screens (the
Dashboard of an app, All apps, and the run panel); neither stores anything new (there is no
migration): the runs come from `workflow_runs`, the jobs are kept in memory.

- `GET /ci/runs/active` (under `/api/workspaces/:workspaceId`) needs `repositories.read`. Query:
  `repositoryId` (comma separated, at most 50) narrows it to those repositories, as an app's
  dashboard does. Answer:

```json
{ "runs": [ { "id": "1001", "repositoryId": "…", "appId": null, "workflow": "iOS release", "title": "Release 2.4.0",
              "status": "in_progress", "conclusion": null, "active": true, "branch": "main", "startedAt": 1731900000000,
              "repository": { "id": "…", "owner": "acme", "repo": "app" },
              "actor": "octocat",
              "progress": { "jobsTotal": 3, "jobsDone": 1, "job": "test", "step": "Run tests",
                            "stepsDone": 2, "stepsTotal": 5, "fraction": 0.4, "readAt": 1731900100000 } } ],
  "recent": [ { "…": "runs finished in the last 24 hours: failed first, then newest; at most 20" } ],
  "repositories": [ { "id": "…", "owner": "acme", "repo": "app" } ],
  "problems": [ { "repositoryId": "…", "reason": "no_access" } ],
  "refreshedAt": 1731900100000, "live": true, "cached": false }
```

  `runs` are the runs that have not finished (a dispatch GitHub has not named yet is `pending`),
  newest first, with the fields of a run above. `actor` is the GitHub login that started the run; the
  table has no column for it, so it is kept in memory for a day and is `null` until a read since the
  last restart saw the run. `progress` is `null` for a run that has not started, when the jobs were not
  read, or (for a viewer) when nobody read them lately. `problems` lists repositories GitHub could not
  be read for, with a reason from a fixed list (`no_access`, `rate_limited`, `unavailable`,
  `unsupported`; never GitHub's own text); the answer is still `200`, and a client shows one quiet
  pill. A repository that cannot be read is left alone for 10 minutes (30 seconds for a temporary
  failure, as long as GitHub asked for a rate limit), and a repository without a local-only flag is
  the only kind covered (a local-only repository has no GitHub).

  **Budget.** Whoever has `repositories.scan` makes the answer live: before reading the table the
  repositories are refreshed through the same run sync as `?refresh=true` and `ci.poll` (conditional
  reads, at least 8 seconds apart per repository whoever asks, one request shared by concurrent
  callers). A repository with a run going is looked at that often; one with none at most **once a
  minute** (that is how a run started on GitHub itself is noticed), at most 25 repositories per answer,
  four at a time. For the runs in progress (12 at most) the jobs are read too (below). A viewer gets
  `"live": false`: the stored rows and whatever progress a member read lately, never a GitHub read.
  An answer is kept **5 seconds** per workspace, role kind and repository set, and requests that arrive
  while it is being made share it (`cached: true`). The route is limited to **60 requests per workspace
  per minute** (`429 rate_limited`, `Retry-After`; a cached answer counts). An API token limited to some
  apps sees only the repositories of those apps, and of their runs only those that belong to no app or to
  one of them (the filtering is done in the route; the operation is registered with the `list` app scope
  so such a token may call it). Reads are audited like the other run reads (`credential.use`, purposes
  `ci.poll` and `ci.jobs`).

- `GET /repositories/:id/workflows/runs/:runId/jobs` needs `repositories.read`. Answer
  `{ runId, jobs, truncated, readAt, cached, live }` where a job is `{ id, name, status, conclusion,
  startedAt, completedAt, url, steps: [{ number, name, status, conclusion, startedAt, completedAt }] }`
  (GitHub's words for status and conclusion, times in epoch milliseconds). **Names, states and times
  only: no logs, no runner details.** A member or admin reads GitHub (`GET /actions/runs/:id/jobs`, one
  page of 100 jobs, a conditional read; kept 10 seconds while the run is going, 2 minutes after it
  finished, shared between concurrent callers); a viewer gets `live: false` with what a member read in
  the last 30 minutes, possibly no jobs, and `404` for a run that is not stored. `422 ci_unsupported`
  when the connection cannot read jobs, `404` when GitHub has no such run, `400` for an id that is not a
  number (a `pending-…` placeholder). An API token limited to some apps cannot call it.

### Events

`ci.run_started` and `ci.run_finished` (see [events](events.md)) are written when the run sync
stores a run: a run that appears active, a pending dispatch that a run adopts, a dispatch that GitHub
named at once, and an active run seen finished. The payload is **ids only** (`runId`, `repositoryId`,
`appId` or `null`) plus the `conclusion` word on a finish. History read for the first time is not
announced; a run first seen already finished is announced (both events) only when it finished in the
last 15 minutes, which means it ran between two reads. Subject: `repositoryId`, and `appId` when the run
was started for an app (so an app limited token hears about its own).

## Builds of an app

The builds of an app are the build numbers the **last store sync** stored: an iOS build number per
version (the newest processed build of that version string) and the Android version codes of each
track's release. A build that no version points to is not listed. A sync replaces the snapshot, so
a build that has left the store reports disappears here too (its stored link stays until the app is
deleted, and is shown if the build comes back).

- `GET /apps/:id/builds` needs `apps.read` and reads only our own tables. Answer:
  `{ app, repository, matchers, builds, diagnostics }`. `repository` is `{ id, owner, repo }` or `null` (an app
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

### Linking through tags (the usual case for fastlane lanes)

Most release workflows cannot be matched by title or input: the build number is decided **inside**
the run (fastlane reads the store's latest number and adds one), the lane commits the bump (`chore:
new build`) and tags that commit, for example `ios/appstore/1.2.3/123`. The run's `head_sha` is
the commit **before** the bump, so the number is not on the run at all. The chain is

> build number -> tag (or GitHub release) -> the tag's commit -> the run that made it

and every step is stored as evidence. It is tried for a build that no matcher above settled:

1. **Names.** The tags and releases of the repository are read (`GET /tags`, five pages of 100 at
   most; when that is cut short, a targeted read of `git/matching-refs/tags/<prefix>`; `GET
   /releases`, two pages) and compared with the **patterns** below. A name that fits and carries
   the build number (and, when the name says so, the platform) is a candidate. A different version
   in the name does not exclude a candidate, it only ranks it lower.
2. **Commit.** The commit of the best candidates is read (`GET /commits/:sha`, parents and commit
   time; at most 30 reads per search, the newest build numbers first, cached for a day because a
   commit never changes).
3. **Run.** A stored run is the run of that build when its `head_sha` is the commit's **parent**
   (the bump on top of the run's head) or the commit itself, or when the commit was made while the
   run was running (started to last update, with 10 seconds before and a minute after as slack: the
   Android job of a lane commits on top of the iOS job's bump, so only the time fits). Runs of the
   configured release workflow are preferred; with none configured, a workflow whose name or path
   says release, publish, deploy, ship, distribute, store, testflight or fastlane.

| Confidence | When |
| --- | --- |
| `high` | one run fits, both by parent/head and by time, in the configured or a recognised release workflow |
| `medium` | one run fits by only one of the two (time alone is the usual case for the Android job), or several runs fit and only one fits both, or only one contains the commit in time |
| `low` | several runs fit and none stands out, or the workflow is not recognised as a release one |

A low link is looked at again on the next search. If a tag is found but no run (the run has left
the table, or the commit was made outside every run) the build is in the **"Tag found"** state:
`linkState: "tag"`, `link.state: "tag"`, `link.run: null`, with the tag's commit and the reason.
It becomes a run link as soon as the run is stored. Order of precedence: a manual link, then a
matcher (title, input, run number), then a tag link. A tag link is replaced when a matcher finds a
run later, and a tag link that has a run is never downgraded to "tag found".

The search runs after the runs are refreshed (a `GET .../workflows/runs?refresh=true`, the scheduled
sync, or "Re-run matching"); reading builds never calls GitHub. A failed search is stored and shown
(`diagnostics.scanError`); it never fails the refresh. A build whose link is settled (a matcher or
a manual link, or a tag link that is not `low`) is not searched again.

A linked build carries the evidence:

```json
"link": { "state": "linked", "source": "tag", "confidence": "high",
  "evidence": { "kind": "tag", "tag": "ios/appstore/1.2.3/123", "releaseName": null,
    "pattern": "{prefix}{platform}/{flavor}/{version}/{buildNumber}",
    "sha": "bbbb…", "parents": ["aaaa…"], "committedAt": 1731900480000, "message": "chore: new build",
    "versionMatch": true, "runId": "5001", "noRunReason": null,
    "reason": "tag \"ios/appstore/1.2.3/123\" has the number; its commit is a child of run 5001's head, in the release workflow",
    "confidence": "high" }, "run": { "…": "…" }, "commit": { "sha": "bbbb…", "message": "chore: new build", "…": "…" } }
```

`source` is `tag` or `release` for a link found this way. `commit` is the **tag's** commit (the
bump), not the run's head.

An unlinked build has `diagnostic: { code, message }` saying why, and `diagnostics` of the answer
says what was searched:

| `diagnostic.code` | Meaning |
| --- | --- |
| `no_tags` | the repository has no tags and no releases |
| `no_pattern_fit` | tags exist but none fits a pattern: add a pattern |
| `number_not_found` | names fit, but none has this build number (the newest fitting number is in `diagnostics.newestFit`) |
| `other_platform` | only tags of the other platform carry the number |
| `tag_without_commit` | a tag carries the number but its commit could not be read |
| `tag_without_run` | (of "Tag found" links) the commit leads to no stored run |
| `scan_failed` | the last search failed (`diagnostics.scanError`) |
| `not_searched` | tags have not been searched since this build was synced |

`diagnostics` is `{ scannedAt, scanOk, scanError, patterns: { tags, releases, prefix, workflow,
usingDefaults, source }, tags: { seen, truncated, sample, targeted }, releases: { seen, truncated,
error }, newestRelease, fitting, newestFit, runs: { stored, newestAt }, canReadTags }`, or `null`
for an app without a repository.

### Tag and release patterns

A pattern is a name with placeholders, compiled to an anchored, case-insensitive match in which
every part is bounded (there is no backtracking to speak of). Text outside placeholders is
literal: `(a+)+$` in a pattern is just those characters.

| Placeholder | Matches |
| --- | --- |
| `{buildNumber}` | 1 to 10 digits (leading zeros are ignored when comparing); **required** |
| `{version}` | `1.2.3` (up to four dotted numbers), with an optional `-beta.1` suffix |
| `{platform}` | letters; `ios`, `iphone`, `ipados` mean iOS, `android` Android, anything else is another platform |
| `{flavor}` | free text, up to 40 characters (`appstore`, `playstore`) |
| `{prefix}` | the literal prefix of the convention (a monorepo's `TAG_PREFIX`) |
| `*` | up to 80 characters of anything but a line break (release patterns only) |

Limits: 120 characters a pattern, 20 patterns per list, a prefix of 40 characters, at most two `*`
and never side by side, no control characters, and tags have no whitespace. A pattern list that
breaks a limit is refused with the reason, not run.

Defaults (used while a convention stores none):

- tags: `{prefix}{platform}/{flavor}/{version}/{buildNumber}`, `{prefix}release/{version}/{buildNumber}`,
  `{prefix}{platform}/{version}/{buildNumber}`, `{prefix}{platform}-{version}-{buildNumber}`,
  `{prefix}v{version}+{buildNumber}`, `{prefix}{version}+{buildNumber}`,
  `{prefix}v{version}-{buildNumber}`, `{prefix}{version}-{buildNumber}`,
  `{prefix}v{version}({buildNumber})`, `{prefix}{version}({buildNumber})`, `{prefix}build-{buildNumber}`
- releases: `*({platform}): v{version} Build {buildNumber}` (the form `<app>(ios): v1.2.3 Build 123`),
  `*: v{version} Build {buildNumber}`, `*v{version} Build {buildNumber}`,
  `*{version} (build {buildNumber})`, `*v{version} ({buildNumber})`, `*{version} ({buildNumber})`,
  `*Build {buildNumber}`

The pattern engine is `@mrm/core` (`build-patterns.ts`), shared by the server and the web preview.
Not matched: iOS build numbers with dots (`1.2.3`), and Mac Catalyst tags.

### Conventions per repository and per app

Where a team's tags do not fit the defaults (or two apps of a monorepo share version and build
numbers and tell apart only by tag prefix), the conventions are stored. One set per repository, and
optionally one per app that overrides it. Nothing is stored by default: patterns empty means the
defaults.

- `GET /repositories/:id/build-conventions[?appId=]` needs `repositories.read`, reads only our
  tables. Answer `{ repositoryId, appId, stored, repository, effective, defaults }`; `stored` is
  `null` when nothing is stored for the scope, `effective` is what matching uses
  (`{ tagPatterns, releasePatterns, prefix, workflow, usingDefaultTags, usingDefaultReleases,
  source }`, `source` `app`, `repository` or `defaults`). An `appId` that is not an app of the
  workspace is `404`.
- `PUT /repositories/:id/build-conventions` needs `repositories.write` (a body of 16 KiB at most,
  else `413 payload_too_large`). Body `{ appId?, tagPatterns, releasePatterns, prefix?, workflow? }`
  (strict: unknown keys are refused). `workflow` is a workflow file name, path or name to prefer
  (`release.yml`), or `null`. Saves for the repository, or for `appId` (which must be an app linked
  to this repository: `422 app_not_found` / `app_repository_mismatch`). An invalid pattern list is
  `400` with `issues`. Answer is the view above. Audit `build.conventions` (the patterns are in the
  detail). Saving replaces the scope; saving empty lists returns it to the defaults.
- `GET /repositories/:id/build-conventions/tags` needs `repositories.scan`: the repository's tag
  names and release names as read now (500 tags and 200 releases at most; `tagsTruncated`,
  `releasesTruncated`, `releasesError`, `readAt`), cached for a minute. It feeds the live preview of
  the web dialog. A failure is the GitHub error, never an empty list. Using the credential is
  audited (`credential.use`, purpose `ci.tags`).
- `POST /apps/:id/builds/rematch` needs `repositories.scan`. It reads the runs, the tags and the
  releases of the app's repository again, bypassing the caches, matches that app's builds and
  answers `{ app, repository, matchers, builds, diagnostics, rematch: { scanned, written, error } }`.
  `scanned` is false when every build was settled (nothing was searched). 6 requests a minute per
  workspace (`429 rate_limited`, `Retry-After`). `422 no_repository`. Audit `build.rematch`.

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

Migration 12 adds `build_conventions` (one row per repository, and per app that overrides it:
`app_id` is `''` for the repository's; unique on repository and app; the patterns as JSON, the
prefix and the preferred workflow), `build_scans` (one row per repository: when the tags were last
searched, whether that worked, the error, and a JSON summary with what was seen and why each build
did not link) and `build_links.evidence_json`. A "Tag found" link has `run_id = ''` and the tag's
commit in `head_sha`. The scheduler deletes the rows of a repository or app that is gone. Like the
tables below, they have no foreign keys, and the Postgres side has not been run (see below).

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
| 413 | `payload_too_large` | a conventions body over 16 KiB |
| 422 | `app_not_found`, `app_repository_mismatch` | `appId` of a dispatch or of a conventions body |
| 422 | `no_repository`, `build_not_found`, `build_not_linked`, `no_base_build`, `run_not_found`, `run_without_commit` | builds, links, changes |
| 422 | `github_auth`, `github_forbidden`, `github_not_found`, `github_invalid` | GitHub refused (`message` says what) |
| 429 | `rate_limited` | too many dispatches or re-matches; `Retry-After`, `retryAfterSeconds`; or GitHub's own limit |
| 502 | `github_unavailable` | GitHub could not be reached |
| 504 | `timeout` | GitHub did not answer in time |
