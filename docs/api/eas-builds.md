# EAS builds and submissions of an app

The builds and the submissions of the Expo (EAS) project an app record is linked to, as one more source in "Builds to test"
([ADR 0036](../adr/0036-eas-build-submit-status.md)). Needs the link of [eas.md](eas.md) (an Expo credential and a project). **Read only:**
nothing is created, cancelled or resubmitted at Expo. The routes are under `/api/workspaces/:workspaceId/apps/:appId/eas/status`.

| Route                  | Right         | What it does                                                                                                                                           |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /status`          | `builds.read` | The stored snapshot. Database only: Expo is not called.                                                                                                |
| `POST /status/refresh` | `apps.sync`   | Reads Expo with the credential of the link, replaces the snapshot, answers like `GET`. Shares the budget of the app syncs (10 a minute per workspace). |

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
  `error` (`{ code, message }`, 500 characters of Expo's text, when it failed), `hasArtifact`, `artifactUrl`, `artifactExpiresAt`, `createdAt`, `updatedAt`,
  `completedAt`, `expoUrl`.
- `submissions[]`, newest first: `id`, `platform`, `status` (`awaiting_build`, `in_queue`, `in_progress`, `finished`, `errored`, `canceled`,
  `unknown`), `buildId` and `build` (its version, when that build is in the snapshot), `store` (`appstoreconnect` or `googleplay`, derived from
  the platform, with its console name), `identifier` (bundle id or package name), `track` and `releaseStatus` (Google Play), `error`,
  `createdAt`, `completedAt`, `expoUrl`.
- `sync`: `readAt` (last successful read, `null` before the first), `lastAttemptAt`, `lastError` (a short code such as `expo_auth`, never
  Expo's text), `consecutiveFailures`, `buildsTruncated` and `submissionsTruncated` (the newest page of 30 was full: older ones exist at Expo
  and are not shown).
- `updates`: the stored OTA (EAS Update) state of the platform of this record ([ADR 0060](../adr/0060-eas-update-state.md)): `{ readAt, lastError,
  channels[] }`. `readAt` is the last successful read of the updates (`null` before the first), `lastError` a short code when that read failed (the
  builds may have been read fine; the old updates stay). Per channel: `current` (the newest update of the branches the channel serves: `id`, `group`,
  `platform`, `channel`, `branch`, `runtimeVersion`, `message` (first line, 200 characters), `createdAt`, `rolloutPercentage` (1 to 99 while a per-update
  rollout is going, else `null`), `rolloutSince` (when this server first read that percentage), `expoUrl`) and `rollouts[]` (other updates of the channel
  that are mid-rollout). Database only, like the rest of `GET /status`.

An app record shows the builds and submissions of **its own platform**: an iOS and an Android record linked to one project each read their
side. `hasArtifact` says that Expo holds a build file; `expoUrl` is the page of the build at expo.dev (logs and the install link).
**`artifactUrl`** is Expo's address of the file (`artifacts.buildUrl`, else `applicationArchiveUrl`; https only; stored in
`eas_builds.artifact_url`, [ADR 0061](../adr/0061-eas-install-dialog.md)). It is `null` unless `KILN_BUILDS_DOWNLOAD_ENABLED` is on **and** the caller
has `builds.download`, and while Expo gave none. It is a direct link to Expo: the file never passes through this server, and the address is never
logged or audited. Times are epoch milliseconds.

Field names: `artifacts { buildUrl applicationArchiveUrl }`, `expirationDate` and `isForIosSimulator` are those of eas-cli's build query (confirmed
from its sources, ADR 0036). **Assumed, not confirmed** against a live account: which of the two artifact fields holds the app file per platform,
and that `expoUrl` is what Expo's own install QR code encodes. Expo's documentation (internal distribution, Orbit) says only that an internal build
has a shareable URL identified by its build id and that anyone with it can open it unless "Unauthenticated access to internal builds" is off.

## Refreshing

The snapshot is refreshed by the scheduler (`KILN_EAS_STATUS_INTERVAL_MINUTES`, default 30, `0` off, 5 to 10080; an app record whose snapshot
has a build or a submission that has not ended is read again after three minutes) and by `POST /status/refresh`. Only linked app records with
a usable Expo credential are ever read, one job per credential at a time, spaced and bounded like the other scheduled reads. After a failed
read the scheduler waits (10 minutes, doubled for every failure in a row, at most 6 hours); a manual read never waits. A failed read keeps the
old snapshot and records the failure in `sync`. The same read also asks Expo for the update channels (one more request, `KilnUpdateChannels`) and
stores the current update of each channel and any mid-rollout update in `eas_updates`; if only that request fails, the builds are stored, the old
updates stay and `updates.lastError` says why. Removing the link, or linking another project, deletes the snapshot.

Refresh errors: `409 not_linked`; `422` `platform_unsupported`, `credential_not_found`, `credential_kind`, `credential_unreadable`,
`expo_auth`, `expo_forbidden`, `expo_not_found`; `429 rate_limited` (our budget, or Expo's, with `Retry-After`); `502 expo_unavailable`;
`504 timeout`. Messages are fixed sentences.

## Failures raise alerts

A read that stores a build or a submission as `errored` which the snapshot before did not hold as `errored` emits the event `eas.build_failed` or
`eas.submission_failed` (ids, platform, version, build number and a short code; right `builds.read`; [events](events.md)), which the alert types of
the same names turn into inbox, email, Slack or Teams alerts ([alerts](../alerts.md)). None on the first read of a project; none for a failure
older than a week. Nothing here calls Expo beyond the read that was due anyway.

`eas.update_rollout_stuck` is raised by the same read when a per-update rollout has stayed at one percentage below 100 for longer than the limit (the
alert rule parameter `hours`, default 48, 1 to 720; a workspace setting like the other thresholds, there is no per app value): once per update (alert
key `eas.update_rollout_stuck:{appId}:{group}`, 90 days), with `appId`, `updateId`, `group`, `platform`, `channel`, `percentage` and `hours`, never the
update message. The clock is "first read at this percentage" (a changed percentage starts again), so the alert comes at least the limit after Kiln first
saw the rollout.

## Audit

Every read of Expo is a `credential.use` with purpose `eas.status` (scheduled reads as the system). A manual refresh is also audited as
`eas.status_refresh` (target: the app; detail: `appId`, `projectId`, counts). Neither holds the token or a build file address.

## In the app

Besides "Builds to test": the app **Overview** has an Expo card (`ExpoOverviewCard`): per iOS or Android record, the latest build and the latest
submission with state, version, build number and time, linking to Builds, from `GET /status` only (no call to Expo); a record that is not linked says
so and links to Builds, a linked one without builds says none is stored yet, a macOS record has no row. Under the builds, "Current update per channel" shows the stored current update of each channel (rollout badge, branch, runtime
version, first line of the message, relative time, a link to the update at Expo and one to Builds, EAS updates) with "Updated X ago" (or that the last read
failed, showing what was stored), and honest empty states (never read; none for this platform). The **release detail** (`ReleaseEasSteps`, one per store release) shows the matching build and its submission as steps:
build finished, submitted, in store review. The build is matched by platform and version and then build number (App Store: the release's build;
Google Play: one of its version codes; without a number only when the version has exactly one build number among finished or running builds);
internal and simulator builds never match; the submission is the one of that build id; nothing is shown when no single build matches
(`lib/eas/eas-release.ts`). For the matched build a quiet extra line "OTA update published" (channel, time, link to Expo) shows when the stored current
update of the build's channel is for the same platform and has exactly the build's runtime version (`matchOta`); a build without a channel or runtime
version, a channel with no stored update or an update of another runtime version shows nothing.


"Builds to test" lists EAS builds next to CI artifacts and store builds (source filter "EAS builds"), with profile, channel, runtime,
distribution and commit; a failed build shows Expo's reason. A section "EAS submissions" lists submissions with their store, state and
reason. While something runs the page reloads the stored status every minute. "Read again" also asks Expo.

**Install dialog.** Install on an EAS row opens a dialog (QR code of `expoUrl`, the address with Copy, Open on Expo, Android or iOS help, the
expiry date). It is offered for a finished, unexpired build with internal or simulator distribution; otherwise the button is disabled with the
reason (running, failed, expired, store build, no address). With `artifactUrl` it also shows **Download build** (new tab, `.apk`, `.ipa`,
`.aab`, `.tar.gz` named from the address, no size: Expo gives none) and, on desktop only, **Open with Orbit**: for an internal Android build that
is not an AAB, an iOS Simulator build, or an internal iOS device build (Expo's Orbit page lists simulators, devices, `.apk`, simulator `.app`
and ad hoc signed apps). Orbit link: `expo-orbit://download?url=<encoded address>` is **assumed**: Expo does not document Orbit's scheme
([ADR 0061](../adr/0061-eas-install-dialog.md)). Logic: `apps/web/src/lib/eas/eas-install.ts`.
