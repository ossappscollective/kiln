// When the public reviews of a followed App Store competitor are read on a schedule (docs/adr/0065-ai-review-privacy-and-competitor-schedule.md).
// Pure and clockless (callers pass `at`); ES2017 (the web imports it). Written for Kiln.

export const reviewScheduleModes = ['off', 'daily', 'weekly'] as const;
export type ReviewScheduleMode = (typeof reviewScheduleModes)[number];
export const isReviewScheduleMode = (v: unknown): v is ReviewScheduleMode =>
  typeof v === 'string' && (reviewScheduleModes as readonly string[]).includes(v);

export type ReviewSchedule = {
  mode: ReviewScheduleMode;
  /** 0 (Sunday) to 6, for `weekly`. */
  weekday: number | null;
  /** An IANA name; null reads as UTC (Kiln has no workspace or app timezone). */
  timezone: string | null;
};

export const competitorReviewLimits = {
  /** The most competitors one run of one app reads. */
  maxCompetitorsDefault: 5,
  maxCompetitorsMax: 10,
  /** The newest reviews of a read that are looked at and stored (one feed page is at most 50). */
  maxReviewsDefault: 20,
  maxReviewsMax: 50,
  /** A scheduled run starts at this local time plus a deterministic jitter, so runs do not meet at one minute. */
  baseMinutes: 5 * 60,
  jitterMinutes: 180,
  backoffMinMs: 15 * 60_000,
  backoffMaxMs: 6 * 60 * 60_000,
} as const;

export const offSchedule = (): ReviewSchedule => ({ mode: 'off', weekday: null, timezone: null });

