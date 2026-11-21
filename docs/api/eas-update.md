# EAS Update of an app

Channels, branches, updates, rollouts and insights of the Expo project an app is linked to ([ADR 0037](../adr/0037-eas-update.md)). Needs
the link of [docs/api/eas.md](eas.md) (an Expo credential and a project). All routes are under `/api/workspaces/:workspaceId/apps/:appId/expo`.
Reads call Expo with the credential (audited as `credential.use`, purposes `eas.update`, `eas.update_insights`, `eas.update_rollout`) and
store nothing. Only the updates and builds of the platform of the app record are shown. macOS has no EAS Update (`422 platform_unsupported`).

| Route | Right | What it does |
| --- | --- | --- |
| `GET /updates` | `apps.read` | The state: channels, branches, newest updates, rollouts, the runtime check. 30 a minute per workspace. |
| `GET /updates/:group/insights?days=7` | `apps.read` | Launches, failed launches, crash rate, unique users, payload size of one update group. `days` 1 to 30. |
| `POST /updates/rollout/preview` | `releases.rollout` | Reads Expo, changes nothing, returns the `confirmHash`. |
| `POST /updates/rollout/apply` | `releases.rollout` | Raises the rollout of one update at Expo. **The only write.** |

## The state

`{ state: { project, platform, channels[], channelsTruncated, builds[], rolloutWriteEnabled, readAt } }`. A channel has `name`, `isPaused`,
`isProtected`, `mapping` (`kind`: `none`, `branch`, `rollout` or `unreadable`, with `entries` that name each branch and, for a rollout
between branches, the condition as text; **no percentage is derived from it**), `branches[]` (each with the newest update groups holding an
update for this platform), `rollouts[]` (updates that are mid-rollout: 1 to 99 percent) and `runtimeCheck`.

`runtimeCheck.status` compares the runtime version of the newest update of the channel with the finished store-distribution builds that name
the channel:

| Status | Severity | Meaning |
| --- | --- | --- |
| `ok` | none | The newest update has the runtime version of the newest store build. |
| `mismatch` | error | The newest update has a runtime version that no store build of the channel has: it reaches no shipped binary. |
| `newest_build_unreached` | warning | It reaches an older store build only; the newest build gets no update. |
| `no_updates`, `no_builds`, `unknown` | info | Nothing to compare (no update, no store build on the channel, or a runtime version is not known). |

"Shipped" means a finished build with store distribution; whether it was submitted is not read. `builds` lists the ones compared (at most 10).
Limits: 25 channels, 5 branches a channel, 3 update groups a branch, 20 builds (`channelsTruncated` when the channel page was full).

## Insights

`{ insights: { group, platform, days, start, end, insights: { updateId, platform, launches, failedLaunches, crashRatePercent, uniqueUsers,
launchAssetCount, averagePayloadBytes } } }`. `launches` and `failedLaunches` are Expo's installs and failed installs over the span.
`crashRatePercent` is failed / (installs + failed) as a percentage, `null` when there was no launch. A number Expo did not report is `null`.

## Raising a rollout

Off unless the server sets `KILN_EAS_UPDATE_ROLLOUT_ENABLED=true` (`409 eas_update_write_disabled`, also for the preview). Body of the preview:
`{ "group": "<update group id>", "percentage": 50 }`; of the apply, the same plus `"confirmHash"` from the preview. The update of this platform in
the group must be mid-rollout (`409 rollout_not_found`), and the share must be above the current one, at most 100 (`422 rollout_not_raised`;
lowering or reverting needs the Expo CLI). 100 ends the rollout (`irreversible: true`). Apply needs a step-up grant for the action class
`rollout` when the workspace policy covers it (`403 step_up_required`; [step-up](step-up.md)), reads Expo again and refuses with `409
state_changed` (and the new `confirmHash`) when the rollout is not the one previewed, and is never retried: after a lost answer it reads the
update back and answers `200` with `confirmedByReread: true`, `502 write_failed` (`outcome: not_applied`) or `409 outcome_unknown`. One write
per update at a time (`409 write_in_progress`); 10 previews or applies a minute per workspace. Audited as `eas.update_rollout_changed` or
`eas.update_rollout_failed` (ids and values, never a token). It is not an MCP tool.

Other errors, as for the link: `409 expo_not_linked`; `422` `credential_not_found`, `expo_auth`, `expo_forbidden`, `expo_not_found`,
`invalid_group`, `invalid_days`; `429 rate_limited`; `502 expo_unavailable`; `504 timeout`. Messages are fixed sentences.
