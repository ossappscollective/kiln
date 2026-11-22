# API: the EAS configuration of an app (`eas.json`)

Shows what the app's repository says about its Expo Application Services builds, submissions and updates: the build and submit
profiles of `eas.json` and the few fields of the Expo app config that relate to them. It is read from the repository only. It needs
no Expo credential and makes no call to Expo; nothing is changed anywhere ([ADR 0033](../adr/0033-eas-integration.md)).

| Route                                                     | Right                               | What it does                                                                                                                             |
| --------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/workspaces/:workspaceId/apps/:appId/eas-config` | `repositories.scan` (member and up) | Reads `eas.json` at the root of the app's repository, at the default branch. Operation `getEasConfig` (read), so it is also an MCP tool. |

Like the other routes that read a repository (the scan, the listing, the project detection): a viewer gets `403`, a non-member `404`,
an unknown app `404`. At most 30 reads a minute per workspace (`429` with `Retry-After`); a refused credential, a rate limit or a
timeout of the repository are `401`/`403`, `429` and `504` as for any repository read. The repository is opened through the same
connector as the other reads (GitHub, or the local clone when the repository is clone-backed; purpose `eas.config`, audited as a use
of the repository credential) and read once per commit (the snapshot is cached by repository and commit).

## Response

`app{id, name, platform, identifier}`, `repository{id, owner, repo, localOnly}` (`null` without one), `branch`, `commit` (`null` when
the connector could not name it), `readAt`, `found`, `reason`, `nested`, `path`, `config`, `expoApp`, `findings`.

`found: false` is an answer, not an error. `reason` is then `{code, message}`:

- `no_repository`: the app has no repository.
- `no_eas_json`: no `eas.json` at the repository root. `nested` lists the `eas.json` files in subfolders; they are not read (only the
  root is). `expoApp` is still filled when an `app.json` exists.
- `unreadable`: the file is too large (more than 1 MB) or not text.

`config` (when found) holds `cli{version, requireCommit, appVersionSource, appVersionSourceEffective}`, `build[]` and `submit[]`, and
`unknownKeys` and `truncated` (more than 100 profiles are not listed). Each build profile has its `extends` resolved: the values
it ends up with, `extendsChain`, `distribution`, `channel`, `developmentClient`, `autoIncrement`, `resourceClass`, `image`, the
`ios` and `android` sections, and `envNames`. **The values of `env` are never returned, nor the value of any unknown key**: only the
names. A submit profile has `ios` (`ascAppId`, `appleTeamId`, `bundleIdentifier`, paths, and `hasAppleId`: the Apple ID itself is not
kept) and `android` (`track`, `releaseStatus`, `rollout`, `serviceAccountKeyPath`, `applicationId`, `changesNotSentForReview`). Paths
are kept as written and never opened. `expoApp` holds the version, the runtime version (and its iOS and Android overrides), whether
updates are configured (`updates.url`), the EAS project id from `extra.eas.projectId`, and the iOS bundle identifier and Android
package. A dynamic `app.config.js` or `app.config.ts` is never run: it is reported (`app_config_dynamic`).

## Tolerant reading

Comments and trailing commas are accepted and reported (`eas_json_lenient`). A wrong type is a finding and the value is left out; one
bad profile never hides the others; unknown keys are listed by name. A file that is not JSON gives `found: true`, `config: null` and
the finding `eas_json_invalid` with a line and column, never a piece of the text.

## Findings

`findings[]`: `{code, severity (error|warning|info), scope (file|cli|build|submit|app), message, profile?, key?}`. A message names keys
and profiles, never a value of `env`.

| Group           | Codes                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File            | `eas_json_invalid`, `eas_json_not_object`, `eas_json_too_large`, `eas_json_lenient`, `section_invalid`, `profile_invalid`, `invalid_value`, `unknown_keys`, `too_many_profiles`                                                      |
| `extends`       | `extends_missing`, `extends_cycle`, `extends_too_deep` (more than 5 steps), `extends_invalid`                                                                                                                                        |
| Build           | `distribution_unknown`, `channel_ignored_dev_client`, `auto_increment_without_source`, `release_channel_deprecated`, `env_secret_like` (the `env` name looks like a secret; the value is not shown)                                  |
| Version source  | `app_version_source_unknown`, `app_version_source_missing`, `app_version_source_remote`                                                                                                                                              |
| Updates         | `channel_without_updates`, `updates_without_channel`, `updates_without_runtime_version`, `updates_url_project_mismatch`, `updates_disabled_with_channel`                                                                             |
| Runtime version | `runtime_version_invalid`, `runtime_policy_unknown`, `runtime_policy_needs_version`, `runtime_policy_native_version`                                                                                                                 |
| Submit          | `submit_track_unknown`, `submit_release_status_unknown`, `submit_rollout_needs_in_progress`, `submit_in_progress_needs_rollout`, `submit_rollout_out_of_range`, `submit_profile_without_build_profile`, `submit_identifier_mismatch` |
| App config      | `app_config_unreadable`, `app_config_dynamic`, `app_config_missing`, `app_config_invalid_value`, `app_identifier_mismatch` (the app's identifier is not the bundle id or package of the app config; not checked for desktop apps)    |

The screen shows them in the order errors, warnings, notes, in the card "EAS configuration" of the app (collapsed, read-only, shown
for an app with a repository to a member and above, read when opened).

## Verified and not verified

Checked on docs.expo.dev on 2026-11-20 (by fetching the pages; a fetch tool summarises them, so a value that matters should be read
on the page too):

- `cli`: `version`, `requireCommit`, `appVersionSource` (`local` or `remote`; `local` is the default, with a warning),
  `promptToConfigurePushNotifications`.
- Build profile fields, `distribution` (`store` or `internal`), `autoIncrement`, `extends` (up to 5 steps, no cycle), `env` (meant for
  values that are not secret, since they are stored in git).
- Submit, Android: `track` (`production`, `beta`, `alpha`, `internal`), `releaseStatus` (`completed`, `draft`, `halted`,
  `inProgress`), `rollout` (0 to 1, only with `inProgress`), `serviceAccountKeyPath`, `applicationId`, `changesNotSentForReview`.
  Submit, iOS: `ascAppId`, `appleTeamId` and the other fields modelled.
- A submit profile is looked up by the name of the build profile, falling back to `production`.
- `runtimeVersion`: a string, `exposdk:x.y.z`, or `{ policy }` (`nativeVersion`, `sdkVersion`, `appVersion`, `fingerprint`), with
  platform overrides; `extra.eas.projectId`.

Not verified (kept as findings of low weight or not modelled):

- How EAS merges `extends` (the model lets the child win and merges `env`, `ios`, `android` and `cache` one level down; this is an
  assumption).
- Whether `eas-cli` accepts comments in `eas.json`; the reader accepts them and says so.
- The rules of Google Play for a draft app, `halted` and the `internal` track, what EAS does with `inProgress` without a `rollout`,
  and custom track names.
- `nativeVersion` with remote versions.
- The form `https://u.expo.dev/<project id>` of `updates.url` (seen only in examples of native files).
- Which of `app.config.json` and `app.json` wins when both exist.
- Whether a name in `env` is a secret is a heuristic of ours (name words, shapes of tokens, long random strings), not Expo's.
