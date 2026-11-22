import { formatDate, formatRelativeTime } from '../i18n/format.ts';
import { t } from '../i18n/t.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** "just now", "5 minutes ago", "yesterday", or a date once it is over a week old, in the language of the page. */
export function agoText(then: number, now: number = Date.now()): string {
  const diff = now - then;
  if (diff < MINUTE) return t('aso:time.justNow');
  if (diff < 7 * DAY) return formatRelativeTime(then, { now });
  return formatDate(then);
}
