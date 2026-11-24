import { type StorageLike, browserStorage } from '../section-state.ts';

/** "Show events" on the charts, remembered per person in this browser (docs/adr/0053-timeline-and-reports.md). */
const PREFIX = 'kiln.timeline.markers';

/** One key per person, so two people on one browser keep their own choice. */
export const markersKey = (userId: string): string => `${PREFIX}.${userId}`;

/** The remembered choice of "Show events" on the charts; off when nothing was chosen or storage cannot be read. */
export function loadShowEvents(
  userId: string,
  store: StorageLike | null = browserStorage(),
): boolean {
  try {
    return store?.getItem(markersKey(userId)) === '1';
  } catch {
    return false;
  }
}

/** Remembers the choice; a failure (private mode, quota) is ignored: the toggle still works for this visit. */
export function saveShowEvents(
  userId: string,
  on: boolean,
  store: StorageLike | null = browserStorage(),
): void {
  try {
    (store as Storage | null)?.setItem(markersKey(userId), on ? '1' : '0');
  } catch {
    // Not remembered.
  }
}
