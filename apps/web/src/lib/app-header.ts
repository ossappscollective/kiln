import { byFamily, type Platform, platformLabel, type ReleaseState, sortPlatforms, supports } from '@mrm/core';
import { parseViewPath } from './app-scope.ts';
import { compareReleases, compareVersions } from './portfolio.ts';
import type { ReleaseSummary } from './types.ts';

/**
 * The header of a versioned app page, as pure functions: the version and locale pickers (the platform
 * control is lib/app-scope.ts), what the address keeps of them, the state of each version as a word
 * and a dot, and which versions a store no longer lets anyone edit. Versions come from the store
 * releases the app screen has already loaded; nothing here reads a store or the network.
 *
 * Address: `#/portfolio/<id>/<section>?platform=ios&version=2.4.0&locale=en-US`. Every tab of the
 * app reads the same three, so a choice made on one page is still there on the next.
 */

// ---------------------------------------------------------------------------------------------
// The address

export type HeaderParams = { version: string | null; locale: string | null };

/** The version and locale the address asks for. Empty values read as nothing. */
export function headerParams(hash: string): HeaderParams {
  const { query } = parseViewPath(hash);
  const clean = (value: string | null): string | null =>
    value === null || value.trim() === '' ? null : value.trim();
  return { version: clean(query.get('version')), locale: clean(query.get('locale')) };
}

/** The same address with another version and/or locale (null removes it); the rest of the query stays. */
export function withHeaderParams(hash: string, patch: Partial<HeaderParams>): string {
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  for (const name of ['version', 'locale'] as const) {
    if (!(name in patch)) continue;
    const value = patch[name];
    if (value === null || value === undefined || value === '') params.delete(name);
    else params.set(name, value);
  }
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** Copies the version and locale of the current address onto a link, so a tab link keeps them. */
export function carryHeaderParams(href: string, hash: string): string {
  const { version, locale } = headerParams(hash);
  if (version === null && locale === null) return href;
  const at = href.indexOf('?');
  const path = at < 0 ? href : href.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : href.slice(at + 1));
  if (version !== null && !params.has('version')) params.set('version', version);
  if (locale !== null && !params.has('locale')) params.set('locale', locale);
  return `${path}?${params.toString()}`;
}

// ---------------------------------------------------------------------------------------------
// The state of a version

export type VersionTone = 'ok' | 'info' | 'accent' | 'warn' | 'bad' | 'neutral';
export type VersionState = { label: string; tone: VersionTone };

/** The word a version carries in the picker. Apple's editable state is called what the App Store calls it. */
export function versionState(status: ReleaseState | null, platform: Platform): VersionState {
  switch (status) {
    case 'draft':
    case 'build_chosen':
      return {
        label: byFamily(platform, { apple: 'Prepare for submission', google: 'Draft' }),
        tone: 'neutral' };
    case 'ready':
      return { label: 'Ready to submit', tone: 'info' };
    case 'in_review':
      return { label: 'In review', tone: 'info' };
    case 'rejected':
      return { label: 'Rejected', tone: 'bad' };
    case 'approved':
      return { label: 'Approved', tone: 'accent' };
    case 'propagating':
      return { label: 'Propagating', tone: 'info' };
    case 'rolling_out':
      return { label: 'Rolling out', tone: 'info' };
    case 'live':
      return { label: 'Live', tone: 'ok' };
    case 'halted':
      return { label: 'Halted', tone: 'warn' };
    default:
      return { label: 'Unknown state', tone: 'neutral' };
  }
}

/** Most urgent first: what the one dot of a version shows when its platforms differ. */
const URGENCY: (ReleaseState | null)[] = [
  'rejected',
  'halted',
  'in_review',
  'propagating',
  'rolling_out',
  'approved',
  'ready',
  'build_chosen',
  'draft',
  'live',
  null,
];
const urgency = (status: ReleaseState | null): number => URGENCY.indexOf(status);

