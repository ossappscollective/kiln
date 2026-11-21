import { analyticsLimits, isAnalyticsErrorCode, metricInfo } from '@kiln/core';
import { ApiError } from '../api.ts';
import {
  analyticsErrorText,
  type EnablePlan,
  type EnablePreview,
  formatCountExact,
  formatDay,
  type ImportPlan,
  type ImportPreview,
  type ImportResult,
  setupSentence,
} from './analytics.ts';

/**
 * The two guarded flows of analytics, as pure logic: enabling Apple analytics (preview what will be created, then a typed
 * confirmation) and importing a report file (check the file, preview its rows, confirm by hash). The components only draw
 * what this module decides. The server's hash is the real guard; this decides what a person is asked to do first.
 */

// ---------------------------------------------------------------------------------------------
// Enable Apple analytics

/** The text to type before the request is created at Apple. It is the one store write of analytics. */
export const ENABLE_PHRASE = 'enable';

export const confirmationMatches = (typed: string): boolean => typed.trim() === ENABLE_PHRASE;

type StepKey = EnablePlan['steps'][number];

/** One step of the plan in words (the server's `willSend` lines say the same for what would be sent). */
export function describeStep(step: StepKey): string {
  const snapshot = step.accessType === 'ONE_TIME_SNAPSHOT';
  const name = snapshot ? 'one-time snapshot' : 'ongoing report request';
  switch (step.action) {
    case 'create':
      return snapshot
        ? 'Create a one-time snapshot request, which brings history from 2024-01-01. Apple allows one a month.'
        : 'Create an ongoing report request. Apple then makes daily reports from the day of the request.';
    case 'adopt':
      return `Apple already has a ${name} for this app. It is kept and this server starts using it. Nothing is created.`;
    case 'exists':
      return `The ${name} is already in place. Nothing to do.`;
    default:
      return `A ${name} step.`;
  }
}

export type EnableDecision =
  /** Nothing would change: it is already enabled. */
  | { kind: 'nothing' }
  /** The key may not create requests: offer the file import instead. */
  | { kind: 'import_instead' }
  | { kind: 'confirm'; creates: number; adopts: number };

/** What the dialog offers for a preview. */
export function enableDecision(preview: EnablePreview): EnableDecision {
  if (!preview.canCreate || preview.plan.roleCheck !== 'ok') return { kind: 'import_instead' };
  const creates = preview.plan.steps.filter((s) => s.action === 'create').length;
  const adopts = preview.plan.steps.filter((s) => s.action === 'adopt').length;
  if (creates + adopts === 0) return { kind: 'nothing' };
  return { kind: 'confirm', creates, adopts };
}

/** The confirm button is live only when the plan can be applied, the box is ticked and the phrase is typed exactly. */
export const canConfirmEnable = (
  preview: EnablePreview | null,
  acknowledged: boolean,
  typed: string,
): boolean =>
  !!preview &&
  enableDecision(preview).kind === 'confirm' &&
  preview.confirmHash !== '' &&
  acknowledged &&
  confirmationMatches(typed);

export type EnableFailure =
  /** The plan changed at Apple since the preview. The answer carries the new plan when it can be read. */
  | { kind: 'plan_changed'; preview: EnablePreview | null; message: string }
  | { kind: 'role_required'; message: string }
  | { kind: 'disabled'; message: string }
  | { kind: 'other'; message: string };

const asPreview = (value: unknown): EnablePreview | null => {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const plan = v.plan as EnablePlan | undefined;
  if (!plan || !Array.isArray(plan.steps) || typeof v.confirmHash !== 'string') return null;
  return { plan, confirmHash: v.confirmHash, canCreate: v.canCreate === true };
};

