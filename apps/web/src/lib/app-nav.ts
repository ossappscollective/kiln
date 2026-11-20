import type { Action } from '@mrm/core';
import { type AppSection, appAddress, parseAppAddress, parseViewPath } from './app-scope.ts';
import { isAsoView } from './aso/aso.ts';
import type { IconName } from './icons.ts';

/**
 * The navigation of an open app as pure functions: the six entries of the left panel, the views inside the pages that merge several
 * old pages (Store listing, Insights, Builds), the redirects from the old addresses, and the titles of the slim page header.
 * Nothing here touches `location`, the DOM or the network.
 *
 * Left panel: Overview, Releases, Store listing, Reviews, Insights, Builds. Pending changes is not an entry: it is the pending bar
 * under the header (the address `#/portfolio/<id>/pending` stays). The old pages keep their addresses and redirect:
 *   workflows   -> builds?view=workflows        test-builds -> builds?view=tests
 *   assets      -> listing?view=graphics        analytics   -> insights
 *   aso         -> insights?view=keywords (or the keyword view it names: `?view=fit`); insights?view=aso -> keywords, ?view=analytics -> overview
 */

// ---------------------------------------------------------------------------------------------
// The left panel

export type NavEntry = { id: AppSection; label: string; icon: IconName; requires: Action };

export const primaryNav: readonly NavEntry[] = [
  { id: 'dashboard', label: 'Overview', icon: 'grid', requires: 'apps.read' },
  { id: 'releases', label: 'Releases', icon: 'rocket', requires: 'apps.read' },
  { id: 'listing', label: 'Store listing', icon: 'file-text', requires: 'listing.read' },
  { id: 'reviews', label: 'Reviews', icon: 'message', requires: 'reviews.read' },
  { id: 'insights', label: 'Insights', icon: 'trending-up', requires: 'analytics.read' },
  { id: 'builds', label: 'Builds', icon: 'pipeline', requires: 'apps.read' },
];

/** The entries a person may open, in order. */
export const visibleNav = (allowed: (action: Action) => boolean): NavEntry[] =>
  primaryNav.filter((e) => allowed(e.requires));

/** The entry of the left panel that a page belongs to (an old page belongs to the page that replaced it); null for none (pending, settings). */
export function navEntryOf(section: AppSection): AppSection | null {
  switch (section) {
    case 'aso':
    case 'analytics':
      return 'insights';
    case 'assets':
      return 'listing';
    case 'workflows':
    case 'test-builds':
      return 'builds';
    case 'pending':
    case 'settings':
      return null;
    default:
      return section;
  }
}

export type RailItem = { id: string; label: string; icon?: string };
export type WorkspaceRail = { main: RailItem[]; more: RailItem[] };

/** The workspace views the rail shows at the bottom (with their rail names); the rest go in the collapsed group. */
const RAIL_MAIN: readonly { id: string; label: string }[] = [
  { id: 'portfolio', label: 'All apps' },
  { id: 'reviews', label: 'Inbox' },
  { id: 'settings', label: 'Settings' },
];

/**
 * The bottom of the left panel of an app: All apps, Inbox and Settings, then everything else the person may open (Repositories,
 * Credentials, Members, API tokens, Webhooks, Audit log, ...) in the order of `views`, in a collapsed group.
 */
export function workspaceRail(views: readonly RailItem[]): WorkspaceRail {
  const main: RailItem[] = [];
  for (const m of RAIL_MAIN) {
    const found = views.find((v) => v.id === m.id);
    if (found) main.push({ ...found, label: m.label });
  }
  const more = views.filter((v) => !RAIL_MAIN.some((m) => m.id === v.id));
  return { main, more };
}

// ---------------------------------------------------------------------------------------------
// Views inside a page

export type SectionView = {
  id: string;
  label: string;
  requires?: Action /** Only drawn when a Google Play app is in scope (Search terms comes from a Play Console file). */;
  androidOnly?: boolean;
};

/** The pages that hold several old pages as views; a page opens on its first view. */
export const sectionViews: Readonly<Partial<Record<AppSection, readonly SectionView[]>>> = {
  listing: [
    { id: 'text', label: 'Text' },
    { id: 'graphics', label: 'Graphics' },
  ],
  insights: [
    { id: 'overview', label: 'Overview' },
    { id: 'keywords', label: 'Keywords', requires: 'aso.read' },
    { id: 'terms', label: 'Search terms', requires: 'aso.read', androidOnly: true },
  ],
  builds: [
    { id: 'builds', label: 'Builds' },
    { id: 'workflows', label: 'Workflows' },
    { id: 'tests', label: 'Test builds', requires: 'builds.read' },
  ],
};

/** What the views of a page may depend on besides the role: whether a Google Play app is in scope (default: yes). */
export type ViewContext = { androidInScope?: boolean };

const openViews = (
  section: AppSection,
  allowed: (action: Action) => boolean,
  context: ViewContext,
): SectionView[] =>
  (sectionViews[section] ?? []).filter(
    (v) =>
      (!v.requires || allowed(v.requires)) && (!v.androidOnly || context.androidInScope !== false),
  );

/** The views of a page a person may open; empty for a page with no views, or with only one (nothing to switch). */
export function viewsFor(
  section: AppSection,
  allowed: (action: Action) => boolean,
  context: ViewContext = {},
): SectionView[] {
  const list = openViews(section, allowed, context);
  return list.length > 1 ? list : [];
}

/**
 * The view of Insights an address names, with every old value mapped (see the table in docs/ux-ia.md): nothing, `analytics` and
 * `overview` are Overview; `terms` is Search terms; `aso` and every ASO sub-view (`keywords`, `rank`, `fit`, ...) are Keywords, which
 * keeps its own sub-views inside; anything else is Overview.
 */
