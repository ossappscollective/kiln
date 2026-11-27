import { type Platform, platformLabel, type ReleaseState } from '@kiln/core';
import type { AppGroup } from './app-groups.ts';
import { appAddress } from './app-scope.ts';
import { t } from './i18n/t.ts';
import { chipFor, type PendingLine } from './pending.ts';
import { latestRelease, type ReleaseLoad, urgencyOf } from './portfolio.ts';
import {
  type PipelineSummaryApp,
  type SummaryStall,
  unfinishedHeading,
  unfinishedItem,
} from './release-pipeline.ts';
import type { SummaryApp } from './reviews/reviews.ts';
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
  /** Per platform, the release that is in review, rolling out, halted or rejected, most urgent first (one platform's can differ from its newest release). */
  inFlight: ReleaseSummary[];
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
  pending?: OverviewPending | null;
};

const rank = (r: ReleaseSummary) => urgencyOf(r.status);

/** The states worth a pill of their own on a row (a released version is the quiet default). */
const FLIGHT_STATES: ReleaseState[] = [
  'rejected',
  'halted',
  'in_review',
  'propagating',
  'rolling_out',
];

/** For each platform of the app, its most urgent release among FLIGHT_STATES (the newest release may be another track's). */
function inFlightOf(
  group: AppGroup,
  releases: Record<string, ReleaseLoad | undefined>,
): ReleaseSummary[] {
  const out: ReleaseSummary[] = [];
  for (const app of group.members) {
    const load = releases[app.id];
    if (load?.state !== 'ready') continue;
    const best = load.releases
      .filter(
        (r) => r.platform === app.platform && r.status !== null && FLIGHT_STATES.includes(r.status),
      )
      .sort((a, b) => rank(a) - rank(b))[0];
    if (best) out.push(best);
  }
  return out.sort((a, b) => rank(a) - rank(b));
}

const cell = (
  app: AppSummary | null,
  releases: Record<string, ReleaseLoad | undefined>,
): PlatformCell | null => {
  if (!app) return null;
  const load = releases[app.id];
  if (!load || load.state === 'loading') return { state: 'loading' };
  if (load.state === 'error') return { state: 'error' };
  return { state: 'ready', latest: latestRelease(load.releases, app.platform) };
};

/** The pending line of an app as the overview shows it: the count (from the app-state store's `lineOf`) and whether its last publish failed. */
export type OverviewPending = PendingLine & { failed?: boolean };

