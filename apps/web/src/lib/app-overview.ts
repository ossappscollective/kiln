import { type ReleaseState, platformLabel } from '@mrm/core';
import type { AppGroup } from './app-groups.ts';
import { type PendingLine, type PendingSummary, lineFor } from './pending.ts';
import { type ReleaseLoad, latestRelease } from './portfolio.ts';
import { type PipelineSummaryApp, unfinishedItem } from './release-pipeline.ts';
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
  macos: PlatformCell | null;
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
  /** Records whose release is left unfinished (not stale), from the pipeline summary; empty when it is not loaded. */
  unfinished: PipelineSummaryApp[];
  /** What is pending for the app (all its records), from the pending summary; null when it is not known or nothing is pending. */
  pending?: PendingLine | null;
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
  pipelineApps: readonly PipelineSummaryApp[] | null = null,
  pendingSummary: PendingSummary | null = null,
): OverviewRow[] {
  return groups.map((group) => {
    const ios = cell(group.ios, releases);
    const macos = cell(group.macos, releases);
    const android = cell(group.android, releases);
    const latests: ReleaseSummary[] = [];
    for (const c of [ios, macos, android]) if (c && c.state === 'ready' && c.latest) latests.push(c.latest);
    const attention = [...latests].sort((a, b) => rank(a) - rank(b))[0] ?? null;
    const synced = group.members.map((m) => m.lastSyncedAt);
    const mine = reviewApps ? reviewApps.filter((r) => group.members.some((m) => m.id === r.app.id)) : null;
    const rated = (mine ?? []).filter((r) => r.average !== null && r.total > 0);
    const ratingCount = rated.reduce((sum, r) => sum + r.total, 0);
    return {
      group,
      ios,
      macos,
      android,
      attention,
      syncFailed: group.members.some((m) => (m.lastSyncError ?? '').trim() !== ''),
      syncedAt: synced.some((s) => s === null) ? null : Math.min(...(synced as number[])),
      rating: ratingCount > 0 ? rated.reduce((sum, r) => sum + (r.average as number) * r.total, 0) / ratingCount : null,
      ratingCount,
      newReviews: mine ? mine.reduce((sum, r) => sum + r.new, 0) : null,
      unfinished: (pipelineApps ?? []).filter((p) => p.stalled !== null && !p.stalled.stale && group.members.some((m) => m.id === p.app.id)),
      pending: lineFor(pendingSummary, group.members.map((m) => m.id)),
    };
  });
}

export type OverviewStats = {
  apps: number;
  inReview: number;
  rollingOut: number;
  problems: number;
  /** Apps with a release left unfinished. */
  unfinished: number;
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
    unfinished: rows.filter((r) => r.unfinished.length > 0).length,
    newReviews: known.length === 0 ? null : known.reduce((sum, r) => sum + (r.newReviews ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------------------------
// The status cell of a row: one pill, a pending badge, one count for unfinished releases

export type RowStatus = {
  /** The ONE status pill: the release that needs the most attention, else a failed sync, else a quiet sentence. */
  primary:
    | { kind: 'release'; release: ReleaseSummary }
    | { kind: 'sync-failed' }
    | { kind: 'loading' }
    | { kind: 'none'; text: string };
  /**
   * Releases left unfinished, collapsed to ONE badge: its text names the count, the `title` lists each platform with the server's
   * sentence. Null when there are none.
   */
  unfinished: { count: number; text: string; title: string; href: string | null } | null;
  /** What is pending for the app (the "N pending" badge). */
  pending: PendingLine | null;
};

/**
 * What the status column of a row says: never two pills for the same thing (the old column could show a release status, "Sync
 * failed" and one "Release left unfinished" pill per platform side by side). A failed sync is also said by the Last synced column,
 * so it is the pill only when there is no release status to show.
 */
export function rowStatus(row: OverviewRow, loading: boolean): RowStatus {
  let primary: RowStatus['primary'];
  if (row.attention) primary = { kind: 'release', release: row.attention };
  else if (row.syncFailed) primary = { kind: 'sync-failed' };
  else if (loading) primary = { kind: 'loading' };
  else primary = { kind: 'none', text: row.group.members.every((m) => m.lastSyncedAt === null) ? 'Not synced yet' : 'No releases' };

  const several = row.group.members.length > 1;
  const items = row.unfinished
    .map((left) => ({
      left,
      item: unfinishedItem({ appId: left.app.id, platform: left.app.platform, scope: left.app.platform, several: false, stalled: left.stalled }),
    }))
    .filter((x) => x.item !== null);
  let unfinished: RowStatus['unfinished'] = null;
  const first = items[0];
  if (first) {
    const who = (platform: Parameters<typeof platformLabel>[0]) => platformLabel(platform);
    unfinished =
      items.length === 1
        ? {
            count: 1,
            text: `Release left unfinished${several ? `: ${who(first.left.app.platform)}` : ''}`,
            title: first.item?.detail ?? '',
            href: first.item?.href ?? null,
          }
        : {
            count: items.length,
            text: `${items.length} releases left unfinished`,
            title: items.map((x) => `${who(x.left.app.platform)}: ${x.item?.detail ?? ''}`).join('\n'),
            href: first.item?.href ?? null,
          };
  }
  return { primary, unfinished, pending: row.pending ?? null };
}
