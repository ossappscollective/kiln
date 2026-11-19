import { showNotification } from './alert-notify.ts';
import type { InboxAlert } from './alerts.ts';
import type { Api } from './api.ts';

/**
 * What the shell knows about alerts (docs/alerts.md): the unread count and the newest alerts for the bell, kept fresh by a slow poll
 * while the page is visible and on every return to it. A desktop notification is shown once per alert for the ones the server flags
 * (`desktop`: the person's own choices allow it outside quiet hours), and only for alerts that arrived after this page opened, so
 * opening the app never replays old news. A failed read keeps what there was; no screen needs it to work.
 */

const POLL_MS = 60_000;
const SEEN_KEY = 'mrm.alerts.notified';
const MAX_SEEN = 200;

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
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-MAX_SEEN)));
  } catch {
    // Storage is full or blocked: a notification may repeat, nothing else.
  }
};

async function notifyNew(alerts: InboxAlert[]): Promise<void> {
  const seen = readSeen();
  const fresh = alerts.filter(
    (a) => a.desktop && !a.read && a.lastAt >= startedAt && seen.indexOf(a.id) < 0,
  );
  if (fresh.length === 0) return;
  const done = seen.slice();
  for (const a of fresh.slice(0, 3)) {
    if (await showNotification(a.title, a.body)) done.push(a.id);
  }
  // Alerts beyond the first three are not announced one by one; they are marked so they do not appear later as a burst.
  for (const a of fresh.slice(3)) done.push(a.id);
  writeSeen(done);
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
