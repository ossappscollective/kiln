import type { AssetKind, Platform } from '@mrm/core';
import type { StoreCompare } from './assets.ts';
import type { AssetIndex } from './types.ts';

/**
 * The Assets tab in three groups (docs/ux-ia.md, design R5): the icon, the Google Play graphics and the
 * screenshots, and the status of a file next to the store. Pure functions, no DOM and no fetch.
 * Written for the ES2017 web build.
 */

export type AssetGroupId = 'icon' | 'play_graphics' | 'screenshots';

export type AssetGroupDef = {
  id: AssetGroupId;
  label: string;
  kinds: AssetKind[];
  /** The only platform that has this group, or null for both. */
  platform: Platform | null;
  hint: string;
};

export const ASSET_GROUPS: readonly AssetGroupDef[] = [
  { id: 'icon', label: 'Icon', kinds: ['icon', 'app_icon'], platform: null, hint: 'The app icon of the project and the store icon.' },
  {
    id: 'play_graphics',
    label: 'Google Play graphics',
    kinds: ['feature_graphic', 'promo_graphic', 'tv_banner'],
    platform: 'android',
    hint: 'Feature graphic, promo graphic and TV banner (Android only).',
  },
  { id: 'screenshots', label: 'Screenshots', kinds: ['screenshot', 'preview'], platform: null, hint: 'Screenshots and app previews, by locale and device.' },
];

/** A tab id as a group id (anything unknown is the screenshots). */
export const asGroupId = (id: string): AssetGroupId => (ASSET_GROUPS.some((g) => g.id === id) ? (id as AssetGroupId) : 'screenshots');

export const groupDef = (id: AssetGroupId): AssetGroupDef => ASSET_GROUPS.filter((g) => g.id === id)[0] as AssetGroupDef;

export function groupOfKind(kind: AssetKind): AssetGroupId {
  for (const g of ASSET_GROUPS) if (g.kinds.indexOf(kind) >= 0) return g.id;
  return 'screenshots';
}

/** Whether this app record's store has the group. A group that does not apply says why. */
export function groupAvailability(id: AssetGroupId, platform: Platform): { available: boolean; reason: string | null } {
  const def = groupDef(id);
  if (def.platform !== null && def.platform !== platform) {
    return { available: false, reason: `${def.label} exist on ${def.platform === 'android' ? 'Google Play' : 'the App Store'} only. This record is on ${platform === 'android' ? 'Google Play' : 'the App Store'}.` };
  }
  return { available: true, reason: null };
}

/** The assets, sets and problems of one group, in the shape `groupAssets` and `filterOptions` take. */
export function sliceIndex(index: Pick<AssetIndex, 'assets' | 'sets' | 'problems'>, id: AssetGroupId): Pick<AssetIndex, 'assets' | 'sets' | 'problems'> {
  const kinds = groupDef(id).kinds;
  const assets = index.assets.filter((a) => kinds.indexOf(a.kind) >= 0);
  const paths: Record<string, true> = {};
  for (const a of assets) paths[a.path] = true;
  return {
    assets,
    sets: index.sets.filter((s) => kinds.indexOf(s.kind) >= 0),
    problems: index.problems.filter((p) => (p.path ? paths[p.path] === true : p.kind !== undefined && kinds.indexOf(p.kind) >= 0)),
  };
}

export type GroupSummary = {
  id: AssetGroupId;
  label: string;
  files: number;
  errors: number;
  warnings: number;
  available: boolean;
  reason: string | null;
};

export function groupSummaries(index: Pick<AssetIndex, 'assets' | 'sets' | 'problems'>, platform: Platform): GroupSummary[] {
  return ASSET_GROUPS.map((g) => {
    const slice = sliceIndex(index, g.id);
    const a = groupAvailability(g.id, platform);
    let errors = 0;
    let warnings = 0;
    for (const p of slice.problems) {
      if (p.severity === 'error') errors += 1;
      else if (p.severity === 'warning') warnings += 1;
    }
    return { id: g.id, label: g.label, files: slice.assets.length, errors, warnings, available: a.available, reason: a.reason };
  });
}

/** The group to show first: the screenshots when there are any, else the first group with files, else the screenshots. */
export function defaultGroup(summaries: readonly GroupSummary[]): AssetGroupId {
  const withFiles = summaries.filter((s) => s.available && s.files > 0);
  const shots = withFiles.filter((s) => s.id === 'screenshots')[0];
  return (shots ?? withFiles[0])?.id ?? 'screenshots';
}

// ---------------------------------------------------------------------------------------------
// Status of a file next to the store

export type StoreStatus = {
  id: 'in_repo' | 'in_both' | 'differs';
  label: string;
  tone: 'neutral' | 'ok' | 'warn';
  title: string;
};

/**
 * The store status of the files of a set, from the set's comparison. The store side is counts per set
 * (not files), so every file of a set carries the status of its set; until the listing reads supply the
 * counts the honest answer is "In repo", with the title saying it was not compared.
 */
export function storeStatusOf(compare: StoreCompare): StoreStatus {
  if (compare.state === 'same') return { id: 'in_both', label: 'In repo and store', tone: 'ok', title: compare.text };
  if (compare.state === 'differs') return { id: 'differs', label: 'Differs from store', tone: 'warn', title: compare.text };
  return { id: 'in_repo', label: 'In repo', tone: 'neutral', title: `In the repository. ${compare.text}.` };
}

/** Files the store has that the repository does not (the store count is higher), or 0. */
export function storeOnlyCount(compare: StoreCompare, repoCount: number): number {
  return compare.state === 'differs' && compare.storeCount > repoCount ? compare.storeCount - repoCount : 0;
}
