import type { StagedChangesView } from '../listing/staged-changes.ts';

/**
 * Staged counts and the ONE `unpushed` predicate (docs/state-model.md, "Single owners (core)"). "How many staged sets/files" was counted
 * with and without the already-pushed rows in eight places (tray text, Release Assets step, `stagedFacts`, `stagedUnpushedCount`, staged
 * marks, the Graphics tab, the cart, the server totals): "2 graphic sets (7 files)" in the tray while the cart and the nav badge said 0.
 *
 * UNPUSHED. A staged row still has to be pushed when it has never been pushed, or when it was pushed and then changed:
 * `pushed_hash IS NULL OR pushed_hash <> value_hash`. `pushed` of a view is the negation. Nothing else decides it.
 *
 * Counts come in two explicit families: `total*` (everything staged, pushed rows included: what the staging area holds) and `unpushed*`
 * (what a push would send: what the cart, the badge and "pending" mean). A screen picks the family by its question, never by accident.
 *
 * Pure. ES2017.
 */

/** Whether a staged row still has to be pushed (see the file comment). */
export const isUnpushed = (row: {
  pushedHash: string | null | undefined;
  valueHash: string;
}): boolean =>
  row.pushedHash === null || row.pushedHash === undefined || row.pushedHash !== row.valueHash;

export type StagedCounts = {
  totalTexts: number;
  totalSets: number;
  totalFiles: number;
  unpushedTexts: number;
  unpushedSets: number;
  unpushedFiles: number;
};

/**
 * The staged counts of a view, both families. A cleared set holds no files but is a set that a push changes. `scope.locale` counts the rows
 * of one locale only (the locales matrix' count per row).
 */
export function stagedCountsOf(
  view: Pick<StagedChangesView, 'text' | 'assets'> | null,
  scope: { locale?: string } = {},
): StagedCounts {
  const out: StagedCounts = {
    totalTexts: 0,
    totalSets: 0,
    totalFiles: 0,
    unpushedTexts: 0,
    unpushedSets: 0,
    unpushedFiles: 0,
  };
  if (view === null) return out;
  for (const t of view.text) {
    if (scope.locale !== undefined && t.locale !== scope.locale) continue;
    out.totalTexts += 1;
    if (!t.pushed) out.unpushedTexts += 1;
  }
  for (const a of view.assets) {
    if (scope.locale !== undefined && a.locale !== scope.locale) continue;
    out.totalSets += 1;
    out.totalFiles += a.files.length;
    if (!a.pushed) {
      out.unpushedSets += 1;
      out.unpushedFiles += a.files.length;
    }
  }
  return out;
}
