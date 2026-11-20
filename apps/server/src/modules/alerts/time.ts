/**
 * Time rules of alerts, pure: quiet hours in a person's timezone and when a digest is due. No clock of its own (callers pass `at`),
 * no database. The timezone is an IANA name ("Europe/Paris"); the standard library knows the daylight saving rules.
 */

export const MINUTES_PER_DAY = 1440;

export const isValidTimeZone = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

type Local = { minutes: number; hour: number; day: string; weekday: number };

/** The wall clock of `tz` at `at`: minutes after midnight, the hour, the date (YYYY-MM-DD) and the weekday (0 = Sunday). */
export function localTime(tz: string, at: number): Local {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
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
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    minutes: hour * 60 + minute,
    hour,
    day: `${get('year')}-${get('month')}-${get('day')}`,
    weekday,
  };
}

export type QuietHours = { start: number | null; end: number | null; timezone: string | null };

/** Whether `at` falls inside the quiet window (it may wrap past midnight). No window, or start equal to end, means never quiet. */
export function inQuietHours(q: QuietHours, at: number): boolean {
  if (q.start === null || q.end === null || q.start === q.end) return false;
  const m = localTime(q.timezone ?? 'UTC', at).minutes;
  return q.start < q.end ? m >= q.start && m < q.end : m >= q.start || m < q.end;
}

/** The first moment at or after `at` when the quiet window is over (`at` itself when it is not quiet). */
export function quietEndsAt(q: QuietHours, at: number): number {
  if (!inQuietHours(q, at) || q.end === null) return at;
  const m = localTime(q.timezone ?? 'UTC', at).minutes;
  const wait = (q.end - m + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  // Whole minutes ahead, from the start of the current minute; a day with a clock change can be an hour off, which is harmless.
  return at - (at % 60_000) + wait * 60_000;
}

export type DigestMode = 'off' | 'daily' | 'weekly';
export const digestModes: readonly DigestMode[] = ['off', 'daily', 'weekly'];

/**
 * Whether a digest is due: the person's local time is at or after `hour`, and no digest was sent for this local day (daily) or in
 * the last six days (weekly, sent on Mondays). `lastAt` null means never sent: due at the next digest hour.
 */
export function digestDue(
  input: { mode: DigestMode; hour: number; timezone: string | null; lastAt: number | null },
  at: number,
): boolean {
  if (input.mode === 'off') return false;
  const tz = input.timezone ?? 'UTC';
  const now = localTime(tz, at);
  if (now.hour < input.hour) return false;
  if (input.mode === 'weekly' && now.weekday !== 1) return false;
  if (input.lastAt === null) return true;
  const last = localTime(tz, input.lastAt);
  if (input.mode === 'daily') return last.day !== now.day;
  return at - input.lastAt >= 6 * 24 * 3_600_000;
}