export function insightsViewOf(
  asked: string | null | undefined,
): 'overview' | 'keywords' | 'terms' {
  if (asked === 'terms') return 'terms';
  return asked === 'aso' || isAsoView(asked) ? 'keywords' : 'overview';
}

/** The `?view=` an Insights address should carry, or null for none: the current names (`overview` is the default and not written). */
export function canonicalInsightsView(asked: string | null): string | null {
  if (asked === null || asked === 'analytics' || asked === 'overview') return null;
  if (asked === 'aso') return 'keywords';
  return asked;
}

/**
 * The view an address names. An unknown or missing value is the first view. For Insights, the old values map as in
 * `insightsViewOf`: the ASO sub-views (`?view=fit`, `?view=rank`, ...) are Keywords, which keeps them as its own sub-views.
 */
export function viewOf(section: AppSection, hash: string): string {
  const list = sectionViews[section];
  if (!list || list.length === 0) return '';
  const asked = parseViewPath(hash).query.get('view');
  if (section === 'insights') return insightsViewOf(asked);
  return list.find((v) => v.id === asked)?.id ?? (list[0] as SectionView).id;
}

/**
 * The view to draw: the one the address names when the role may open it, else the first one the role may open; '' for a page without views.
 * Search terms in an address for an app with no Google Play record falls back to Keywords.
 */
export function resolveView(
  section: AppSection,
  hash: string,
  allowed: (action: Action) => boolean,
  context: ViewContext = {},
): string {
  const list = openViews(section, allowed, context);
  if (list.length === 0) return '';
  const asked = viewOf(section, hash);
  return (
    list.find((v) => v.id === asked)?.id ??
    (asked === 'terms' ? list.find((v) => v.id === 'keywords') : undefined)?.id ??
    (list[0] as SectionView).id
  );
}

const setQuery = (hash: string, change: (params: URLSearchParams) => void): string => {
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  change(params);
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
};

/** The same address on another view of the page. The first view is the default and is not written; other query parts stay. */
export function withView(hash: string, section: AppSection, view: string): string {
  const list = sectionViews[section];
  if (!list?.some((v) => v.id === view)) return hash;
  const first = (list[0] as SectionView).id;
  return setQuery(hash, (params) => {
    if (view === first) params.delete('view');
    else params.set('view', view);
  });
}

/** A keyword sub-view inside Insights (`?view=rank`, `?view=fit`, ...). Keywords itself is written `keywords`: the default of Insights is Overview. */
export const withInsightsAsoView = (hash: string, view: string): string =>
  setQuery(hash, (params) => params.set('view', view));

// ---------------------------------------------------------------------------------------------
// The old addresses

type Redirect = { section: AppSection; view: (current: string | null) => string | null };

const REDIRECTS: Readonly<Partial<Record<AppSection, Redirect>>> = {
  workflows: { section: 'builds', view: () => 'workflows' },
  'test-builds': { section: 'builds', view: () => 'tests' },
  assets: { section: 'listing', view: () => 'graphics' },
  analytics: { section: 'insights', view: () => null },
  // An ASO address that names a sub-view keeps it (`/aso?view=fit` is Insights, Keywords, Fit).
  aso: { section: 'insights', view: (current) => (isAsoView(current) ? current : 'keywords') },
};

/**
 * The new address of an old one, or null when the address needs no redirect. Platform, version, locale and every other query part
 * stay; the old `?section=` form is dropped. A release address (`.../release/<version>`) is never redirected.
 */
export function canonicalAppHash(hash: string): string | null {
  const open = parseAppAddress(hash);
  if (!open || open.release !== null) return null;
  const { query } = parseViewPath(hash);
  const rule = REDIRECTS[open.section];
  if (!rule) {
    // The values Insights used before the views were Overview, Keywords and Search terms: `aso` and `analytics`.
    if (open.section !== 'insights') return null;
    const asked = query.get('view');
    const next = canonicalInsightsView(asked);
    if (next === asked) return null;
    const params = new URLSearchParams(query);
    params.delete('section');
    if (next === null) params.delete('view');
    else params.set('view', next);
    const search = params.toString();
    const base = appAddress(open.id, 'insights');
    return search === '' ? base : `${base}?${search}`;
  }
  const params = new URLSearchParams(query);
  params.delete('section');
  const view = rule.view(query.get('view'));
  if (view === null) params.delete('view');
  else params.set('view', view);
  const base = appAddress(open.id, rule.section);
  const search = params.toString();
  return search === '' ? base : `${base}?${search}`;
}

/** The page an address lands on: an old page reads as the page that replaced it. */
export const canonicalSection = (section: AppSection): AppSection =>
  REDIRECTS[section]?.section ?? section;

// ---------------------------------------------------------------------------------------------
// The slim page header

const TITLES: Readonly<Record<AppSection, string>> = {
  dashboard: 'Overview',
  releases: 'Releases',
  listing: 'Store listing',
  reviews: 'Reviews',
  insights: 'Insights',
  builds: 'Builds',
  pending: 'Pending changes',
  settings: 'App settings',
  workflows: 'Builds',
  assets: 'Store listing',
  aso: 'Insights',
  analytics: 'Insights',
  'test-builds': 'Builds',
};

/** The name of the page in the header. */
export const pageTitle = (section: AppSection): string => TITLES[section];

/** Whether the platform control is drawn: not for an app with one platform (nothing to choose) and not on the settings page (they are about the whole app). */
export const showsScope = (section: AppSection, platformCount: number): boolean =>
  platformCount > 1 && section !== 'settings';
