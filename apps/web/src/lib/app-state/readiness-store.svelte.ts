import { READINESS_FRESH_MS } from '@kiln/core';
import { type Api, ApiError } from '../api.ts';
import type { ReadinessFact, ReadinessReading } from './blockers.ts';

/**
 * The last reading of what blocks a submit NOW, per app (`GET /apps/:id/publish/readiness`: the server reads the store and judges it with the
 * pure rules of core; the browser owns none). It is the app-state store's fact: nothing else reads it. A reading is reused for 30 seconds
 * (the server keeps its own for the same time); `fresh` ("Check again", a sync, "Read again") asks the store again. A failed or refused
 * reading keeps the last good one and says why; it is never retried by itself inside the same 30 seconds.
 */
/** `READINESS_FRESH_MS` of `@kiln/core`'s timings: derived from the server's own TTL for the same reading. */
export const READING_FRESH_MS = READINESS_FRESH_MS;

type Entry = {
  reading: ReadinessReading | null;
  error: string | null;
  at: number;
  checking: number;
};

let version = $state(0);
const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<void>>();
const keyOf = (workspaceId: string, appId: string) => `${workspaceId}|${appId}`;

export const readinessStore = {
  /** The last reading of an app, whether one is on its way and why the last one failed; null when none was ever asked for. Reactive. */
  of(workspaceId: string, appId: string): ReadinessFact | null {
    void version;
    const e = entries.get(keyOf(workspaceId, appId));
    return e === undefined
      ? null
      : { reading: e.reading, checking: e.checking > 0, error: e.error };
  },

  /**
   * Reads it now, unless a reading younger than 30 seconds is kept (`options.fresh` always asks). One request per app at a time: a second caller
   * waits for the first. Never throws.
   */
  load(
    api: Api,
    workspaceId: string,
    appId: string,
    options: {
      fresh?: boolean;
      /** A kept reading made before this time (the end of the run it is held against) does not count. */
      notBefore?: number;
      now?: number;
    } = {},
  ): Promise<void> {
    const fresh = options.fresh === true;
    const now = options.now ?? Date.now();
    const key = keyOf(workspaceId, appId);
    const kept = entries.get(key);
    const current = kept?.reading != null && kept.reading.storeReadAt >= (options.notBefore ?? 0);
    if (!fresh && kept !== undefined && current && now - kept.at < READING_FRESH_MS)
      return Promise.resolve();
    // A reading of this app that failed is not repeated inside the same 30 seconds.
    if (
      !fresh &&
      kept !== undefined &&
      kept.reading === null &&
      kept.error !== null &&
      now - kept.at < READING_FRESH_MS
    )
      return Promise.resolve();
    const running = inFlight.get(key);
    if (running !== undefined && !fresh) return running;
    const entry: Entry = kept ?? { reading: null, error: null, at: 0, checking: 0 };
    entries.set(key, entry);
    entry.checking += 1;
    version += 1;
    const work = (async () => {
      try {
        const done = await api.publishReadiness(workspaceId, appId, fresh);
        const r = done.readiness;
        entry.reading = {
          ready: r.ready,
          blockers: r.blockers,
          unknown: r.unknown,
          versionString: r.versionString,
          storeReadAt: r.storeReadAt,
        };
        entry.error = null;
      } catch (e) {
        entry.error = e instanceof ApiError || e instanceof Error ? e.message : String(e);
      } finally {
        entry.at = Date.now();
        entry.checking -= 1;
        version += 1;
      }
    })();
    inFlight.set(key, work);
    const done = () => {
      if (inFlight.get(key) === work) inFlight.delete(key);
    };
    void work.then(done, done);
    return work;
  },

  /** The store changed under it (a publish): the last reading is no longer a fact. */
  forget(workspaceId: string, appId: string): void {
    entries.delete(keyOf(workspaceId, appId));
    version += 1;
  },

  /** For tests. */
  clear(): void {
    entries.clear();
    inFlight.clear();
    version += 1;
  },
};
