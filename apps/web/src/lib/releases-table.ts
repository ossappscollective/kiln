import type { Platform, ReleaseState } from '@mrm/core';
import { runBadge } from './ci.ts';
import { type BadgeTone, compareReleases, compareVersions, formatRollout, trackLabel } from './portfolio.ts';
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
export function buildsForRelease(release: Pick<ReleaseSummary, 'platform' | 'build' | 'versionCodes'>, builds: readonly AppBuild[]): AppBuild[] {
  const numbers = new Set<string>();
  if (release.build !== null) numbers.add(release.build);
  for (const code of release.versionCodes ?? []) numbers.add(code);
  if (numbers.size === 0) return [];
  return builds
    .filter((b) => b.platform === release.platform && numbers.has(b.buildNumber))
    .sort((a, b) => (b.uploadedAt ?? b.syncedAt) - (a.uploadedAt ?? a.syncedAt) || compareVersions(b.buildNumber, a.buildNumber));
}

const rank = (b: AppBuild): number => (b.link?.run ? 2 : b.linkState === 'tag' ? 1 : 0);

/** The CI state of a release: the run of its best linked build, else a tag, else nothing found. `unknown`: builds were not loaded. */
export function ciFor(release: Pick<ReleaseSummary, 'platform' | 'build' | 'versionCodes'>, builds: readonly AppBuild[] | null): CiCell {
  if (builds === null) {
    return { state: 'unknown', label: '—', tone: 'neutral', dot: false, title: 'CI data is not available.' };
  }
  const matches = buildsForRelease(release, builds);
  if (matches.length === 0) {
    return { state: 'unlinked', label: 'No build', tone: 'neutral', dot: false, title: 'No build with this number was found for this release.' };
  }
  const best = [...matches].sort((a, b) => rank(b) - rank(a))[0] as AppBuild;
  const run = best.link?.run ?? null;
  if (run) {
    const badge = runBadge(run);
    return { state: 'run', label: badge.label, tone: badge.tone, dot: badge.dot, title: `CI run of build ${best.buildNumber}: ${badge.label}.` };
  }
  if (best.linkState === 'tag') {
    return { state: 'tag', label: 'Tag found', tone: 'info', dot: false, title: 'A tag carries this build number; no CI run was found.' };
  }
  return { state: 'unlinked', label: 'Not linked', tone: 'neutral', dot: false, title: 'No CI run is linked to this build.' };
}

// ---------------------------------------------------------------------------------------------
// Plan state of a row

export type PlanCell =
  | { kind: 'none'; label: string; tone: BadgeTone; title: string }
  | { kind: 'plan'; plan: PlanSummary; label: string; tone: BadgeTone; title: string; viaApp: boolean };

const checklistText = (plan: Pick<PlanSummary, 'checklist'>): string =>
  plan.checklist.total === 0 ? 'no checklist items' : `${plan.checklist.done} of ${plan.checklist.total} checklist items done`;

/**
 * The plan that covers a release. A plan belongs to one app record and names a platform, or none
 * when it covers both; a plan for both on the other platform's record covers this one too.
 */
export function planFor(
  release: Pick<ReleaseSummary, 'appId' | 'platform' | 'version'>,
  plansByApp: Readonly<Record<string, readonly PlanSummary[] | undefined>>,
): { plan: PlanSummary; viaApp: boolean } | null {
  const own = (plansByApp[release.appId] ?? []).find(
    (p) => p.version === release.version && (p.platform === null || p.platform === release.platform),
  );
  if (own) return { plan: own, viaApp: false };
  for (const appId of Object.keys(plansByApp)) {
    if (appId === release.appId) continue;
    const other = (plansByApp[appId] ?? []).find((p) => p.version === release.version && p.platform === null);
    if (other) return { plan: other, viaApp: true };
  }
  return null;
}

/** The words for a plan: blocked, released, overdue, due soon, ready, or how far the checklist is. */
export function planCell(found: { plan: PlanSummary; viaApp: boolean } | null, plansLoaded = true): PlanCell {
  if (found === null) {
    return plansLoaded
      ? { kind: 'none', label: 'No plan', tone: 'neutral', title: 'No release plan for this version.' }
      : { kind: 'none', label: '—', tone: 'neutral', title: 'Plans are not available.' };
  }
  const { plan, viaApp } = found;
  const base = (label: string, tone: BadgeTone, extra: string): PlanCell => ({
    kind: 'plan',
    plan,
    label,
    tone,
    viaApp,
    title: `${extra}${viaApp ? ' The plan is on the other platform’s app and covers both.' : ''}`,
  });
  if (plan.blocked) return base('Blocked', 'bad', plan.blockedReason ? `Blocked: ${plan.blockedReason}` : 'The plan is blocked.');
  if (plan.released) return base('Released', 'ok', 'The last sync saw this version live.');
  if (plan.due.overdue) return base('Overdue', 'bad', plan.targetDate ? `The target date ${plan.targetDate} has passed.` : 'The target date has passed.');
  if (plan.due.dueSoon) return base('Due soon', 'warn', `The target date is ${plan.targetDate ?? 'soon'}.`);
  if (plan.readiness.ready) return base('Ready', 'ok', 'Every required checklist item is done and the release notes are complete.');
  const progress = checklistText(plan);
  return base('In progress', 'info', `${progress.charAt(0).toUpperCase()}${progress.slice(1)}.`);
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
  /** When the store last changed it; null when it did not say. */
  at: number | null;
  ci: CiCell;
  plan: PlanCell;
};

export type VersionGroup = {
  version: string;
  /** iOS before Android, more public tracks first. */
  rows: ReleaseRow[];
  /** The platforms in the group, iOS first. */
  platforms: Platform[];
  /** At least one row is not live (a draft, in review, rolling out, halted, ...). */
  inProgress: boolean;
};

export function buildText(release: Pick<ReleaseSummary, 'platform' | 'build' | 'versionCodes'>): string {
  if (release.platform === 'android' && release.versionCodes && release.versionCodes.length > 0) return release.versionCodes.join(', ');
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
      trackText: trackLabel(release.track),
      release,
      buildText: buildText(release),
      status: release.status,
      rolloutText: formatRollout(release.rolloutFraction),
      at: release.storeUpdatedAt,
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
    group.rows.sort((a, b) => (a.platform === b.platform ? 0 : a.platform === 'ios' ? -1 : 1));
    group.platforms.sort((a, b) => (a === b ? 0 : a === 'ios' ? -1 : 1));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Filters

export type ReleaseFilter = { query: string; inProgressOnly: boolean };

export const defaultReleaseFilter = (): ReleaseFilter => ({ query: '', inProgressOnly: false });

/** A search over the version, the build and the store state; and "not live yet" only. */
export function filterGroups(groups: readonly VersionGroup[], filter: ReleaseFilter): VersionGroup[] {
  const query = filter.query.trim().toLowerCase();
  const out: VersionGroup[] = [];
  for (const group of groups) {
    const rows = group.rows.filter((row) => {
      if (filter.inProgressOnly && row.status === 'live') return false;
      if (query === '') return true;
      return [row.version, row.buildText, row.release.rawState, row.trackText].some((text) => text.toLowerCase().includes(query));
    });
    if (rows.length > 0) out.push({ ...group, rows });
  }
  return out;
}

/** "3 versions, 5 releases". */
export function tableSummary(groups: readonly VersionGroup[]): string {
  const releases = groups.reduce((n, g) => n + g.rows.length, 0);
  const versions = `${groups.length} ${groups.length === 1 ? 'version' : 'versions'}`;
  return `${versions}, ${releases} ${releases === 1 ? 'release' : 'releases'}`;
}
