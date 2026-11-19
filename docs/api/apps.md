# API: apps and store sync

Phase 2, read-only. Everything is under `/api/workspaces/:workspaceId/apps`, needs a session, and
follows the usual rules: a non-member (or an unknown workspace or app) gets
`404 {"error":"not_found"}`, a member without the right gets `403 {"error":"forbidden"}`, a bad
body gets `400 {"error":"invalid_request","issues":[{"path":"identifier","message":"..."}]}`, no
session gets `401 {"error":"unauthenticated"}`. Times are epoch milliseconds.

An **app** is one store listing (an iOS app in App Store Connect, or an Android app in Google
Play) bound to a stored credential. A **sync** reads the app's versions and tracks from the store
and keeps a snapshot of them (**releases**) in the database. Nothing is ever written to a store:
every store request is a read (see `docs/spikes/store-api-conventions.md`). Creating an app does
not contact the store; the first sync does.

## Rights

| Action                                                      | viewer | member | admin / owner |
| ----------------------------------------------------------- | ------ | ------ | ------------- |
| `apps.read`: list and read apps and their releases          | yes    | yes    | yes           |
| `apps.sync`: run a sync (now, or as a background job)       | no     | yes    | yes           |
| `apps.write`: add and remove apps, discover and import apps | no     | no     | yes           |

## Shapes

An app:

```json
{
  "id": "6f1c…",
  "name": "Acme Mobile",
  "platform": "ios",
  "identifier": "com.acme.app",
  "storeAppId": "1234567890",
  "credentialId": "b2d7…",
  "repositoryId": null,
  "createdAt": 1731900000000,
  "lastSyncedAt": 1731900600000,
  "lastSyncAttemptAt": 1731900600000,
  "lastSyncError": null
}
```

- `platform` is `"ios"` or `"android"`.
- `identifier` is the bundle id (iOS) or the package name (Android). An app is identified by
  **platform and identifier together** (unique per workspace): an iOS app and an Android app with
  the same identifier, such as a bundle id equal to a package name, are two apps with two ids.
- `storeAppId` is the store's own id: Apple's numeric app id for iOS (filled by the first
  successful sync, `null` before), the package name for Android after the first sync. Display
  `identifier`, not this.
- `repositoryId` is the linked repository, or `null`. If that repository is disconnected later,
  it reads `null` again.
- `lastSyncedAt` is the last **successful** sync (`null` = never). `lastSyncAttemptAt` is the last
  try, successful or not. `lastSyncError` is a short message for a person, set when the last
  attempt failed and cleared by the next success. It never contains a secret. While it is set the
  releases shown are still those of the last good sync, so show `lastSyncedAt` next to them.

A release (one row per version, or per version and track on Android):

```json
{
  "id": "9a3e…",
  "appId": "6f1c…",
  "platform": "android",
  "version": "2.4.0",
  "track": "production",
  "build": "240",
  "status": "rolling_out",
  "rawState": "inProgress",
  "rolloutFraction": 0.2,
  "versionCodes": ["240"],
  "storeUpdatedAt": null,
  "syncedAt": 1731900600000
}
```

