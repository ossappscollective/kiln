import type { ExpoRest } from './client.ts';
import { ExpoError } from './errors.ts';

/**
 * EAS Workflows over Expo's REST API (https://docs.expo.dev/eas/workflows/rest-api/, read 2026-11-20): start a workflow run and read a
 * run with its jobs, with the same bearer token the GraphQL client uses. Two endpoints, both under `https://api.expo.dev`:
 *
 * - `POST /v2/workflows/dispatch` with `{ appId, gitRef, fileName, inputs? }` answers `200 { data: { id, url } }`. `fileName` is the file
 *   name only (`deploy.yml`), without `.eas/workflows/`. 400: the body or the inputs do not fit the file's `workflow_dispatch` inputs;
 *   403: the token has no access to the project; 404: the Git ref or the workflow file does not exist.
 * - `GET /v2/workflows/runs/:workflowRunId` answers `200 { data: { id, status, url, gitCommitHash, gitCommitMessage, requestedGitRef,
 *   triggerEventType, createdAt, updatedAt, jobs: [...] } }`. Timestamps are ISO 8601 UTC strings. Run statuses: `new`, `waiting` (waits
 *   for another run of its concurrency group), `in-progress`, `action-required` (paused for a manual action), and the terminal `success`,
 *   `failure`, `canceled`. A job has `id, key, name, type, status, requiredJobKeys, environment, outputs, errors, buildId, submissionId,
 *   createdAt, updatedAt`; `buildId` and `submissionId` name the Expo Build and Submit records of `build` and `submission` jobs.
 *
 * UNVERIFIED (not stated by the docs, not guessed here): whether `.yaml` file names are accepted (this code lets them through and
 * Expo answers); whether input values must be strings (they are sent as given, not converted); which role is the least that may dispatch;
 * whether Expo rate limits these endpoints (a 429 is handled like everywhere else); there is no endpoint to list runs or workflow files,
 * so only runs started through this tool can be followed; the docs page on managing runs also lists a `Queued` status for runs waiting
 * in a concurrency group, while the REST page calls it `waiting`: both are read as waiting; any other status is refused as unreadable
 * instead of being guessed. The run answer has no workflow name, so the name comes from what was dispatched.
 */

export const EXPO_WORKFLOWS_DIR = '.eas/workflows';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 500): string | undefined =>
  typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined;
const unreadable = () => new ExpoError('unexpected');

/** A workflow run id (Expo's examples are UUIDs, version 7). */
export const EXPO_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isExpoRunId = (value: string): boolean => EXPO_RUN_ID.test(value);

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/;

/**
 * The file name Expo wants from `.eas/workflows/build.yml`, `./.eas/workflows/build.yml` or `build.yml`; undefined when it is
 * none of these (a path into a folder, a name without `.yml`).
 */
export function normalizeWorkflowFileName(value: string): string | undefined {
  let name = value.trim();
  if (name.startsWith('./')) name = name.slice(2);
  if (name.startsWith(`${EXPO_WORKFLOWS_DIR}/`)) name = name.slice(EXPO_WORKFLOWS_DIR.length + 1);
  return FILE_NAME.test(name) ? name : undefined;
}

/** The path as a person knows it: `.eas/workflows/build.yml`. */
export const workflowPathOf = (fileName: string): string => `${EXPO_WORKFLOWS_DIR}/${fileName}`;

const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

