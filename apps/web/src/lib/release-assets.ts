import type { AssetCompareTotals } from '@mrm/core';

/**
 * The Assets step of "Prepare release": one plain sentence on whether the screenshots in the repository match what the store
 * shows, and how many graphic sets are staged. The comparison is the existing one (`GET /assets/diff`); nothing here reads or
 * writes anything. Written for the ES2017 web build.
 */

export type AssetsLine = { tone: 'ok' | 'warn' | 'neutral'; text: string; needsUpdate: boolean };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The state of the screenshots against the store, from the totals of the comparison (null: not read). */
export function assetsLine(totals: AssetCompareTotals | null): AssetsLine {
  if (totals === null) return { tone: 'neutral', text: 'The screenshots were not compared yet.', needsUpdate: false };
  const all = totals.identical + totals.likely_same + totals.differs + totals.only_repo + totals.only_store;
  if (all === 0) return { tone: 'neutral', text: 'Nothing to compare: neither the repository nor the store has screenshots for this app.', needsUpdate: false };
  const changed = totals.differs + totals.only_repo;
  if (changed > 0) {
    const parts: string[] = [];
    if (totals.differs > 0) parts.push(`${plural(totals.differs, 'screenshot differs', 'screenshots differ')} from the store`);
    if (totals.only_repo > 0) parts.push(`${plural(totals.only_repo, 'screenshot is', 'screenshots are')} only in the repository`);
    return { tone: 'warn', text: `${parts.join(' and ')}. If this release has new screenshots, stage them on the Assets tab.`, needsUpdate: true };
  }
  const extra = totals.only_store > 0 ? ` ${plural(totals.only_store, 'screenshot is', 'screenshots are')} only in the store.` : '';
  return { tone: 'ok', text: `The screenshots in the repository match the store.${extra}`, needsUpdate: false };
}

/** The count of staged graphic sets as a sentence. */
export function stagedSetsLine(sets: number, files: number): string {
  if (sets === 0) return 'No graphic sets are staged. The screenshots in the store stay as they are.';
  return `${plural(sets, 'graphic set is', 'graphic sets are')} staged (${plural(files, 'file', 'files')}). They go to the store draft with the rest.`;
}
