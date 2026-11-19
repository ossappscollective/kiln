# Events

Every workspace has an event log: a row for each thing that happened that an automation might care
about. Read it with a cursor, or follow it live. The same events are pushed to
[webhooks](webhooks.md). The log is a feed, not an archive: events older than 90 days are removed
when the server starts.

Rights: `events.read` (every role). What you see depends on what you may read: `app.*` and `release.*` events need
`apps.read`, `changeset.*` and `ci.*` need `repositories.read`, `credential.*` need `credentials.read` (owner,
admin, member), `plan.*` need `plans.read` (every role), `review.*` need `reviews.read` (every role). An API token sees the same as its ceiling allows, and a token limited to some apps
sees only events about those apps; see [tokens](tokens.md). A non-member gets 404.

## Event shape

```json
{
  "id": 1042,
  "workspaceId": "...",
  "type": "app.synced",
  "subject": { "appId": "..." },
  "payload": { "found": 3, "added": 0, "updated": 1, "removed": 0, "unmapped": 0,
               "statusChanges": 1, "statusChangesTruncated": false, "trigger": "request" },
  "createdAt": 1766000000000
}
```

- `id` is a number that only goes up, across the whole server. It is the cursor.
- `subject` names what the event is about: any of `appId`, `repositoryId`, `releaseId`.
- `payload` is small plain JSON (16 KB at most; a larger one is replaced by `{ "truncated": true }`).
  Keys that look like secrets are dropped before it is stored, and **a payload never carries a
  credential, a token, a file's content or a store listing**. An event points at the thing; read the
  thing with the API.

## Types