export function buildOverviewRows(
  groups: readonly AppGroup[],
  releases: Record<string, ReleaseLoad | undefined>,
  reviewApps: readonly SummaryApp[] | null,
  pipelineApps: readonly PipelineSummaryApp[] | null = null,
  pendingOf: (appIds: string[]) => OverviewPending | null = () => null,
): OverviewRow[] {
  return groups.map((group) => {
    const ios = cell(group.ios, releases);
    const macos = cell(group.macos, releases);
    const android = cell(group.android, releases);
    const latests: ReleaseSummary[] = [];
    for (const c of [ios, macos, android])
      if (c && c.state === 'ready' && c.latest) latests.push(c.latest);
    const inFlight = inFlightOf(group, releases);
    const attention = [...latests, ...inFlight].sort((a, b) => rank(a) - rank(b))[0] ?? null;
    const synced = group.members.map((m) => m.lastSyncedAt);
    const mine = reviewApps
      ? reviewApps.filter((r) => group.members.some((m) => m.id === r.app.id))
      : null;
    const rated = (mine ?? []).filter((r) => r.average !== null && r.total > 0);
    const ratingCount = rated.reduce((sum, r) => sum + r.total, 0);
    return {
      group,
      ios,
      macos,
      android,
      attention,
      inFlight,
      syncFailed: group.members.some((m) => (m.lastSyncError ?? '').trim() !== ''),
      syncedAt: synced.some((s) => s === null) ? null : Math.min(...(synced as number[])),
      rating:
        ratingCount > 0
          ? rated.reduce((sum, r) => sum + (r.average as number) * r.total, 0) / ratingCount
          : null,
      ratingCount,
      newReviews: mine ? mine.reduce((sum, r) => sum + r.new, 0) : null,
      unfinished: (pipelineApps ?? []).filter(
        (p) =>
          p.stalled !== null && !p.stalled.stale && group.members.some((m) => m.id === p.app.id),
      ),
      pending: pendingOf(group.members.map((m) => m.id)),
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
  // An app counts once for a state when any of its platforms is in it.
  const count = (states: ReleaseState[]) =>
    rows.filter((r) =>
      [r.attention, ...r.inFlight].some(
        (x) => x !== null && x.status !== null && states.includes(x.status),
      ),
    ).length;
  const known = rows.filter((r) => r.newReviews !== null);
  return {
    apps: rows.length,
    inReview: count(['in_review']),
    rollingOut: count(['rolling_out', 'propagating']),
    problems: rows.filter(
      (r) =>
        r.syncFailed ||
        (r.attention !== null &&
          (r.attention.status === 'rejected' || r.attention.status === 'halted')),
    ).length,
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
  /** The other platforms' releases that are in review, rolling out, halted or rejected: one pill each beside the first. */
  more: ReleaseSummary[];
  /**
   * Releases left unfinished, collapsed to ONE badge: its text names the count, the `title` lists each platform with the server's
   * sentence. Null when there are none.
   */
  unfinished: {
    count: number;
    text: string;
    /** The button of the row: the step's own words ("Create a version"), "Finish the release(s)" for releases. */
    action: string;
    title: string;
    href: string | null;
  } | null;
  /** What is pending for the app (the "N pending" badge), and whether its last publish failed. */
  pending: OverviewPending | null;
};

/**
 * What the status column of a row says: never two pills for the same thing (the old column could show a release status, "Sync
 * failed" and one "Release left unfinished" pill per platform side by side). A failed sync is also said by the Last synced column,
 * so it is the pill only when there is no release status to show.
 */
export function rowStatus(row: OverviewRow, loading: boolean): RowStatus {
  const headingOne = (stalled: SummaryStall | null, platform: string | null): string => {
    const heading = stalled ? unfinishedHeading(stalled.step) : unfinishedHeading('draft');
    return platform === null
      ? heading
      : t('app:overview.unfinishedOnPlatform', { heading, platform });
  };
  let primary: RowStatus['primary'];
  if (row.attention) primary = { kind: 'release', release: row.attention };
  else if (row.syncFailed) primary = { kind: 'sync-failed' };
  else if (loading) primary = { kind: 'loading' };
  else
    primary = {
      kind: 'none',
      text: row.group.members.every((m) => m.lastSyncedAt === null)
        ? t('app:overview.notSynced')
        : t('app:overview.noReleases'),
    };

  const several = row.group.members.length > 1;
  const items = row.unfinished
    .map((left) => ({
      left,
      item: unfinishedItem({
        appId: left.app.id,
        platform: left.app.platform,
        scope: left.app.platform,
        several: false,
        stalled: left.stalled,
      }),
    }))
    .filter((x) => x.item !== null);
  let unfinished: RowStatus['unfinished'] = null;
  const first = items[0];
  // A stall of a release (not of a build or a CI run) reads with the default heading, whatever the language.
  const releaseHeading = unfinishedHeading('draft');
  const allReleases = items.every(
    (x) => x.left.stalled === null || unfinishedHeading(x.left.stalled.step) === releaseHeading,
  );
  if (first) {
    const who = (platform: Parameters<typeof platformLabel>[0]) => platformLabel(platform);
    unfinished =
      items.length === 1
        ? {
            count: 1,
            text: headingOne(first.left.stalled, several ? who(first.left.app.platform) : null),
            action: first.item?.action ?? t('app:overview.finishRelease'),
            title: first.item?.detail ?? '',
            href: first.item?.href ?? null,
          }
        : {
            count: items.length,
            text: allReleases
              ? t('app:overview.releasesLeft', { count: items.length })
              : t('app:overview.thingsLeft', { count: items.length }),
            action: allReleases
              ? t('app:overview.finishReleases')
              : t('app:overview.seeWhatIsLeft'),
            title: items
              .map((x) =>
                t('app:overview.platformDetail', {
                  platform: who(x.left.app.platform),
                  detail: x.item?.detail ?? '',
                }),
              )
              .join('\n'),
            href: first.item?.href ?? null,
          };
  }
  const lead = primary.kind === 'release' ? primary.release : null;
  const more = row.inFlight.filter((r) => r.id !== lead?.id && r.platform !== lead?.platform);
  return { primary, more, unfinished, pending: row.pending ?? null };
}

// ---------------------------------------------------------------------------------------------
// The ONE next action of a row

export type RowNextAction = {
  label: string;
  href: string;
  tone: 'bad' | 'warn' | 'accent';
  /** The longer sentence for the link's title, when there is one. */
  title?: string;
};

/**
 * The one thing to do for the app, most urgent first: a rejection, a halted rollout, a failed sync, a release left unfinished,
 * an approved release, pending changes, new reviews. Null when nothing waits for the person (the status says the rest), so a row
 * never offers two actions and never repeats the status in a second badge.
 */
export function rowNextAction(row: OverviewRow, status: RowStatus): RowNextAction | null {
  const key = row.group.key;
  const release = status.primary.kind === 'release' ? status.primary.release : null;
  if (release?.status === 'rejected')
    return {
      label: t('app:overview.fixRejection'),
      href: appAddress(key, 'releases', release.platform, release.version),
      tone: 'bad',
    };
  if (release?.status === 'halted')
    return {
      label: t('app:overview.reviewHalted'),
      href: appAddress(key, 'releases', release.platform, release.version),
      tone: 'bad',
    };
  if (status.primary.kind === 'sync-failed')
    return { label: t('app:overview.checkSyncError'), href: appAddress(key), tone: 'bad' };
  // A publish that failed comes before what the release could do next: the model holds those back until it is resolved.
  if (status.pending?.failed === true)
    return {
      label: t('publish:publishing.showPending'),
      href: appAddress(key, 'pending'),
      tone: 'warn',
      title: t('state:topBar.failedTitle'),
    };
  if (status.unfinished)
    return {
      label: status.unfinished.action,
      href: status.unfinished.href ?? appAddress(key, 'releases'),
      tone: 'warn',
      title: status.unfinished.title,
    };
  if (release?.status === 'approved')
    return {
      label: t('app:overview.releaseIt'),
      href: appAddress(key, 'releases', release.platform, release.version),
      tone: 'accent',
    };
  const chip = chipFor(status.pending);
  if (chip)
    return {
      label: t('app:overview.reviewPending', { pending: chip.text }),
      href: appAddress(key, 'pending'),
      tone: chip.tone === 'warn' ? 'warn' : 'accent',
    };
  if (row.newReviews !== null && row.newReviews > 0)
    return {
      label: t('app:overview.readNew', { count: row.newReviews }),
      href: appAddress(key, 'reviews'),
      tone: 'accent',
    };
  return null;
}

// ---------------------------------------------------------------------------------------------
// The status column: one chip per platform of the app

/** The state of one platform of an app, for its chip in the status column. */
export type PlatformStatus = {
  platform: Platform;
  /** `release`: the platform's most urgent release (a state in flight, else its newest); `none`: loaded, nothing reported. */
  kind: 'release' | 'loading' | 'error' | 'none';
  release: ReleaseSummary | null;
};

/**
 * Every platform the app has (iOS, macOS, Android, always in that order), each with the state of its most urgent release: one that is
 * in review, rolling out, halted or rejected before the newest one. The app-level "Next" column does not depend on this.
 */
export function platformStatuses(row: OverviewRow): PlatformStatus[] {
  const out: PlatformStatus[] = [];
  const cells: [Platform, PlatformCell | null][] = [
    ['ios', row.ios],
    ['macos', row.macos],
    ['android', row.android],
  ];
  for (const [platform, c] of cells) {
    if (c === null) continue;
    if (c.state !== 'ready') {
      out.push({ platform, kind: c.state, release: null });
      continue;
    }
    const best = [c.latest, ...row.inFlight.filter((r) => r.platform === platform)]
      .filter((r): r is ReleaseSummary => r !== null)
      .sort((a, b) => rank(a) - rank(b))[0];
    out.push(
      best
        ? { platform, kind: 'release', release: best }
        : { platform, kind: 'none', release: null },
    );
  }
  return out;
}
