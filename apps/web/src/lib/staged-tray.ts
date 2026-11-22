import { t } from './i18n/t.ts';
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
  if (input.loadFailed) return { tone: 'bad', text: t('publish:tray.loadFailed') };
  if (input.loading) return { tone: 'neutral', text: t('publish:tray.checking') };
  switch (input.availability) {
    case 'off':
      return { tone: 'info', text: t('publish:tray.pushOff') };
    case 'unknown':
      return { tone: 'info', text: t('publish:tray.pushUnknown') };
    case 'role':
      return { tone: 'info', text: t('publish:tray.pushRole') };
    default:
      return { tone: 'neutral', text: t('publish:staged.nothingStaged') };
  }
}
