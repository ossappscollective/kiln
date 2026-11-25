import { type Platform, platformMeta } from '@kiln/core';
import { codedText, paramsOf } from './error-text.ts';
import { t } from './i18n/t.ts';
import {
  failedSentence,
  type LastPublish,
  outcomeSentence,
  type RunStep,
  STEP_NAME,
  skippedSentence,
} from './pending.ts';

/**
 * Why a publish failed, as a person reads it (docs/api/pending.md "Why a publish failed"). Pure: from the run the server kept
 * (`LastPublish`: per step the error code, the HTTP status, what the store said, cleaned by the server) it builds, for each step, its
 * status, the reason (a title from the error code, the advice of the cause when the server named one, the store's own sentence cut to
 * 300 characters with a "Show more") and a technical line (`store_rejected · HTTP 422 · badRequest`), and the plain-text report that
 * "Copy details" puts on the clipboard. Text from a store is cleaned AGAIN here (control characters, token-shaped strings): the server
 * is trusted, a screen that shows or copies a store's words is not the place to rely on it alone.
 * Written for the ES2017 web build: no flatMap, no fromEntries.
 */

/** The store's sentence is cut here with a "Show more". */
export const SAID_SHOWN = 300;

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bya29\.[A-Za-z0-9._-]{16,}/g,
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[A-Za-z0-9+=_-]{40,}\b/g,
];

/** Text from a store as one clean line: no control characters, no token-shaped string, white space collapsed. */
export function cleanText(text: string | undefined): string {
  let out = (text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ');
  for (const pattern of SECRETS)
    out = out.replace(pattern, (m) =>
      /^(bearer|token)\s/i.test(m) ? `${m.split(/\s/)[0]} [redacted]` : '[redacted]',
    );
  return out.replace(/\s+/g, ' ').trim();
}

/** The text cut to `max` characters at a word when it can, with whether it was cut. */
export function clip(text: string, max: number = SAID_SHOWN): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return { text: `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`, cut: true };
}

export type FailureReason = {
  /** From the error code: "The store rejected this step." */
  title: string;
  /** What to do, when the server named a known cause (`store.google.draftApp`); '' otherwise. */
  advice: string;
  /** The store's own sentence, cleaned (empty when it said nothing). */
  said: string;
  /** `store_rejected · HTTP 422 · badRequest`. */
  technical: string;
  /** What is known of the outcome: nothing was changed, or look at the store. */
  outcome: string;
};

const safeCode = (code: string): string =>
  code.replace(/[^a-z0-9_.]/gi, '').slice(0, 60) || 'error';

/** The store's own words of a failed step: its sentence (the first detail that has one), else nothing. */
const saidOf = (step: RunStep): string => {
  const details = step.store?.details ?? [];
  for (const d of details) if (d.detail) return cleanText(d.detail);
  return '';
};

/** The reason of one failed step. */
export function reasonOf(step: RunStep): FailureReason {
  const error = step.error ?? 'error';
  const title =
    failedSentence(error) || t('app:pending.failed.unknownCode', { code: safeCode(error) });
  const coded = step.code ? codedText(step.code, paramsOf(step.params)) : undefined;
  // A newer server's cause this app has no sentence for: its own English sentence stands in.
  const advice = coded ?? (step.code && step.message ? cleanText(step.message) : '');
  const first = step.store?.details?.[0];
  const parts = [safeCode(error)];
  if (step.httpStatus !== undefined) parts.push(`HTTP ${step.httpStatus}`);
  if (step.store?.httpStatus !== undefined && step.store.httpStatus !== step.httpStatus)
    parts.push(`store HTTP ${step.store.httpStatus}`);
  if (first?.code) parts.push(cleanText(first.code).slice(0, 60));
  if (first?.title) parts.push(cleanText(first.title).slice(0, 60));
  return {
    title,
    advice: advice === title ? '' : advice,
    said: saidOf(step),
    technical: parts.join(' · '),
    outcome: outcomeSentence(step.outcome),
  };
}

export type StepLine = {
  key: string;
  type: RunStep['type'];
  label: string;
  status: RunStep['status'];
  word: string;
  tone: 'ok' | 'bad' | 'neutral';
  /** Failed: why. */
  reason: FailureReason | null;
  /** Skipped: why it was not run (one sentence). */
  note: string;
};

