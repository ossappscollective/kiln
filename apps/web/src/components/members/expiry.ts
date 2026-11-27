import { t } from '../../lib/i18n/t.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Expires in 6 days", "Expires in 5 hours", "Expires in 20 minutes" or "Expired". */
export function expiresIn(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return t('workspace:members.expires.expired');
  if (left < HOUR)
    return t('workspace:members.expires.minutes', { count: Math.max(1, Math.ceil(left / MINUTE)) });
  if (left < DAY) return t('workspace:members.expires.hours', { count: Math.floor(left / HOUR) });
  return t('workspace:members.expires.days', { count: Math.floor(left / DAY) });
}
