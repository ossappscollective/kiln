import type { Role } from '@kiln/core';
import type { AttentionItem } from '../app-attention.ts';
import type { StoreBuildItem } from '../builds.ts';
import type { CartSummary } from '../cart-summary.ts';
import type { LastPublish, PendingLine, PendingSummary } from '../pending.ts';
import type { Publishing } from '../publishing.ts';
import type { AppPipeline } from '../release-pipeline.ts';
import type { AppSummary, ReleaseSummary } from '../types.ts';
import type { ReadinessFact } from './blockers.ts';
import type { StoreBuildFact } from './candidates.ts';
import type { AppFacts, PendingFacts } from './types.ts';

/**
 * From what the stores hold to the plain facts the model derives from. Pure: the rune store passes its readers in, a test passes
 * hand-written ones. This is the ONE place that says where each fact comes from:
 *
 *   pending count   <- the cart summary (`GET /pending/cart-summary`); an app it does not list has nothing pending
 *   blocking        <- the pending summary (`GET /pending/summary`), never more than the count
 *   publishing      <- the claims (`GET /pending/publishing`)
 *   last run        <- the same read (`lastPublish`), minus what a person hid
 *   readiness       <- `GET /apps/{id}/publish/readiness` (what blocks a submit NOW; the run's own blockers are history), null until asked
 *   pipelines       <- `GET /apps/{id}/release-pipeline`
 *   store builds    <- the store rows of `GET /apps/{id}/builds/artifacts` (TestFlight, version codes): the candidates' source; null until read
 *   store versions  <- the releases the app page loaded (`GET /apps/{id}`), by record
 *   batch switch    <- `GET /publish/config`
 */

/** The pending line of records: PendingLine plus the staged part of the count and what waits apart from it (never added to `count`). */
export type RecordsLine = PendingLine & {
  stagedUnpushed: number;
  awaitingSubmit: number;
  awaitingRelease: number;
};

export type FactSources = {
  cart: CartSummary | null;
  pendingSummary: PendingSummary | null;
  publishing: (appId: string) => Publishing | null;
  /** The latest run that did not complete and nobody hid, or null. */
  failure: (appId: string) => LastPublish | null;
  pipeline: (appId: string) => Pick<AppPipeline, 'app' | 'pipeline'> | null;
  /** The store builds of a record (TestFlight rows), or null while they are not read (the model then knows the pipeline's newest build). */
  builds?: ((appId: string) => readonly StoreBuildFact[] | null) | undefined;
  /** The last reading of what blocks a submit now, or null when none was asked for (the run's own blockers are shown as history then). */
  readiness?: ((appId: string) => ReadinessFact | null) | undefined;
  publishBatchEnabled: boolean | null;
};

export type FactInput = {
  role: Role;
  /** Every platform record of the app. */
  records: readonly AppSummary[];
  /** The releases the page loaded, by record id. */
  releases?: Readonly<Record<string, readonly ReleaseSummary[] | undefined>> | undefined;
  attention?: readonly AttentionItem[] | undefined;
  now: number;
};

const whole = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/** The cart count of one record: what the cart summary says, 0 when it does not list the record. */
export function countOf(cart: CartSummary | null, appId: string): number {
  if (cart === null) return 0;
  const line = cart.apps.find((l) => (l.appId ?? l.id) === appId);
  return line ? whole(line.count) : 0;
}

const summaryLineOf = (summary: PendingSummary | null, appId: string) =>
  summary !== null && Array.isArray(summary.apps)
    ? summary.apps.find((l) => (l.appId ?? l.id) === appId)
    : undefined;

/** The items of a record that an error blocks (from the pending summary), never more than its count: a quality of the count. */
function blockingOf(summary: PendingSummary | null, appId: string, count: number): number {
  if (summary === null || !Array.isArray(summary.apps)) return 0;
  const line = summary.apps.find((l) => (l.appId ?? l.id) === appId);
  return line ? Math.min(count, whole(line.blocking)) : 0;
}

export function assembleFacts(input: FactInput, src: FactSources): AppFacts {
  const pending: Record<string, PendingFacts> = {};
  const publishing: Record<string, Publishing | null> = {};
  const lastRun: Record<string, LastPublish | null> = {};
  const pipelines: Record<string, Pick<AppPipeline, 'app' | 'pipeline'> | null> = {};
  const builds: Record<string, readonly StoreBuildFact[] | null> = {};
  const readiness: Record<string, ReadinessFact | null> = {};
  for (const r of input.records) {
    const count = countOf(src.cart, r.id);
    const line = summaryLineOf(src.pendingSummary, r.id);
    pending[r.id] = {
      count,
      blocking: blockingOf(src.pendingSummary, r.id, count),
      // The summary states these for the same cart; a count read apart (the cart summary) is never higher than the staged part it knows.
      stagedUnpushed: Math.min(count, whole(line?.stagedUnpushed)),
      awaitingSubmit: whole(line?.awaitingSubmit),
      awaitingRelease: whole(line?.awaitingRelease),
      waiting: whole(line?.waiting),
    };
    publishing[r.id] = src.publishing(r.id);
    lastRun[r.id] = src.failure(r.id);
    pipelines[r.id] = src.pipeline(r.id);
    builds[r.id] = src.builds ? src.builds(r.id) : null;
    readiness[r.id] = src.readiness ? src.readiness(r.id) : null;
  }
  return {
    role: input.role,
    records: input.records,
    pending,
    pendingKnown: src.cart !== null,
    publishing,
    lastRun,
    releases: input.releases ?? {},
    pipelines,
    builds,
    readiness,
    attention: input.attention ?? [],
    publishBatchEnabled: src.publishBatchEnabled,
    now: input.now,
  };
}

/**
 * The pending line of an app made of these records, for the chips and the badges: the cart count (the one count), the items an error
 * blocks, the items that only wait for the store, and what waits for a submit or a release apart from the count (from the pending summary).
 * Null when the cart is not read or nothing is pending.
 */
export function lineOfRecords(
  src: Pick<FactSources, 'cart' | 'pendingSummary'>,
  appIds: readonly string[],
): RecordsLine | null {
  if (src.cart === null) return null;
  let count = 0;
  let blocking = 0;
  let waiting = 0;
  let staged = 0;
  let awaitingSubmit = 0;
  let awaitingRelease = 0;
  for (const id of appIds) {
    const n = countOf(src.cart, id);
    count += n;
    blocking += blockingOf(src.pendingSummary, id, n);
    const line = summaryLineOf(src.pendingSummary, id);
    waiting += whole(line?.waiting);
    staged += Math.min(n, whole(line?.stagedUnpushed));
    awaitingSubmit += whole(line?.awaitingSubmit);
    awaitingRelease += whole(line?.awaitingRelease);
  }
  return count + waiting + awaitingSubmit + awaitingRelease === 0
    ? null
    : { count, blocking, waiting, stagedUnpushed: staged, awaitingSubmit, awaitingRelease };
}

/** A store row of the Builds page (`app_builds`) as the model's build fact: only what decides a candidate. */
export function storeBuildFactOf(item: StoreBuildItem): StoreBuildFact {
  return {
    buildNumber: item.buildNumber,
    version: item.version,
    state: item.state,
    expired: item.expired,
    uploadedAt: item.uploadedAt,
    channel: item.channel,
    tracks: item.tracks.slice(),
  };
}