/** Sorts an error of the enable call into what the dialog does next. A store's own text is never shown. */
export function classifyEnableError(error: unknown): EnableFailure {
  const message = analyticsErrorText(error);
  if (error instanceof ApiError) {
    if (error.code === 'plan_changed')
      return { kind: 'plan_changed', preview: asPreview(error.body), message };
    if (error.code === 'analytics_role_required') return { kind: 'role_required', message };
    if (error.code === 'analytics_disabled') return { kind: 'disabled', message };
  }
  return { kind: 'other', message };
}

// ---------------------------------------------------------------------------------------------
// Import a report file

export const MAX_IMPORT_BYTES = analyticsLimits.maxFileBytes;

/** Why a file cannot be sent, or '' when it can. The server checks the content; this only saves a pointless upload. */
export function checkImportFile(file: { name: string; size: number }): string {
  if (file.size <= 0) return 'The file is empty.';
  if (file.size > MAX_IMPORT_BYTES) return 'The file is larger than 10 MiB.';
  if (file.name.length > 200) return 'The file name is longer than 200 characters.';
  return '';
}

export type ImportState =
  | { phase: 'idle' }
  | { phase: 'checking'; fileName: string }
  | { phase: 'preview'; fileName: string; plan: ImportPlan; confirmHash: string }
  | { phase: 'importing'; fileName: string; plan: ImportPlan; confirmHash: string }
  | { phase: 'done'; fileName: string; result: ImportResult['imported'] }
  | {
      phase: 'error';
      fileName: string | null;
      during: 'preview' | 'import';
      code: string;
      message: string;
    };

export type ImportEvent =
  | { type: 'pick'; fileName: string }
  | { type: 'previewed'; preview: ImportPreview }
  | { type: 'confirm' }
  | { type: 'imported'; result: ImportResult['imported'] }
  | { type: 'failed'; during: 'preview' | 'import'; code: string; message: string }
  | { type: 'reset' };

export const idleImport: ImportState = { phase: 'idle' };

/** One step of the import. An event that does not fit the state is ignored, so a late answer cannot jump a step. */
export function importStep(state: ImportState, event: ImportEvent): ImportState {
  switch (event.type) {
    case 'reset':
      return state.phase === 'importing' || state.phase === 'checking' ? state : idleImport;
    case 'pick':
      return state.phase === 'importing' || state.phase === 'checking'
        ? state
        : { phase: 'checking', fileName: event.fileName };
    case 'previewed':
      return state.phase === 'checking'
        ? {
            phase: 'preview',
            fileName: state.fileName,
            plan: event.preview.plan,
            confirmHash: event.preview.confirmHash,
          }
        : state;
    case 'confirm':
      return state.phase === 'preview' && canConfirmImport(state)
        ? {
            phase: 'importing',
            fileName: state.fileName,
            plan: state.plan,
            confirmHash: state.confirmHash,
          }
        : state;
    case 'imported':
      return state.phase === 'importing'
        ? { phase: 'done', fileName: state.fileName, result: event.result }
        : state;
    case 'failed': {
      if (event.during === 'preview' && state.phase !== 'checking') return state;
      if (event.during === 'import' && state.phase !== 'importing') return state;
      const fileName =
        state.phase === 'checking' || state.phase === 'importing' ? state.fileName : null;
      return {
        phase: 'error',
        fileName,
        during: event.during,
        code: event.code,
        message: event.message,
      };
    }
    default:
      return state;
  }
}

/** Something to store and the hash of the preview. A file with nothing usable cannot be confirmed. */
export const canConfirmImport = (state: ImportState): boolean =>
  (state.phase === 'preview' || state.phase === 'importing') &&
  state.confirmHash !== '' &&
  state.plan.points > 0;

/** The sentence for a failed preview or import: from the fixed vocabularies, never the file's text. */
export function importErrorText(error: unknown): { code: string; message: string } {
  const code = error instanceof ApiError ? error.code : '';
  if (error instanceof ApiError && isAnalyticsErrorCode(code))
    return { code, message: analyticsErrorText(error) };
  return { code, message: analyticsErrorText(error) };
}

