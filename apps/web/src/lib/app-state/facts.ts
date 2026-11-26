import type { AttentionItem } from '../app-attention.ts';
import type { CartSummary } from '../cart-summary.ts';
import type { LastPublish, PendingLine, PendingSummary } from '../pending.ts';
import type { Publishing } from '../publishing.ts';
import type { AppPipeline } from '../release-pipeline.ts';
import type { AppSummary, ReleaseSummary } from '../types.ts';
import type { AppFacts, PendingFacts } from './types.ts';
import type { Role } from '@kiln/core';

/**
 * From what the stores hold to the plain facts the model derives from. Pure: the rune store passes its readers in, a test passes
 * hand-written ones. This is the ONE place that says where each fact comes from:
 *
 *   pending count   <- the cart summary (`GET /pending/cart-summary`); an app it does not list has nothing pending
 *   blocking        <- the pending summary (`GET /pending/summary`), never more than the count
 *   publishing      <- the claims (`GET /pending/publishing`)
 *   last run        <- the same read (`lastPublish`), minus what a person hid
 *   pipelines       <- `GET /apps/{id}/release-pipeline`
 *   batch switch    <- `GET /publish/config`
 */

export type FactSources = {
  cart: CartSummary | null;
  pendingSummary: PendingSummary | null;
  publishing: (appId: string) => Publishing | null;
  /** The latest run that did not complete and nobody hid, or null. */
  failure: (appId: string) => LastPublish | null;
  pipeline: (appId: string) => Pick<AppPipeline, 'app' | 'pipeline'> | null;
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
  for (const r of input.records) {
    const count = countOf(src.cart, r.id);
    pending[r.id] = { count, blocking: blockingOf(src.pendingSummary, r.id, count) };
    publishing[r.id] = src.publishing(r.id);
    lastRun[r.id] = src.failure(r.id);
    pipelines[r.id] = src.pipeline(r.id);
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
    attention: input.attention ?? [],
    publishBatchEnabled: src.publishBatchEnabled,
    now: input.now,
  };
}

/**
 * The pending line of an app made of these records, for the chips and the badges: the cart count (the one count), the items an error
 * blocks, and the items that only wait for the store (from the pending summary). Null when the cart is not read or nothing is pending.
 */
export function lineOfRecords(
  src: Pick<FactSources, 'cart' | 'pendingSummary'>,
  appIds: readonly string[],
): PendingLine | null {
  if (src.cart === null) return null;
  let count = 0;
  let blocking = 0;
  let waiting = 0;
  for (const id of appIds) {
    const n = countOf(src.cart, id);
    count += n;
    blocking += blockingOf(src.pendingSummary, id, n);
    const line = src.pendingSummary?.apps?.find((l) => (l.appId ?? l.id) === id);
    waiting += line ? whole(line.waiting) : 0;
  }
  return count + waiting === 0 ? null : { count, blocking, waiting };
}
