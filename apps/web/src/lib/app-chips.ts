import { timeAgo } from './format.ts';
import { t } from './i18n/t.ts';
import type { AppSummary } from './types.ts';

/**
 * The three "where does the data live" chips of an app header (docs/ux-ia.md section 3), for the
 * records in scope. Only what the app already knows is used; nothing is read from a store here.
 */

export type ChipTone = 'ok' | 'info' | 'neutral' | 'warn';
export type DataChip = {
  id: 'repository' | 'store_live' | 'store_draft';
  label: string;
  value: string;
  tone: ChipTone;
  /** What the chip means, for the tooltip. */
  title: string;
  /** True when the value is a stand-in until the data is read. */
  placeholder: boolean;
};

export function dataChips(apps: readonly AppSummary[], now: number): DataChip[] {
  const linked = apps.filter((a) => a.repositoryId !== null).length;
  const repo =
    apps.length === 0 || linked === 0
      ? { value: t('app:chips.notLinked'), tone: 'neutral' as ChipTone }
      : linked === apps.length
        ? { value: t('app:chips.linked'), tone: 'ok' as ChipTone }
        : {
            value: t('app:chips.linkedOn', { linked, total: apps.length }),
            tone: 'info' as ChipTone,
          };

  const synced = apps.map((a) => a.lastSyncedAt);
  const failed = apps.some((a) => (a.lastSyncError ?? '').trim() !== '');
  const never = apps.length === 0 || synced.some((s) => s === null);
  const oldest = never ? 0 : Math.min(...(synced as number[]));
  const live = failed
    ? { value: t('app:chips.lastSyncFailed'), tone: 'warn' as ChipTone }
    : never
      ? { value: t('app:chips.notSynced'), tone: 'neutral' as ChipTone }
      : { value: t('app:chips.synced', { when: timeAgo(oldest, now) }), tone: 'ok' as ChipTone };

  return [
    {
      id: 'repository',
      label: t('app:chips.repository'),
      ...repo,
      title: t('app:chips.repositoryTitle'),
      placeholder: false,
    },
    {
      id: 'store_live',
      label: t('app:chips.storeLive'),
      ...live,
      title: t('app:chips.storeLiveTitle'),
      placeholder: false,
    },
    {
      id: 'store_draft',
      label: t('app:chips.storeDraft'),
      value: t('app:chips.notRead'),
      tone: 'neutral',
      title: t('app:chips.storeDraftTitle'),
      placeholder: true,
    },
  ];
}
