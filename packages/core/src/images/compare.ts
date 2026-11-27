import {
  type AssetCompareRow,
  type AssetCompareStatus,
  type AssetCompareTotals,
  compareFile,
  compareTotals,
  type RepoSideFile,
  type StoreImageFile,
} from '../listing/asset-sync.ts';
import type { DisplaySet, StoreGroup } from './groups.ts';

/**
 * The comparison of the repository's images with the store's, for display and for PULL (docs/state-model.md, "Single owners (core)").
 *
 * THE DEFECT THIS REPLACES. `compareSet` pairs by array index and numbers the row `position = i + 1`, but the store position of an image in
 * a SIBLING group continues the display's counter (11, 12 after the primary group's 10). The web built `${setKey}#${row.position}` and the
 * pull resolved it by the STORE position, so "Pull this image" on a sibling group pulled another image, and the pull of a whole display kept
 * the LAST sibling and skipped the primary group. Now every row carries what the store call needs (`storeRef`, `storePosition`, `group`) and a
 * pull selects by `storeRef`, never by an index. The row's `index` is the place in the comparison, nothing else.
 *
 * Pure. ES2017.
 */

export type CompareRow = AssetCompareRow & {
  /** 0-based place in the comparison of this group (the pairing key; NEVER a store address). */
  index: number;
  /** The store's group the row's store image sits in. */
  group: string | null;
  /** The opaque ref of the store image: what a pull and a removal select by. Null: nothing in the store at this place. */
  storeRef: string | null;
  /** The store's own position of the image (continues across sibling groups). Null: nothing in the store. */
  storePosition: number | null;
};

/**
 * Pairs the repository's files of a set with the images of ONE store group, in order, and compares each pair. `position` is `index + 1`
 * (kept for the existing table); `storeRef` and `storePosition` come from the store image.
 */
export function compareRows(
  repo: readonly RepoSideFile[],
  group: { target: string | null; files: readonly StoreImageFile[] } | null,
): CompareRow[] {
  const files = group === null ? [] : group.files;
  const rows: CompareRow[] = [];
  const n = Math.max(repo.length, files.length);
  for (let i = 0; i < n; i++) {
    const r = repo[i] ?? null;
    const s = files[i] ?? null;
    const c = compareFile(r, s);
    rows.push({
      index: i,
      position: i + 1,
      status: c.status,
      repo: r,
      store: s,
      reason: c.reason,
      group: group === null ? null : group.target,
      storeRef: s === null ? null : s.ref,
      storePosition: s === null ? null : s.position,
    });
  }
  return rows;
}

export type DisplayComparison = {
  /** The rows against the PRIMARY group (the one Kiln compares with and pushes to). */
  rows: CompareRow[];
  /** Every other group of the display: nothing in the repository corresponds to it, so each image is `only_store`. */
  siblings: { group: string; rows: CompareRow[] }[];
  /** Over the primary rows and the sibling rows. */
  totals: AssetCompareTotals;
  /** Primary rows are all identical or probably the same, and no sibling holds an image. */
  inSync: boolean;
};

/** The comparison of one display: the primary group against the repository, siblings listed as store-only. */
export function compareDisplay(
  repo: readonly RepoSideFile[],
  display: DisplaySet | null,
): DisplayComparison {
  if (display === null) {
    const rows = compareRows(repo, null);
    return { rows, siblings: [], totals: compareTotals(rows), inSync: rows.length === 0 };
  }
  const rows = compareRows(repo, display.primaryGroup);
  const siblings = display.groups
    .filter((g: StoreGroup) => g !== display.primaryGroup)
    .map((g) => ({ group: g.target, rows: compareRows([], g) }));
  const all: { status: AssetCompareStatus }[] = rows.slice();
  for (const s of siblings) for (const r of s.rows) all.push(r);
  const totals = compareTotals(all);
  return {
    rows,
    siblings,
    totals,
    inSync: totals.differs + totals.only_repo + totals.only_store === 0,
  };
}

/** What a pull of ONE compared row asks the store for: its image ref. Null when the store holds nothing there (nothing to pull). */
export const pullRefOf = (row: Pick<CompareRow, 'storeRef'>): string | null => row.storeRef;

/** What a pull of a whole display asks for: every image of EVERY group, in the merged order (never one sibling only). */
export const pullRefsOfDisplay = (display: DisplaySet): string[] => display.files.map((f) => f.ref);

// ---------------------------------------------------------------------------------------------
// The sentence

export type CompareSentence = {
  /** `not_compared` (no totals), `nothing` (no image either side), `changed` (differs or only in the repository), `match`. */
  state: 'not_compared' | 'nothing' | 'changed' | 'match';
  /** Every non-zero status in the fixed order identical, likely_same, differs, only_repo, only_store: the words a screen translates. */
  parts: { status: AssetCompareStatus; count: number }[];
  /** Only the changes a push would make: `differs` and `only_repo`. */
  changes: { status: AssetCompareStatus; count: number }[];
  /** The release step asks for an update (something differs or is only in the repository). */
  needsUpdate: boolean;
  tone: 'neutral' | 'warn' | 'ok';
  /** English text of `parts`: "3 identical, 1 differs". Empty when there is nothing. */
  text: string;
};

const ORDER: AssetCompareStatus[] = [
  'identical',
  'likely_same',
  'differs',
  'only_repo',
  'only_store',
];
const WORDS: Record<AssetCompareStatus, (n: number) => string> = {
  identical: (n) => `${n} identical`,
  likely_same: (n) => `${n} probably the same`,
  differs: (n) => `${n} ${n === 1 ? 'differs' : 'differ'}`,
  only_repo: (n) => `${n} only in the repository`,
  only_store: (n) => `${n} only in the store`,
};

/**
 * THE sentence for a set of totals (it was written three times: core `compareText`, web `compareSummary` and `assetsLine`). The structure
 * (`state`, `parts`, `changes`, `tone`, `needsUpdate`) is what every screen reads; `text` is the English wording (`compareText`).
 */
export function compareSentence(totals: AssetCompareTotals | null): CompareSentence {
  if (totals === null)
    return {
      state: 'not_compared',
      parts: [],
      changes: [],
      needsUpdate: false,
      tone: 'neutral',
      text: '',
    };
  const parts = ORDER.filter((s) => totals[s] > 0).map((status) => ({
    status,
    count: totals[status],
  }));
  const changes = parts.filter((p) => p.status === 'differs' || p.status === 'only_repo');
  const text = parts.map((p) => WORDS[p.status](p.count)).join(', ');
  if (parts.length === 0)
    return { state: 'nothing', parts, changes, needsUpdate: false, tone: 'neutral', text };
  if (changes.length > 0)
    return { state: 'changed', parts, changes, needsUpdate: true, tone: 'warn', text };
  return { state: 'match', parts, changes, needsUpdate: false, tone: 'ok', text };
}
