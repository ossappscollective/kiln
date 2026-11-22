import type { AssetKind, AssetProblem, AssetSet } from '@kiln/core';
import { formatBytes as formatBytesIntl, formatList, formatNumber } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
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
  if (locale === '') return t('assets:locale.project');
  if (locale === 'default') return t('assets:locale.default');
  return locale;
}

const KIND_LABELS: Record<AssetKind, string> = {
  screenshot: k('assets:kind.screenshot'),
  preview: k('assets:kind.preview'),
  feature_graphic: k('assets:kind.featureGraphic'),
  promo_graphic: k('assets:kind.promoGraphic'),
  tv_banner: k('assets:kind.tvBanner'),
  icon: k('assets:kind.icon'),
  app_icon: k('assets:kind.appIcon'),
};

export function kindLabel(kind: AssetKind): string {
  const key = KIND_LABELS[kind];
  return key !== undefined ? t(key) : kind;
}

// ---------------------------------------------------------------------------------------------
// Texts

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return t('assets:size.unknown');
  return formatBytesIntl(bytes);
}

export function dimensionsText(asset: Pick<AssetItem, 'width' | 'height' | 'format'>): string {
  if (asset.width !== null && asset.height !== null)
    return t('assets:dimensions', { width: asset.width, height: asset.height });
  return asset.format === 'video' ? t('assets:media.video') : t('assets:dimensions.unknown');
}

export function fileName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** "Local clone (fast)" or "GitHub (slower)": where the files were read, and how fast that is. */
export function sourceText(source: AssetIndex['source']): string {
  if (!source) return t('assets:source.none');
  return source.label;
}

export function sourceHint(source: AssetIndex['source']): string {
  if (!source) return '';
  return source.fast ? t('assets:source.hintFast') : t('assets:source.hintSlow');
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
  return severity === 'error'
    ? t('assets:severity.error')
    : severity === 'warning'
      ? t('assets:severity.warning')
      : t('assets:severity.note');
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
      return t('assets:preview.video');
    case 'too_large':
      return t('assets:preview.tooLarge', { size: formatBytes(maxServedBytes) });
    case 'unavailable':
      return t('assets:preview.unavailable');
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
].forEach((kind, i) => {
  KIND_ORDER[kind] = i;
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
  return group.max === null
    ? formatNumber(group.count)
    : t('assets:count.atMost', { count: group.count, max: group.max });
}

export function summaryText(index: Pick<AssetIndex, 'totals'>): string {
  const totals = index.totals;
  const parts = [t('assets:summary.files', { count: totals.assets })];
  if (totals.locales > 0) parts.push(t('assets:summary.locales', { count: totals.locales }));
  parts.push(formatBytes(totals.bytes));
  return formatList(parts, { type: 'unit' });
}

export function problemCountsText(index: Pick<AssetIndex, 'totals'>): string {
  const totals = index.totals;
  const parts: string[] = [];
  if (totals.errors > 0) parts.push(t('assets:problems.errors', { count: totals.errors }));
  if (totals.warnings > 0) parts.push(t('assets:problems.warnings', { count: totals.warnings }));
  if (totals.infos > 0) parts.push(t('assets:problems.notes', { count: totals.infos }));
  return parts.length > 0 ? formatList(parts, { type: 'unit' }) : t('assets:problems.none');
}

export type StoreCompare =
  | { state: 'not_compared'; text: string }
  | { state: 'same'; text: string; storeCount: number }
  | { state: 'differs'; text: string; storeCount: number };

/** A message key: `t(NOT_COMPARED)`. `StoreCompare.text` already holds the translated text. */
export const NOT_COMPARED = k('assets:compare.notYet');

/**
 * The repository count of a set next to what the store has. `storeSide` is null until the listing
 * reads supply it: then the answer is "not yet compared", never a guess.
 */
export function compareWithStore(
  storeSide: AssetIndex['storeSide'],
  group: Pick<DeviceGroup, 'count' | 'kind' | 'device'>,
  locale: string,
): StoreCompare {
  if (!storeSide) return { state: 'not_compared', text: t(NOT_COMPARED) };
  const entry = storeSide.counts.find(
    (c) =>
      c.locale === locale && c.kind === group.kind && (c.device ?? '') === (group.device ?? ''),
  );
  if (!entry) return { state: 'not_compared', text: t(NOT_COMPARED) };
  return entry.count === group.count
    ? {
        state: 'same',
        text: t('assets:compare.same', { count: entry.count }),
        storeCount: entry.count,
      }
    : {
        state: 'differs',
        text: t('assets:compare.differs', { store: entry.count, repo: group.count }),
        storeCount: entry.count,
      };
}
