import type { Platform } from '@kiln/core';
import { t } from './i18n/t.ts';
import { type BadgeTone, latestRelease, platformRank, statusInfo } from './portfolio.ts';
import type { ReleaseSummary } from './types.ts';

/**
 * The status summary at the top of the left panel of an open app: one line per platform ("iOS  In review 2.9.0", "Android  Live
 * 2.8.1"). Pure; the releases are the ones the app screen already loaded (nothing is read for this).
 *
 * A platform line shows the newest release of that platform: a version that is live reads "Live 2.8.1"; a version on its way reads
 * with its state and version ("In review 2.9.0"). Nothing reported reads "Not synced yet" or "No release yet"; releases that are not
 * loaded yet draw a quiet "Reading".
 */

export type PlatformStatusLine = {
  platform: Platform;
  /** The state word: "Live", "In review", "Rejected", "Draft", "Not synced yet", "No release yet", "Reading". */
  label: string;
  /** The version the state is about; null when there is no release. */
  version: string | null;
  tone: BadgeTone;
  /** One sentence for assistive technology: "In review, version 2.9.0". */
  text: string;
};

export function platformStatusLines(
  members: readonly { id: string; platform: Platform; lastSyncedAt: number | null }[],
  releases: Readonly<Record<string, readonly ReleaseSummary[] | undefined>>,
): PlatformStatusLine[] {
  return [...members]
    .sort((a, b) => platformRank(a.platform) - platformRank(b.platform))
    .map((m): PlatformStatusLine => {
      const list = releases[m.id];
      if (list === undefined) {
        return {
          platform: m.platform,
          label: t('app:status.reading'),
          version: null,
          tone: 'neutral',
          text: t('app:status.readingText'),
        };
      }
      const latest = latestRelease(list, m.platform);
      if (latest === null) {
        const label =
          m.lastSyncedAt === null ? t('app:status.notSynced') : t('app:status.noRelease');
        return { platform: m.platform, label, version: null, tone: 'neutral', text: label };
      }
      const info = statusInfo(latest.status, latest.rawState);
      return {
        platform: m.platform,
        label: info.label,
        version: latest.version,
        tone: info.tone,
        text: t('app:status.line', { label: info.label, version: latest.version }),
      };
    });
}
