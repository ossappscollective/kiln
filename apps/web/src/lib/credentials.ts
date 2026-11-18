import type { CredentialGuide } from '@mrm/core';
import { ApiError } from './api.ts';
import { fullTime, timeAgo } from './format.ts';
import type { LastTest, TestResult } from './types.ts';

export type TestTone = 'ok' | 'bad' | 'none';

export type TestStatus = {
  state: 'working' | 'failed' | 'untested';
  /** The badge text: Working, Failed or Never tested. */
  label: string;
  tone: TestTone;
  /** "5 minutes ago", or an empty string when it was never tested. */
  when: string;
  /** A sentence for a tooltip: what happened, when, and what the provider said. */
  title: string;
};

/** What the status column shows for the last recorded test of a saved credential. */
export function testStatus(lastTest: LastTest | null | undefined, now: number = Date.now(), locale?: string): TestStatus {
  if (!lastTest) {
    return { state: 'untested', label: 'Never tested', tone: 'none', when: '', title: 'This credential has not been tested yet.' };
  }
  const state = lastTest.ok ? 'working' : 'failed';
  const label = lastTest.ok ? 'Working' : 'Failed';
  const when = timeAgo(lastTest.at, now, locale);
  const message = lastTest.message.trim();
  return {
    state,
    label,
    tone: lastTest.ok ? 'ok' : 'bad',
    when,
    title: `${label}, tested ${fullTime(lastTest.at, locale)}.${message ? ` ${message}` : ''}`,
  };
}

const MAX_DETAILS = 20;
const MAX_LINE = 300;

export type TestSummary = { ok: boolean; tone: 'ok' | 'bad'; message: string; details: string[] };

/**
 * Makes a test result safe and tidy to show: trims lines, drops blanks and duplicates, caps the
 * list, and supplies a message if the provider sent none.
 */
export function summarizeTest(result: TestResult): TestSummary {
  const clip = (text: string) => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text);
  const seen = new Set<string>();
  const details: string[] = [];
  for (const raw of Array.isArray(result.details) ? result.details : []) {
    if (typeof raw !== 'string') continue;
    const line = clip(raw.trim());
    if (!line || seen.has(line)) continue;
    seen.add(line);
    details.push(line);
    if (details.length >= MAX_DETAILS) break;
  }
  const message = typeof result.message === 'string' ? result.message.trim() : '';
  return {
    ok: result.ok,
    tone: result.ok ? 'ok' : 'bad',
    message: message ? clip(message) : result.ok ? 'The connection works.' : 'The test failed.',
    details,
  };
}

/** The sentence to show when the test could not run at all: no network, rate limit, or a refusal. */
export function testErrorMessage(error: unknown, fallback = 'Could not run the test. Try again.'): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** What to announce to a screen reader when a saved credential's test finishes. */
export function announceTest(label: string, result: TestResult): string {
  const { ok, message } = summarizeTest(result);
  return `${label}: ${ok ? 'test passed' : 'test failed'}. ${message}`;
}

/** Which parts of a guide have content. Empty parts are hidden, so a draft guide stays tidy. */
export function guideSections(guide: CredentialGuide) {
  return {
    prerequisites: guide.prerequisites.length > 0,
    steps: guide.steps.length > 0,
    permissions: guide.permissions.length > 0,
    troubleshooting: guide.troubleshooting.length > 0,
    links: guide.links.length > 0,
  };
}

/** "18 November 2026" from "2026-11-18", or an empty string when the date is missing or malformed. */
export function formatCheckedOn(iso: string, locale?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return '';
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return date.toLocaleDateString(locale, { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
}

/** Only web links are rendered as links, so content can never smuggle in a script URL. */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
