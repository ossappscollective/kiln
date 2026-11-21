import type { Api } from '../api.ts';
import type { InboxAlert } from './alerts.ts';
import {
  deviceEnabled,
  notificationTitle,
  planNotifications,
  readDeviceChoice,
  remember,
} from './desktop.ts';
import { notificationState, showNotification } from './notify.ts';

/**
 * What the shell knows about alerts (docs/alerts.md): the unread count and the newest alerts for the bell, kept fresh by a slow poll
 * while the page is visible and on every return to it. A desktop notification (title only) is shown once per alert for the ones the server flags
 * (`desktop`: the person's own choices allow it outside quiet hours), when this device has them on, and only for alerts that arrived
 * after this page opened, so opening the app never replays old news. The rules are in alert-desktop.ts. A failed read keeps what there was; no screen needs it to work.
 */

const POLL_MS = 60_000;
const SEEN_KEY = 'kiln.alerts.notified';

let unread = $state(0);
let items = $state<InboxAlert[]>([]);
let loaded = $state(false);
let timer: ReturnType<typeof setInterval> | undefined;
let startedAt = 0;
let generation = 0;

const readSeen = (): string[] => {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const writeSeen = (ids: string[]) => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SEEN_KEY, JSON.stringify(ids));
  } catch {
    // Storage is full or blocked: a notification may repeat, nothing else.
  }
};

/** What the last read did about desktop notifications: said on the Alerts settings page after "Try it", so a silent failure is not a mystery. */
export type NotifyOutcome =
  | 'shown' // handed to the browser or the desktop shell (the system may still hide it: Focus, notification settings)
  | 'refused' // the browser or shell would not show it (permission, unsupported)
  | 'device_off' // this device's switch is off (or permission not granted)
  | 'nothing_new'; // no new unread alert flagged for a desktop notification

let lastOutcome = $state<NotifyOutcome | null>(null);

async function notifyNew(alerts: InboxAlert[]): Promise<void> {
  const seen = readSeen();
  const choice = readDeviceChoice(typeof localStorage === 'undefined' ? undefined : localStorage);
  const permission = await notificationState();
  const deviceOn = deviceEnabled(choice, permission);
  const plan = planNotifications({ alerts, seen, startedAt, deviceOn });
  if (plan.mark.length === 0) {
    lastOutcome = 'nothing_new';
    return;
  }
  // An alert is marked even when its notification could not be shown (blocked, unsupported): it is not retried every minute.
  let shown = 0;
  for (const a of plan.show) if (await showNotification(notificationTitle(a))) shown++;
  lastOutcome = !deviceOn ? 'device_off' : shown > 0 ? 'shown' : 'refused';
  writeSeen(remember(seen, plan.mark));
}

export const alertStore = {
  get unread() {
    return unread;
  },
  get items() {
    return items;
  },
  get loaded() {
    return loaded;
  },
  /** What the last read did about desktop notifications (null before the first read). */
  get notifyOutcome() {
    return lastOutcome;
  },

  /** Reads the newest alerts and the count. Never throws. */
  async refresh(api: Api, workspaceId: string): Promise<void> {
    const mine = ++generation;
    try {
      const page = await api.alertInbox(workspaceId, { limit: 8 });
      if (mine !== generation) return;
      unread = page.unreadCount;
      items = page.alerts;
      loaded = true;
      await notifyNew(page.alerts);
    } catch {
      // Keep what there was.
    }
  },

  /** Starts polling for a workspace; returns the function that stops it. */
  start(api: Api, workspaceId: string): () => void {
    this.stop();
    startedAt = Date.now();
    unread = 0;
    items = [];
    loaded = false;
    const tick = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible')
        void this.refresh(api, workspaceId);
    };
    tick();
    timer = setInterval(tick, POLL_MS);
    const onVisible = () => tick();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', onVisible);
      this.stop();
    };
  },

  stop(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    generation++;
  },

  /** After the person read some alerts elsewhere (the Alerts screen): take the new count. */
  setUnread(n: number): void {
    unread = n;
  },
};