/** Every step of a run as a line: done, failed with its reason, or not run with its reason. */
export function stepLines(run: Pick<LastPublish, 'results'>): StepLine[] {
  return run.results.map((step) => ({
    key: step.type,
    type: step.type,
    label: STEP_NAME[step.type],
    status: step.status,
    word:
      step.status === 'applied'
        ? t('app:pending.result.done')
        : step.status === 'failed'
          ? t('app:pending.result.failed')
          : t('app:pending.result.notRun'),
    tone: step.status === 'applied' ? 'ok' : step.status === 'failed' ? 'bad' : 'neutral',
    reason: step.status === 'failed' ? reasonOf(step) : null,
    note: step.status === 'skipped' ? skippedSentence(step.reason) : '',
  }));
}

/** `Stopped at: Push the draft. 0 done, 1 failed, 2 not run.` */
export function runSummary(run: Pick<LastPublish, 'results' | 'completed'>): {
  title: string;
  text: string;
} {
  const count = (s: RunStep['status']) => run.results.filter((r) => r.status === s).length;
  const stopped = run.results.find((r) => r.status !== 'applied');
  return {
    title: stopped
      ? t('app:pending.result.stoppedAt', { step: STEP_NAME[stopped.type] })
      : t('app:pending.result.notAll'),
    text: t('app:pending.result.counts', {
      applied: count('applied'),
      failed: count('failed'),
      skipped: count('skipped'),
    }),
  };
}

/** The first failed step's reason on one line, for a place with no room for the list (a toast, a tooltip). */
export function headlineReason(run: Pick<LastPublish, 'results'>): string {
  const step = run.results.find((r) => r.status === 'failed');
  if (!step) return '';
  const r = reasonOf(step);
  const quoted = r.said === '' ? '' : clip(r.said, 160).text;
  return [r.advice || r.title, quoted].filter((x) => x !== '').join(' ');
}

const iso = (at: number): string => new Date(at).toISOString();

/**
 * The plain-text report "Copy details" copies, for a support request or an issue: the app, the steps, what each step did and why one
 * failed, with times, codes and HTTP statuses. Redacted again here, and with no person's name or address: the store's words, codes and
 * times only.
 */
export function failureReport(input: {
  appName: string;
  platform: Platform;
  run: LastPublish;
}): string {
  const { run } = input;
  const lines: string[] = [
    'Kiln publish report',
    `App: ${cleanText(input.appName)} (${platformMeta(input.platform).label})`,
    `Run: ${safeCode(run.id)}`,
    `Started: ${iso(run.startedAt)}`,
    `Finished: ${iso(run.finishedAt)}`,
    `Outcome: ${run.outcome}`,
    `Steps: ${run.steps.join(', ')}`,
  ];
  run.results.forEach((step, i) => {
    const head = `${i + 1}. ${step.type}: ${step.status === 'skipped' ? 'not run' : step.status}`;
    lines.push('', `${head} (${iso(step.startedAt)} to ${iso(step.finishedAt)})`);
    if (step.status === 'skipped') {
      if (step.reason) lines.push(`   Reason: ${safeCode(step.reason)}`);
      return;
    }
    if (step.status === 'applied') return;
    if (step.error) lines.push(`   Code: ${safeCode(step.error)}`);
    if (step.httpStatus !== undefined) lines.push(`   HTTP status: ${step.httpStatus}`);
    if (step.outcome) lines.push(`   Outcome: ${step.outcome}`);
    if (step.code) lines.push(`   Cause: ${safeCode(step.code)}`);
    if (step.message) lines.push(`   Message: ${clip(cleanText(step.message), 600).text}`);
    if (step.store) {
      lines.push(
        `   Store: ${step.store.kind}${step.store.httpStatus !== undefined ? `, HTTP ${step.store.httpStatus}` : ''}`,
      );
      for (const d of step.store.details ?? []) {
        const what = [d.code, d.title]
          .filter((x): x is string => Boolean(x))
          .map((x) => cleanText(x).slice(0, 80))
          .join(' ');
        const said = d.detail ? clip(cleanText(d.detail), 600).text : '';
        lines.push(`   Store said: ${[what, said].filter((x) => x !== '').join(': ')}`);
      }
    }
  });
  return `${lines.join('\n')}\n`;
}
