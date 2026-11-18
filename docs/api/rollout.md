# Store rollout (a store write, off by default)

Change the staged rollout of a release in the store: **Google Play** raises the share of users of a
staged rollout, halts, resumes or completes it; the **App Store** pauses, resumes or releases to all
users the phased release of a version. This is a **store write that changes who receives an update**,
so it is switched off by default (`MRM_STORE_ROLLOUT_ENABLED`), needs a separate right, a preview and
a confirmation, and some changes cannot be taken back. Design: [ADR 0008](../adr/0008-store-rollout-writes.md).

**Never run against a real store**: the connectors are tested with recorded-shape fixtures and fakes
only. The facts that were not verified are listed [below](#unverified-check-with-a-real-account).
Planning a rollout (steps and percentages that people tick off) is a different feature that writes
nothing to a store: see [plans](plans.md).

Routes are under `/api/workspaces/{workspaceId}`. A non-member gets 404, a member without the right
gets 403. The kill switch is checked after the rights check.

| Right | Who | For |
| --- | --- | --- |
| `apps.read` | every role | `GET /rollout/config` |
| `releases.rollout` | **admin and up** | read the live state, preview, **change the rollout** |

An API token holds `releases.rollout` only when its list of actions **names it** (explicit-only, like
`reviews.reply`): a token with no list never gets it, and its role must be admin or owner. A token
limited to some apps reaches those apps only (404 for others). A change made with a token is audited
with `actor_type = token`. All four routes are in the [OpenAPI description](openapi.md) (tag
`rollout`); the apply is `x-mrm-risk: destructive`.

## Routes

### `GET /rollout/config`

```json
{
  "enabled": false,
  "envName": "MRM_STORE_ROLLOUT_ENABLED",
  "actions": { "android": ["set_fraction", "halt", "resume", "complete"], "ios": ["pause", "resume", "release_to_all"] },
  "irreversible": ["complete", "release_to_all"],
  "fraction": { "exclusiveMin": 0, "exclusiveMax": 1 }
}
```

Readable while the feature is off, so a screen can explain why it is disabled.

### `GET /apps/{id}/rollout/state`

Query: Android `track` (for example `production`) and `versionCodes` (comma separated); iOS `version`
(the marketing version, for example `2.4.0`). Reads the store, **changes nothing**.

```json
{
  "app": { "id": "...", "name": "...", "platform": "android", "store": "googleplay" },
  "current": { "store": "googleplay", "platform": "android", "track": "production", "versionCodes": ["240"],
               "name": "2.4.0", "status": "inProgress", "userFraction": 0.1, "otherReleases": 1 },
  "allowedActions": [ { "action": "halt", "allowed": true, "irreversible": false },
                      { "action": "resume", "allowed": false, "reason": "...", "irreversible": false } ],
  "minUserFraction": 0.1,
  "readAt": 1700000000000
}
```

`current` for iOS: `{ store: "appstoreconnect", platform: "ios", version, storeVersionId, versionState,
phasedReleaseId, phasedReleaseState ("ACTIVE" | "PAUSED" | "COMPLETE" | null), currentDayNumber,
startDate, totalPauseDays }`. A successful read settles an earlier unknown outcome (see below).

### `POST /apps/{id}/rollout/preview`

Body: the change. Strict: unknown fields are `400`.

| Platform | `action` | Other fields |
| --- | --- | --- |
| android | `set_fraction` | `track`, `versionCodes`, `userFraction` (more than 0, less than 1, at most 4 decimals) |
| android | `halt`, `resume`, `complete` | `track`, `versionCodes`; **`resume` may also carry `userFraction`** (it must not be lower than the current share) |
| ios | `pause`, `resume`, `release_to_all` | `version` |

Reads the live state, checks the change against it, writes nothing:

```json
{ "preview": {
    "app": { "id": "...", "name": "...", "platform": "android", "store": "googleplay" },
    "action": "set_fraction",
    "target": { "track": "production", "versionCodes": ["240"] },
    "current": { "...": "as above" },
    "proposed": { "...": "the state the change leads to" },
    "summary": "Raise the rollout of 2.4.0 on production from 10% to 25%.",
    "irreversible": false,
    "confirmHash": "64 hexadecimal characters",
    "warnings": ["Google Play can take several hours to apply a change to a release."],
    "readAt": 1700000000000 } }
```

### `POST /apps/{id}/rollout/apply`

Body: the same change **plus `confirmHash`** from the preview. Answer `200`:

```json
{ "result": {
    "app": { "id": "...", "name": "...", "platform": "android", "store": "googleplay" },
    "action": "set_fraction",
    "before": { "...": "state" }, "after": { "...": "state" },
    "irreversible": false,
    "confirmedByReread": false,
    "appliedAt": 1700000000000,
    "note": "The stored copy of this app is refreshed by the next sync. ..." } }
```

`confirmedByReread: true` means the store did not answer the write but reading it back showed the
change. The hash is the SHA-256 of the workspace, the app, the target, the change and the live state
the person was shown (the App Store's `currentDayNumber` is not part of it, so a day passing does not
make a preview stale).

## Rules the server enforces

- **Off by default.** While `MRM_STORE_ROLLOUT_ENABLED` is not `true`, state, preview and apply answer
  `409 rollout_disabled` (with `envName`) and no connector is built.
- **Preview, then confirm.** Apply needs the `confirmHash`. Before writing the server **reads the
  store again** and compares it to the state the hash was made from. If it differs (somebody used
  Play Console, a different request, a different app, a wrong hash): `409 state_changed`, nothing
  written, with `current`, and `proposed`, `summary` and a new `confirmHash` when the change still
  fits (or `reason`, `problem` and `allowedActions` when it does not).
- **Google Play only goes up.** A share lower than or equal to the current one is refused
  (`422 rollout_not_allowed`, `reason: not_an_increase`), also with a valid hash. The one way down is
  `halt`. A halted release is resumed before its share is raised. `complete` (100%) is irreversible.
- **The App Store cannot be un-released.** The share per day is Apple's; there is no way to set one.
  `release_to_all` is irreversible, and nothing can be done to a finished phased release.
- **One write in flight per app and platform**, across processes (`store_rollout_claims`): a second
  change meanwhile is `409 write_in_progress`. A claim older than 3 minutes (a dead process) is taken
  over; the re-read and the hash still decide.
- **An unknown outcome is settled by looking, never by retrying.** A timeout, a cut connection or a 5xx
  on the write is never repeated (also not a 429). The server reads the store back: the change is
  there: `200` with `confirmedByReread`; the old state on the App Store: `502 write_failed` with
  `outcome: not_applied` (Apple answers synchronously); the old state on Google Play: `409
  outcome_unknown` (a commit can be slow to show); a third state: `409 state_changed`; unreadable: `409
  outcome_unknown`. `outcome_unknown` **blocks further writes to that app** until a state read or
  preview reads the store successfully.
- **Google Play never cancels a review as a side effect.** The commit uses `changesInReviewBehavior =
  ERROR_IF_IN_REVIEW`: changes in review give `409 changes_in_review`.
- **Audit and events carry ids and values only**, never a credential. A change writes the audit entry
  `release.rollout_changed` and emits the event [`release.rollout_changed`](events.md); a refusal or an
  unknown outcome writes `release.rollout_failed`. The credential's use is audited as `credential.use`
  (purpose `release.rollout`).

The audit `detail` of a change: `appId`, `store`, `platform`, `action`, the target (`track` and
`versionCodes`, or `version`), `from` and `to` (`{ status, userFraction }` or `{ phasedReleaseState }`),
`irreversible`, `hash`, `via` (`store` or `reread`).

## Errors

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | (validation) | A body that is not the shape above, or a `confirmHash` that is not 64 lowercase hexadecimal characters |
| 404 | `not_found` | Not a member, or no such app in this workspace, or a token not allowed this app |
| 403 | `forbidden` | The role (or the token) lacks `releases.rollout` |
| 409 | `rollout_disabled` | The kill switch is off |
| 422 | `invalid_rollout` | A field is wrong for the platform or the action (`field` names it) |
| 422 | `rollout_not_allowed` | The state does not allow it (`reason`: `not_an_increase`, `not_allowed`, ...; `current`) |
| 422 | `credential_not_found`, `credential_kind`, `credential_unreadable`, `app_not_synced` | The app's credential or its App Store id is not usable; no store was called |
| 422 | `store_auth`, `store_forbidden`, `store_not_found`, `store_rejected` | The store refused; nothing changed |
| 409 | `state_changed` | The store is not what was previewed (see above) |
| 409 | `write_in_progress` | Another change for this app is running |
| 409 | `changes_in_review` | Google Play has changes in review |
| 409 | `outcome_unknown` | Not known whether the store applied it |
| 429 | `rate_limited` | The store's limit (`Retry-After`) |
| 502 | `store_unavailable`, `write_failed` | The store failed; `write_failed` with `outcome: not_applied` is a confirmed no |
| 504 | `timeout` | The store did not answer in time (default 90 seconds); nothing was changed, or see `outcome_unknown` for a write |

## UNVERIFIED (check with a real account)

Verified on Google's and Apple's pages on 2026-11-18: the Play edit flow (insert, `tracks.get`,
`tracks.update`, `commit`), the release fields and statuses, `ERROR_IF_IN_REVIEW`, that Apple's PATCH
of an `appStoreVersionPhasedReleases` resource pauses, resumes or releases immediately, and Apple's
day schedule. **Not verified**, treated as unknown:

- Play: whether `tracks.update` replaces **all** releases of a track (this server sends every release
  back unchanged except the target); whether Play itself refuses a lower share; whether `halted`
  keeps `userFraction`; whether a rollout change counts as "changes in review"; which Play Console
  permission an update needs.
- Apple: the exact request body (JSON:API with `phasedReleaseState` `ACTIVE`, `PAUSED` or `COMPLETE`
  is assumed), the success status (any 2xx counts), the attribute names of the resource
  (`phasedReleaseState`, `startDate`, `totalPauseDuration`, `currentDayNumber`), the state values, what
  a version without a phased release answers (404 and `data: null` are both read as none), the 409
  for a version state that does not allow it, and which API key role may do it.
- Whether the stores' reads show a committed change at once (Google: "several hours" to reach users).
