import { PLATFORMS } from '@mrm/core';
import { z } from 'zod';
import { type Draft, object, timestamp, W } from '../../operations/shared.ts';

const conventionsInput = z.object({
  appId: z
    .string()
    .optional()
    .describe('Set for an override of one app; leave out for the repository.'),
  tagPatterns: z
    .array(z.string())
    .describe(
      'Patterns with {buildNumber}, {version}, {platform}, {flavor}, {prefix}, *. Empty: defaults.',
    ),
  releasePatterns: z.array(z.string()).describe('The same for release names. Empty: defaults.'),
  prefix: z.string().optional().describe('The literal that fills {prefix}.'),
  workflow: z
    .string()
    .nullable()
    .optional()
    .describe('The release workflow (file name or name); null to detect it.'),
});

export const ciOperations: Draft[] = [
  {
    id: 'listWorkflows',
    method: 'get',
    path: `${W}/repositories/{id}/workflows`,
    tags: ['ci'],
    summary: 'GitHub Actions workflows of a repository',
    risk: 'read',
    access: { action: 'repositories.scan' },
    partial: true,
    responses: { '200': { description: 'Workflows.', schema: object } },
  },
  {
    id: 'listWorkflowRuns',
    method: 'get',
    path: `${W}/repositories/{id}/workflows/runs`,
    tags: ['ci'],
    summary: 'Recent workflow runs',
    description:
      'Each run has `appId` (the first app, kept for older clients) and `appIds` (every app the run builds; empty: it was not started for an app and counts for every app of the repository). With `appId` the list keeps the runs that count for that app.',
    risk: 'read',
    access: { action: 'repositories.read' },
    query: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      workflow: z.string().optional(),
      branch: z.string().optional(),
      refresh: z.enum(['true']).optional(),
      active: z.enum(['true']).optional(),
      appId: z.string().optional(),
    }),
    partial: true,
    responses: { '200': { description: 'Runs.', schema: object } },
  },
  {
    id: 'getWorkflowRun',
    method: 'get',
    path: `${W}/repositories/{id}/workflows/runs/{runId}`,
    tags: ['ci'],
    summary: 'A workflow run',
    risk: 'read',
    access: { action: 'repositories.read' },
    query: z.object({ refresh: z.enum(['true']).optional() }),
    partial: true,
    responses: { '200': { description: 'The run.', schema: object } },
  },
  {
    id: 'listActiveWorkflowRuns',
    method: 'get',
    path: `${W}/ci/runs/active`,
    tags: ['ci'],
    summary:
      'Workflow runs going now across the repositories, and those finished in the last 24 hours',
    description:
      'Stored runs for everybody who may read repositories; a member or admin also refreshes them from GitHub first (conditional reads, cached for seconds, shared with the run sync). `problems` lists repositories GitHub could not be read for, with a fixed reason, so a client can show a quiet pill instead of an error. Rate limited per workspace. A token limited to some apps sees only the runs of those apps\u2019 repositories that belong to no app or to one of them (the filtering is done here, not by the app list).',
    risk: 'read',
    access: { action: 'repositories.read' },
    appScope: { kind: 'list' },
    rateLimited: true,
    query: z.object({
      repositoryId: z
        .string()
        .optional()
        .describe('Only these repositories, comma separated (at most 50).'),
      appId: z
        .string()
        .optional()
        .describe(
          'Only the runs that count for this app: those started for it (alone or with other apps) and those not started for an app, which count for every app of the repository.',
        ),
    }),
    responses: {
      '200': {
        description: 'Runs going, recent runs, the repositories covered and the problems.',
        schema: z.object({
          runs: z.array(object),
          recent: z.array(object),
          repositories: z.array(z.object({ id: z.string(), owner: z.string(), repo: z.string() })),
          problems: z.array(
            z.object({
              repositoryId: z.string(),
              reason: z.enum(['no_access', 'rate_limited', 'unavailable', 'unsupported']),
            }),
          ),
          refreshedAt: timestamp.nullable(),
          live: z.boolean(),
          cached: z.boolean(),
        }),
      },
    },
  },
  {
    id: 'listWorkflowRunJobs',
    method: 'get',
    path: `${W}/repositories/{id}/workflows/runs/{runId}/jobs`,
    tags: ['ci'],
    summary: 'The jobs and steps of a workflow run (names, states and times; never logs)',
    description:
      'A member or admin reads GitHub (kept 10 seconds while the run is going); a viewer sees what was read lately, possibly nothing (`live: false`).',
    risk: 'read',
    access: { action: 'repositories.read' },
    responses: {
      '200': {
        description: 'The jobs with their steps.',
        schema: z.object({
          runId: z.string(),
          jobs: z.array(object),
          truncated: z.boolean(),
          readAt: timestamp.nullable(),
          cached: z.boolean(),
          live: z.boolean(),
        }),
      },
    },
  },
  {
    id: 'getWorkflowInputs',
    method: 'get',
    path: `${W}/repositories/{id}/workflows/{workflow}/inputs`,
    tags: ['ci'],
    summary: 'The inputs a workflow accepts',
    risk: 'read',
    access: { action: 'repositories.scan' },
    query: z.object({ ref: z.string().optional() }),
    partial: true,
    responses: { '200': { description: 'The inputs.', schema: object } },
  },
  {
    id: 'dispatchWorkflow',
    method: 'post',
    path: `${W}/repositories/{id}/workflows/{workflow}/dispatches`,
    tags: ['ci'],
    summary: 'Start a workflow run',
    description:
      'Runs a workflow on GitHub. It can ship a build: assistants should ask a person first. Body: `ref`, `inputs`, and the app or apps the run builds: `appId` (one) and/or `appIds` (several apps that share the repository; each must be linked to it, `422 app_not_found` / `app_repository_mismatch`).',
    risk: 'write',
    access: { action: 'ci.dispatch' },
    body: object,
    partial: true,
    responses: {
      '202': {
        description: 'The dispatch was accepted.',
        schema: z.object({
          dispatched: z.boolean(),
          runKnown: z.boolean(),
          run: object.nullable(),
        }),
      },
    },
  },
  {
    id: 'listBuilds',
    method: 'get',
    path: `${W}/apps/{id}/builds`,
    tags: ['ci'],
    summary: 'Builds of an app and the runs linked to them',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'id' },
    partial: true,
    responses: { '200': { description: 'Builds.', schema: object } },
  },
  {
    id: 'getBuildChanges',
    method: 'get',
    path: `${W}/apps/{id}/builds/changes`,
    tags: ['ci'],
    summary: 'Commits between two builds',
    risk: 'read',
    access: { action: 'repositories.scan' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      platform: z.enum(PLATFORMS),
      build: z.string(),
      base: z.string().optional(),
    }),
    partial: true,
    responses: { '200': { description: 'The changes.', schema: object } },
  },
  {
    id: 'linkBuild',
    method: 'put',
    path: `${W}/apps/{id}/builds/{platform}/{buildNumber}/link`,
    tags: ['ci'],
    summary: 'Link a build to a workflow run',
    risk: 'write',
    access: { action: 'apps.sync' },
    appScope: { kind: 'param', name: 'id' },
    body: object,
    partial: true,
    responses: { '200': { description: 'The build.', schema: z.object({ build: object }) } },
  },
  {
    id: 'unlinkBuild',
    method: 'delete',
    path: `${W}/apps/{id}/builds/{platform}/{buildNumber}/link`,
    tags: ['ci'],
    summary: 'Remove the link of a build',
    risk: 'destructive',
    access: { action: 'apps.sync' },
    appScope: { kind: 'param', name: 'id' },
    partial: true,
    responses: { '200': { description: 'The build.', schema: z.object({ build: object }) } },
  },
  {
    id: 'rematchBuilds',
    method: 'post',
    path: `${W}/apps/{id}/builds/rematch`,
    tags: ['ci'],
    summary: 'Search runs, tags and releases again for the unlinked builds of an app',
    description:
      'Reads GitHub (runs, tags, releases, a few commits) and stores the links it finds. Rate limited per workspace.',
    risk: 'write',
    access: { action: 'repositories.scan' },
    appScope: { kind: 'param', name: 'id' },
    partial: true,
    responses: {
      '200': {
        description: 'The builds, with diagnostics, and what the search did.',
        schema: object,
      },
    },
  },
  {
    id: 'getBuildConventions',
    method: 'get',
    path: `${W}/repositories/{id}/build-conventions`,
    tags: ['ci'],
    summary: 'How build numbers are found in tags and releases',
    description:
      'Stored and effective tag and release-name patterns of a repository, or of one app with `appId`.',
    risk: 'read',
    access: { action: 'repositories.read' },
    query: z.object({ appId: z.string().optional() }),
    partial: true,
    responses: { '200': { description: 'The conventions.', schema: object } },
  },
  {
    id: 'setBuildConventions',
    method: 'put',
    path: `${W}/repositories/{id}/build-conventions`,
    tags: ['ci'],
    summary: 'Set how build numbers are found in tags and releases',
    description:
      'Replaces the convention of the repository, or of one app with `appId`. An empty pattern list means the built-in defaults. Body at most 16 KiB.',
    risk: 'write',
    access: { action: 'repositories.write' },
    body: conventionsInput,
    partial: true,
    responses: { '200': { description: 'The conventions after the change.', schema: object } },
  },
  {
    id: 'listBuildConventionTags',
    method: 'get',
    path: `${W}/repositories/{id}/build-conventions/tags`,
    tags: ['ci'],
    summary: 'Tags and releases of a repository, to try patterns against',
    description: 'Reads GitHub (a bounded number of pages) and keeps the answer for a minute.',
    risk: 'read',
    access: { action: 'repositories.scan' },
    partial: true,
    responses: {
      '200': { description: 'Tag names with their commits, and release names.', schema: object },
    },
  },
];
