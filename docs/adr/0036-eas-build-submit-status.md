# ADR 0036: EAS Build and Submit status

Status: accepted. Builds on [ADR 0033](0033-eas-integration.md) (the Expo credential, client and app link). Read only.

## Context

An app linked to an Expo project builds on EAS and sends builds to the stores with EAS Submit. Until now the tool saw none of it: "Builds to
test" listed CI artifacts and store builds only, so a failed EAS build, a build still in the queue or a submission Google Play refused was
visible only at expo.dev.

## Decision

1. **A snapshot per app record, read from Expo.** Migration 47: `eas_builds`, `eas_submissions` (one row per build or submission, key `app_id` +
   Expo's id) and `eas_status_sync` (last attempt and success, a short failure code, the failure streak, the backoff, whether the page was
   full). A read (`refreshEasStatus`, `modules/eas/status.ts`) takes the newest 30 builds and 30 submissions of the project for the platform of
   the app record (an iOS record reads iOS, an Android record Android; macOS is not read: EAS has no such platform) and replaces the snapshot in
   one transaction. A failed read keeps the old snapshot and records why. The views read the database only, so listing never calls Expo.
2. **The repo's own sync pattern.** A job queue `eas.status` and a scheduler pass like the review and analytics ones: spaced, bounded, one job per
   credential, the shared per workspace budget, a doubling backoff (10 minutes up to 6 hours), `KILN_EAS_STATUS_INTERVAL_MINUTES` (default 30,
   `0` off). One addition suited to the data: an app record whose snapshot has a build or submission that has not ended is read again after
   three minutes, which is how a running build is followed. Only linked records with an Expo credential are ever read.
3. **Two routes** (`docs/api/eas-builds.md`): `GET /apps/:appId/eas/status` (`builds.read`, database only) and `POST .../eas/status/refresh`
   (`apps.sync`, the budget of the app syncs). Both are in the operation registry, so tokens and MCP tools follow the usual rules. Every read
   of Expo is a `credential.use` (purpose `eas.status`); a manual refresh is also `eas.status_refresh`.
4. **Another source of "Builds to test", not a special case.** `BuildRow.source` is `'ci' | 'store' | 'eas'`; an EAS build is a row like the others
   (title `1.4.0 (57)`, state, profile/channel/runtime/distribution/commit, Expo's reason when it failed), with its filter option. Submissions
   are a section below the list. The store a submission goes to and the name of the build number ("Build" or "Version code") come from the core
   platform table; the only place that names Expo's `IOS` / `ANDROID` is a mapping table keyed by `Platform`.
5. **No build file address is stored or returned.** (Amended by [ADR 0061](0061-eas-install-dialog.md): it is stored and returned only where the download switch is on and the role may download.) `hasArtifact` and the page of the build at expo.dev (`expoUrl`) are. A stored link would be a
   way around the switch of the builds download (`KILN_BUILDS_DOWNLOAD_ENABLED`, `builds.download`); Expo applies its own access rules to its page.
   The "Install" help of an EAS row says so and points at Expo.
6. **Expo's text** (an error, a commit message) is cut (500 and 200 characters), shown as plain text and never logged or put in an audit row.
   A scheduled failure is a short code (`expo_auth`, `rate_limited`, ...), never Expo's wording.

## Checked against Expo's sources (2026-11-20)

In eas-cli (`packages/eas-cli/src/graphql`, `src/commands/build/list.ts`, `src/build/utils/url.ts`) and the generated client of the published
`eas-cli` package: `app { byId(appId) { builds(offset, limit, filter: BuildFilter) } }` and `submissions(filter: {platform}, offset, limit)`; the
build fields `id status platform error { errorCode message } artifacts { buildUrl applicationArchiveUrl } updateChannel { name } distribution
buildProfile appIdentifier sdkVersion appVersion appBuildVersion runtime { version } gitCommitHash gitCommitMessage createdAt updatedAt completedAt
expirationDate isForIosSimulator`; the submission fields `id status platform createdAt completedAt submittedBuild { id } androidConfig {
applicationIdentifier track releaseStatus } iosConfig { ascAppIdentifier } error { errorCode message }`; the keys of `BuildFilter` (`platform`
among them); the enums `BuildStatus`, `SubmissionStatus`, `AppPlatform`, `DistributionType` with their wire values; the web pages of a build
(`/accounts/{account}/projects/{slug}/builds/{id}`) and of a submission (`.../submissions/{id}`); that an internal-distribution Android build is
installed from `artifacts.buildUrl` and an iOS one from an `itms-services` link to Expo's manifest.

## UNVERIFIED (not checked against a live Expo account; each is marked in the code)

- The largest `limit` Expo accepts for `builds` and `submissions` (30 is used; no paging, so older items are not read and `*Truncated` says so).
- That `DateTime` fields are ISO 8601 strings (anything else becomes `null`), and that Expo returns newest first (the reader sorts anyway).
- That `appBuildVersion` holds the Android version code as well as the iOS build number (it is read as one field and labelled by platform).
- That `submissions` accepts the variable `$platform: AppPlatform` inside `filter: { platform: $platform }` exactly as eas-cli writes it (it is
  eas-cli's own query shape), and what it does for `null`: it is never sent without a platform.
- The default web origin of Expo's pages (`https://expo.dev`, used for `expoUrl`): eas-cli builds the links from `getExpoWebsiteBaseUrl()`,
  which was not read.
- That the Expo page of an internal-distribution build shows the install link (eas-cli prints it; the page was not looked at).
- Expo's error wording and codes (a failure is classified as in ADR 0033), its rate limits, and which Expo role is the least that can read
  builds and submissions (the guide for the credential says Developer).
- That a robot token can read builds of a project it can see (only the Developer role is documented to make builds).
- The fake answers of the tests are written from eas-cli's query documents, not recorded from Expo.

## Deliberately not done

- No write to Expo: no cancel, retry, resubmit or new build. No webhook from Expo.
- No download or storing of build files, and no install link of our own (see 5).
- No alert on a failed EAS build or submission. The alerts module takes events (`ci.run_finished`) and a catalog entry; a new event type touches
  the event list, its read rights, the catalog and its tests, the webhooks documentation and the web list of event types, which is more than
  this change should reach into. The next step is one event `eas.build_failed` emitted where the snapshot first holds an errored build.
- The release pipeline (which matches builds to releases by build number) is unchanged: EAS builds appear in "Builds to test" only.
- No history beyond the newest page, and no per-build log: the Expo page has them.
