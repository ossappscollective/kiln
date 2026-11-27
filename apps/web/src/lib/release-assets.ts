import { type AssetCompareTotals, compareSentence } from '@kiln/core';
import { formatList } from './i18n/format.ts';
import { t } from './i18n/t.ts';

/**
 * The Assets step of "Prepare release": one plain sentence on whether the screenshots in the repository match what the store
 * shows, and how many graphic sets are staged. The comparison is the existing one (`GET /assets/diff`); nothing here reads or
 * writes anything. Written for the ES2017 web build.
 */

export type AssetsLine = { tone: 'ok' | 'warn' | 'neutral'; text: string; needsUpdate: boolean };

/**
 * The state of the screenshots against the store, from the totals of the comparison (null: not read). The structure (state, changes, tone)
 * is core's `compareSentence`; this only puts it in words.
 */
export function assetsLine(totals: AssetCompareTotals | null): AssetsLine {
  const sentence = compareSentence(totals);
  if (sentence.state === 'not_compared')
    return { tone: 'neutral', text: t('release-stepper:assetsLine.notCompared'), needsUpdate: false };
  if (sentence.state === 'nothing')
    return { tone: 'neutral', text: t('release-stepper:assetsLine.nothing'), needsUpdate: false };
  if (sentence.state === 'changed') {
    const parts: string[] = [];
    for (const c of sentence.changes)
      parts.push(
        c.status === 'differs'
          ? t('release-stepper:assetsLine.differs', { count: c.count })
          : t('release-stepper:assetsLine.onlyRepo', { count: c.count }),
      );
    return {
      tone: 'warn',
      text: t('release-stepper:assetsLine.changed', { changes: formatList(parts) }),
      needsUpdate: true,
    };
  }
  const text = [t('release-stepper:assetsLine.match')];
  for (const p of sentence.parts)
    if (p.status === 'only_store') text.push(t('release-stepper:assetsLine.onlyStore', { count: p.count }));
  return { tone: 'ok', text: text.join(' '), needsUpdate: false };
}

/** The count of staged graphic sets as a sentence. */
export function stagedSetsLine(sets: number, files: number): string {
  if (sets === 0) return t('release-stepper:stagedSets.none');
  return t('release-stepper:stagedSets.some', {
    count: sets,
    files: t('release-stepper:stagedSets.files', { count: files }),
  });
}
