import type { PushAvailability } from './staged.ts';

/**
 * The one line of the staged-changes tray while nothing is staged (the tray is a slim line then, and the
 * full tray with its notes and buttons only when there is something to push). Pure: it only words what the
 * screen already knows. It never changes what the tray allows.
 */

export type TrayLine = {
  /** `bad` for a failed load, `info` when pushing is switched off or not allowed, else `neutral`. */
  tone: 'neutral' | 'info' | 'bad';
  text: string;
};

export type TrayLineInput = {
  /** Staged items over every app in scope. */
  items: number;
  /** True until every app in scope has answered (a view or an error). */
  loading: boolean;
  /** Some app's staged changes could not be read. */
  loadFailed: boolean;
  availability: PushAvailability['state'];
};

/** True when the tray should be the full tray: there is something staged. */
export const trayIsFull = (input: Pick<TrayLineInput, 'items'>): boolean => input.items > 0;

export function trayLine(input: TrayLineInput): TrayLine {
  if (input.loadFailed) return { tone: 'bad', text: 'Could not load the staged changes' };
  if (input.loading) return { tone: 'neutral', text: 'Checking the staged changes…' };
  switch (input.availability) {
    case 'off':
      return { tone: 'info', text: 'Nothing staged. Pushing drafts is switched off' };
    case 'unknown':
      return { tone: 'info', text: 'Nothing staged. Could not check whether pushing drafts is on' };
    case 'role':
      return { tone: 'info', text: 'Nothing staged. Pushing needs the admin or owner role' };
    default:
      return { tone: 'neutral', text: 'Nothing staged' };
  }
}
