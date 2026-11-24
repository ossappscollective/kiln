// ONE invalidation for everything that shows "what is staged": a stage, an unstage, a discard (in the cart or elsewhere) and a publish
// announce it here, and a single listener in the app shell reads the staged and pending state of those apps again. The listing matrix,
// the locale panel, the Graphics tab, the cart, the overview hint and the release pages all read `stagedStore` and `pendingStore`, so
// they follow without knowing who changed what. The server is the source of truth: the listener only re-reads.

export const STAGED_CHANGED_EVENT = 'kiln:staged-changed';

export type StagedChangeReason = 'stage' | 'unstage' | 'discard' | 'publish';
export type StagedChangedDetail = { appId: string; reason: StagedChangeReason };

type Target = Pick<EventTarget, 'dispatchEvent'>;
type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

const windowOrNull = () => (typeof window === 'undefined' ? null : window);

/** Tells every screen that what is staged for this app record changed. Safe where there is no window (tests, servers). */
export function announceStagedChanged(
  appId: string,
  reason: StagedChangeReason,
  target: Target | null = windowOrNull(),
): void {
  target?.dispatchEvent(
    new CustomEvent<StagedChangedDetail>(STAGED_CHANGED_EVENT, { detail: { appId, reason } }),
  );
}

/** Calls `handler` for each announcement. Returns the function that stops listening. */
export function onStagedChanged(
  handler: (detail: StagedChangedDetail) => void,
  target: Listenable | null = windowOrNull(),
): () => void {
  if (target === null) return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<StagedChangedDetail | undefined>).detail;
    if (detail && typeof detail.appId === 'string') handler(detail);
  };
  target.addEventListener(STAGED_CHANGED_EVENT, listener);
  return () => target.removeEventListener(STAGED_CHANGED_EVENT, listener);
}

/**
 * Collects the app ids of announcements that arrive close together (a cart publish of three apps, a stage and its follow-up) and runs
 * `run` ONCE with the distinct ids. `schedule` is the timer (injectable for tests). `cancel` drops what is waiting.
 */
export function batchAppIds(
  run: (appIds: string[]) => void,
  schedule: (fn: () => void) => () => void = (fn) => {
    const handle = setTimeout(fn, 120);
    return () => clearTimeout(handle);
  },
): { add: (appId: string) => void; cancel: () => void } {
  let waiting = new Set<string>();
  let stop: (() => void) | null = null;
  return {
    add(appId) {
      waiting.add(appId);
      if (stop === null)
        stop = schedule(() => {
          const ids = [...waiting];
          waiting = new Set();
          stop = null;
          run(ids);
        });
    },
    cancel() {
      stop?.();
      stop = null;
      waiting = new Set();
    },
  };
}
