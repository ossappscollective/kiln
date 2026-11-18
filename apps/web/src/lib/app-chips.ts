import { timeAgo } from './format.ts';
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
      ? { value: 'Not linked', tone: 'neutral' as ChipTone }
      : linked === apps.length
        ? { value: 'Linked', tone: 'ok' as ChipTone }
        : { value: `Linked on ${linked} of ${apps.length}`, tone: 'info' as ChipTone };

  const synced = apps.map((a) => a.lastSyncedAt);
  const failed = apps.some((a) => (a.lastSyncError ?? '').trim() !== '');
  const never = apps.length === 0 || synced.some((s) => s === null);
  const oldest = never ? 0 : Math.min(...(synced as number[]));
  const live = failed
    ? { value: 'Last sync failed', tone: 'warn' as ChipTone }
    : never
      ? { value: 'Not synced yet', tone: 'neutral' as ChipTone }
      : { value: `Synced ${timeAgo(oldest, now)}`, tone: 'ok' as ChipTone };

  return [
    {
      id: 'repository',
      label: 'Repository',
      ...repo,
      title: 'Files in the linked repository (fastlane metadata, images). The source for edits.',
      placeholder: false,
    },
    {
      id: 'store_live',
      label: 'Store live',
      ...live,
      title: 'What the store serves or reports now, as of the last sync.',
      placeholder: false,
    },
    {
      id: 'store_draft',
      label: 'Store draft',
      value: 'Not read yet',
      tone: 'neutral',
      title: 'The editable, unpublished version in the store. Not read by this tool yet.',
      placeholder: true,
    },
  ];
}
