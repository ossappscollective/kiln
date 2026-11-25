import { ApiError } from '../api.ts';
import { MAX_DISPATCH_INPUTS, parseFreeFormInputs } from '../ci/ci.ts';
import { t } from '../i18n/t.ts';
import type { WorkflowRun } from '../types.ts';
import { waitText } from './eas.ts';

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
export function startForm(form: StartForm): {
  problems: string[];
  body: EasWorkflowDispatchBody | null;
} {
  const problems: string[] = [];
  const file = workflowFileName(form.workflow);
  if (file === '') problems.push(t('eas:workflows.problem.file'));
  const ref = form.ref.trim();
  if (
    ref !== '' &&
    (!GIT_REF.test(ref) ||
      ref.indexOf('..') !== -1 ||
      ref.slice(-1) === '/' ||
      ref.slice(-5) === '.lock')
  ) {
    problems.push(t('eas:workflows.problem.ref'));
  }
  const parsed = parseFreeFormInputs(form.inputsText);
  // The count problem has its own short sentence here (the CI form's says "GitHub accepts at most ...").
  const tooMany = Object.keys(parsed.inputs).length > MAX_DISPATCH_INPUTS;
  const tooManyText = t('builds:ci.free.tooMany', { max: MAX_DISPATCH_INPUTS });
  for (const p of parsed.problems) {
    if (!(tooMany && p === tooManyText)) problems.push(p);
  }
  if (tooMany)
    problems.push(t('eas:workflows.problem.tooManyInputs', { max: MAX_DISPATCH_INPUTS }));
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
export function startSummary(input: {
  workflow: string;
  ref: string;
  project: string;
  inputCount: number;
}): string {
  const { workflow, project, inputCount: count } = input;
  const ref = input.ref.trim();
  if (ref === '')
    return count === 0
      ? t('eas:workflows.summary.defaultNone', { workflow, project })
      : t('eas:workflows.summary.defaultInputs', { workflow, project, count });
  return count === 0
    ? t('eas:workflows.summary.refNone', { workflow, ref, project })
    : t('eas:workflows.summary.refInputs', { workflow, ref, project, count });
}

/** Whether the card can offer to start a workflow, and if not, why not (one sentence). */
export function startBlocker(input: {
  credentialAvailable: boolean;
  hasRepository: boolean;
  canStart: boolean;
}): string {
  if (!input.credentialAvailable) return t('eas:workflows.blocker.credential');
  if (!input.hasRepository) return t('eas:workflows.blocker.repository');
  if (!input.canStart) return t('eas:workflows.blocker.role');
  return '';
}

/** A sentence for what the API said while starting or reading a run. */
export function easWorkflowErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return t('common:error.genericRetry');
  const own = typeof error.body.message === 'string' ? error.body.message : '';
  switch (error.code) {
    case 'forbidden':
      return t('eas:workflows.blocker.role');
    case 'not_found':
      return t('eas:workflows.err.notFound');
    case 'expo_not_linked':
      return t('eas:workflows.err.notLinked');
    case 'repository_required':
      return own || t('eas:workflows.err.repository');
    case 'invalid_workflow':
    case 'invalid_ref':
    case 'invalid_request':
      return own || t('eas:workflows.err.invalid');
    case 'credential_not_found':
    case 'credential_kind':
    case 'credential_unreadable':
      return own || t('eas:workflows.err.credential');
    case 'expo_auth':
    case 'expo_forbidden':
    case 'expo_not_found':
    case 'expo_unavailable':
      return own || t('eas:err.expoAsk');
    case 'rate_limited':
      return t('eas:err.rateLimited', { wait: waitText(error.retryAfter ?? 60) });
    case 'timeout':
      return own || t('eas:workflows.err.timeout');
    default:
      return error.status >= 500 ? t('errors:http.serverError') : error.message;
  }
}

/** Runs not finished yet: the ones to ask Expo about. */
export const activeRuns = (runs: readonly WorkflowRun[]): WorkflowRun[] =>
  runs.filter((r) => r.active);