// ---------------------------------------------------------------------------------------------
// The versions of an app

export type VersionOption = {
  version: string;
  /** The state of the version; when the platforms differ, that of the most urgent one. */
  state: VersionState;
  /** "iOS Live · Android Draft" when the platforms in scope differ, else ''. */
  detail: string;
  /** The platforms in scope that have this version. */
  platforms: Platform[];
  /** One release per platform: the most public track on Play. */
  releases: ReleaseSummary[];
};

/** The release that stands for a platform's version: the most public track, then the highest build. */
function pick(
  list: readonly ReleaseSummary[],
  platform: Platform,
  version: string,
): ReleaseSummary | null {
  return (
    list.filter((r) => r.platform === platform && r.version === version).sort(compareReleases)[0] ??
    null
  );
}

/**
 * The versions of the platforms in scope, newest first, each with its state. A version that only one
 * platform has is listed once with that platform's state.
 */
export function buildVersionOptions(
  releases: readonly ReleaseSummary[],
  platforms: readonly Platform[],
  limit = 40,
): VersionOption[] {
  const scoped = releases.filter((r) => platforms.includes(r.platform));
  const versions = [...new Set(scoped.map((r) => r.version))]
    .sort((a, b) => compareVersions(b, a))
    .slice(0, limit);
  return versions.map((version) => {
    const mine = sortPlatforms(
      platforms.filter((p) => scoped.some((r) => r.platform === p && r.version === version)),
    );
    const chosen = mine
      .map((p) => pick(scoped, p, version))
      .filter((r): r is ReleaseSummary => r !== null);
    const lead = [...chosen].sort(
      (a, b) => urgency(a.status) - urgency(b.status),
    )[0] as ReleaseSummary;
    const states = chosen.map((r) => versionState(r.status, r.platform));
    // The same status on two stores is one state even when the stores name it differently.
    const differ = chosen.some((r) => r.status !== chosen[0]?.status);
    return {
      version,
      state: versionState(lead.status, lead.platform),
      detail: differ
        ? chosen
            .map((r, i) => `${platformLabel(r.platform)} ${(states[i] as VersionState).label}`)
            .join(' · ')
        : '',
      platforms: mine,
      releases: chosen };
  });
}

/** The version to show: the one asked for when it exists, else the newest; null when there is none. */
export function resolveVersion(
  requested: string | null,
  options: readonly VersionOption[],
): string | null {
  if (requested !== null && options.some((o) => o.version === requested)) return requested;
  return options[0]?.version ?? null;
}

/** One line for the picker button and an option: "2.4.0 · Prepare for submission". */
export const optionText = (option: Pick<VersionOption, 'version' | 'state' | 'detail'>): string =>
  `${option.version} · ${option.detail !== '' ? option.detail : option.state.label}`;

// ---------------------------------------------------------------------------------------------
// Locked versions

/** States in which Apple lets the metadata of the version change no more. Play listings are not tied to a release and never lock. */
const RELEASED: ReleaseState[] = ['live', 'rolling_out', 'propagating', 'halted'];
/** Apple also freezes the version while it waits for review or for the release button. Play keeps the listing open. */
const APPLE_FROZEN: ReleaseState[] = ['in_review', 'approved'];

export const isLockedState = (status: ReleaseState | null, platform: Platform): boolean =>
  status !== null &&
  !supports(platform, 'transactionalEdits') &&
  (RELEASED.includes(status) || APPLE_FROZEN.includes(status));

const lockWord = (status: ReleaseState): string =>
  status === 'live'
    ? 'live'
    : status === 'in_review'
      ? 'in review'
      : status === 'approved'
        ? 'approved'
        : status === 'halted'
          ? 'halted'
          : 'rolling out';

