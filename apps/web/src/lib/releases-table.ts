import type { Platform, ReleaseState } from '@kiln/core';
import { isDesktop, platformMeta, supports } from '@kiln/core';
import { runBadge } from './ci/ci.ts';
import { formatDate } from './i18n/format.ts';
import { t } from './i18n/t.ts';
import {
  type BadgeTone,
  compareReleases,
  compareVersions,
  formatRollout,
  platformRank,
  trackLabel,
} from './portfolio.ts';
import type { AppBuild, PlanSummary, ReleaseSummary } from './types.ts';

/**
 * The compact releases table of an app as pure functions: the releases the store reports for the
 * platforms in scope, grouped by version, each row with its build, rollout share, CI state and the
 * state of the plan we keep for it. Nothing here reads or changes a store.
 */

// ---------------------------------------------------------------------------------------------
// CI state of a row

export type CiCell = {
  state: 'run' | 'tag' | 'unlinked' | 'unknown';
  label: string;
  tone: BadgeTone;
  dot: boolean;
  /** One sentence for the tooltip. */
  title: string;
};

/**
 * The builds that belong to a release: iOS carries one build number; a Play release carries
 * version codes (one per APK/AAB), with `build` as the newest of them.
 */
export function buildsForRelease(
  release: Pick<ReleaseSummary, 'platform' | 'build' | 'versionCodes'>,
  builds: readonly AppBuild[],
): AppBuild[] {
  const numbers = new Set<string>();
  if (release.build !== null) numbers.add(release.build);
  for (const code of release.versionCodes ?? []) numbers.add(code);
  if (numbers.size === 0) return [];
  return builds
    .filter((b) => b.platform === release.platform && numbers.has(b.buildNumber))
    .sort(
      (a, b) =>
        (b.uploadedAt ?? b.syncedAt) - (a.uploadedAt ?? a.syncedAt) ||
        compareVersions(b.buildNumber, a.buildNumber),
    );
}

const rank = (b: AppBuild): number => (b.link?.run ? 2 : b.linkState === 'tag' ? 1 : 0);

/** The CI state of a release: the run of its best linked build, else a tag, else nothing found. `unknown`: builds were not loaded. */
export function ciFor(
  release: Pick<ReleaseSummary, 'platform' | 'build' | 'versionCodes'>,
  builds: readonly AppBuild[] | null,
): CiCell {
  if (builds === null) {
    return {
      state: 'unknown',
      label: '—',
      tone: 'neutral',
      dot: false,
      title: t('release:table.ci.unavailable'),
    };
  }
  const matches = buildsForRelease(release, builds);
  if (matches.length === 0) {
    return {
      state: 'unlinked',
      label: t('release:table.ci.noBuild'),
      tone: 'neutral',
      dot: false,
      title: t('release:table.ci.noBuildTitle'),
    };
  }
  const best = [...matches].sort((a, b) => rank(b) - rank(a))[0] as AppBuild;
  const run = best.link?.run ?? null;
  if (run) {
    const badge = runBadge(run);
    return {
      state: 'run',
      label: badge.label,
      tone: badge.tone,
      dot: badge.dot,
      title: t('release:table.ci.run', { number: best.buildNumber, label: badge.label }),
    };
  }
  if (best.linkState === 'tag') {
    return {
      state: 'tag',
      label: t('release:table.ci.tag'),
      tone: 'info',
      dot: false,
      title: t('release:table.ci.tagTitle'),
    };
  }
  return {
    state: 'unlinked',
    label: t('release:table.ci.notLinked'),
    tone: 'neutral',
    dot: false,
    title: t('release:table.ci.notLinkedTitle'),
  };
}

// ---------------------------------------------------------------------------------------------
// Plan state of a row

export type PlanCell =
  | { kind: 'none'; label: string; tone: BadgeTone; title: string }
  | {
      kind: 'plan';
      plan: PlanSummary;
      label: string;
      tone: BadgeTone;
      title: string;
      viaApp: boolean;
    };

const checklistText = (plan: Pick<PlanSummary, 'checklist'>): string =>
  plan.checklist.total === 0
    ? t('release:table.plan.noChecklist')
    : t('release:table.plan.progress', {
        done: plan.checklist.done,
        count: plan.checklist.total,
      });

/**
 * The plan that covers a release. A plan belongs to one app record and names a platform, or none
 * when it covers both; a plan for both on the other platform's record covers this one too.
 */
export function planFor(
  release: Pick<ReleaseSummary, 'appId' | 'platform' | 'version'>,
  plansByApp: Readonly<Record<string, readonly PlanSummary[] | undefined>>,
): { plan: PlanSummary; viaApp: boolean } | null {
  const own = (plansByApp[release.appId] ?? []).find(
    (p) =>
      p.version === release.version && (p.platform === null || p.platform === release.platform),
  );
  if (own) return { plan: own, viaApp: false };
  for (const appId of Object.keys(plansByApp)) {
    if (appId === release.appId) continue;
    const other = (plansByApp[appId] ?? []).find(
      (p) => p.version === release.version && p.platform === null,
    );
    if (other) return { plan: other, viaApp: true };
  }
  return null;
}

