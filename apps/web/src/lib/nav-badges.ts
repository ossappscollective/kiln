import type { OverviewRow } from './app-overview.ts';

/**
 * The counts that sit beside the sidebar entries, taken from what the screens already loaded: the
 * overview rows (apps that need attention) and the reviews summary (unanswered reviews). Nothing here
 * reads the network. A count that is not known is null and draws no badge; a field the server does not
 * send yet reads as not known.
 */

/** How many apps need attention: a failed sync, or a release the store rejected or halted. */
export function attentionCount(rows: readonly Pick<OverviewRow, 'syncFailed' | 'attention'>[]): number {
  return rows.filter((r) => r.syncFailed || (r.attention !== null && (r.attention.status === 'rejected' || r.attention.status === 'halted'))).length;
}

/**
 * The unanswered reviews of a summary, or null when the summary has no such field (or it is not a
 * number). Accepts the whole summary or only its `totals`.
 */
export function unansweredCount(summary: unknown): number | null {
  if (typeof summary !== 'object' || summary === null) return null;
  const record = summary as Record<string, unknown>;
  const totals = typeof record.totals === 'object' && record.totals !== null ? (record.totals as Record<string, unknown>) : record;
  const value = totals.unanswered;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** The text of a badge: nothing for zero or unknown, "99+" above 99. */
export function badgeText(count: number | null | undefined): string | null {
  if (count === null || count === undefined || !Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
}

/** What a screen reader hears for a badge, for example "3 unanswered reviews". Null when no badge is drawn. */
export function badgeLabel(count: number | null | undefined, one: string, many: string): string | null {
  const text = badgeText(count);
  if (text === null) return null;
  return `${text} ${count === 1 ? one : many}`;
}