- `version` is the marketing version on iOS. On Android it is the release name (the store derives
  it from the build's versionName), or the version codes joined by commas when there is no name.
- `track` is the Play track (`internal`, `alpha`, `beta`, `production`, or a custom or form-factor
  track). `null` on iOS.
- `build`: iOS, the build number of the most recently uploaded build with the same version string
  (a heuristic: the version-to-build link is not read from Apple), or `null`. Android, the
  release's version codes joined by commas, or `null`.
- `status` is the normalized lifecycle state of `@mrm/core`: `draft`, `build_chosen`, `ready`,
  `in_review`, `rejected`, `approved`, `propagating`, `rolling_out`, `live` or `halted`. It is
  `null` when the store's state has no mapping (never guessed); show `rawState` then. A Play
  track read never yields `in_review`, `rejected`, `approved` or `propagating` (the edits API does
  not expose review), and an App Store version in a "live" state is `live` even if it is a phased
  release.
- `rawState` is the store's own state name, verbatim (`READY_FOR_SALE`, `inProgress`, ...).
- `rolloutFraction` is a number from 0 to 1 when the store reports a staged rollout share, else
  `null`. It means "share of users eligible", not "installed".
- `versionCodes` is Android only (`null` on iOS).
- `storeUpdatedAt` is the store-side time we know of: the upload time of the attached build on iOS
  when Apple sent it; always `null` on Android (the API sends none).
- `syncedAt` is when this row was last confirmed by a sync.

Releases are unique per app, platform, version and track. A sync updates rows in place (their `id`
stays), adds new ones and **removes** rows the store no longer reports, so the list is a snapshot
of the store, not a history.

Order of `releases` in responses: by `track`, then `version`. Sort again client-side to taste.

## Endpoints

### `GET /apps`

`200 { "apps": [App, ...] }`, oldest first. Needs `apps.read`.

### `POST /apps`

Needs `apps.write`. Request:

```json
{
  "platform": "ios",
  "identifier": "com.acme.app",
  "credentialId": "b2d7…",
  "name": "Acme Mobile",
  "repositoryId": "c41a…"
}
```

`name` and `repositoryId` are optional. `name` (1 to 100 characters, one line) defaults to the
identifier; a sync never changes it. `201 { "app": App }`.

Validation and errors:

- `400 invalid_request`: missing or bad fields. `identifier` is checked against the platform: an
  Android package name such as `com.acme.app`, or a bundle id (letters, digits, dots, hyphens,
  at most 155 characters).
- `422 credential_not_found`: no such credential in this workspace. A credential of another
  workspace looks exactly like a missing one.
- `422 credential_kind`: iOS needs an `app_store_connect` credential, Android a `google_play`
  one. `message` says which.
- `422 repository_not_found`: `repositoryId` is not a repository of this workspace.
- `409 already_exists`: the workspace already has this identifier on this platform (iOS bundle ids
  are compared without case).

Audit: `app.create`.

### `POST /apps/discover`

Needs `apps.write`. Finds the apps behind a stored credential, so they can be added without typing
identifiers. Reads the store only; nothing is created. Request (body at most 16 KB):

```json
{ "credentialId": "b2d7…", "packages": ["com.acme.app", "com.acme.beta"] }
```

- `credentialId` is an `app_store_connect` or `google_play` credential of this workspace.
- App Store Connect: every app the key can see is listed. `packages` is ignored.
- Google Play: the Play API cannot list the apps of a developer account, so `packages` is
  **required**: 1 to 50 package names, validated like the Android `identifier` of `POST /apps`
  (`400 invalid_request` with `issues[].path` such as `packages.1` otherwise; repeats are dropped).
  Each package is verified on its own with a read-only edit that is never committed. A package that
  fails is reported in `failures` and does not fail the call.

`200`:

```json
{
  "credentialId": "b2d7…",
  "kind": "google_play",
  "candidates": [
    {
      "platform": "android",
      "storeId": "com.acme.app",
      "identifier": "com.acme.app",
      "name": "Acme Mobile",
      "alreadyAdded": true,
      "appId": "6f1c…"
    },
    {
      "platform": "android",
      "storeId": "com.acme.beta",
      "identifier": "com.acme.beta",
      "name": "Acme Beta",
      "alreadyAdded": false
    }
  ],
  "failures": [
    {
      "identifier": "com.acme.missing",
      "error": "store_not_found",
      "message": "No app com.acme.missing for this account."
    }
  ]
}
```

- `storeId` is Apple's numeric app id (iOS) or the package name (Android). `identifier` is the bundle
  id or the package name. `name` is one line of at most 100 characters.
- `alreadyAdded` is true when this workspace already has that identifier on that platform (iOS
  bundle ids compared without case); `appId` is then that app. Other workspaces never count.
- iOS candidates are sorted by name. Apps without a usable bundle id are left out.
- `failures` is always present (empty for App Store Connect). Each has an `error` code from the
  table below and a safe `message`. A problem of the credential itself (`store_auth`, API
  disabled, `rate_limited`) or the time limit ends the checks: the packages not reached carry the
  same code. A slow check keeps what was verified and marks the rest `timeout`.

Errors of the whole call:

| Status | `error`                 | Meaning                                                                                                                                         |
| ------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 422    | `credential_not_found`  | No such credential in this workspace (another workspace's looks the same)                                                                       |
| 422    | `credential_kind`       | Not an App Store Connect or Google Play credential                                                                                              |
| 422    | `packages_required`     | A Google Play credential needs `packages`                                                                                                       |
| 422    | `credential_unreadable` | The stored secret cannot be decrypted. Enter it again                                                                                           |
| 422    | `store_auth`            | The store rejected the key (App Store Connect; for Google Play it is per package)                                                               |
| 422    | `store_forbidden`       | The key is valid but has no access (App Store Connect)                                                                                          |
| 422    | `store_not_found`       | The store has no such app (App Store Connect)                                                                                                   |
| 429    | `rate_limited`          | More than 10 store reads a minute in this workspace (**shared with syncs**), or the store said slow down. `Retry-After` and `retryAfterSeconds` |
| 502    | `store_unavailable`     | The store failed or sent something unreadable                                                                                                   |
| 502    | `discover_failed`       | Anything else. The message is generic on purpose                                                                                                |
| 504    | `timeout`               | The store did not answer in time (default 60 seconds for the whole call; App Store Connect only, Google Play keeps partial results)             |

The per-package `error` codes in `failures` are `store_not_found` (no such package, or this service
account cannot see it), `store_forbidden` (no access, or the API is disabled), `store_auth`,
`rate_limited`, `store_unavailable`, `timeout` and `discover_failed`. A request refused before the
store is read (wrong credential, missing packages, bad body) costs no rate limit slot.

Audit: using the secret is recorded as `credential.use` with purpose `app.discover`. No separate
`app.discover` event, and never a secret or a store response body.

### `POST /apps/import`

Needs `apps.write`. Adds many apps in one transaction, typically from the candidates of
`POST /apps/discover`. Does not contact the store, so it is not rate limited; the first sync does.
Request (body at most 32 KB):

```json
{
  "credentialId": "b2d7…",
  "items": [
    {
      "platform": "ios",
      "identifier": "com.acme.app",
      "storeAppId": "1234567890",
      "name": "Acme Mobile",
      "repositoryId": "c41a…"
    },
    { "platform": "ios", "identifier": "com.acme.old" }
  ]
}
```

- `items`: 1 to 50. `platform` and `identifier` are validated like `POST /apps`. `storeAppId`
  (optional, letters, digits, dots, hyphens, underscores) is stored so the first sync can skip the
  lookup of the Apple id; for Android it defaults to the package name. It is taken as given, not
  checked against the store. `name` (optional, at most 100 characters) defaults to the identifier.
  `repositoryId` is optional.
- Every item must fit the credential's platform: App Store Connect for `ios`, Google Play for
  `android`. A credential therefore imports one platform per request: to add the iOS and the Android
  app that share an identifier, import with the App Store Connect credential, then with the Google
  Play credential (two requests). An item of the other platform in the same request fails alone with
  `credential_kind`. Duplicates are detected per platform and identifier only: the iOS app never
  makes the Android one `skipped`, and the other way round.

`200` (also when some items failed):

```json
{
  "results": [
    {
      "platform": "ios",
      "identifier": "com.acme.app",
      "status": "created",
      "app": { "...": "App" }
    },
    {
      "platform": "ios",
      "identifier": "com.acme.old",
      "status": "skipped",
      "error": "already_exists",
      "message": "com.acme.old is already added for ios.",
      "app": { "...": "the existing App" }
    },
    {
      "platform": "ios",
      "identifier": "com.acme.ghost",
      "status": "failed",
      "error": "repository_not_found",
      "message": "That repository is not connected in this workspace."
    }
  ],
  "summary": { "created": 1, "skipped": 1, "failed": 1 }
}
```

- `results` has one entry per item, in order. `created` carries the new `app`. `skipped` means the
  workspace already had it (an earlier import, a manual add, or a repeat in the same request) and
  carries that `app`: importing the same items again creates nothing. `failed` means that item
  could not be added: `credential_kind` (platform does not fit the credential) or
  `repository_not_found`; the other items are unaffected.
- All created apps and their audit events are written in one transaction: if the database fails,
  nothing is created and the response is `500`.
- Errors of the whole request: `400 invalid_request`, `413 payload_too_large`, `422
  credential_not_found`, `422 credential_kind` (not an App Store Connect or Google Play
  credential).

Audit: `app.create` for each created app, with `source: "import"` in the detail. Skipped and failed
items write nothing.

### `GET /apps/:id`

Needs `apps.read`. `200 { "app": App, "releases": [Release, ...] }`. `404 not_found`.

### `DELETE /apps/:id`

Needs `apps.write`. `204`, no body. Deletes the app, its releases and its stored listing history
([listing](listing.md)); nothing in the store is touched. `404 not_found`. Audit: `app.delete`.

### `POST /apps/:id/sync`

Needs `apps.sync`. No body. Reads the store with the app's credential and replaces the snapshot.
The stored secret is decrypted for this call only and never returned or logged; using it is
audited as `credential.use` (purpose `app.sync`).

After the releases are stored, the sync also reads the app's store listing (best effort, with the same
connector and credential) and records changed values for the listing drift and history views
([listing](listing.md)). A failure there never fails the sync and is not part of this response; it is
shown as `store.error` by `GET /apps/:id/listing/drift`.

Synchronous (default). It can take several seconds (default limit 60 seconds):

```json
{
  "app": { "...": "App, with the new lastSyncedAt" },
  "releases": ["Release, ..."],
  "sync": { "at": 1731900600000, "found": 3, "added": 1, "updated": 1, "removed": 0, "unmapped": 1 }
}
```

`sync.found` is the number of releases the store reported; `unmapped` is how many of them have
`status: null`. Running it again with nothing changed in the store gives `added 0, updated 0,
removed 0` and the same release ids.

In the background: `POST /apps/:id/sync?background=true` queues a job (`app.sync`) and returns
`202 { "jobId": "…" }` at once. The result appears on the app (`lastSyncedAt`, `lastSyncError`,
releases); poll `GET /apps/:id`. A job is retried with backoff for temporary failures (store
down, rate limit, timeout) and not for permanent ones (bad key, no access); either way the app's
`lastSyncError` says what happened. The job's own audit actor is `system`, and `app.sync`
records `trigger: "job"` and the user who queued it in `requestedBy`.

Errors (a failed sync is recorded in `lastSyncError` and audited as `app.sync` with `ok: false`;
the response carries the updated `app` so the screen can show it):

| Status | `error`                 | Meaning                                                                                                                                        |
| ------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 404    | `not_found`             | No such app in this workspace                                                                                                                  |
| 409    | `sync_in_progress`      | A sync of this app is already running                                                                                                          |
| 422    | `credential_not_found`  | The app's credential was deleted. Add a new app or credential                                                                                  |
| 422    | `credential_unreadable` | The stored secret cannot be decrypted. Enter it again                                                                                          |
| 422    | `store_auth`            | The store rejected the key (bad key, wrong issuer, clock skew)                                                                                 |
| 422    | `store_forbidden`       | The key is valid but has no access (role, app not invited, API disabled)                                                                       |
| 422    | `store_not_found`       | The store has no such app for this key                                                                                                         |
| 429    | `rate_limited`          | Either this workspace ran too many syncs (10 per minute) or the store said slow down. `Retry-After` header and `retryAfterSeconds` in the body |
| 502    | `store_unavailable`     | The store failed or sent something unreadable. Try again                                                                                       |
| 502    | `sync_failed`           | Anything else. The message is generic on purpose                                                                                               |
| 504    | `timeout`               | The store did not answer in time                                                                                                               |

When the store answers an unexpected 400, `message` carries Apple's own error text including the
rejected query parameter, for example `... with HTTP 400 (PARAMETER_ERROR.ILLEGAL: A given parameter
is not allowed for this request - <detail> (parameter: sort))`. The iOS build list is read with
`GET /v1/builds?filter[app]=...` and retried once with a minimal query when Apple rejects a parameter
(see the store API spike).

Every error body is `{ "error": "...", "message": "...", "app": App }` (`message` is written to be
shown; `app` is present for failures after the app was found). The 404 and 409 bodies have no
`app`, and the 429 from the workspace limit has none either.

## Audit events

`app.create` (platform, identifier, credentialId; `source: "import"` when added by import),
`app.delete`, `app.sync` (`ok`, counts or `code`, `trigger` `request` or `job`), and
`credential.use` with purpose `app.sync` or `app.discover`. Never a
secret, a token or a store response body.

## Not verified

The store connectors have only run against hand-written fixtures, never a live account (see the
spike document). The statuses above come from those mappings.
