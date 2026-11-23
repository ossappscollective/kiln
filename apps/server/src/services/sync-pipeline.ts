// The shared plumbing of the store sync pipeline (docs/adr/0050-sync-pipeline.md).
//
// Adapted from Open Screenshot Generator (MIT), see THIRD_PARTY_NOTICES.md: worker pools of a few,
// independent feeds that fail alone, critical feeds first.
//
// What lives here, and nothing else:
// - `mapPool`: bounded concurrency over a list, every item settled, results in input order;
// - `createHostGate`: one limit on requests in flight per store host (Apple and Google apart),
//   and a shared pause when a store answers 429 with Retry-After, so parallel work never turns
//   into a burst the store would refuse;
// - `credentialLane`: how many reads of one credential run at once (it replaces "one at a time");
// - `syncActivity`: which feeds are being read right now, for the "what is syncing" indicator.

/** Runs `task` for every item with at most `limit` at once. Never throws: each outcome is in the result, in input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  await Promise.all(Array.from({ length: items.length === 0 ? 0 : width }, worker));
  return results;
}

/**
 * Starts `read` for the next `ahead` items while the caller handles the earlier ones in order: the downloads overlap, the
 * handling (and its writes) stays in sequence. A read that fails is thrown at its own turn, never as an unhandled rejection.
 */
export async function* readAhead<T, R>(
  items: readonly T[],
  ahead: number,
  read: (item: T) => Promise<R>,
): AsyncGenerator<{ item: T; result: R }> {
  const started: Promise<R>[] = [];
  const start = (index: number) => {
    if (index < items.length && started[index] === undefined) {
      const promise = read(items[index] as T);
      promise.catch(() => undefined);
      started[index] = promise;
    }
  };
  const width = Math.max(1, Math.trunc(ahead) || 1);
  for (let i = 0; i < items.length; i++) {
    for (let j = i; j < i + width; j++) start(j);
    yield { item: items[i] as T, result: await (started[i] as Promise<R>) };
  }
}

export class Semaphore {
  readonly limit: number;
  #free: number;
  #waiting: Array<() => void> = [];
  /** The most holders there were at one moment. */
  peak = 0;
  inFlight = 0;

  constructor(limit: number) {
    this.limit = Math.max(1, Math.trunc(limit) || 1);
    this.#free = this.limit;
  }

  async acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free--;
      this.inFlight++;
      if (this.inFlight > this.peak) this.peak = this.inFlight;
    } else {
      // A releasing holder hands its slot straight over, so the count never dips below the real holders.
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
  }

  release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else {
      this.inFlight--;
      this.#free++;
    }
  }

  get waiting(): number {
    return this.#waiting.length;
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await job();
    } finally {
      this.release();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Per host limits and the shared 429 pause

export type HostGroup = 'apple' | 'google';

/** The store host a URL belongs to, or undefined for any other host (which is never gated). */
export function hostGroupOf(input: string | URL | Request): HostGroup | undefined {
  let host: string;
  try {
    host = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host === 'appstoreconnect.apple.com' || host.endsWith('.appstoreconnect.apple.com')) return 'apple';
  if (host === 'googleapis.com' || host.endsWith('.googleapis.com')) return 'google';
  return undefined;
}

/** Seconds from a Retry-After header (delta seconds or an HTTP date); undefined when absent or unreadable. */
export function retryAfterSeconds(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - nowMs) / 1000));
}

export const DEFAULT_HOST_LIMITS: Record<HostGroup, number> = { apple: 4, google: 4 };
/** The longest a gate holds every request of a host after one 429. A longer Retry-After is still passed on to the caller. */
export const MAX_COOLDOWN_MS = 120_000;
/** Pause used when a 429 carries no Retry-After. */
export const DEFAULT_COOLDOWN_MS = 5_000;

export type HostGateOptions = {
  limits?: Partial<Record<HostGroup, number>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxCooldownMs?: number;
};

export type HostGate = {
  /** The same `fetch`, with store requests held to the limits. Other hosts pass straight through. */
  wrap(base: typeof fetch): typeof fetch;
  stats(): Record<HostGroup, { inFlight: number; peak: number; limit: number; pausedUntil: number }>;
};

const abortError = () => new DOMException('The sync was stopped', 'AbortError');

