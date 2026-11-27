/**
 * The dev-mode consistency assertion (docs/state-model.md, "Consistency contract").
 *
 * A surface that DRAWS a fact tells the monitor what it draws:
 *
 *     import { reportShown } from '../../lib/app-state/dev-assert.ts';
 *     $effect(() => reportShown('pendingCount', appState.pendingCount, 'pendingCartDrawer'));
 *     $effect(() => reportShown(`liveVersion:${record.id}`, live?.version ?? null, 'appDashboardTiles'));
 *
 * In development (`import.meta.env.DEV`) the monitor collects what every surface reported in one tick (a macrotask: a whole render pass).
 * When two surfaces reported DIFFERENT values for one fact key in that tick it logs `console.error` naming both surfaces and values, keeps
 * the conflict, and `window.__kilnConsistency()` returns what the surfaces last reported and every conflict seen so far (an e2e or screenshots
 * run can assert it is empty). In production `reportShown` returns at once: no allocation, no timer, no `window` property.
 *
 * The fact keys and surface ids are the ones of `projections.ts` (the same names the consistency test compares), so a console error and a
 * failing test speak of the same thing. A surface reports ONLY what it shows; one that shows nothing for a fact reports nothing.
 * No import: any component may depend on it without a cycle.
 */

export type ShownValue = string | number | boolean | null | readonly string[];

export type Conflict = {
  factKey: string;
  /** What each surface showed in that tick. */
  shown: { surfaceId: string; value: ShownValue }[];
  tick: number;
};

export type ConsistencyReport = {
  /** The value each surface reported last, by fact key. */
  latest: Record<string, Record<string, ShownValue>>;
  conflicts: Conflict[];
  /** The fact keys whose LAST reported values (whatever the tick) differ across surfaces, now. */
  disagreeingNow: string[];
};

export type MonitorOptions = {
  enabled: boolean;
  /** Runs `flush` once, after the current render pass (default: `setTimeout(0)`). */
  schedule?: (flush: () => void) => void;
  log?: (message: string, conflict: Conflict) => void;
  /** Where `__kilnConsistency` is put (default: `window`, when there is one). */
  expose?: (read: () => ConsistencyReport) => void;
};

const canon = (v: ShownValue): string =>
  Array.isArray(v) ? JSON.stringify([...(v as readonly string[])].sort()) : JSON.stringify(v);

export type Monitor = {
  reportShown(factKey: string, value: ShownValue, surfaceId: string): void;
  report(): ConsistencyReport;
  reset(): void;
};

export function createMonitor(options: MonitorOptions): Monitor {
  const schedule = options.schedule ?? ((flush) => void setTimeout(flush, 0));
  const log =
    options.log ??
    ((message: string) => {
      console.error(message);
    });
  const thisTick = new Map<string, Map<string, ShownValue>>();
  const latest = new Map<string, Map<string, ShownValue>>();
  const conflicts: Conflict[] = [];
  const seen = new Set<string>();
  let tick = 0;
  let scheduled = false;
  let exposed = false;

  const disagreeing = (shown: Map<string, ShownValue>): boolean =>
    new Set([...shown.values()].map(canon)).size > 1;

  const read = (): ConsistencyReport => {
    const out: ConsistencyReport['latest'] = {};
    const now: string[] = [];
    for (const [key, shown] of latest) {
      out[key] = Object.fromEntries(shown);
      if (disagreeing(shown)) now.push(key);
    }
    return { latest: out, conflicts: conflicts.slice(), disagreeingNow: now.sort() };
  };

  const flush = () => {
    scheduled = false;
    tick += 1;
    for (const [factKey, shown] of thisTick) {
      if (!disagreeing(shown)) continue;
      const conflict: Conflict = {
        factKey,
        shown: [...shown].map(([surfaceId, value]) => ({ surfaceId, value })),
        tick,
      };
      const signature = `${factKey}\u0000${conflict.shown
        .map((s) => `${s.surfaceId}=${canon(s.value)}`)
        .sort()
        .join('\u0000')}`;
      if (seen.has(signature)) continue; // the same disagreement is said once, not on every render
      seen.add(signature);
      conflicts.push(conflict);
      log(
        `[kiln consistency] ${factKey}: ${conflict.shown.map((s) => `${s.surfaceId} shows ${JSON.stringify(s.value)}`).join(', ')}. One fact, one definition: read it from the app-state model.`,
        conflict,
      );
    }
    thisTick.clear();
  };

  return {
    reportShown(factKey, value, surfaceId) {
      if (!options.enabled) return;
      if (!exposed) {
        exposed = true;
        if (options.expose) options.expose(read);
        else if (typeof window !== 'undefined')
          (window as unknown as { __kilnConsistency?: () => ConsistencyReport }).__kilnConsistency =
            read;
      }
      const mine = thisTick.get(factKey) ?? new Map<string, ShownValue>();
      mine.set(surfaceId, value);
      thisTick.set(factKey, mine);
      const last = latest.get(factKey) ?? new Map<string, ShownValue>();
      last.set(surfaceId, value);
      latest.set(factKey, last);
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
    report: read,
    reset() {
      thisTick.clear();
      latest.clear();
      conflicts.length = 0;
      seen.clear();
      scheduled = false;
    },
  };
}

const dev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
const monitor = createMonitor({ enabled: dev });

/** A surface reports what it draws. Development only: in production it returns at once. */
export function reportShown(factKey: string, value: ShownValue, surfaceId: string): void {
  if (!dev) return;
  monitor.reportShown(factKey, value, surfaceId);
}

/** The monitor of this page (development): what the tests and a console read. */
export const consistencyMonitor: Monitor = monitor;
