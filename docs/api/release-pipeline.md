# The release pipeline: where a release stands, and whether it stands still

Between "a CI run succeeded" and "it is live" a release passes a build, a prepared version, review and a release step. Each
hand-over is a place where it can be **left unfinished**: a build nobody attached, a draft nobody submitted, an approved version
nobody released. This page is about the read that says where an app is, the signal that says it has stood still, and the event
that tells a person.

Read only. It uses **this server's own tables** (the stored CI runs, the builds and versions of the last store sync, the links
between builds and runs), so reading it calls neither GitHub nor a store and costs a few queries. What it knows is as fresh as the last
sync of the app (`lastSyncedAt` says when). Routes are under `/api/workspaces/{workspaceId}`; a non-member gets `404`.

## Routes

| Route                             | Right       | Answer                                               |
| --------------------------------- | ----------- | ---------------------------------------------------- |
| `GET /apps/{id}/release/pipeline` | `apps.read` | `{ app, pipeline, lastSyncedAt, generatedAt }`       |
| `GET /release/pipeline/summary`   | `apps.read` | `{ stalledAfterHours, apps[], totals, generatedAt }` |

A token limited to some apps sees only those apps in the summary, and gets `404` for another app (like every app route).

### `pipeline`

```json
{
  "appId": "…",
  "platform": "ios",
  "state": "draft",
  "waitingOn": "you",
  "since": 1731900000000,
  "stalledAfterHours": 6,
  "stalled": {
    "step": "draft",
    "key": "draft:2.4.0",
    "anchor": "2.4.0",
    "since": 1731900000000,
    "hours": 10,
    "stale": false,
    "label": "Prepared, not submitted",
    "message": "Build 412 was uploaded 10 h ago by run #88; version 2.4.0 is still in Prepare for submission with its build and has not been submitted for review.",
    "evidence": [
      { "kind": "run", "id": "1001", "at": 1731890000000, "label": "run #88" },
      { "kind": "build", "id": "412", "at": 1731900000000, "label": "build 412 (2.4.0), VALID" },
      {
        "kind": "version",
        "id": "2.4.0",
        "at": 1731900000000,
        "label": "version 2.4.0 PREPARE_FOR_SUBMISSION"
      }
    ]
  },
  "stalls": ["…every stall, the first is `stalled`…"],
  "steps": [
    { "id": "ci", "status": "done", "at": 1731890000000, "detail": "run #88 succeeded" },
    { "id": "build", "status": "done", "at": 1731900000000, "detail": "build 412 processed" },
    { "id": "prepare", "status": "stalled", "at": 1731900000000, "detail": "…" },
    { "id": "review", "status": "todo", "at": null, "detail": null },
    { "id": "release", "status": "todo", "at": null, "detail": null }
  ],
  "summary": "…one sentence about the state…",
  "latest": { "run": null, "build": null, "version": null }
}
```

- `state`: `unknown` (never synced, nothing known), `idle`, `ci_running`, `ci_failed`, `build_processing`, `build_ready` (a
  processed build no version uses), `draft`, `in_review`, `rejected`, `approved`, `rolling_out`, `halted`, `live`. New states may be
  added.
- `waitingOn`: who has to act next: `ci`, `store`, `you` (a person), or `null` (nobody: live, or idle).
- `since`: when the thing the state is about last moved; `null` when unknown.
- `steps`: five fixed rows (`ci`, `build`, `prepare`, `review`, `release`), each `done`, `current`, `waiting`, `failed`,
  `stalled`, `todo` or `unknown`, with the time and a short wording, so a screen can draw the line without logic of its own.
- `latest`: the run, build and version the judgement rests on (the same facts, as stored), with ONE rule for what counts:
  - **What is live** is the serving set: `live`, `rolling_out` and `halted` releases (Google Play: the `production` track only; an
    internal or closed-testing release is never what is live). The newest is chosen by version, then build, never by the time Kiln first
    saw it.
  - **What is left behind is not a release.** A version still in preparation (`draft`, `build_chosen`, `ready`) that is lower than or the
    same as what is live (Google Play: all its version codes below the production codes) is never `latest.version`, never the state and
    never a stall; a build lower than the live build is never `latest.build`, never "processing" and never an orphan. The live build
    itself stays the latest build while nothing newer was uploaded. A phased 1.19.0 over an old draft 1.11.6 reads `rolling_out` (or
    `build_ready` when a newer TestFlight build waits), never `draft`.
  - The alerts (`release.stalled`), the events and signed webhooks, the timeline and the screens read this one answer; nothing has to
    be patched afterwards.
  - **Google Play "sent for review".** A release this server started in the last 7 days reads `in_review` here and in `GET /apps/{id}`
    (one overlay, `sentOverlay`), because Google reports it as live. The release watch (`release.stalled`) does NOT apply the overlay:
    a stall must not be judged on a state Google never reported.