export function createHostGate(options: HostGateOptions = {}): HostGate {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxCooldown = options.maxCooldownMs ?? MAX_COOLDOWN_MS;
  const limits = { ...DEFAULT_HOST_LIMITS, ...options.limits };
  const gates: Record<HostGroup, Semaphore> = { apple: new Semaphore(limits.apple), google: new Semaphore(limits.google) };
  const pausedUntil: Record<HostGroup, number> = { apple: 0, google: 0 };

  const pause = async (group: HostGroup, signal: AbortSignal | null | undefined) => {
    for (let wait = pausedUntil[group] - now(); wait > 0; wait = pausedUntil[group] - now()) {
      if (signal?.aborted) throw abortError();
      await sleep(wait);
    }
    if (signal?.aborted) throw abortError();
  };

  return {
    wrap(base) {
      return async (input, init) => {
        const group = hostGroupOf(input as string | URL | Request);
        if (!group) return base(input, init);
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        return gates[group].run(async () => {
          await pause(group, signal);
          const reply = await base(input, init);
          if (reply.status === 429) {
            const seconds = retryAfterSeconds(reply.headers.get('retry-after'), now());
            const hold = Math.min(seconds === undefined ? DEFAULT_COOLDOWN_MS : seconds * 1000, maxCooldown);
            pausedUntil[group] = Math.max(pausedUntil[group], now() + hold);
          }
          return reply;
        });
      };
    },
    stats() {
      const of = (group: HostGroup) => ({
        inFlight: gates[group].inFlight,
        peak: gates[group].peak,
        limit: gates[group].limit,
        pausedUntil: pausedUntil[group],
      });
      return { apple: of('apple'), google: of('google') };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Process wide settings (the server sets them once at start; tests use the defaults or their own)

export type PipelineSettings = {
  appleConcurrency: number;
  googleConcurrency: number;
  /** Reads of one credential at once (reviews, analytics). */
  perCredential: number;
  /** Sources of one app's analytics sync read at once. */
  analyticsSources: number;
  /** Report files fetched ahead while the earlier ones are stored. */
  readAhead: number;
};

export const DEFAULT_PIPELINE: PipelineSettings = {
  appleConcurrency: 4,
  googleConcurrency: 4,
  perCredential: 2,
  analyticsSources: 3,
  readAhead: 4,
};

let settings: PipelineSettings = { ...DEFAULT_PIPELINE };
let hostGate: HostGate | undefined;

export function pipelineSettings(): PipelineSettings {
  return settings;
}

/**
 * Applies the settings and puts the host gate in front of `globalThis.fetch`. Every store read goes through
 * `globalThis.fetch` (each module wraps it with its own abort signal), so one gate there covers all of them, and
 * the connectors' own tests, which pass a fake `fetch`, are untouched. Called once, from index.ts.
 */
export function installSyncPipeline(next: Partial<PipelineSettings> = {}): HostGate {
  settings = { ...DEFAULT_PIPELINE, ...next };
  hostGate = createHostGate({ limits: { apple: settings.appleConcurrency, google: settings.googleConcurrency } });
  globalThis.fetch = hostGate.wrap(globalThis.fetch);
  return hostGate;
}

export function installedHostGate(): HostGate | undefined {
  return hostGate;
}

/** Test helper: the defaults again. */
export function resetSyncPipeline(next: Partial<PipelineSettings> = {}): void {
  settings = { ...DEFAULT_PIPELINE, ...next };
}

const lanes = new Map<string, { gate: Semaphore }>();

/**
 * Runs `job` in the lane of one credential: at most `perCredential` jobs of a key at once (Apple's limit is per key,
 * Play's quota per app, and the host gate bounds the requests themselves). Replaces the old one-at-a-time queue.
 */
export async function credentialLane<T>(key: string, job: () => Promise<T>): Promise<T> {
  let lane = lanes.get(key);
  if (!lane || lane.gate.limit !== Math.max(1, settings.perCredential)) {
    lane = { gate: new Semaphore(settings.perCredential) };
    lanes.set(key, lane);
  }
  const mine = lane;
  try {
    return await mine.gate.run(job);
  } finally {
    if (mine.gate.inFlight === 0 && mine.gate.waiting === 0 && lanes.get(key) === mine) lanes.delete(key);
  }
}

// ---------------------------------------------------------------------------------------------
// What is being read right now

export type SyncFeed = 'releases' | 'listing' | 'reviews' | 'analytics' | 'testflight';

export type ActiveFeed = { workspaceId: string; appId: string; feed: SyncFeed; since: number };

const active = new Map<number, ActiveFeed>();
let activeSeq = 0;

export const syncActivity = {
  /** Marks a feed of an app as being read; call the returned function when it ends, however it ends. */
  begin(workspaceId: string, appId: string, feed: SyncFeed, at: number = Date.now()): () => void {
    const id = ++activeSeq;
    active.set(id, { workspaceId, appId, feed, since: at });
    return () => {
      active.delete(id);
    };
  },
  list(workspaceId: string): ActiveFeed[] {
    return [...active.values()].filter((entry) => entry.workspaceId === workspaceId);
  },
};
