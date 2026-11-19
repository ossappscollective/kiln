import { type Action, PLATFORMS, type Platform, isPlatform, platformLabel, sortPlatforms } from '@mrm/core';
import type { IconName } from './icons.ts';

/**
 * The address of an app and its platform scope, as pure functions. The address is the source of
 * truth: `#/portfolio/<id>/<section>?platform=ios`. Nothing here touches `location`.
 */

// ---------------------------------------------------------------------------------------------
// A location hash as segments and query

export type ViewPath = { segments: string[]; query: URLSearchParams };

const decode = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/** `#/reviews?rating=1` is the segments `['reviews']` and the query `rating=1`. A `?` never changes the section. */
export function parseViewPath(hash: string): ViewPath {
  const raw = hash.replace(/^#/, '');
  const at = raw.indexOf('?');
  const path = (at < 0 ? raw : raw.slice(0, at)).split('#')[0] ?? '';
  const search = at < 0 ? '' : (raw.slice(at + 1).split('#')[0] ?? '');
  return {
    segments: path
      .split('/')
      .filter((s) => s !== '')
      .map(decode),
    query: new URLSearchParams(search),
  };
}

// ---------------------------------------------------------------------------------------------
// Sections of an app

export type AppSection = 'dashboard' | 'pending' | 'listing' | 'releases' | 'workflows' | 'assets' | 'reviews' | 'aso' | 'analytics' | 'builds' | 'test-builds' | 'settings';

export const appSections: readonly AppSection[] = ['dashboard', 'pending', 'listing', 'releases', 'workflows', 'assets', 'reviews', 'aso', 'analytics', 'builds', 'test-builds', 'settings'];

export type SectionDef = { id: AppSection; label: string; icon: IconName; requires: Action };

/** The left panel of an app, in order. Listing and assets have their own right; the rest need the app. */
export const appSectionDefs: readonly SectionDef[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'grid', requires: 'apps.read' },
  { id: 'pending', label: 'Pending changes', icon: 'upload', requires: 'listing.read' },
  { id: 'listing', label: 'Listing', icon: 'file-text', requires: 'listing.read' },
  { id: 'releases', label: 'Releases', icon: 'rocket', requires: 'apps.read' },
  { id: 'workflows', label: 'Workflows', icon: 'play', requires: 'apps.read' },
  { id: 'assets', label: 'Assets', icon: 'images', requires: 'listing.read' },
  { id: 'reviews', label: 'Reviews', icon: 'message', requires: 'reviews.read' },
  { id: 'aso', label: 'ASO', icon: 'trending-up', requires: 'aso.read' },
  { id: 'analytics', label: 'Analytics', icon: 'activity', requires: 'analytics.read' },
  { id: 'builds', label: 'Builds and CI', icon: 'pipeline', requires: 'apps.read' },
  { id: 'test-builds', label: 'Test builds', icon: 'smartphone', requires: 'builds.read' },
  { id: 'settings', label: 'Settings', icon: 'settings', requires: 'apps.read' },
];

/** The sections a person may open. */
export const visibleSections = (allowed: (action: Action) => boolean): SectionDef[] =>
  appSectionDefs.filter((s) => allowed(s.requires));

export const isAppSection = (value: string | undefined): value is AppSection =>
  value !== undefined && (appSections as readonly string[]).includes(value);

/** One platform of the app, or `both` for every platform it has (labelled "All" from three platforms; the id stays for old links). */
export type PlatformScope = Platform | 'both';

export const isPlatformScope = (value: string | null | undefined): value is PlatformScope =>
  value === 'both' || isPlatform(value);

export type AppAddress = {
  /** The id of one of the app's platform records. Any of them opens the whole app. */
  id: string;
  section: AppSection;
  /** The version of an open release (`.../release/<version>`), which belongs to the releases section. */
  release: string | null;
  /** What the address asks for; null when it says nothing. Resolve it with `resolveScope`. */
  platform: PlatformScope | null;
};

/** The app an address names, or null when the address is not an app (the list, another view). */
export function parseAppAddress(hash: string): AppAddress | null {
  const { segments, query } = parseViewPath(hash);
  const [view, id, part, version] = segments;
  if (view !== 'portfolio' || !id) return null;
  const platform = query.get('platform');
  const scope = isPlatformScope(platform) ? platform : null;
  if (part === 'release' && version) return { id, section: 'releases', release: version, platform: scope };
  // `#/portfolio/<id>?section=pending` names a section too (the path wins when it names one).
  const asked = query.get('section') ?? undefined;
  const section: AppSection = isAppSection(part) ? part : !part && isAppSection(asked) ? asked : 'dashboard';
  return { id, section, release: null, platform: scope };
}

const enc = encodeURIComponent;

/** The address of an app section, keeping the platform scope when one is given. */
export function appAddress(
  id: string,
  section: AppSection = 'dashboard',
  platform: PlatformScope | null = null,
  release: string | null = null,
): string {
  const base = `#/portfolio/${enc(id)}`;
  const path = release !== null ? `${base}/release/${enc(release)}` : section === 'dashboard' ? base : `${base}/${section}`;
  return platform ? `${path}?platform=${platform}` : path;
}

/** The workflows of one app (the link from Builds and CI). */
export const appWorkflowsHref = (id: string, platform: PlatformScope | null = null): string => appAddress(id, 'workflows', platform);

/** The reviews of one app (the link from the inbox). */
export const appReviewsHref = (id: string, platform: PlatformScope | null = null): string => appAddress(id, 'reviews', platform);

/** The same address with another platform scope; other query parts stay. */
export function withScope(hash: string, platform: PlatformScope | null): string {
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  if (platform === null) params.delete('platform');
  else params.set('platform', platform);
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

// ---------------------------------------------------------------------------------------------
// The platform scope

export type ScopeOption = { id: PlatformScope; label: string; disabled: boolean; reason: string };
export type ResolvedScope = {
  scope: PlatformScope;
  /** The platforms the screens show, in the order iOS, macOS, Android. */
  platforms: Platform[];
  options: ScopeOption[];
};

/** The label of the all-platforms choice: "Both" for two platforms, "All" for more. */
export const allScopeLabel = (count: number): string => (count > 2 ? 'All' : 'Both');

/**
 * The scope to use: what the address asked for when the app can show it, else the all-platforms
 * scope for an app on several platforms and the one platform otherwise.
 *
 * Options: an app with iOS and/or Android records only keeps the two familiar options, the missing
 * one disabled with a reason, so that layout does not move. An app with a macOS record shows only the
 * platforms it has (nothing disabled), and the macOS option never appears for an app without it.
 */
export function resolveScope(requested: PlatformScope | null, available: readonly Platform[]): ResolvedScope {
  const have = sortPlatforms(available);
  const fallback: PlatformScope = have.length >= 2 || have.length === 0 ? 'both' : (have[0] as Platform);
  const allowed = (scope: PlatformScope) => (scope === 'both' ? have.length >= 2 : have.includes(scope));
  const scope = requested !== null && allowed(requested) ? requested : fallback;
  const option = (id: PlatformScope, label: string): ScopeOption => ({
    id,
    label,
    disabled: !allowed(id),
    reason: allowed(id) ? '' : id === 'both' ? 'This app is on one store only' : 'This app is not on that store',
  });
  const hasMac = have.includes('macos');
  const shown: Platform[] = hasMac ? have : PLATFORMS.filter((p) => p !== 'macos');
  const options = shown.map((p) => option(p, platformLabel(p)));
  if (!hasMac || have.length >= 2) options.push(option('both', allScopeLabel(have.length)));
  return { scope, platforms: scope === 'both' ? have : [scope], options };
}
