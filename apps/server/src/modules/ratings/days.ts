/** Day arithmetic on YYYY-MM-DD strings, in UTC. No clock, no time zone: pure. */
const MS = 86_400_000;
export const toMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => fromMs(toMs(day) + n * MS);
export const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(toMs(v));
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 4000; d = addDays(d, 1)) out.push(d);
  return out;
}
/** Monday of the week. */
export const weekStart = (day: string): string => addDays(day, -((new Date(toMs(day)).getUTCDay() + 6) % 7));
export const monthStart = (day: string): string => `${day.slice(0, 7)}-01`;
export type Granularity = 'day' | 'week' | 'month';
export const bucketOf = (day: string, g: Granularity): string => (g === 'week' ? weekStart(day) : g === 'month' ? monthStart(day) : day);
/** The buckets covering from..to, in order; the first starts where its period starts, the last ends at `to`. */
export function bucketsIn(from: string, to: string, g: Granularity): { start: string; end: string }[] {
  const starts: string[] = [];
  for (const d of dayRange(from, to)) {
    const s = bucketOf(d, g);
    if (starts[starts.length - 1] !== s) starts.push(s);
  }
  return starts.map((start, i) => ({ start, end: i + 1 < starts.length ? addDays(starts[i + 1]!, -1) : to }));
}