/** The words for a plan: blocked, released, overdue, due soon, ready, or how far the checklist is. */
export function planCell(
  found: { plan: PlanSummary; viaApp: boolean } | null,
  plansLoaded = true,
): PlanCell {
  if (found === null) {
    return plansLoaded
      ? {
          kind: 'none',
          label: t('release:table.plan.none'),
          tone: 'neutral',
          title: t('release:table.plan.noneTitle'),
        }
      : {
          kind: 'none',
          label: '—',
          tone: 'neutral',
          title: t('release:table.plan.unavailable'),
        };
  }
  const { plan, viaApp } = found;
  const base = (label: string, tone: BadgeTone, extra: string): PlanCell => ({
    kind: 'plan',
    plan,
    label,
    tone,
    viaApp,
    // Two whole sentences, joined with a space.
    title: viaApp ? `${extra} ${t('release:table.plan.viaApp')}` : extra,
  });
  if (plan.blocked)
    return base(
      t('release:table.plan.blocked'),
      'bad',
      plan.blockedReason
        ? t('release:table.plan.blockedReason', { reason: plan.blockedReason })
        : t('release:table.plan.blockedTitle'),
    );
  if (plan.released)
    return base(
      t('release:table.plan.released'),
      'ok',
      t('release:table.plan.releasedTitle'),
    );
  if (plan.due.overdue)
    return base(
      t('release:table.plan.overdue'),
      'bad',
      plan.targetDate
        ? t('release:table.plan.overdueDate', { date: formatDate(plan.targetDate) })
        : t('release:table.plan.overdueNoDate'),
    );
  if (plan.due.dueSoon)
    return base(
      t('release:table.plan.dueSoon'),
      'warn',
      plan.targetDate
        ? t('release:table.plan.dueSoonDate', { date: formatDate(plan.targetDate) })
        : t('release:table.plan.dueSoonNoDate'),
    );
  if (plan.readiness.ready)
    return base(t('release:table.plan.ready'), 'ok', t('release:table.plan.readyTitle'));
  return base(t('release:table.plan.inProgress'), 'info', checklistText(plan));
}

// ---------------------------------------------------------------------------------------------
// Rows and groups

export type ReleaseRow = {
  /** Unique per release record; the key of the expanded state. */
  key: string;
  version: string;
  platform: Platform;
  appId: string;
  track: string | null;
  /** "Production" for a Play track, "App Store" for iOS. */
  trackText: string;
  release: ReleaseSummary;
  /** The build number, or the Play version codes. */
  buildText: string;
  status: ReleaseState | null;
  /** "20%", or null when the store reports no share. */
  rolloutText: string | null;
  /** The date shown: the store's own date (the build upload, on the App Store), else when this server first saw the release in its state; null when neither is known. */
  at: number | null;
  /** `store`: the store gave the date. `seen`: this server first saw the release then (the store gives no date). */
  atSource: 'store' | 'seen' | null;
  ci: CiCell;
  plan: PlanCell;
};

export type VersionGroup = {
  version: string;
  /** iOS, macOS, Android, more public tracks first. */
  rows: ReleaseRow[];
  /** The platforms in the group, iOS first. */
  platforms: Platform[];
  /** At least one row is not live (a draft, in review, rolling out, halted, ...). */
  inProgress: boolean;
};

export function buildText(
  release: Pick<ReleaseSummary, 'platform' | 'build' | 'versionCodes'>,
): string {
  if (
    supports(release.platform, 'releaseTracks') &&
    release.versionCodes &&
    release.versionCodes.length > 0
  )
    return release.versionCodes.join(', ');
  return release.build ?? '—';
}

export type TableInput = {
  /** The releases of the platforms in scope, by app id. */
  releases: Readonly<Record<string, readonly ReleaseSummary[] | undefined>>;
  /** The plans by app id; null when plans are not available (no right, or a failed load). */
  plans: Readonly<Record<string, readonly PlanSummary[] | undefined>> | null;
  /** The builds by app id; an app without an entry has no CI data. */
  builds: Readonly<Record<string, readonly AppBuild[] | undefined>>;
  /** The app ids in scope, in the order of the platforms. */
  appIds: readonly string[];
};

