import type { AssetCompareTotals } from '@kiln/core';
import { formatList } from './i18n/format.ts';
import { t } from './i18n/t.ts';

/**
 * The Assets step of "Prepare release": one plain sentence on whether the screenshots in the repository match what the store
 * shows, and how many graphic sets are staged. The comparison is the existing one (`GET /assets/diff`); nothing here reads or
 * writes anything. Written for the ES2017 web build.
 */

export type AssetsLine = { tone: 'ok' | 'warn' | 'neutral'; text: string; needsUpdate: boolean };

/** The state of the screenshots against the store, from the totals of the comparison (null: not read). */
export function assetsLine(totals: AssetCompareTotals | null): AssetsLine {
  if (totals === null)
    return {
      tone: 'neutral',
      text: t('release-stepper:assetsLine.notCompared'),
      needsUpdate: false,
    };
  const all =
    totals.identical + totals.likely_same + totals.differs + totals.only_repo + totals.only_store;
  if (all === 0)
    return {
      tone: 'neutral',
      text: t('release-stepper:assetsLine.nothing'),
      needsUpdate: false,
    };
  const changed = totals.differs + totals.only_repo;
  if (changed > 0) {
    const parts: string[] = [];
    if (totals.differs > 0)
      parts.push(t('release-stepper:assetsLine.differs', { count: totals.differs }));
    if (totals.only_repo > 0)
      parts.push(t('release-stepper:assetsLine.onlyRepo', { count: totals.only_repo }));
    return {
      tone: 'warn',
      text: t('release-stepper:assetsLine.changed', { changes: formatList(parts) }),
      needsUpdate: true,
    };
  }
  const text = [t('release-stepper:assetsLine.match')];
  if (totals.only_store > 0)
    text.push(t('release-stepper:assetsLine.onlyStore', { count: totals.only_store }));
  return {
    tone: 'ok',
    text: text.join(' '),
    needsUpdate: false,
  };
}

/** The count of staged graphic sets as a sentence. */
export function stagedSetsLine(sets: number, files: number): string {
  if (sets === 0) return t('release-stepper:stagedSets.none');
  return t('release-stepper:stagedSets.some', {
    count: sets,
    files: t('release-stepper:stagedSets.files', { count: files }),
  });
}
