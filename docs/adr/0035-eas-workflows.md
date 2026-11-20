# ADR 0035: EAS Workflows as a CI provider

Status: accepted. Builds on [ADR 0033](0033-eas-integration.md) (the Expo credential, client and app link).

## Context

CI so far meant GitHub Actions: `workflow_runs` held GitHub runs, and everything that shows runs (the runs list, "running now", the
release pipeline, the builds, events and alerts) reads that table. Expo's Workflows REST API
([docs](https://docs.expo.dev/eas/workflows/rest-api/), read 2026-11-20) can start a workflow run and read a run with the bearer token the
Expo client already holds.

## Decision

1. **Same table, a `provider` column.** Migration 46 adds `workflow_runs.provider` (`github` default, or `eas-workflows`). EAS runs are
   stored with the repository of the app and the app (`ci_run_apps`), in the status words the table already has: Expo `new` is `queued`,
   `waiting` and `action-required` are `waiting`, `in-progress` is `in_progress`, `success` / `failure` / `canceled` are `completed` with
   `success` / `failure` / `cancelled`. Because of that, the pipeline, the builds (a `build_number` dispatch input links a build to the
   run), `ci.run_started` / `ci.run_finished` and the "A build run failed" alert needed no change. The words for a provider (label, host)
   are data in `packages/core/src/ci-providers.ts`; no screen or service tests a provider's or a platform's name. An unknown Expo status is
   refused, not mapped.
2. **Starting is `ci.dispatch`, exactly like a GitHub dispatch.** Member and above, the same per-workspace dispatch budget (`shared.ci.limiter`),
   audited as `ci.dispatch` with `provider` in the detail (names of the inputs, never values), plus `credential.use` (purpose `eas.workflow`).
   The existing pattern has no environment switch and no step-up, so none is added; assistants are told to ask a person first. The start is
   never retried; a timeout says the run may have started. It needs an Expo link and a connected repository (where the run is listed).
3. **Routes under the app:** `POST /apps/:appId/expo/workflows/dispatches`, `GET .../runs`, `GET .../runs/:runId` (`?refresh=true` asks Expo,
   needs `apps.sync`, returns the jobs: names, types, statuses, Expo Build and Submit ids; never logs, outputs or errors). See
   [docs/api/eas-workflows.md](../api/eas-workflows.md).
4. **Following.** Expo has no list of runs, so the run started here is read by a job `eas.poll` (15 s growing to 1 min, at most 3 hours, rate
   limits wait as asked, temporary failures retry, permanent ones are audited once). The GitHub refresh, `ci.poll`, the job reads of "running
   now" and the scheduler's poll queueing now only touch `provider = 'github'` rows, so GitHub never settles an EAS run as missing.
5. **Client.** `ExpoClient` gains `rest()` (same token, timeout, size cap, no redirects, same error kinds, a path allow-list);
   `workflows.ts` has `dispatchExpoWorkflow`, `expoWorkflowRun`, the file name and ref checks and the status mapping.

## Checked against Expo's docs (2026-11-20)

`POST /v2/workflows/dispatch` with `appId`, `gitRef`, `fileName` (name only), optional `inputs`; answer `data.id`, `data.url`; 400, 403, 404.
`GET /v2/workflows/runs/:id`; answer `data` with `id`, `status`, `url`, `gitCommitHash`, `gitCommitMessage`, `requestedGitRef`,
`triggerEventType`, ISO `createdAt` / `updatedAt`, `jobs` (`id`, `key`, `name`, `type`, `status`, `buildId`, `submissionId`, ...); run statuses
`new`, `waiting`, `in-progress`, `action-required`, `success`, `failure`, `canceled`; bearer token, robot user recommended.

## UNVERIFIED (not in the docs, not guessed)

- Everything was written from the docs, with fixtures, never run against a live Expo account.
- The least role that may dispatch (the docs say "scoped role"; the 403 text recommends Developer, as for the link).
- Whether `.yaml` file names are accepted (let through, Expo decides), and whether input values must be strings (sent as given; our cap of
  25 inputs is ours, not Expo's).
- Rate limits of these endpoints (a 429 is handled like everywhere else).
- Whether a run answer can carry statuses beyond the seven documented: the page on managing runs lists `Queued` where the REST page lists
  `waiting`; both are read as waiting. Any other value is refused.
- The shape of error bodies (never read: messages are fixed sentences) and whether a dispatch of a file that is not a `workflow_dispatch`
  workflow answers 400 or 404 (both become `invalid_workflow` / `expo_not_found`).
- The run answer has no workflow name or title: the name shown is the dispatched file name, and `branch` is the requested ref.

## Deliberately not done

- No listing of workflow files (Expo has no endpoint; reading `.eas/workflows` from the repository is a follow-up), no run list from Expo,
  so runs started by a GitHub event or the dashboard are not shown. No cancel or re-run (the docs say re-run is dashboard only; cancel is
  CLI and dashboard only).
- No webhook from Expo, no scheduler restart of a poll that ended (a run still going after three hours stays as last read until refreshed).
- No manual "link a build to this run" for EAS runs (that route takes GitHub's numeric run id).
