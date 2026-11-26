import { READ_FROM_CI_MAX, type ReadFromCi } from './builds.ts';
import { t } from './i18n/t.ts';

/**
 * The words of "Read build info from CI" in Prepare release (the loader itself is `readRecentCiBuilds` in builds.ts, shared with the
 * Test builds page). Pure: a result in, sentences out.
 */

/** "Reading 2 of 5…". */
export function readProgressText(progress: { index: number; total: number }): string {
  return t('release-stepper:cir.progress', { index: progress.index, total: progress.total });
}

/** The hover text of the button. */
export const readHintText = (): string => t('release-stepper:cir.hint', { max: READ_FROM_CI_MAX });

export type ReadOutcomeText = { tone: 'ok' | 'warn'; text: string };

/** What to say when the reading ended: how many were read, or exactly why it stopped (never just "failed"). */
export function readOutcomeText(r: ReadFromCi): ReadOutcomeText {
  if (r.problem === 'list') return { tone: 'warn', text: t('release-stepper:cir.failed') };
  if (r.problem === 'off') return { tone: 'warn', text: t('release-stepper:cir.off') };
  if (r.stopped === 403) return { tone: 'warn', text: t('release-stepper:cir.stop403') };
  if (r.stopped === 409) return { tone: 'warn', text: t('release-stepper:cir.stop409') };
  if (r.stopped === 429) return { tone: 'warn', text: t('release-stepper:cir.stop429') };
  if (r.total === 0) return { tone: 'ok', text: t('release-stepper:cir.nothing') };
  const done = t('release-stepper:cir.done', { read: r.read, total: r.total });
  return r.failed > 0
    ? { tone: 'warn', text: `${done} ${t('release-stepper:cir.skipped', { failed: r.failed })}` }
    : { tone: 'ok', text: done };
}
