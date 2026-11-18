import type { ReleaseState } from '@mrm/core';
import type { AppGroup } from './app-groups.ts';
import { type ReleaseLoad, latestRelease } from './portfolio.ts';
import type { SummaryApp } from './reviews.ts';
import type { AppSummary, ReleaseSummary } from './types.ts';

/** The rows and the stats strip of the all-apps overview, from data the screen already loads. */

export type PlatformCell =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; latest: ReleaseSummary | null };

export type OverviewRow = {
  group: AppGroup;
  ios: PlatformCell | null;
  android: PlatformCell | null;
  /** The release whose state needs the most attention across the platforms, or null. */
  attention: ReleaseSummary | null;
  /** A sync of one of the records failed last time. */
  syncFailed: boolean;
  /** The oldest successful sync of the records; null when one never synced. */
  syncedAt: number | null;
  /** Average of the stored reviews over the platforms, weighted by count; null when there are none or they are not loaded. */
  rating: number | null;
  ratingCount: number;
  /** Reviews with the status New; null when the counts are not loaded. */
  newReviews: number | null;
};

/** Most urgent first. */
const urgency: ReleaseState[] = ['rejected', 'halted', 'in_review', 'propagating', 'rolling_out', 'approved', 'ready', 'build_chosen', 'draft', 'live'];
const rank = (r: ReleaseSummary) => {
  const i = r.status === null ? -1 : urgency.indexOf(r.status);
  return i < 0 ? urgency.length : i;
};

const cell = (app: AppSummary | null, releases: Record<string, ReleaseLoad | undefined>): PlatformCell | null => {
  if (!app) return null;
  const load = releases[app.id];
  if (!load || load.state === 'loading') return { state: 'loading' };
  if (load.state === 'error') return { state: 'error' };
  return { state: 'ready', latest: latestRelease(load.releases, app.platform) };
};

export function buildOverviewRows(
  groups: readonly AppGroup[],
  releases: Record<string, ReleaseLoad | undefined>,
  reviewApps: readonly SummaryApp[] | null,
): OverviewRow[] {
  return groups.map((group) => {
    const ios = cell(group.ios, releases);
    const android = cell(group.android, releases);
    const latests: ReleaseSummary[] = [];
    for (const c of [ios, android]) if (c && c.state === 'ready' && c.latest) latests.push(c.latest);
    const attention = [...latests].sort((a, b) => rank(a) - rank(b))[0] ?? null;
    const synced = group.members.map((m) => m.lastSyncedAt);
    const mine = reviewApps ? reviewApps.filter((r) => group.members.some((m) => m.id === r.app.id)) : null;
    const rated = (mine ?? []).filter((r) => r.average !== null && r.total > 0);
    const ratingCount = rated.reduce((sum, r) => sum + r.total, 0);
    return {
      group,
      ios,
      android,
      attention,
      syncFailed: group.members.some((m) => (m.lastSyncError ?? '').trim() !== ''),
      syncedAt: synced.some((s) => s === null) ? null : Math.min(...(synced as number[])),
      rating: ratingCount > 0 ? rated.reduce((sum, r) => sum + (r.average as number) * r.total, 0) / ratingCount : null,
      ratingCount,
      newReviews: mine ? mine.reduce((sum, r) => sum + r.new, 0) : null,
    };
  });
}

export type OverviewStats = {
  apps: number;
  inReview: number;
  rollingOut: number;
  problems: number;
  /** Null when the review counts are not available. */
  newReviews: number | null;
};

export function overviewStats(rows: readonly OverviewRow[]): OverviewStats {
  const count = (states: ReleaseState[]) =>
    rows.filter((r) => r.attention !== null && r.attention.status !== null && states.includes(r.attention.status)).length;
  const known = rows.filter((r) => r.newReviews !== null);
  return {
    apps: rows.length,
    inReview: count(['in_review']),
    rollingOut: count(['rolling_out', 'propagating']),
    problems: rows.filter((r) => r.syncFailed || (r.attention !== null && (r.attention.status === 'rejected' || r.attention.status === 'halted'))).length,
    newReviews: known.length === 0 ? null : known.reduce((sum, r) => sum + (r.newReviews ?? 0), 0),
  };
}