/** One group per version, newest first. */
export function buildReleaseTable(input: TableInput): VersionGroup[] {
  const all: ReleaseSummary[] = [];
  for (const appId of input.appIds) all.push(...(input.releases[appId] ?? []));
  all.sort(compareReleases);
  const groups = new Map<string, VersionGroup>();
  for (const release of all) {
    const found = input.plans === null ? null : planFor(release, input.plans);
    const row: ReleaseRow = {
      key: `${release.appId}:${release.id}`,
      version: release.version,
      platform: release.platform,
      appId: release.appId,
      track: release.track,
      trackText:
        release.track === null && isDesktop(release.platform)
          ? platformMeta(release.platform).storeName
          : trackLabel(release.track),
      release,
      buildText: buildText(release),
      status: release.status,
      rolloutText: formatRollout(release.rolloutFraction),
      at: release.storeUpdatedAt ?? release.statusSince ?? null,
      atSource:
        release.storeUpdatedAt !== null
          ? 'store'
          : release.statusSince !== undefined && release.statusSince !== null
            ? 'seen'
            : null,
      ci: ciFor(release, input.builds[release.appId] ?? null),
      plan: planCell(found, input.plans !== null),
    };
    let group = groups.get(release.version);
    if (!group) {
      group = { version: release.version, rows: [], platforms: [], inProgress: false };
      groups.set(release.version, group);
    }
    group.rows.push(row);
    if (!group.platforms.includes(release.platform)) group.platforms.push(release.platform);
    if (release.status !== 'live') group.inProgress = true;
  }
  const out = [...groups.values()];
  for (const group of out) {
    group.rows.sort((a, b) => platformRank(a.platform) - platformRank(b.platform));
    group.platforms.sort((a, b) => platformRank(a) - platformRank(b));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Filters

export type ReleaseFilter = { query: string; inProgressOnly: boolean };

export const defaultReleaseFilter = (): ReleaseFilter => ({ query: '', inProgressOnly: false });

/** A search over the version, the build and the store state; and "not live yet" only. */
export function filterGroups(
  groups: readonly VersionGroup[],
  filter: ReleaseFilter,
): VersionGroup[] {
  const query = filter.query.trim().toLowerCase();
  const out: VersionGroup[] = [];
  for (const group of groups) {
    const rows = group.rows.filter((row) => {
      if (filter.inProgressOnly && row.status === 'live') return false;
      if (query === '') return true;
      return [row.version, row.buildText, row.release.rawState, row.trackText].some((text) =>
        text.toLowerCase().includes(query),
      );
    });
    if (rows.length > 0) out.push({ ...group, rows });
  }
  return out;
}

/** "3 versions, 5 releases". */
export function tableSummary(groups: readonly VersionGroup[]): string {
  const releases = groups.reduce((n, g) => n + g.rows.length, 0);
  return t('release:table.summary', {
    versions: t('release:table.versions', { count: groups.length }),
    releases: t('release:table.releases', { count: releases }),
  });
}

// ---------------------------------------------------------------------------------------------
// Current and older

export type CurrentSplit = {
  /** What a person usually looks for: the newest release of each platform, what is live now, what is in progress, what has a plan. */
  current: VersionGroup[];
  /** Everything else, newest first. */
  older: VersionGroup[];
  currentCount: number;
  olderCount: number;
};

/**
 * Splits the table into the releases that matter now and the rest. A release is current when it is
 * in the newest version of its platform (every track of it), is the newest one that is live on its
 * platform, is not live (a draft, in review, rolling out, halted; an old release whose store state has no mapping is history), or has
 * a plan that is not released yet. Groups keep their order and a group may be split between the two.
 * `groups` must be newest first, as buildReleaseTable returns them.
 */
export function splitCurrent(groups: readonly VersionGroup[]): CurrentSplit {
  const newestVersion = new Map<Platform, string>();
  const newestLive = new Map<Platform, string>();
  for (const group of groups) {
    for (const row of group.rows) {
      if (!newestVersion.has(row.platform)) newestVersion.set(row.platform, group.version);
      if (row.status === 'live' && !newestLive.has(row.platform))
        newestLive.set(row.platform, row.key);
    }
  }
  const isCurrent = (group: VersionGroup, row: ReleaseRow): boolean =>
    newestVersion.get(row.platform) === group.version ||
    newestLive.get(row.platform) === row.key ||
    (row.status !== 'live' && row.status !== null) ||
    (row.plan.kind === 'plan' && !row.plan.plan.released);

  const current: VersionGroup[] = [];
  const older: VersionGroup[] = [];
  let currentCount = 0;
  let olderCount = 0;
  const regroup = (group: VersionGroup, rows: ReleaseRow[]): VersionGroup => ({
    ...group,
    rows,
    platforms: group.platforms.filter((p) => rows.some((r) => r.platform === p)),
    inProgress: rows.some((r) => r.status !== 'live'),
  });
  for (const group of groups) {
    const now = group.rows.filter((r) => isCurrent(group, r));
    const rest = group.rows.filter((r) => !isCurrent(group, r));
    if (now.length > 0) current.push(regroup(group, now));
    if (rest.length > 0) older.push(regroup(group, rest));
    currentCount += now.length;
    olderCount += rest.length;
  }
  return { current, older, currentCount, olderCount };
}