/** A branch, a tag, a commit SHA or a fully qualified ref (`refs/heads/main`); undefined when it cannot be one. */
export function normalizeGitRef(value: string): string | undefined {
  const ref = value.trim();
  if (!GIT_REF.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock'))
    return undefined;
  return ref;
}

/** What a run's status is called in the vocabulary the CI runs of this tool share (GitHub's words, kept verbatim for GitHub). */
export type CiStatusWords = {
  status: 'queued' | 'waiting' | 'in_progress' | 'completed';
  /** Set when `status` is `completed`. */
  conclusion?: 'success' | 'failure' | 'cancelled';
};

export const EXPO_RUN_STATUSES = [
  'new',
  'waiting',
  'queued',
  'in-progress',
  'action-required',
  'success',
  'failure',
  'canceled',
] as const;
export type ExpoWorkflowRunStatus = (typeof EXPO_RUN_STATUSES)[number];

/**
 * Expo's run status in CI words: `new` is queued; `waiting` (and `queued`, see above) and `action-required` (a person must approve)
 * are waiting; `in-progress` is in progress; the terminal ones are completed with a conclusion (`canceled` is `cancelled`).
 * Undefined for a status this code does not know.
 */
export function ciStatusOfExpoRun(status: string): CiStatusWords | undefined {
  switch (status) {
    case 'new':
      return { status: 'queued' };
    case 'waiting':
    case 'queued':
    case 'action-required':
      return { status: 'waiting' };
    case 'in-progress':
      return { status: 'in_progress' };
    case 'success':
      return { status: 'completed', conclusion: 'success' };
    case 'failure':
      return { status: 'completed', conclusion: 'failure' };
    case 'canceled':
      return { status: 'completed', conclusion: 'cancelled' };
    default:
      return undefined;
  }
}

export type ExpoWorkflowInputs = Record<string, string | number | boolean>;

export type ExpoWorkflowDispatch = {
  /** The project id (a UUID, `expo.extra.eas.projectId`). */
  projectId: string;
  /** From `normalizeWorkflowFileName`. */
  fileName: string;
  /** From `normalizeGitRef`. */
  gitRef: string;
  inputs?: ExpoWorkflowInputs | undefined;
};

export type ExpoWorkflowStarted = {
  /** The run id. */
  id: string;
  /** The run's page on expo.dev, or null when Expo sent none that is an https address. */
  url: string | null;
};

const httpsUrl = (value: unknown): string | null => {
  const raw = text(value, 1000);
  if (!raw) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
};

const DISPATCH_INVALID =
  'Expo refused the workflow request. Check the workflow file name, the Git ref and that the inputs match the inputs the workflow file declares.';
const DISPATCH_NOT_FOUND = 'Expo could not find that Git ref or workflow file in the project.';

/**
 * Starts a workflow run. A WRITE at Expo: it is never retried (a second call would start a second run), and a timeout leaves it
 * unknown whether the run started.
 */
export async function dispatchExpoWorkflow(
  client: ExpoRest,
  input: ExpoWorkflowDispatch,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<ExpoWorkflowStarted> {
  const body = await client.rest<unknown>(
    {
      method: 'POST',
      path: '/v2/workflows/dispatch',
      body: {
        appId: input.projectId.toLowerCase(),
        gitRef: input.gitRef,
        fileName: input.fileName,
        ...(input.inputs && Object.keys(input.inputs).length > 0 ? { inputs: input.inputs } : {}),
      },
      invalid: DISPATCH_INVALID,
      notFound: DISPATCH_NOT_FOUND,
    },
    options,
  );
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data)) throw unreadable();
  const id = text(data.id, 100);
  // The id goes into a path later: only an id of the shape Expo documents is accepted.
  if (!id || !isExpoRunId(id)) throw unreadable();
  return { id, url: httpsUrl(data.url) };
}

export type ExpoWorkflowJob = {
  id: string;
  key: string;
  name: string;
  /** `build`, `submission`, ... as Expo says; kept verbatim. */
  type: string;
  /** Expo's job status (`new`, `in-progress`, `action-required`, `pending-cancel`, `success`, `failure`, `canceled`, `skipped`), verbatim. */
  status: string;
  /** The Expo Build of a `build` job, the Expo Submit record of a `submission` job. */
  buildId: string | null;
  submissionId: string | null;
};

export type ExpoWorkflowRun = {
  id: string;
  /** Expo's status, one of `EXPO_RUN_STATUSES`. */
  status: ExpoWorkflowRunStatus;
  ci: CiStatusWords;
  url: string | null;
  gitCommitHash: string | null;
  /** The first line only. */
  gitCommitMessage: string | null;
  requestedGitRef: string | null;
  triggerEventType: string | null;
  /** Epoch milliseconds. */
  createdAt: number | null;
  updatedAt: number | null;
  jobs: ExpoWorkflowJob[];
};

const MAX_JOBS = 100;

const timeOf = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

function jobOf(value: unknown): ExpoWorkflowJob {
  if (!isRecord(value)) throw unreadable();
  const id = text(value.id, 100);
  const status = text(value.status, 40);
  if (!id || !status) throw unreadable();
  const key = text(value.key, 200) ?? id;
  return {
    id,
    key,
    name: text(value.name, 200) ?? key,
    type: text(value.type, 40) ?? 'unknown',
    status,
    buildId: text(value.buildId, 100) ?? null,
    submissionId: text(value.submissionId, 100) ?? null,
  };
}

/** A workflow run with its jobs. `not_found` when Expo has none the token can see. Outputs, errors and environment are not read. */
export async function expoWorkflowRun(
  client: ExpoRest,
  runId: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<ExpoWorkflowRun> {
  if (!isExpoRunId(runId))
    throw new ExpoError('invalid_input', { message: 'That is not a workflow run id.' });
  const body = await client.rest<unknown>(
    {
      method: 'GET',
      path: `/v2/workflows/runs/${encodeURIComponent(runId.toLowerCase())}`,
      notFound: 'Expo has no such workflow run, or the token cannot see it.',
      invalid: 'That is not a workflow run id.',
    },
    options,
  );
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data)) throw unreadable();
  const id = text(data.id, 100);
  const status = text(data.status, 40);
  if (!id || !status) throw unreadable();
  const ci = ciStatusOfExpoRun(status);
  if (!ci) throw unreadable();
  const jobs = Array.isArray(data.jobs) ? data.jobs.slice(0, MAX_JOBS).map(jobOf) : [];
  return {
    id,
    status: status as ExpoWorkflowRunStatus,
    ci,
    url: httpsUrl(data.url),
    gitCommitHash: text(data.gitCommitHash, 100) ?? null,
    gitCommitMessage:
      text(data.gitCommitMessage, 2000)?.split(/\r?\n/, 1)[0]?.trim().slice(0, 200) || null,
    requestedGitRef: text(data.requestedGitRef, 200) ?? null,
    triggerEventType: text(data.triggerEventType, 60) ?? null,
    createdAt: timeOf(data.createdAt),
    updatedAt: timeOf(data.updatedAt),
    jobs,
  };
}