const zoneOk = (tz: string): boolean => {
  if (tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export type ReviewScheduleIssue = { path: string; message: string };

/** A schedule from a body. `weekly` needs a weekday; `daily` and `off` drop it. */
export function normalizeReviewSchedule(
  input: unknown,
  base: ReviewSchedule,
): { ok: true; value: ReviewSchedule } | { ok: false; issues: ReviewScheduleIssue[] } {
  const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const issues: ReviewScheduleIssue[] = [];
  const value: ReviewSchedule = { ...base };
  if (raw.mode !== undefined) {
    if (isReviewScheduleMode(raw.mode)) value.mode = raw.mode;
    else issues.push({ path: 'mode', message: `Use one of ${reviewScheduleModes.join(', ')}.` });
  }
  if (raw.weekday !== undefined) {
    if (raw.weekday === null) value.weekday = null;
    else if (typeof raw.weekday === 'number' && Number.isInteger(raw.weekday) && raw.weekday >= 0 && raw.weekday <= 6) value.weekday = raw.weekday;
    else issues.push({ path: 'weekday', message: 'A whole number from 0 (Sunday) to 6.' });
  }
  if (raw.timezone !== undefined) {
    if (raw.timezone === null || raw.timezone === '') value.timezone = null;
    else if (typeof raw.timezone === 'string' && zoneOk(raw.timezone)) value.timezone = raw.timezone;
    else issues.push({ path: 'timezone', message: 'An IANA time zone such as Europe/Paris, or null for UTC.' });
  }
  if (issues.length === 0 && value.mode === 'weekly' && value.weekday === null) issues.push({ path: 'weekday', message: 'A weekly schedule needs a weekday.' });
  if (issues.length === 0 && value.mode !== 'weekly') value.weekday = null;
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/**
 * The schedule of one competitor: its own override when it has one (off, daily or weekly), else the app's. `override` null follows the app.
 * An override has its own weekday and keeps the time zone of the app.
 */
export function effectiveReviewSchedule(app: ReviewSchedule, override: { mode: ReviewScheduleMode; weekday: number | null } | null): ReviewSchedule {
  if (override === null) return app;
  if (override.mode === 'weekly' && override.weekday === null) return { ...app, mode: 'weekly', weekday: app.weekday === null ? 1 : app.weekday };
  return { mode: override.mode, weekday: override.mode === 'weekly' ? override.weekday : null, timezone: app.timezone };
}

// ---------------------------------------------------------------------------------------------
// Time

type Local = { year: number; month: number; day: number; weekday: number; minutes: number };

function local(tz: string | null, at: number): Local {
  const zone = tz !== null && zoneOk(tz) ? tz : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(at));
  const get = (type: string) => {
    for (const p of parts) if (p.type === type) return p.value;
    return '';
  };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

/** The offset of `tz` from UTC at `at`, in ms (whole minutes). */
function offsetAt(tz: string | null, at: number): number {
  const minute = at - (((at % 60_000) + 60_000) % 60_000);
  const l = local(tz, minute);
  return Date.UTC(l.year, l.month - 1, l.day, 0, l.minutes) - minute;
}

/** The instant of the wall clock `minutes` after midnight on the local date y-m-d. A gap in daylight saving time moves it forward. */
function zonedInstant(tz: string | null, y: number, m: number, d: number, minutes: number): number {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const first = guess - offsetAt(tz, guess);
  const second = guess - offsetAt(tz, first);
  return second;
}

/** A stable number from a key (FNV-1a), for the jitter. */
function hash(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Minutes after the base time at which this competitor runs: 0 to `jitterMinutes - 1`, the same every day. */
export const reviewJitterMinutes = (key: string): number => hash(key) % competitorReviewLimits.jitterMinutes;

/** The run instants of a schedule around `at`: from two days before to nine days after, oldest first. */
function slotsAround(s: ReviewSchedule, key: string, at: number): number[] {
  if (s.mode === 'off') return [];
  const offset = competitorReviewLimits.baseMinutes + reviewJitterMinutes(key);
  const out: number[] = [];
  const now = local(s.timezone, at);
  for (let delta = -2; delta <= 9; delta += 1) {
    const noon = Date.UTC(now.year, now.month - 1, now.day + delta, 12);
    const day = new Date(noon);
    if (s.mode === 'weekly' && day.getUTCDay() !== s.weekday) continue;
    out.push(zonedInstant(s.timezone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), offset));
  }
  return out.sort((a, b) => a - b);
}

/** The latest planned run at or before `at`, or null. */
export function latestReviewSlot(s: ReviewSchedule, key: string, at: number): number | null {
  let found: number | null = null;
  for (const slot of slotsAround(s, key, at)) if (slot <= at) found = slot;
  return found;
}

/** The first planned run after `at`, or null when the schedule is off. */
export function nextReviewSlot(s: ReviewSchedule, key: string, at: number): number | null {
  for (const slot of slotsAround(s, key, at)) if (slot > at) return slot;
  return null;
}

export type ReviewDueInput = {
  schedule: ReviewSchedule;
  /** The competitor id: the jitter is derived from it. */
  key: string;
  now: number;
  /** The last scheduled attempt, whatever its result. */
  lastAttemptAt: number | null;
  /** When the schedule was last changed: a new schedule waits for its next slot instead of reading at once. */
  changedAt: number;
  backoffUntil: number | null;
  paused: boolean;
};

export type ReviewDue = { due: boolean; reason: 'due' | 'off' | 'paused' | 'backoff' | 'not_yet' };

export function reviewReadDue(i: ReviewDueInput): ReviewDue {
  if (i.schedule.mode === 'off') return { due: false, reason: 'off' };
  if (i.paused) return { due: false, reason: 'paused' };
  if (i.backoffUntil !== null && i.backoffUntil > i.now) return { due: false, reason: 'backoff' };
  const slot = latestReviewSlot(i.schedule, i.key, i.now);
  const since = Math.max(i.lastAttemptAt === null ? 0 : i.lastAttemptAt, i.changedAt);
  if (slot === null || slot <= since) return { due: false, reason: 'not_yet' };
  return { due: true, reason: 'due' };
}

/** The time to wait after `failures` failures in a row: 15 minutes, doubled each time, at most 6 hours (the ASO refresh uses the same). */
export const reviewReadBackoffMs = (failures: number): number =>
  Math.min(competitorReviewLimits.backoffMinMs * 2 ** Math.max(0, failures - 1), competitorReviewLimits.backoffMaxMs);

/** When the next scheduled read happens: after a backoff if there is one, never in the past, null when off or paused. */
export function nextReviewRunAt(i: Omit<ReviewDueInput, 'lastAttemptAt' | 'changedAt'> & { lastAttemptAt: number | null; changedAt: number }): number | null {
  if (i.schedule.mode === 'off' || i.paused) return null;
  const since = Math.max(i.lastAttemptAt === null ? 0 : i.lastAttemptAt, i.changedAt);
  const latest = latestReviewSlot(i.schedule, i.key, i.now);
  // A slot that already passed and was not served is due now (or when the backoff ends).
  const pending = latest !== null && latest > since ? Math.max(i.now, i.backoffUntil === null ? 0 : i.backoffUntil) : null;
  if (pending !== null) return pending;
  const next = nextReviewSlot(i.schedule, i.key, i.now);
  if (next === null) return null;
  return Math.max(next, i.backoffUntil === null ? 0 : i.backoffUntil);
}
