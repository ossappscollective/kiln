# API: EAS Workflows (a CI provider)

Start and follow [EAS Workflows](https://docs.expo.dev/eas/workflows/get-started/) runs of the Expo project an app is linked to ([eas.md](eas.md)).
Everything is under `/api/workspaces/:workspaceId`, needs a session, and follows the usual rules (non-member or unknown app `404`, missing
right `403`, bad body `400 invalid_request`). Times are epoch milliseconds. Decision and what was and was not verified against Expo:
[ADR 0035](../adr/0035-eas-workflows.md). Never run against a live Expo account: the shapes were written from Expo's REST API page.

A run started here is stored in the same table as GitHub Actions runs (`workflow_runs`, with `provider: "eas-workflows"`) in the words the
other runs use, so it appears in the runs of the repository ([ci.md](ci.md)), the "running now" list, the release pipeline, the builds of
the app (a `build_number` dispatch input links the build to the run) and the `ci.run_started` / `ci.run_finished` events and the
"A build run failed" alert, with no change on their side. The app needs an Expo link and a repository.

| Method and path                               | Right                                          | What                                                                                             |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /apps/:appId/expo/workflows/dispatches` | `ci.dispatch` (member and above)               | Start a run at Expo. `202 { dispatched, run }`.                                                  |
| `GET /apps/:appId/expo/workflows/runs`        | `apps.read`                                    | The runs started here for the app, newest first (stored; Expo is not called).                    |
| `GET /apps/:appId/expo/workflows/runs/:runId` | `apps.read`; `?refresh=true` needs `apps.sync` | The stored run; with `refresh=true` Expo is asked, the run is stored again and `jobs` is filled. |

**Start.** Body `{ workflow, ref?, inputs? }`, no other keys. `workflow` is `.eas/workflows/build.yml` or `build.yml` (a file directly in
`.eas/workflows`, ending `.yml` or `.yaml`); `ref` a branch, tag, commit SHA or `refs/...` (default: the default branch of the app's
repository); `inputs` the values of the file's `workflow_dispatch` inputs (at most 25, strings, numbers or booleans, sent to Expo as given). It
is a write that runs the team's workflows with the team's EAS secrets, so it works exactly like a GitHub dispatch: `ci.dispatch`, the same
per-workspace budget (a GitHub and an Expo start count together), audited as `ci.dispatch` (target: the repository; detail: `provider`,
`workflow`, `ref`, the **names** of the inputs, `appId`, `ok`, `runId` or `code`) plus `credential.use` with purpose `eas.workflow`. There is
no environment switch and no step-up, as for GitHub. Assistants should ask a person first.

**The run** has the fields of any CI run ([ci.md](ci.md)): `id` is Expo's run id (a UUID), `workflow` the file name, `workflowPath`
`.eas/workflows/<file>`, `url` the run page on expo.dev, `branch` the requested ref, `inputs` as strings, `provider: "eas-workflows"`.
`status` and `conclusion` use the CI words: Expo `new` is `queued`; `waiting` and `action-required` (paused for an approval) are `waiting`;
`in-progress` is `in_progress`; `success`, `failure` and `canceled` are `completed` with `success`, `failure` and `cancelled`. A run Expo no
longer has settles as `completed` / `unknown`. Runs are read again by the `eas.poll` job (15 s growing to a minute, for at most three
hours); Expo has no list of runs, so only runs started here are followed.

**Jobs** (`refresh=true`): `key`, `name`, `type` (`build`, `submission`, ...), `status` (Expo's: `new`, `in-progress`, `action-required`,
`pending-cancel`, `success`, `failure`, `canceled`, `skipped`), `buildId`, `submissionId`. Never logs, outputs or errors.

**Errors.** `422`: `expo_not_linked`, `repository_required`, `invalid_workflow` (also when Expo refuses the file name or the inputs),
`invalid_ref`, `credential_not_found` / `credential_kind` / `credential_unreadable`, `expo_auth`, `expo_forbidden`, `expo_not_found` (the
ref or the file does not exist at Expo; for a refresh, the run); `429 rate_limited` (the CI budget, or Expo said to slow down; `Retry-After`);
`502 expo_unavailable`; `504 timeout` (a start that timed out may still have started: look at Expo before trying again). A status Expo does not
document is refused (`502 expo_unavailable`), not guessed. Nothing is retried.

**Stored data.** Migration 46 adds `workflow_runs.provider` (`github` for every existing row). The GitHub refresh, its poll, the job reads
of "running now" and the scheduler only touch `github` rows.
