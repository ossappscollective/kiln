import { ASSET_KIND_LABELS, type AssetKind, type AssetProblem, type AssetSet } from '@kiln/core';
import type { AssetIndex, AssetItem } from '../types.ts';

/**
 * Pure helpers of the Assets tab (docs/api/assets.md): grouping the index by locale and device,
 * filters, problem lookups and the texts the screen shows. No DOM, no fetch. Written for the ES2017
 * target of the web build (no flatMap, no Object.fromEntries).
 */

export type AssetFilter = { locale: string; device: string; kind: string };
/** The value of a filter that lets everything through. */
export const ALL = 'all';
export const NO_FILTER: AssetFilter = { locale: ALL, device: ALL, kind: ALL };

/** Locale folder names that mean "not a locale" (the icon of the project, a flat folder). */
const NO_LOCALE = new Set(['', 'default']);

export function localeLabel(locale: string): string {
  if (locale === '') return 'Project (no locale)';
  if (locale === 'default') return 'Default folder';
  return locale;
}

export function kindLabel(kind: AssetKind): string {
  return ASSET_KIND_LABELS[kind] ?? kind;
}

// ---------------------------------------------------------------------------------------------
// Texts

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return 'Size unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function dimensionsText(asset: Pick<AssetItem, 'width' | 'height' | 'format'>): string {
  if (asset.width !== null && asset.height !== null) return `${asset.width} x ${asset.height} px`;
  return asset.format === 'video' ? 'Video' : 'Dimensions unknown';
}

export function fileName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** "Local clone (fast)" or "GitHub (slower)": where the files were read, and how fast that is. */
export function sourceText(source: AssetIndex['source']): string {
  if (!source) return 'No repository linked';
  return source.label;
}

export function sourceHint(source: AssetIndex['source']): string {
  if (!source) return '';
  return source.fast
    ? 'Read from a clone on the server: large sets are read in full.'
    : 'Read over the network, so only a limited number of images is opened and large sets may be partial.';
}

export function shortCommit(commit: string | null): string {
  return commit ? commit.slice(0, 7) : '';
}

// ---------------------------------------------------------------------------------------------
// Severity

export type Tone = 'bad' | 'warn' | 'info';

export function severityTone(severity: AssetProblem['severity']): Tone {
  return severity === 'error' ? 'bad' : severity === 'warning' ? 'warn' : 'info';
}

export function severityLabel(severity: AssetProblem['severity']): string {
  return severity === 'error' ? 'Error' : severity === 'warning' ? 'Warning' : 'Note';
}

const SEVERITY_RANK: Record<AssetProblem['severity'], number> = { error: 0, warning: 1, info: 2 };

export function bySeverity(a: AssetProblem, b: AssetProblem): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
}

/** The problems of each file, worst first. Problems with no path are not in the map. */
export function problemsByPath(problems: readonly AssetProblem[]): Record<string, AssetProblem[]> {
  const out: Record<string, AssetProblem[]> = {};
  for (const problem of problems) {
    if (!problem.path) continue;
    const list = out[problem.path] ?? [];
    list.push(problem);
    out[problem.path] = list;
  }
  for (const key of Object.keys(out)) (out[key] as AssetProblem[]).sort(bySeverity);
  return out;
}

export function worstSeverity(problems: readonly AssetProblem[]): AssetProblem['severity'] | null {
  let worst: AssetProblem['severity'] | null = null;
  for (const p of problems)
    if (worst === null || SEVERITY_RANK[p.severity] < SEVERITY_RANK[worst]) worst = p.severity;
  return worst;
}

// ---------------------------------------------------------------------------------------------
// Thumbnails

