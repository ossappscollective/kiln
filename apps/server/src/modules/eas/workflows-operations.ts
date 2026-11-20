import { z } from 'zod';
import { type Draft, timestamp, W } from '../../operations/shared.ts';
import { dispatchEasBody } from './workflows-routes.ts';

/**
 * The operations of EAS Workflows (docs/api/eas.md): starting a run is `ci.dispatch` (member and above, like a GitHub dispatch, on the
 * same per-workspace budget), reading the stored runs is `apps.read`, asking Expo for a run's state and jobs needs `apps.sync`.
 */

const run = z.object({
  id: z.string().describe('Expo’s workflow run id (a UUID).'),
  repositoryId: z.string(),
  appId: z.string().nullable(),
  appIds: z.array(z.string()),
  workflow: z.string().describe('The workflow file name, as dispatched (`build.yml`).'),
  workflowPath: z.string().nullable().describe('`.eas/workflows/<file>`.'),
  title: z.string().nullable(),
  status: z
    .string()
    .describe('In the CI words: `queued`, `waiting`, `in_progress` or `completed` (see `conclusion`).'),
  conclusion: z.string().nullable().describe('`success`, `failure`, `cancelled` or `unknown` once completed.'),
  provider: z.literal('eas-workflows'),
  active: z.boolean(),
  headSha: z.string().nullable(),
  commitMessage: z.string().nullable(),
  branch: z.string().nullable().describe('The ref the run was requested on.'),
  event: z.string().nullable(),
  runNumber: z.number().int().nullable(),
  url: z.string().nullable().describe('The run page on expo.dev.'),
  inputs: z.record(z.string()).nullable(),
  dispatchedBy: z.string().nullable(),
  startedAt: timestamp,
  updatedAt: timestamp,
  syncedAt: timestamp,
});

const job = z.object({
  key: z.string(),
  name: z.string(),
  type: z.string().describe('`build`, `submission`, ... as Expo says.'),
  status: z
    .string()
    .describe('Expo’s job status: `new`, `in-progress`, `action-required`, `pending-cancel`, `success`, `failure`, `canceled`, `skipped`.'),
  buildId: z.string().nullable().describe('The Expo Build of a `build` job.'),
  submissionId: z.string().nullable().describe('The Expo Submit record of a `submission` job.'),
});

export const easWorkflowOperations: Draft[] = [
  {
    id: 'dispatchEasWorkflow',
    method: 'post',
    path: `${W}/apps/{appId}/expo/workflows/dispatches`,
    tags: ['eas', 'ci'],
    summary: 'Start an EAS Workflows run for an app',
    description:
      'Runs a workflow of the linked Expo project on Expo, with the team’s EAS secrets. It can ship a build: assistants should ask a person first. `workflow` is `.eas/workflows/<file>.yml` or the file name, `ref` a branch, tag or commit (default: the default branch of the app’s repository), `inputs` the values of the `workflow_dispatch` inputs the file declares (sent as given). The app needs an Expo link and a repository. Needs `ci.dispatch` and the CI dispatch budget of the workspace; audited as `ci.dispatch` with `provider: eas-workflows`, and the Expo credential use as `credential.use`. The run is stored with the runs of the repository (`provider: eas-workflows`) and followed until it finishes. `422` `expo_not_linked` / `repository_required` / `invalid_workflow` (also when Expo refuses the inputs) / `invalid_ref` / `credential_*` / `expo_auth` / `expo_forbidden` / `expo_not_found` (the ref or the file); `429`; `502` `expo_unavailable`; `504` `timeout` (the run may have started: look at Expo before trying again). Unverified against a live Expo account: see docs/adr/0035-eas-workflows.md.',
    risk: 'write',
    access: { action: 'ci.dispatch' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    body: dispatchEasBody,
    responses: {
      '202': {
        description: 'Expo accepted the run; it is stored.',
        schema: z.object({ dispatched: z.boolean(), run }),
      },
    },
  },
  {
    id: 'listEasWorkflowRuns',
    method: 'get',
    path: `${W}/apps/{appId}/expo/workflows/runs`,
    tags: ['eas', 'ci'],
    summary: 'The EAS Workflows runs started for an app, newest first',
    description:
      'Stored runs only (Expo is not called). Expo has no list of runs, so these are the runs started through this tool. The same runs appear in the runs of the repository, the release pipeline and the builds. Needs `apps.read`.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: { '200': { description: 'The runs (at most 30).', schema: z.object({ runs: z.array(run) }) } },
  },
  {
    id: 'getEasWorkflowRun',
    method: 'get',
    path: `${W}/apps/{appId}/expo/workflows/runs/{runId}`,
    tags: ['eas', 'ci'],
    summary: 'An EAS Workflows run, with its jobs when Expo is asked',
    description:
      'The stored run. With `refresh=true` (needs `apps.sync`) Expo is asked for the run’s state, which is stored (a run Expo no longer has settles as `completed` / `unknown`), and the jobs are returned (names, types, statuses, the Expo Build and Submit ids; never logs, outputs or errors). Without it `jobs` is empty and `refreshed` false. `404` when the run is not one of this app’s EAS runs. Needs `apps.read`.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'appId' },
    query: z.object({ refresh: z.enum(['true']).optional() }),
    responses: {
      '200': {
        description: 'The run and, when refreshed, its jobs.',
        schema: z.object({ run, jobs: z.array(job), refreshed: z.boolean() }),
      },
    },
  },
];
