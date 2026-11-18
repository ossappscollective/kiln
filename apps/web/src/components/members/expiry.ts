const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Expires in 6 days", "Expires in 5 hours", "Expires in 20 minutes" or "Expired". */
export function expiresIn(expiresAt: number, now: number = Date.now()): string {
  const left = expiresAt - now;
  if (left <= 0) return 'Expired';
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (left < HOUR) return `Expires in ${plural(Math.max(1, Math.ceil(left / MINUTE)), 'minute')}`;
  if (left < DAY) return `Expires in ${plural(Math.floor(left / HOUR), 'hour')}`;
  return `Expires in ${plural(Math.floor(left / DAY), 'day')}`;
}