/** The file route of an asset (same origin). The commit makes the response cacheable for good. */
export function assetFileUrl(
  workspaceId: string,
  appId: string,
  path: string,
  commit: string | null,
): string {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(appId)}/assets/file`;
  const query = `?path=${encodeURIComponent(path)}${commit ? `&commit=${encodeURIComponent(commit)}` : ''}`;
  return base + query;
}

export type PreviewState = 'image' | 'video' | 'too_large' | 'unavailable';

/**
 * Whether the browser can be shown the file: the route serves png, jpeg, webp and gif up to
 * `maxServedBytes`. Videos are never served (previews are listed only).
 */
export function previewState(asset: AssetItem, maxServedBytes: number): PreviewState {
  if (asset.format === 'video') return 'video';
  if (asset.format === null || asset.oid === null) return 'unavailable';
  if (asset.bytes !== null && asset.bytes > maxServedBytes) return 'too_large';
  return 'image';
}

export function previewNote(state: PreviewState, maxServedBytes: number): string {
  switch (state) {
    case 'video':
      return 'App previews are listed, not played.';
    case 'too_large':
      return `Larger than ${formatBytes(maxServedBytes)}: not shown here.`;
    case 'unavailable':
      return 'The file was not opened, so there is no preview.';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------------------------
// Grouping

export type DeviceGroup = {
  key: string;
  kind: AssetKind;
  kindLabel: string;
  device: string | null;
  deviceLabel: string;
  assets: AssetItem[];
  count: number;
  /** The most the store takes for the set, or null for none. */
  max: number | null;
  rule: string | null;
  /** Problems of the set as a whole (a count over the maximum, a missing file): no single file. */
  setProblems: AssetProblem[];
};

export type LocaleGroup = {
  locale: string;
  label: string;
  /** False for the project's own icon and for a flat folder. */
  isLocale: boolean;
  groups: DeviceGroup[];
  assetCount: number;
};

const KIND_ORDER: Record<string, number> = {};
[
  'screenshot',
  'preview',
  'feature_graphic',
  'promo_graphic',
  'tv_banner',
  'icon',
  'app_icon',
].forEach((k, i) => {
  KIND_ORDER[k] = i;
});

export function groupKey(locale: string, kind: AssetKind, device: string | null): string {
  return `${locale}|${kind}|${device ?? ''}`;
}

/** An asset passes the filter when it matches the locale, the device and the kind of it. */
export function matchesFilter(
  asset: { locale: string; device: string | null; kind: AssetKind },
  filter: AssetFilter,
): boolean {
  if (filter.locale !== ALL && asset.locale !== filter.locale) return false;
  if (filter.kind !== ALL && asset.kind !== filter.kind) return false;
  if (filter.device !== ALL && (asset.device ?? '') !== filter.device) return false;
  return true;
}

/**
 * The assets as locale -> kind and device -> files in order. Sets with no file (the index reports
 * a set only when it has files) are not made up. Locale folders sort by name; the project's own
 * files come last.
 */
export function groupAssets(
  index: Pick<AssetIndex, 'assets' | 'sets' | 'problems'>,
  filter: AssetFilter = NO_FILTER,
): LocaleGroup[] {
  const sets: Record<string, AssetSet> = {};
  for (const set of index.sets) sets[groupKey(set.locale, set.kind, set.device)] = set;
  const groups: Record<string, DeviceGroup> = {};
  const order: string[] = [];
  for (const asset of index.assets) {
    if (!matchesFilter(asset, filter)) continue;
    const key = groupKey(asset.locale, asset.kind, asset.device);
    let group = groups[key];
    if (!group) {
      const set = sets[key];
      group = {
        key,
        kind: asset.kind,
        kindLabel: kindLabel(asset.kind),
        device: asset.device,
        deviceLabel: asset.deviceLabel,
        assets: [],
        count: 0,
        max: set ? set.max : null,
        rule: set ? set.rule : null,
        setProblems: [],
      };
      groups[key] = group;
      order.push(key);
    }
    group.assets.push(asset);
  }
  for (const problem of index.problems) {
    if (problem.path || problem.locale === undefined || problem.kind === undefined) continue;
    const group = groups[groupKey(problem.locale, problem.kind, problem.device ?? null)];
    if (group) group.setProblems.push(problem);
  }
  const byLocale: Record<string, LocaleGroup> = {};
  const locales: string[] = [];
  for (const key of order) {
    const group = groups[key] as DeviceGroup;
    group.assets.sort((a, b) => a.order - b.order || (a.path < b.path ? -1 : 1));
    group.count = sets[key] ? (sets[key] as AssetSet).count : group.assets.length;
    group.setProblems.sort(bySeverity);
    const locale = (group.assets[0] as AssetItem).locale;
    let entry = byLocale[locale];
    if (!entry) {
      entry = {
        locale,
        label: localeLabel(locale),
        isLocale: !NO_LOCALE.has(locale),
        groups: [],
        assetCount: 0,
      };
      byLocale[locale] = entry;
      locales.push(locale);
    }
    entry.groups.push(group);
    entry.assetCount += group.assets.length;
  }
  for (const locale of locales) {
    (byLocale[locale] as LocaleGroup).groups.sort(
      (a, b) =>
        (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99) ||
        (a.deviceLabel < b.deviceLabel ? -1 : a.deviceLabel > b.deviceLabel ? 1 : 0),
    );
  }
  locales.sort((a, b) => {
    const an = NO_LOCALE.has(a) ? 1 : 0;
    const bn = NO_LOCALE.has(b) ? 1 : 0;
    return an - bn || (a < b ? -1 : a > b ? 1 : 0);
  });
  return locales.map((l) => byLocale[l] as LocaleGroup);
}

// ---------------------------------------------------------------------------------------------
// Filter options

export type FilterOption = { value: string; label: string };

export type FilterOptions = {
  locales: FilterOption[];
  devices: FilterOption[];
  kinds: FilterOption[];
};

/** Only values that occur in the index are offered, so no choice gives an empty gallery. */
export function filterOptions(index: Pick<AssetIndex, 'assets'>): FilterOptions {
  const locales: string[] = [];
  const devices: Record<string, string> = {};
  const deviceIds: string[] = [];
  const kinds: AssetKind[] = [];
  for (const asset of index.assets) {
    if (!locales.includes(asset.locale)) locales.push(asset.locale);
    const id = asset.device ?? '';
    if (devices[id] === undefined) {
      devices[id] = asset.deviceLabel;
      deviceIds.push(id);
    }
    if (!kinds.includes(asset.kind)) kinds.push(asset.kind);
  }
  locales.sort(
    (a, b) =>
      (NO_LOCALE.has(a) ? 1 : 0) - (NO_LOCALE.has(b) ? 1 : 0) || (a < b ? -1 : a > b ? 1 : 0),
  );
  deviceIds.sort((a, b) => ((devices[a] as string) < (devices[b] as string) ? -1 : 1));
  kinds.sort((a, b) => (KIND_ORDER[a] ?? 99) - (KIND_ORDER[b] ?? 99));
  return {
    locales: locales.map((value) => ({ value, label: localeLabel(value) })),
    devices: deviceIds.map((value) => ({ value, label: devices[value] as string })),
    kinds: kinds.map((value) => ({ value, label: kindLabel(value) })),
  };
}

/** A filter whose values are no longer in the index (after a reload) falls back to everything. */
export function sanitizeFilter(filter: AssetFilter, options: FilterOptions): AssetFilter {
  const has = (list: FilterOption[], value: string) =>
    value === ALL || list.some((o) => o.value === value);
  return {
    locale: has(options.locales, filter.locale) ? filter.locale : ALL,
    device: has(options.devices, filter.device) ? filter.device : ALL,
    kind: has(options.kinds, filter.kind) ? filter.kind : ALL,
  };
}

export function isFiltered(filter: AssetFilter): boolean {
  return filter.locale !== ALL || filter.device !== ALL || filter.kind !== ALL;
}

// ---------------------------------------------------------------------------------------------
// Counts, partial reads, the store-side seam

export function countText(group: Pick<DeviceGroup, 'count' | 'max'>): string {
  return group.max === null ? `${group.count}` : `${group.count} of at most ${group.max}`;
}

export function summaryText(index: Pick<AssetIndex, 'totals'>): string {
  const t = index.totals;
  const files = `${t.assets} ${t.assets === 1 ? 'file' : 'files'}`;
  const locales = t.locales > 0 ? `, ${t.locales} ${t.locales === 1 ? 'locale' : 'locales'}` : '';
  return `${files}${locales}, ${formatBytes(t.bytes)}`;
}

export function problemCountsText(index: Pick<AssetIndex, 'totals'>): string {
  const t = index.totals;
  const parts: string[] = [];
  if (t.errors > 0) parts.push(`${t.errors} ${t.errors === 1 ? 'error' : 'errors'}`);
  if (t.warnings > 0) parts.push(`${t.warnings} ${t.warnings === 1 ? 'warning' : 'warnings'}`);
  if (t.infos > 0) parts.push(`${t.infos} ${t.infos === 1 ? 'note' : 'notes'}`);
  return parts.length > 0 ? parts.join(', ') : 'No problems found';
}

export type StoreCompare =
  | { state: 'not_compared'; text: string }
  | { state: 'same'; text: string; storeCount: number }
  | { state: 'differs'; text: string; storeCount: number };

export const NOT_COMPARED = 'Not yet compared with the store';

/**
 * The repository count of a set next to what the store has. `storeSide` is null until the listing
 * reads supply it: then the answer is "not yet compared", never a guess.
 */
export function compareWithStore(
  storeSide: AssetIndex['storeSide'],
  group: Pick<DeviceGroup, 'count' | 'kind' | 'device'>,
  locale: string,
): StoreCompare {
  if (!storeSide) return { state: 'not_compared', text: NOT_COMPARED };
  const entry = storeSide.counts.find(
    (c) =>
      c.locale === locale && c.kind === group.kind && (c.device ?? '') === (group.device ?? ''),
  );
  if (!entry) return { state: 'not_compared', text: NOT_COMPARED };
  return entry.count === group.count
    ? { state: 'same', text: `The store has ${entry.count}, the same`, storeCount: entry.count }
    : {
        state: 'differs',
        text: `The store has ${entry.count}, the repository ${group.count}`,
        storeCount: entry.count,
      };
}
