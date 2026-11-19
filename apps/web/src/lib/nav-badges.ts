import type { OverviewRow } from './app-overview.ts';

/**
 * The counts that sit beside the sidebar entries, taken from what the screens already loaded: the
 * overview rows (apps that need attention) and the reviews summary (unanswered reviews). Nothing here
 * reads the network. A count that is not known is null and draws no badge; a field the server does not
 * send yet reads as not known.
 */

/** How many apps need attention: a failed sync, a release the store rejected or halted, or a release left unfinished. */
export function attentionCount(
  rows: readonly (Pick<OverviewRow, 'syncFailed' | 'attention'> & {
    unfinished?: readonly unknown[];
  })[],
): number {
  return rows.filter(
    (r) =>
      r.syncFailed ||
      (r.attention !== null &&
        (r.attention.status === 'rejected' || r.attention.status === 'halted')) ||
      (r.unfinished ?? []).length > 0,
  ).length;
}

/**
 * The badges of the sidebar of ONE open app, from what the screens already loaded: the unanswered reviews of its records (null
 * when none is known) and how many of its records have a release left unfinished (a stale stall, older than the server's limit
 * for a reminder, does not count). Nothing here reads the network.
 */
export function appNavCounts(input: {
  memberIds: readonly string[];
  unanswered: Readonly<Record<string, number | undefined>>;
  stalled: readonly { app: { id: string }; stalled: { stale: boolean } | null }[];
}): { reviews: number | null; releases: number | null } {
  const known = input.memberIds.filter((id) => typeof input.unanswered[id] === 'number');
  const reviews =
    known.length === 0 ? null : known.reduce((n, id) => n + (input.unanswered[id] as number), 0);
  const releases = input.stalled.filter(
    (s) => input.memberIds.indexOf(s.app.id) >= 0 && s.stalled !== null && !s.stalled.stale,
  ).length;
  return { reviews, releases: releases === 0 ? null : releases };
}

/**
 * The unanswered reviews of a summary, or null when the summary has no such field (or it is not a
 * number). Accepts the whole summary or only its `totals`.
 */
export function unansweredCount(summary: unknown): number | null {
  if (typeof summary !== 'object' || summary === null) return null;
  const record = summary as Record<string, unknown>;
  const totals =
    typeof record.totals === 'object' && record.totals !== null
      ? (record.totals as Record<string, unknown>)
      : record;
  const value = totals.unanswered;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/** The text of a badge: nothing for zero or unknown, "99+" above 99. */
export function badgeText(count: number | null | undefined): string | null {
  if (count === null || count === undefined || !Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
}

/** What a screen reader hears for a badge, for example "3 unanswered reviews". Null when no badge is drawn. */
export function badgeLabel(
  count: number | null | undefined,
  one: string,
  many: string,
): string | null {
  const text = badgeText(count);
  if (text === null) return null;
  return `${text} ${count === 1 ? one : many}`;
}
