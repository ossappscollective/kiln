import type { AppSection } from './app-scope.ts';
import { type PendingLine, chipFor } from './pending.ts';

/**
 * Small pure helpers of the slim page header of an app: the pending bar and the dot of the Status button.
 */

export type PendingBar = {
  /** "3 changes waiting. Nothing is published until you review them." */
  text: string;
  /** The one button. */
  action: string;
  /** An error blocks one of the changes (warning tone with an icon); otherwise a quiet strip. */
  blocking: boolean;
};

/**
 * The bar under the header when an app has changes waiting. Null (nothing is drawn) when none is pending, when only the store has
 * to act (in review) or when the pending page itself is open: that page is the review.
 */
export function pendingBar(line: PendingLine | null | undefined, section: AppSection): PendingBar | null {
  if (section === 'pending') return null;
  const chip = chipFor(line);
  if (!chip || !line) return null;
  const n = line.count > 0 ? line.count : line.blocking;
  return {
    text: `${n > 99 ? '99+' : n} ${n === 1 ? 'change' : 'changes'} waiting. Nothing is published until you review them.`,
    action: 'Review and publish',
    blocking: line.blocking > 0,
  };
}

export type StatusDot = 'warn' | 'ok' | 'neutral';

/** The dot on the Status button: a failed sync is a warning; every record synced is fine; otherwise nothing is known yet. */
export function statusDot(apps: readonly { lastSyncedAt: number | null; lastSyncError: string | null }[]): StatusDot {
  if (apps.some((a) => (a.lastSyncError ?? '').trim() !== '')) return 'warn';
  if (apps.length > 0 && apps.every((a) => a.lastSyncedAt !== null)) return 'ok';
  return 'neutral';
}

/** The name of the window event that opens the Status popover of the app header (the one place that holds "Sync now"). */
export const OPEN_STATUS_EVENT = 'mrm:open-status';

/**
 * Opens the Status popover from a page, for the pages that used to carry a second Sync button ("Open Status to sync"). Returns false
 * when there is no window (tests, server rendering) or nothing listened.
 */
export function openStatusPopover(target: Pick<EventTarget, 'dispatchEvent'> | null = typeof window === 'undefined' ? null : window): boolean {
  if (target === null) return false;
  return target.dispatchEvent(new Event(OPEN_STATUS_EVENT, { cancelable: true })) === false;
}