export type LockInfo = {
  /** Platforms whose release of the version is locked. */
  locked: Platform[];
  /** Platforms in scope that can still be edited (including those without this version yet). */
  editable: Platform[];
  /** Every platform in scope is locked. */
  all: boolean;
  /** The banner sentence, '' when nothing is locked. */
  text: string;
};

export const noLock: LockInfo = { locked: [], editable: [], all: false, text: '' };

/**
 * Whether the selected version can be edited on each platform in scope, and the sentence that says so.
 * A platform without this version is open for editing, unless `fallbackToNewest` is set (the version was not
 * chosen by the person, only defaulted): then its own newest release stands in, so a default never opens
 * a platform whose newest version is live just because its numbering differs.
 */
export function lockInfo(
  releases: readonly ReleaseSummary[],
  version: string | null,
  platforms: readonly Platform[],
  options: { fallbackToNewest?: boolean } = {},
): LockInfo {
  const scope = sortPlatforms(platforms);
  if (version === null) return { ...noLock, editable: scope };
  const rows = scope.map((platform) => {
    const release =
      pick(releases, platform, version) ??
      (options.fallbackToNewest
        ? (releases.filter((r) => r.platform === platform).sort(compareReleases)[0] ?? null)
        : null);
    const status = release?.status ?? null;
    return { platform, status, locked: isLockedState(status, platform) };
  });
  const locked = rows.filter((r) => r.locked);
  const editable = rows.filter((r) => !r.locked).map((r) => r.platform);
  if (locked.length === 0) return { locked: [], editable, all: false, text: '' };
  const words = [...new Set(locked.map((r) => lockWord(r.status as ReleaseState)))];
  const names = (list: readonly Platform[]) => list.map(platformLabel).join(' and ');
  // "iOS and macOS are live, Android is rolling out": platforms in the same state are named together.
  const said = words
    .map((word) => {
      const group = locked
        .filter((r) => lockWord(r.status as ReleaseState) === word)
        .map((r) => r.platform);
      return `${names(group)} ${group.length > 1 ? 'are' : 'is'} ${word}`;
    })
    .join(', ');
  let text: string;
  if (editable.length === 0 && words.length === 1) {
    text = `This version is ${words[0]} — metadata is locked`;
  } else if (editable.length === 0) {
    text = `Metadata is locked — ${said}`;
  } else {
    text = `${said} — ${names(locked.map((r) => r.platform))} metadata is locked`;
  }
  return { locked: locked.map((r) => r.platform), editable, all: editable.length === 0, text };
}

// ---------------------------------------------------------------------------------------------
// Locales

/** The union of the locale lists the screens have loaded, sorted, each once. Empty entries are dropped. */
export function mergeLocales(lists: readonly (readonly string[])[]): string[] {
  const all = new Set<string>();
  for (const list of lists) for (const locale of list) if (locale.trim() !== '') all.add(locale);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** The locale to use: the one asked for when it is known, else null (every locale). */
export const resolveLocale = (
  requested: string | null,
  locales: readonly string[],
): string | null => (requested !== null && locales.includes(requested) ? requested : null);

// ---------------------------------------------------------------------------------------------
// Which pages carry the header

export type PickerSet = { version: boolean; locale: boolean };

/**
 * The pickers a page shows, or null for a page without them (the dashboard, reviews, workflows, builds,
 * settings, and one open release). Store listing and assets: version and locale. Releases: version only (a
 * release has no locale). ASO: only its fit view, which is read per locale of the live listing.
 */
export function pickersFor(
  section: string,
  options: { asoView?: string; releaseOpen?: boolean } = {},
): PickerSet | null {
  if (options.releaseOpen) return null;
  if (section === 'listing' || section === 'assets') return { version: true, locale: true };
  if (section === 'releases') return { version: true, locale: false };
  if ((section === 'aso' || section === 'insights') && options.asoView === 'fit')
    return { version: true, locale: true };
  return null;
}

/** The sections whose metadata a locked version makes read-only. */
export const lockableSections: readonly string[] = ['listing', 'assets'];