| Type | When | Payload |
| --- | --- | --- |
| `app.synced` | An app's store sync finished and was stored (by hand, as a background job or on the schedule). A failed sync is not an event. | `found`, `added`, `updated`, `removed`, `unmapped`, `statusChanges`, `statusChangesTruncated`, `trigger` (`request`, or `job` for a background or scheduled sync) |
| `app.release.status_changed` | A sync saw a release whose normalized status differs from the stored one, or a new release after the app's first sync. | `version`, `track`, `build`, `from` (null for a new release), `to`. Subject has `appId`, and `releaseId` for a release that already existed. At most 50 per sync, sent before that sync's `app.synced`. |
| `changeset.created` | A change set was drafted. | `changeSetId`, `files` (count), `actor` |
| `changeset.approved` | A change set was approved. | `changeSetId`, `actor` |
| `changeset.applied` | A change set was applied: a pull request was opened. | `changeSetId`, `branch`, `prNumber`, `prUrl`, `commitSha`, `actor` |
| `changeset.failed` | Applying failed or timed out. | `changeSetId`, `reason`, `actor` |
| `credential.test_failed` | A credential test failed (a saved credential, or a secret tested before saving). A passing test is not an event. | `credentialId` (null when not saved), `kind`, `saved`, `actor` |
| `plan.rollout_step_done` | A person marked a step of a plan's rollout plan done (planning data; nothing was changed in a store). Asking again for a step that is already done is not an event. | `planId`, `appId`, `version`, `stepId`, `index`, `total`, `percent`, `source` (`manual`, or `store` when confirmed from the store's share), `actor`. Subject has `appId`. |
| `plan.rollout_step_skipped` | A step was skipped. | as above, without `source` |
| `plan.rollout_step_reopened` | A done or skipped step was put back to planned. | as above, without `source` |
| `plan.deadline_due_soon` | A reminder: the target date of an open plan is within the lead time (24 hours before the end of the day, UTC, by default). Sent once per plan and date. | `planId`, `appName`, `platform`, `version`, `targetDate`, `hoursLeft`, `blocked`, `openRequiredItems`, `actor` (`system`, `plan.reminders`). Subject has `appId`. |
| `plan.deadline_overdue` | A reminder: the target day is over and the plan is still open. Sent once per plan and date; not sent for a deadline more than 30 days past. | `planId`, `appName`, `platform`, `version`, `targetDate`, `daysOverdue`, `blocked`, `openRequiredItems`, `actor` |
| `plan.rollout_step_due` | A reminder: the planned time of a rollout step has passed and the step is still open. Sent once per step and planned time; not sent more than 30 days late. | `planId`, `appName`, `platform`, `version`, `stepId`, `index`, `total`, `percent`, `plannedAt`, `minutesLate`, `actor` |
| `review.new_low_rating` | A customer review with a rating at or below the workspace's threshold (setting `reviews.lowRatingThreshold`, default 2) was stored: a new one, or an existing one whose rating changed to it. Raising the threshold does not re-send events for reviews already read. Sent once per store review. Not sent for the first read of an app (a quiet baseline), and at most 50 per read. | `reviewId`, `storeReviewId`, `appId`, `store` (`appstoreconnect` or `googleplay`), `rating`, `threshold`, `source` (`new` or `edited`). **Never the review text or the display name**: read the review with [the reviews API](reviews.md). Subject has `appId`. |
| `review.sync_failed` | Reading the reviews of an app failed. Sent once per failure streak, not for every failed try; a successful read ends the streak. | `appId`, `store`, `code` (the error code), `transient`, `failures`. Subject has `appId`. |
| `review.reply_sent` | A reply to a customer review was published in the store from this server (App Store Connect or Google Play), or an unknown outcome was later confirmed as published. Not sent for a failed or unconfirmed send. | `reviewId`, `storeReviewId`, `appId`, `store`, `actor`. **Never the reply text, the review text or any name**: read the review with [the reviews API](reviews.md#replying-to-a-review). Subject has `appId`. |
| `release.rollout_changed` | A staged rollout (Google Play) or phased release (App Store) was changed in the store from this server ([rollout](rollout.md)), or an unknown outcome was later confirmed by reading the store. Not sent for a refused, failed or unconfirmed change. | `appId`, `store`, `platform`, `action` (`set_fraction`, `halt`, `resume`, `complete`, `pause`, `release_to_all`), `track` and `versionCodes` (Google Play) or `version` (App Store), `from` and `to` (`{ status, userFraction }` or `{ phasedReleaseState }`), `irreversible`, `confirmedByReread`, `actor`. Never a credential. Subject has `appId`. |
| `listing.draft_pushed` | Staged listing changes (texts, screenshots, graphics) were written to a store's **draft** from this server ([staged-changes](staged-changes.md)), or an unknown outcome was later confirmed by reading the draft. Nothing was submitted, sent for review or published. Not sent for a refused, failed or partial push. | `appId`, `store`, `platform`, `texts`, `assetSets`, `applied`, `alreadySame`, `filesUploaded`, `filesRemoved`, `commit` (`none` or `not_sent_for_review`), `submitted` (always `false`), `confirmedByReread`, `actor`. **Never a text, a file name or a credential.** Subject has `appId`. |
| `assets.pulled` | Images of a store were pulled into a draft change set ([assets](assets.md#two-way-sync)). Not sent when nothing differed or the pull failed. Nothing was written to the store or applied to the repository. | `appId`, `store`, `platform`, `changeSetId`, `written`, `deleted`, `skipped`, `unverified`, `actor`. **Never a file name, an address or bytes.** Subject has `appId` and `repositoryId`. Needs `listing.read`. |
| `listing.submitted` | The pushed draft of an app was **handed to the store's review** from this server ([submit](submit.md)): an App Review submission or a Google Play commit that sends the held back changes. Or an unknown outcome was later confirmed by reading the store (App Store only). Nothing was released and no rollout changed. Not sent for a refused, blocked, failed or unconfirmed submit. | `appId`, `store`, `platform`, `versionString` (App Store), `submissionId` (App Store, when known), `via` (`review_submission` or `edit_commit`), `released` (always `false`), `confirmedByReread`, `actor`. **Never a text, a build or a credential.** Subject has `appId`. Visible to whoever can read listings. |
| `ci.run_started` | The run sync stored a GitHub Actions run that has not finished: a run started on GitHub or here, a pending dispatch that a run took over, or a dispatch whose run GitHub named at once. Sent once per run. | `runId`, `repositoryId`, `appId` (or `null`). **Ids only**: never a title, branch, input or person; read the run with [the CI API](ci.md#runs). Subject has `repositoryId`, and `appId` when the run was started for an app. |
| `ci.run_finished` | A run that was active was seen finished. History read for the first time is not announced; a run first seen finished within the last 15 minutes is announced after its `ci.run_started`. Sent once per run. | `runId`, `repositoryId`, `appId`, `conclusion` (GitHub's word: `success`, `failure`, `cancelled`, ...). Subject as above. |

`actor` is `{ "type": "user" | "token" | "system", "id": "..." }`. The first sync of an app is a
quiet baseline: it emits `app.synced` but no status changes.

Events for change sets and credential tests are derived from the audit log at the moment the audited
change is written, in the same transaction, so an event exists exactly when the change does. The
rollout step events are written in the transaction that moves the step.

## Plan reminders

The three reminder types are sent by the server's own scheduler, not by a person, so their `actor`
is `{ "type": "system", "id": "plan.reminders" }` (and the audit entry `plan.reminder` has the same
actor, like the background sync). **They are events only: there is no email and no push
notification.** A reminder reaches a person through a [webhook](webhooks.md) receiver, the event
stream or a script that reads this log, and the web UI shows the same things as a "Due soon and
overdue" strip on the board and on the plan.

- **What is reminded.** The deadline of an open plan (its target date; checklist items have no
  due date of their own, so the checklist's deadline is the plan's) and the rollout steps of an open
  plan whose `plannedAt` has passed while still open. A plan whose version the last sync saw `live`
  is not open. A plan with a deadline or step more than 30 days past is not reminded about.
- **Once.** Each reminder is written once under the key (plan, item, kind, date or planned time) in
  the table `plan_reminders`: an `INSERT … ON CONFLICT DO NOTHING` in the same transaction as the
  event. A second tick, a restart, or a second server instance sharing the same database cannot send it
  again, and that unique key is the only lock. **Changing the date (or a step's planned time) arms it
  again**, because the key changes.
- **When.** Every `MRM_REMINDER_INTERVAL_MINUTES` (default 15; `0` is off; 5 to 10080), in the
  process that runs the scheduler (`MRM_WORKER=inline`, the default). Each run sends at most 100
  reminders; the rest wait for the next run. The lead time of "due soon" is 24 hours before the end
  of the target day (UTC); there is no workspace setting for it yet, only the `leadHours` option of
  the code.
- **Upgrade note.** The first run after an upgrade sends `plan.deadline_overdue` once for each open
  plan whose deadline passed in the last 30 days.


## `GET /api/workspaces/:wid/events`

Query:

- `since` an event id (0 or more): events after it, oldest first. Without it, the newest `limit`
  events, still oldest first.
- `limit` 1 to 200, default 50.
- `type` comma separated event types to keep.

200: `{ "events": [...], "hasMore": true, "nextCursor": 1042 }`. Ask again with
`since=<nextCursor>` while `hasMore` is true. `nextCursor` is the id of the last event returned, or
the `since` you sent when there were none, so it is always safe to store. 400 `invalid_request` for
a bad `since`, `limit` or unknown `type`.

## `GET /api/workspaces/:wid/events/stream`

Server-sent events (`text/event-stream`), with a session cookie or a bearer token.

```
event: ready
retry: 3000
data: {"cursor":1042}

id: 1043
event: app.synced
data: {"id":1043,"type":"app.synced", ... }

: heartbeat
```

- It starts with `ready`, naming the cursor it continues from.
- Each event is one message: `id` is the event id, `event` the type, `data` the event as JSON.
- It continues from `Last-Event-ID` (what a browser's `EventSource` sends when it reconnects), else
  `?since=`, else from now. Resuming from an id replays what happened after it, with no gaps and no
  repeats. A browser's `EventSource` cannot send an `Authorization` header: use a cookie there, or
  `fetch` with a stream reader for a token.
- `?type=` filters as above.
- A comment line (`: heartbeat`) is sent every 15 seconds. At each heartbeat the server checks the
  person is still a member and a token is still valid, and ends the stream if not.
- At most 5 streams per person at once; the sixth gets 429 `too_many_streams` with `Retry-After: 5`.
- On shutdown the server ends every stream, so it does not wait for clients. The client reconnects
  with `Last-Event-ID`.
- Events written by this process wake the stream within about 25 ms. The stream also polls the
  table every 2 seconds, so events written by a worker in another process arrive too.

## For code that emits events

```ts
await emitEvent(tx, { workspaceId, type: 'app.synced', subject: { appId }, payload: { ... } });
```

Pass the transaction when the thing that happened is written in one. Never call it with the
`Database` from inside a transaction callback (SQLite would wait for the transaction). New types go
in `apps/server/src/services/event-types.ts` with the action that lets a person read them, plus
this page and `webhookEventChoices` in `apps/web/src/lib/webhooks.ts` (a test fails when they drift).
`emitEvent` also queues the webhook deliveries.

## Not verified

- Only SQLite has run it; the `events` table uses `AUTOINCREMENT` there and an identity column in
  the Postgres schema, which has not been run.
- The stream was tested with in-process requests, not through a reverse proxy. A proxy must not
  buffer it (the server sends `X-Accel-Buffering: no`, which nginx honours) and must not cut idle
  connections before 15 seconds.
- Event ids on Postgres are assigned at insert; with concurrent writers a reader following the id
  could in theory see a higher id before a lower one commits. The stream re-reads from its cursor
  and a client resuming from `Last-Event-ID` has the same property. If this matters to you, use the
  webhook delivery log, or ask again from a slightly older cursor.
