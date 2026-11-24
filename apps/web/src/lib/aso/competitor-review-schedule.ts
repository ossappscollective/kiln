import type { ReviewScheduleMode } from '@kiln/core';
import { formatDate, formatDateTime, formatRelativeTime } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';

/**
 * The schedule of the reads of competitor reviews, as the Competitors section shows it (docs/adr/0065-ai-review-privacy-and-competitor-schedule.md,
 * docs/api/aso.md). The server plans and runs the reads; this file turns its state into sentences. Pure: no network; `now` is passed in.
 */

export type ScheduleShape = { mode: ReviewScheduleMode; weekday: number | null; timezone: string | null };

export type CompetitorReviewState = {
  competitorId: string;
  name: string;
  store: string;
  supported: boolean;
  override: { mode: ReviewScheduleMode; weekday: number | null } | null;
  effective: ScheduleShape;
  lastReadAt: number | null;
  newCount: number;
  failures: number;
  lastError: string | null;
  backoffUntil: number | null;
  nextRunAt: number | null;
};

export type ReviewScheduleView = {
  schedule: ScheduleShape;
  paused: boolean;
  maxCompetitors: number;
  maxReviews: number;
  updatedAt: number | null;
  updatedBy: string | null;
  nextRunAt: number | null;
  limits: { maxCompetitors: number; maxReviews: number };
  competitors: CompetitorReviewState[];
  canEdit: boolean;
  notice: string;
};

export type ScheduleForm = { mode: ReviewScheduleMode; weekday: number; /** An IANA name; empty is UTC. */ timezone: string; paused: boolean; maxCompetitors: string; maxReviews: string };

export const scheduleModes: readonly ReviewScheduleMode[] = ['off', 'daily', 'weekly'];
export const modeText = { off: k('aso:schedule.mode.off'), daily: k('aso:schedule.mode.daily'), weekly: k('aso:schedule.mode.weekly') } as const;
/** Sunday is 0, as in the API; the week shown starts on Monday. */
export const weekdayOrder: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

/** The name of a weekday in the language of the screen (2024-01-07 was a Sunday). */
export const weekdayName = (day: number): string => formatDate(Date.UTC(2024, 0, 7 + day, 12), { weekday: 'long', timeZone: 'UTC' });

export const scheduleToForm = (view: Pick<ReviewScheduleView, 'schedule' | 'paused' | 'maxCompetitors' | 'maxReviews'>): ScheduleForm => ({
  mode: view.schedule.mode,
  weekday: view.schedule.weekday ?? 1,
  timezone: view.schedule.timezone ?? '',
  paused: view.paused,
  maxCompetitors: String(view.maxCompetitors),
  maxReviews: String(view.maxReviews),
});

export type ScheduleErrors = { maxCompetitors?: string; maxReviews?: string };

export function validateSchedule(form: ScheduleForm, limits: { maxCompetitors: number; maxReviews: number }): ScheduleErrors {
  const errors: ScheduleErrors = {};
  const within = (text: string, max: number) => /^\d{1,3}$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= max;
  if (!within(form.maxCompetitors, limits.maxCompetitors)) errors.maxCompetitors = t('aso:schedule.maxCompetitorsError', { max: limits.maxCompetitors });
  if (!within(form.maxReviews, limits.maxReviews)) errors.maxReviews = t('aso:schedule.maxReviewsError', { max: limits.maxReviews });
  return errors;
}

/** The body of the PUT: only what differs. */
export function scheduleChanges(view: Pick<ReviewScheduleView, 'schedule' | 'paused' | 'maxCompetitors' | 'maxReviews'>, form: ScheduleForm): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.mode !== view.schedule.mode) out.mode = form.mode;
  if (form.mode === 'weekly' && (form.mode !== view.schedule.mode || form.weekday !== view.schedule.weekday)) out.weekday = form.weekday;
  if (form.timezone !== (view.schedule.timezone ?? '')) out.timezone = form.timezone === '' ? null : form.timezone;
  if (form.maxCompetitors.trim() !== String(view.maxCompetitors)) out.maxCompetitors = Number(form.maxCompetitors);
  if (form.maxReviews.trim() !== String(view.maxReviews)) out.maxReviews = Number(form.maxReviews);
  return out;
}

export const isScheduleDirty = (view: Parameters<typeof scheduleChanges>[0], form: ScheduleForm): boolean => Object.keys(scheduleChanges(view, form)).length > 0;

/** "Reads every day" / "Reads every Monday" / "Does not read". */
export function scheduleSentence(s: ScheduleShape): string {
  if (s.mode === 'daily') return t('aso:schedule.everyDay');
  if (s.mode === 'weekly' && s.weekday !== null) return t('aso:schedule.everyWeekday', { day: weekdayName(s.weekday) });
  return t('aso:schedule.never');
}

/** The reason of a failed read, from its code; a code Kiln does not know reads as a general failure. */
export function readErrorText(code: string | null): string {
  switch (code) {
    case 'timeout':
      return t('aso:schedule.error.timeout');
    case 'rate_limited':
      return t('aso:schedule.error.rateLimited');
    case 'invalid_input':
      return t('aso:schedule.error.invalidInput');
    case null:
      return '';
    default:
      return code.startsWith('unavailable') ? t('aso:schedule.error.unavailable') : t('aso:schedule.error.failed');
  }
}

/**
 * The state line of one competitor: "Reads every Monday, last read 2 days ago, 3 new reviews" (or why it does not read), then the next run
 * or the failure. `parts` are separate so the screen can lay them out.
 */
export function competitorStateLines(c: CompetitorReviewState, paused: boolean, now: number): { schedule: string; last: string; next: string; failure: string } {
  if (!c.supported) return { schedule: t('aso:schedule.playOnly'), last: '', next: '', failure: '' };
  const schedule = paused && c.effective.mode !== 'off' ? t('aso:schedule.paused') : scheduleSentence(c.effective);
  const last =
    c.lastReadAt === null
      ? t('aso:schedule.neverRead')
      : t('aso:schedule.lastRead', { when: formatRelativeTime(c.lastReadAt, { now }), count: c.newCount });
  const next = c.nextRunAt === null ? '' : t('aso:schedule.nextRun', { when: formatDateTime(c.nextRunAt) });
  const failure = c.lastError === null ? '' : c.failures > 0 ? t('aso:schedule.failed', { reason: readErrorText(c.lastError), count: c.failures }) : t('aso:schedule.waiting', { reason: readErrorText(c.lastError) });
  return { schedule, last, next, failure };
}
