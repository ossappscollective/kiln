import type { CatalogEntry, InboxAlert, PersonalChannel, Preference } from './alerts.ts';
import { effectiveChannels } from './alerts.ts';

/**
 * Desktop notifications for alerts: the pure rules (docs/alerts.md#desktop-notifications). Which kinds the Alerts settings page lists,
 * whether this device shows notifications, which new alerts to show, and what a notification says. No browser API here; `alert-notify.ts`
 * shows the notification and `alert-store.svelte.ts` calls these. Written for the ES2017 web build.
 */

/** The kinds the "Desktop notifications" card offers, in this order. The server's per-person choice per type decides what is delivered. */
export const DESKTOP_KINDS = [
  'release.in_review',
  'release.approved',
  'release.rejected',
  'release.halted',
  'release.live',
  'release.stalled',
  'store.sync_failed',
  'review.sync_failed',
  'credential.invalid',
] as const;

/** The catalog entries to list, in `DESKTOP_KINDS` order: visible to this person, enabled, and allowed to use a desktop notification. */
export function desktopKindEntries(catalog: CatalogEntry[]): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const id of DESKTOP_KINDS) {
    const entry = catalog.filter((e) => e.id === id)[0];
    if (entry && entry.visible && entry.rule.enabled && entry.allowedChannels.indexOf('desktop') >= 0)
      out.push(entry);
  }
  return out;
}

/** Whether this person's choice for the type (all apps) includes a desktop notification. */
export function kindUsesDesktop(entry: CatalogEntry, prefs: Preference[]): boolean {
  return effectiveChannels(entry, prefs, entry.id, null).indexOf('desktop' as PersonalChannel) >= 0;
}

// ---------------------------------------------------------------------------------------------
// This device: on or off (a browser or the desktop app asks for its permission per device, so the switch is per device too).

export const DEVICE_KEY = 'mrm.alerts.desktop';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

/** The stored choice of this device: true, false, or null when the person never chose. Never throws. */
export function readDeviceChoice(storage: Storage | undefined): boolean | null {
  try {
    const raw = storage ? storage.getItem(DEVICE_KEY) : null;
    return raw === 'on' ? true : raw === 'off' ? false : null;
  } catch {
    return null;
  }
}

export function writeDeviceChoice(storage: Storage | undefined, on: boolean): void {
  try {
    if (storage) storage.setItem(DEVICE_KEY, on ? 'on' : 'off');
  } catch {
    // Storage blocked: the choice lasts until the page closes at most.
  }
}

/**
 * Whether this device shows notifications. An explicit choice wins. Without one it follows the permission, so a person who allowed
 * notifications before this switch existed keeps getting them.
 */
export function deviceEnabled(choice: boolean | null, permission: string): boolean {
  return choice === null ? permission === 'granted' : choice && permission === 'granted';
}

// ---------------------------------------------------------------------------------------------
// Which new alerts to show

/** Most notifications shown for one read; the rest are marked so they do not come later as a burst. */
export const MAX_PER_READ = 3;
export const MAX_SEEN = 200;

export type NotifyPlan = {
  /** Alerts to show now, newest first as given. */
  show: InboxAlert[];
  /** Ids to remember as handled (shown, or deliberately skipped): the alert never notifies again. */
  mark: string[];
};

/**
 * Which alerts of one inbox read become notifications. An alert qualifies when the server flagged it for desktop (the person's own
 * choice for its type, outside quiet hours), it is unread, it was last raised after this page opened (opening the app never replays old
 * news) and it was not handled before (one alert notifies once, even when it is raised again and its count grows). With the device
 * switch off nothing is shown, and the qualifying alerts are marked, so turning it on later does not replay them.
 */
export function planNotifications(input: {
  alerts: InboxAlert[];
  seen: string[];
  startedAt: number;
  deviceOn: boolean;
}): NotifyPlan {
  const fresh = input.alerts.filter(
    (a) => a.desktop && !a.read && a.lastAt >= input.startedAt && input.seen.indexOf(a.id) < 0,
  );
  if (fresh.length === 0) return { show: [], mark: [] };
  if (!input.deviceOn) return { show: [], mark: fresh.map((a) => a.id) };
  return { show: fresh.slice(0, MAX_PER_READ), mark: fresh.map((a) => a.id) };
}

/** The ids to keep after adding `more`: no duplicates, the newest `MAX_SEEN`. */
export function remember(seen: string[], more: string[]): string[] {
  const out = seen.slice();
  for (const id of more) if (out.indexOf(id) < 0) out.push(id);
  return out.slice(-MAX_SEEN);
}

/**
 * What a notification says: the alert's title and nothing else (no body, no store text, no review text), without control characters
 * and at most 140 characters. Empty when there is nothing to say.
 */
export function notificationTitle(alert: Pick<InboxAlert, 'title'>): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
  const clean = alert.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
}