### `summary`

One line per app, **stalled apps first** (fresh stalls before stale ones, the longest waiting first), then the others by name:
`{ app { id, name, platform, store }, state, waitingOn, since, summary, lastSyncedAt, stalled | null }` where `stalled` is
`{ step, label, message, hours, since, stale, evidence[] { kind, id, at } }`. `totals` is `{ apps, stalled, byState }`
(`stalled` counts the fresh ones only).

## What "stalled" means

A stall is a step that **should have been followed by the next one, and was not, for longer than
`release.stalledAfterHours`** (a [workspace setting](settings.md), default 6; `0` turns the signal off for the workspace, the state
is still shown). The clock starts at the last thing that moved. The steps, most advanced first (the first is `stalled`):

| `step`             | What it says                                                                                                                                     | Starts at                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `approved`         | A version was approved and nobody released it.                                                                                                   | the time the version became `approved`                                    |
| `rejected`         | A version was rejected and nothing changed since.                                                                                                | the time it became `rejected`                                             |
| `draft`            | A draft version (App Store: Prepare for Submission; Google Play: a draft release) has a build or version codes but was not submitted or started. | the newest of the state change, the build upload and the last release run |
| `build_ready`      | A processed build is not attached to any version, and nothing newer is.                                                                          | the build upload                                                          |
| `build_invalid`    | A build failed processing.                                                                                                                       | the build upload                                                          |
| `build_processing` | The store still shows a build as processing.                                                                                                     | the build upload                                                          |
| `ci_run`           | A release run succeeded, the store was read after it ended, and no new build and no state change appeared.                                       | the end of the run                                                        |

- `message` is one sentence a person can read, built from the evidence in words ("Build 412 was uploaded 6 h ago by run #88;
  version 2.4.0 is still in Prepare for submission ..."), `label` a few words for a chip, and `evidence[]` the ids and times it
  rests on (`run`: the run id; `build`: the build number; `version`: `version` or `version@track`).
- A stall older than **14 days** is `stale: true`: still shown, never reminded; an abandoned release is not news.
- A newer build of a version string that is already past "Prepare" cannot be attached to it, so it is not counted as a release left behind.
- Which runs count: the runs that were started for the app or that count for every app of the repository ([CI](ci.md#one-run-several-apps)),
  and whose workflow is the release workflow of the [conventions](ci.md#conventions-per-repository-and-per-app) (or, without one, whose
  name or file looks like `release`, `publish`, `deploy`, `ship`, `distribut`, `store`, `testflight` or `fastlane`), of the last 30 days.

## The reminder event `release.stalled`

The scheduler's release watch ([events](events.md#release-watch)) sends [`release.stalled`](events.md) for the stall `stalled` shows, **once per
episode** (a step and the thing that is stuck, `key`) and again only after `release.stalledRepeatHours` (default 24; `0`: never). When
the stall clears, the next stall is a new episode. The payload holds ids, versions and times, never the sentence, a text or a name.
It needs `KILN_RELEASE_WATCH_INTERVAL_MINUTES` not `0` and `release.stalledAfterHours` not `0`; events only: no email, no push. See
[events](events.md) for the payload and [settings](settings.md) for the keys.

## Where the facts come from (and their limits)

The store sync (`POST /apps/{id}/sync` and the scheduled one) now also keeps:

- `app_builds` (migration 28): the builds the store listed at the last sync, per app and platform (the build number, its marketing
  version, the processing state as Apple reports it and normalised to `processing`, `processed` or `invalid`, `expired`, when it was
  uploaded, when this server first saw it), at most 200 per app, replaced at each sync. **Google Play** has no processing state and
  no upload time in the API this server reads: its builds are the version codes of the releases it lists, and the time they were
  first seen is used.
- `app_releases.status_since` (migration 28): when the version last changed state, **as seen by a sync**. It is a **lower bound**: a
  change is dated at the sync that saw it, and rows that were stored before the migration are dated at their last sync, so a stall
  can be reported later than it began, never earlier.

Because the store is read at the sync interval, an app that is synced rarely shows stale facts (`lastSyncedAt`). The `ci_run` stall is
only raised when the store was read after the run ended, so "no build yet" is not mistaken for "not looked yet".

**Postgres:** the migration, the queries and the release watch have run only on SQLite; the test suite runs them on Postgres when
`KILN_TEST_POSTGRES_URL` is set.

## Stored data

Migration 28: `app_builds`, `app_releases.status_since`, `release_stall_reminders` (one row per app and platform: the episode, the step,
when it was first and last sent, and how often), `review_unanswered_reminders` (one row per workspace). The scheduler's orphan sweep and
the deletion of an app remove these rows.
