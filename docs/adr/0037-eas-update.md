# ADR 0037: EAS Update view

Status: accepted. Builds on [ADR 0033](0033-eas-integration.md) (Expo credential, client, link between an app and its EAS project).

## Context

An Expo app can ship JavaScript and asset changes over the air (EAS Update) without a new store build. Whether an update reaches a
user depends on three things the stores know nothing about: the **channel** baked into the binary, the **branch** that channel points
to, and the **runtime version** of the update, which must equal the runtime version of the binary. When a team changes native code and
bumps the runtime version, updates published with the new one reach nobody who still runs the old binary, and nothing says so. This
change shows the state and says so.

## Decision

1. **Live reads, no table.** `GET /apps/:appId/expo/updates` asks Expo (two requests: the update channels with their branches and newest
   update groups; the finished store-distribution builds of the platform) and returns channels, the branch each points to, the newest
   updates of each branch (message, platform, runtime version, creation time, group id, commit), the updates that are mid-rollout, and the
   runtime check. Only the updates and builds of the platform of the app record are shown (an iOS and an Android record of one project each
   see their own). No migration. A read is audited as `credential.use` (purpose `eas.update`) and limited to 30 a minute per workspace.
2. **Runtime version mismatch.** For each channel the newest update (across the channel's branches) is compared with the store builds that
   bake in that channel (`checkRuntimeVersions`, `packages/connectors/src/expo/updates.ts`): `ok`; `mismatch` (error: its runtime version is
   that of no store build of the channel, so it reaches no shipped binary); `newest_build_unreached` (warning: it reaches only an older
   build); and the cases that cannot be compared (`no_updates`, `no_builds`, `unknown`), which are information, never an error. The server
   fetches the builds itself (`expoStoreBuilds`); it does not depend on the EAS build status snapshot of ADR 0036. "Shipped" is approximated
   by "finished build with store distribution": whether the build was submitted is not read.
3. **Insights on request.** `GET /apps/:appId/expo/updates/:group/insights?days=` (1 to 30, default 7; the limit is ours) returns launches
   (Expo's installs), failed launches (failed installs), unique users, the average payload size and the number of launched assets of the
   update of this platform in that group. The crash rate is computed here as failed / (installs + failed), the formula `eas update:insights`
   documents; it is null when there was no launch at all, never 0.
4. **One write, gated like a store write: raise the rollout of an update.** Expo's per-update rollout (`eas update --rollout-percentage`,
   `eas update:edit`) is changed with the mutation `update { setRolloutPercentage(updateId, percentage) }`, which eas-cli itself calls.
   `POST .../expo/updates/rollout/preview` reads Expo and returns the current and new share and a `confirmHash`; `.../apply` needs
   `KILN_EAS_UPDATE_ROLLOUT_ENABLED=true` (off by default, separate from the store switches), the right `releases.rollout` (owners and
   admins), a step-up grant when the workspace policy covers the existing action class `rollout` (bound to the app and the hash), re-reads
   Expo and refuses with `409 state_changed` when the rollout is not what was previewed, writes once, never retries (after a lost answer it
   reads the update back: `confirmedByReread`, `502 write_failed` or `409 outcome_unknown`), and audits `eas.update_rollout_changed` /
   `eas.update_rollout_failed` with ids and values only. **The share only goes up** (this server never sends a lower value); 100 ends the
   rollout and is marked irreversible. No claim table: two identical writes are harmless at Expo, and a change is bound to the state that
   was read. It is not an MCP tool (assistants may not apply writes).
5. **Web.** An "EAS Update" card on the Builds page, drawn only for an app linked to an Expo project, collapsed until opened, with the
   warnings first, channels, rollouts, newest updates, insights on request, and a dialog (preview, then confirmation) for raising a rollout.

## Not done, and why (follow-ups)

- **Publishing an update.** It needs a JavaScript bundle, asset uploads to signed URLs and a manifest; that is a build step of the client
  (eas-cli, a CI run), not a call this server can make. EAS Workflows (ADR 0035) can start one.
- **Rolling back or republishing** (`eas update:rollback`, `:republish`, `:roll-back-to-embedded`, `:revert-update-rollout`). They publish
  a new update group built from an existing one; the shape of `PublishUpdateGroupInput` was not read, so it is not guessed.
- **Changing the branch of a channel, or starting or ending a branch-based rollout** (`eas channel:edit`, `channel:rollout`). The channel
  mutation was not found in eas-cli's sources, and the meaning of the mapping's condition is unverified (see below).
- **Lowering or reverting a per-update rollout.** Whether Expo accepts a lower value for `setRolloutPercentage` is unverified.
- An MCP read tool for the state, and a scheduled read that raises an alert on a mismatch.

## Checked against Expo's sources (2026-11-20)

From the open source of eas-cli (`packages/eas-cli/src/graphql`, `src/channel/branch-mapping.ts`) and docs.expo.dev
(`eas-update/rollouts`, `eas-update/runtime-versions`):

- `app { byId(appId) { updateChannels(offset, limit) { id name isPaused isProtected createdAt updatedAt branchMapping updateBranches(offset, limit)
  { id name updateGroups(offset, limit) { ... } } } } }`; `updateGroups` is a list of groups, a group a list of updates.
- The update fields: `id group message createdAt runtime { version } platform gitCommitHash isRollBackToEmbedded rolloutPercentage
  rolloutControlUpdate { group }`.
- `branchMapping` is a JSON string `{ version, data: [{ branchId, branchMappingLogic }] }`; the logic is `"true"`, an object
  `{ clientKey, branchMappingOperator, operand }` or an `["and" | "or" | "not", ...]` statement.
- Insights: `updatesByGroup(group) { id platform insights { totalUniqueUsers(timespan) cumulativeAverageMetrics { launchAssetCount
  averageUpdatePayloadBytes } cumulativeMetrics(timespan) { metricsAtLastTimestamp { totalInstalls totalFailedInstalls } } } }` with
  `$groupId: ID!` and `$timespan: InsightsTimespan!` passed as `{ start, end }`.
- Builds: `app { byId { builds(offset, limit, filter: BuildFilter) } }`, `runtime { version }` and `updateChannel { name }` on a build,
  `BuildFilter` keys `platform status distribution ...`, `BuildStatus` `FINISHED`, `DistributionType` `STORE`, `AppPlatform` `IOS` `ANDROID`.
- The mutation `update { setRolloutPercentage(updateId: ID!, percentage: Int!) }`.
- Docs: a per-update rollout is scoped to branch, platform and runtime version; only one is active at a time; it is finished by raising it
  to 100 (`eas update:edit`); an update matches a build by runtime version.

## UNVERIFIED (marked as such in the code)

- The largest `limit` Expo accepts for channels, branches, groups and builds (25, 5, 3 and 20 are used).
- The value types of the `BuildFilter` fields (`platform`, `status`, `distribution` are sent as the enum names). The answer is checked again
  here, so a filter that was ignored cannot show a wrong build.
- The wire format of `InsightsTimespan` (ISO 8601 strings are sent) and the longest span Expo keeps (we allow 30 days).
- That update and update group ids are UUIDs (ids that are not are refused before they are sent).
- The scale of a branch rollout's `operand` (a fraction or a percent). A rollout between branches is therefore shown as its condition text
  (`rolloutToken hash_lt 0.25`) and **no percentage is derived from it**; the percentage shown is that of a per-update rollout only.
- That the crash rate is failed / (installs + failed): taken from a third-party copy of Expo's `eas-update-insights` skill, not from eas-cli.
- Whether `setRolloutPercentage` accepts lowering, and whether a rollout that reaches 100 is reported afterwards as `null` or 100 (a read
  that no longer finds the rollout after a request for 100 is counted as done; 100 and 0 are never shown as "mid-rollout").
- Which role of an Expo token can read update insights and change a rollout (the guide recommends a robot with the Developer role).
- That a build's `updateChannel` is always the channel baked into the binary (it is what Expo records for the build).