export type PreviewFacts = {
  report: string;
  range: string;
  rows: string[];
  days: string;
  metrics: { label: string; days: number; total: string }[];
  willStore: string;
};

/** What the preview says before anything is stored: which report, the dates, the rows read and skipped, the metrics. */
export function previewFacts(plan: ImportPlan): PreviewFacts {
  const s = plan.stats;
  const rows = [`${formatCountExact(s.rowsRead)} rows read, ${formatCountExact(s.rowsUsed)} used`];
  if (s.rowsFiltered > 0)
    rows.push(
      `${formatCountExact(s.rowsFiltered)} left out because they belong to another app or platform`,
    );
  if (s.rowsUnreadable > 0) rows.push(`${formatCountExact(s.rowsUnreadable)} could not be read`);
  const range =
    plan.dateFrom && plan.dateTo
      ? plan.dateFrom === plan.dateTo
        ? formatDay(plan.dateFrom, true)
        : `${formatDay(plan.dateFrom, true)} to ${formatDay(plan.dateTo, true)}`
      : 'No dates found';
  return {
    report: plan.report.label || 'Apple report',
    range,
    rows,
    days: `${formatCountExact(plan.days)} ${plan.days === 1 ? 'day' : 'days'}`,
    metrics: plan.metrics.map((m) => ({
      label: m.label,
      days: m.days,
      total: m.total === null ? 'Average, not a total' : formatCountExact(m.total),
    })),
    willStore:
      plan.points > 0
        ? `${formatCountExact(plan.points)} values for ${formatCountExact(plan.days)} ${plan.days === 1 ? 'day' : 'days'} can be stored.`
        : 'Nothing in this file can be stored.',
  };
}

export type SampleTable = { columns: string[]; rows: string[][] };

/** The few normalised rows of the preview as a small table. Rows of an unexpected shape are left out. */
export function sampleTable(sample: readonly unknown[]): SampleTable {
  const rows: string[][] = [];
  for (const item of sample) {
    if (!item || typeof item !== 'object') continue;
    const r = item as {
      date?: unknown;
      metric?: unknown;
      value?: unknown;
      dimension?: { type?: unknown; value?: unknown };
    };
    if (typeof r.date !== 'string' || typeof r.metric !== 'string' || typeof r.value !== 'number')
      continue;
    const label = (metricInfo as Record<string, { label: string }>)[r.metric]?.label ?? r.metric;
    const dim =
      r.dimension && typeof r.dimension.type === 'string' && typeof r.dimension.value === 'string'
        ? `${r.dimension.type.replace(/_/g, ' ')}: ${r.dimension.value}`
        : 'Total';
    rows.push([
      formatDay(r.date, true),
      label,
      dim,
      Number.isInteger(r.value) ? formatCountExact(r.value) : String(r.value),
    ]);
    if (rows.length >= 6) break;
  }
  return { columns: ['Date', 'Metric', 'Dimension', 'Value'], rows };
}

/** The notes of a preview: plain short sentences, drawn as text. */
export function previewNotes(notes: readonly unknown[]): string[] {
  return notes
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    .map((n) => (n.length > 300 ? `${n.slice(0, 297)}...` : n));
}

/** The line after a successful import, from the numbers of the answer. A repeat of the same file stores nothing, and says so. */
export function importedText(result: ImportResult['imported']): string {
  if (result.written === 0)
    return 'Nothing new was stored: every value was already there, or the store API already had it.';
  const parts = [`Stored ${formatCountExact(result.written)} values`];
  if (result.unchanged > 0) parts.push(`${formatCountExact(result.unchanged)} were already there`);
  const range =
    result.dateFrom && result.dateTo
      ? ` for ${formatDay(result.dateFrom, true)} to ${formatDay(result.dateTo, true)}`
      : '';
  return `${parts.join(', ')}${range}.`;
}

export const importSetupHint = (): string => setupSentence('role_required');
