import { ApiError, waitPhrase } from '../api.ts';
import { parseFreeFormInputs } from '../ci/ci.ts';
import type { WorkflowRun } from '../types.ts';

/**
 * Pure helpers of the "Workflows" part of the Expo project card (docs/adr/0035-eas-workflows.md, docs/api/eas-workflows.md): what the
 * API takes and answers, the check of what is typed (the server checks it again) and a sentence for each error code. Written for the
 * ES2017 web build.
 */

/** `POST /apps/{appId}/expo/workflows/dispatches`. */
export type EasWorkflowDispatchBody = {
  workflow: string;
  ref?: string | undefined;
  inputs?: Record<string, string> | undefined;
};

export type EasJobView = {
  key: string;
  name: string;
  type: string;
  status: string;
  buildId: string | null;
  submissionId: string | null;
};

/** `GET /apps/{appId}/expo/workflows/runs/{runId}`. `jobs` is empty unless the run was refreshed from Expo. */
export type EasWorkflowRunRead = { run: WorkflowRun; jobs: EasJobView[]; refreshed: boolean };

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** The file name Expo wants from `.eas/workflows/build.yml` or `build.yml`; '' when it is neither. */
export function workflowFileName(text: string): string {
  let name = text.trim();
  if (name.startsWith('./')) name = name.slice(2);
  if (name.startsWith('.eas/workflows/')) name = name.slice('.eas/workflows/'.length);
  return FILE_NAME.test(name) ? name : '';
}

export type StartForm = { workflow: string; ref: string; inputsText: string };

/** What is wrong with the form, as sentences; empty when it can be sent. `body` is then what to send. */
export function startForm(form: StartForm): { problems: string[]; body: EasWorkflowDispatchBody | null } {
  const problems: string[] = [];
  const file = workflowFileName(form.workflow);
  if (file === '') problems.push('Enter a workflow file in .eas/workflows, such as build.yml.');
  const ref = form.ref.trim();
  if (ref !== '' && (!GIT_REF.test(ref) || ref.indexOf('..') !== -1 || ref.slice(-1) === '/' || ref.slice(-5) === '.lock')) {
    problems.push('Use a branch, a tag or a commit for the ref, or leave it empty for the default branch.');
  }
  const parsed = parseFreeFormInputs(form.inputsText);
  for (const p of parsed.problems) problems.push(p.replace('GitHub accepts at most', 'At most'));
  if (problems.length > 0) return { problems, body: null };
  return {
    problems,
    body: {
      workflow: file,
      ...(ref === '' ? {} : { ref }),
      ...(Object.keys(parsed.inputs).length === 0 ? {} : { inputs: parsed.inputs }),
    },
  };
}

/** The confirmation sentence: what is about to run at Expo, on which ref, with how many inputs. */
export function startSummary(input: { workflow: string; ref: string; project: string; inputCount: number }): string {
  const withInputs = input.inputCount === 0 ? 'with no inputs' : `with ${input.inputCount} input${input.inputCount === 1 ? '' : 's'}`;
  return `Run ${input.workflow} on ${input.ref} in ${input.project} at Expo ${withInputs}. It runs with the EAS secrets of the project.`;
}

/** Whether the card can offer to start a workflow, and if not, why not (one sentence). */
export function startBlocker(input: { credentialAvailable: boolean; hasRepository: boolean; canStart: boolean }): string {
  if (!input.credentialAvailable) return 'The Expo credential of the link was deleted. Choose another above first.';
  if (!input.hasRepository) return 'Connect this app to its repository first: its runs are listed with the runs of the repository.';
  if (!input.canStart) return 'Starting a workflow needs the member or admin role.';
  return '';
}

/** A sentence for what the API said while starting or reading a run. */
export function easWorkflowErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  const own = typeof error.body.message === 'string' ? error.body.message : '';
  switch (error.code) {
    case 'forbidden':
      return 'Starting a workflow needs the member or admin role.';
    case 'not_found':
      return 'That app or run no longer exists. Reload the page.';
    case 'expo_not_linked':
      return 'This app is not linked to an Expo project.';
    case 'repository_required':
      return own || 'Connect this app to its repository first.';
    case 'invalid_workflow':
    case 'invalid_ref':
    case 'invalid_request':
      return own || 'Check the workflow file, the ref and the inputs.';
    case 'credential_not_found':
    case 'credential_kind':
    case 'credential_unreadable':
      return own || 'The Expo credential cannot be used. Choose another one.';
    case 'expo_auth':
    case 'expo_forbidden':
    case 'expo_not_found':
    case 'expo_unavailable':
      return own || 'Expo could not be asked. Try again in a moment.';
    case 'rate_limited':
      return `Too many requests. Try again in ${waitPhrase(error.retryAfter ?? 60)}.`;
    case 'timeout':
      return own || 'Expo took too long to answer. The workflow may have started: look at the runs in Expo before trying again.';
    default:
      return error.status >= 500 ? 'The server had a problem. Try again.' : error.message;
  }
}

/** Runs not finished yet: the ones to ask Expo about. */
export const activeRuns = (runs: readonly WorkflowRun[]): WorkflowRun[] => runs.filter((r) => r.active);
