# EAS builds and submissions of an app

The builds and the submissions of the Expo (EAS) project an app record is linked to, as one more source in "Builds to test"
([ADR 0036](../adr/0036-eas-build-submit-status.md)). Needs the link of [eas.md](eas.md) (an Expo credential and a project). **Read only:**
nothing is created, cancelled or resubmitted at Expo. The routes are under `/api/workspaces/:workspaceId/apps/:appId/eas/status`.

| Route | Right | What it does |
| --- | --- | --- |
| `GET /status` | `builds.read` | The stored snapshot. Database only: Expo is not called. |
| `POST /status/refresh` | `apps.sync` | Reads Expo with the credential of the link, replaces the snapshot, answers like `GET`. Shares the budget of the app syncs (10 a minute per workspace). |

Members and above can read; viewers cannot (as for the other builds). Non-members and apps of another workspace are `404`. A token limited to
some apps may use both for those apps only.

## The snapshot

`{ status: { project, supported, builds[], submissions[], active, sync } }`.

- `project`: `{ fullName, projectId, url, credentialAvailable }`, or `null` when the app has no link (then everything else is empty).
  `supported` is `false` for a macOS record (EAS builds iOS and Android only).
- `builds[]`, newest first: `id`, `platform` (this tool's: `ios` or `android`), `status` (`new`, `in_queue`, `in_progress`, `pending_cancel`,
  `finished`, `errored`, `canceled` or `unknown`, with Expo's own word in `rawStatus`), `active` (not ended), `buildProfile`, `channel`,
  `appVersion`, `buildNumber` with `buildNumberLabel` ("Build" or "Version code"), `sdkVersion`, `runtimeVersion`, `distribution` (`store`,
  `internal`, `simulator`) and `internal`, `simulator`, `appIdentifier`, `gitCommitHash`, `gitCommitMessage` (first line, 200 characters),
  `error` (`{ code, message }`, 500 characters of Expo's text, when it failed), `hasArtifact`, `artifactExpiresAt`, `createdAt`, `updatedAt`,
  `completedAt`, `expoUrl`.
- `submissions[]`, newest first: `id`, `platform`, `status` (`awaiting_build`, `in_queue`, `in_progress`, `finished`, `errored`, `canceled`,
  `unknown`), `buildId` and `build` (its version, when that build is in the snapshot), `store` (`appstoreconnect` or `googleplay`, derived from
  the platform, with its console name), `identifier` (bundle id or package name), `track` and `releaseStatus` (Google Play), `error`,
  `createdAt`, `completedAt`, `expoUrl`.
- `sync`: `readAt` (last successful read, `null` before the first), `lastAttemptAt`, `lastError` (a short code such as `expo_auth`, never
  Expo's text), `consecutiveFailures`, `buildsTruncated` and `submissionsTruncated` (the newest page of 30 was full: older ones exist at Expo
  and are not shown).

An app record shows the builds and submissions of **its own platform**: an iOS and an Android record linked to one project each read their
side. **The address of a build file is never stored or returned.** `hasArtifact` says that Expo holds one; `expoUrl` is the page of the build
at expo.dev (logs and, where the build has one, the install link), so the switch `MRM_BUILDS_DOWNLOAD_ENABLED` stays the only way a build
file leaves through this server. Times are epoch milliseconds.

## Refreshing

The snapshot is refreshed by the scheduler (`MRM_EAS_STATUS_INTERVAL_MINUTES`, default 30, `0` off, 5 to 10080; an app record whose snapshot
has a build or a submission that has not ended is read again after three minutes) and by `POST /status/refresh`. Only linked app records with
a usable Expo credential are ever read, one job per credential at a time, spaced and bounded like the other scheduled reads. After a failed
read the scheduler waits (10 minutes, doubled for every failure in a row, at most 6 hours); a manual read never waits. A failed read keeps the
old snapshot and records the failure in `sync`. Removing the link, or linking another project, deletes the snapshot.

Refresh errors: `409 not_linked`; `422` `platform_unsupported`, `credential_not_found`, `credential_kind`, `credential_unreadable`,
`expo_auth`, `expo_forbidden`, `expo_not_found`; `429 rate_limited` (our budget, or Expo's, with `Retry-After`); `502 expo_unavailable`;
`504 timeout`. Messages are fixed sentences.

## Audit

Every read of Expo is a `credential.use` with purpose `eas.status` (scheduled reads as the system). A manual refresh is also audited as
`eas.status_refresh` (target: the app; detail: `appId`, `projectId`, counts). Neither holds the token or a build file address.

## In the app

"Builds to test" lists EAS builds next to CI artifacts and store builds (source filter "EAS builds"), with profile, channel, runtime,
distribution and commit; a failed build shows Expo's reason. A section "EAS submissions" lists submissions with their store, state and
reason. While something runs the page reloads the stored status every minute. "Read again" also asks Expo.
