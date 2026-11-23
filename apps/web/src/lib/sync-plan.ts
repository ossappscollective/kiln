import type { Action, Role } from '@kiln/core';
import { can } from '@kiln/core';
import type { AppSection } from './app-scope.ts';
import { k } from './i18n/t.ts';
import { type RunState, type SourceInput, type SyncKind, SYNC_KINDS, sourceState } from './sync-sources.ts';

/**
 * The page-scoped Sync (docs/ux-ia.md "Sync is per page"): pure planning. Which kinds a page needs, which sources are not fresh, which failed,
 * and from that what the main button does, what its label says and what the menu offers. Nothing here reads a store or the DOM; the readings
 * are the sources' own stored status (lib/sync-readings.ts).
 */

/** What a page syncs. `listing` is the fallback for the overview, the listing, releases and every page that has no source of its own. */
export type SyncPage = 'listing' | 'reviews' | 'analytics' | 'health' | 'timeline' | 'products' | 'builds' | 'ads';

export const PAGE_KINDS: Readonly<Record<SyncPage, readonly SyncKind[]>> = {
  listing: ['app'],
  reviews: ['reviews'],
  analytics: ['analytics'],
  /** Insights, Ratings and health: ratings come with the reviews read, crashes and ANRs with the analytics read. */
  health: ['reviews', 'analytics'],
  /** Insights, Timeline and reports: releases and listing history come with the app read, the numbers with the analytics read, the rating of a report with the reviews read. */
  timeline: ['app', 'reviews', 'analytics'],
  products: ['products'],
  builds: ['eas', 'testflight'],
  /** Insights, Ads: the Apple Ads reports of the linked ad account (docs/adr/0058-apple-ads.md). */
  ads: ['ads'],
};

export function syncPageFor(section: AppSection, view = ''): SyncPage {
  if (section === 'insights' && view === 'ratings') return 'health';
  if (section === 'insights' && view === 'timeline') return 'timeline';
  if (section === 'insights' && view === 'ads') return 'ads';
  switch (section) {
    case 'reviews':
      return 'reviews';
    case 'insights':
    case 'analytics':
      return 'analytics';
    case 'products':
      return 'products';
    case 'builds':
    case 'test-builds':
      return 'builds';
    default:
      return 'listing';
  }
}

/** A source read within this window is fresh: the page's Sync leaves it alone (the menu's "Sync everything" does not). Analytics are daily reports. */
export const FRESH_MS: Readonly<Record<SyncKind, number>> = {
  app: 10 * 60_000,
  reviews: 30 * 60_000,
  eas: 5 * 60_000,
  analytics: 6 * 3_600_000,
  products: 30 * 60_000,
  testflight: 30 * 60_000,
  ads: 60 * 60_000,
};

/** The right a role needs to run each kind (the server checks the same per kind: docs/api/apps.md). */
export const KIND_ACTION: Readonly<Record<SyncKind, Action>> = {
  app: 'apps.sync',
  reviews: 'reviews.sync',
  eas: 'apps.sync',
  analytics: 'analytics.manage',
  products: 'apps.sync',
  testflight: 'apps.sync',
  ads: 'apps.sync',
};
export const kindAllowed = (role: Role, kind: SyncKind): boolean => can(role, KIND_ACTION[kind]);

/** One thing to read: a source of an app record; `sources` limits analytics to those sources (failed or not fresh ones). */
export type SyncTarget = { appId: string; platform: string; kind: SyncKind; sources?: string[] };

export type Freshness = 'failed' | 'never' | 'stale' | 'fresh';

const rank: Record<Freshness, number> = { failed: 0, never: 1, stale: 2, fresh: 3 };

function age(lastReadAt: number | null, kind: SyncKind, now: number): Freshness {
  if (lastReadAt === null) return 'never';
  return now - lastReadAt > FRESH_MS[kind] ? 'stale' : 'fresh';
}

/** How one input reads: a failed last attempt first (even with older data), then never read, stale, fresh. Analytics: the worst of its sources. */
export function freshnessOf(input: SourceInput, now: number): Freshness {
  const r = input.reading;
  if (input.kind === 'analytics' && r.parts && r.parts.length > 0) {
    const all = r.parts.map((p): Freshness => (p.failed ? 'failed' : age(p.lastReadAt, 'analytics', now)));
    return all.reduce((worst, f) => (rank[f] < rank[worst] ? f : worst), 'fresh' as Freshness);
  }
  return r.failed ? 'failed' : age(r.lastReadAt, input.kind, now);
}

/** What to read for one input. `failed` and `due` narrow analytics to its sources; a kind without sources reads whole. */
function targetOf(input: SourceInput, want: 'failed' | 'due' | 'all', now: number): SyncTarget | null {
  const f = freshnessOf(input, now);
  if (want === 'failed' && f !== 'failed') return null;
  if (want === 'due' && f === 'fresh') return null;
  const base: SyncTarget = { appId: input.appId, platform: input.platform, kind: input.kind };
  const parts = input.reading.parts;
  if (input.kind === 'analytics' && parts && parts.length > 0 && want !== 'all') {
    const picked = parts
      .map((p) => ({ id: p.id, f: (p.failed ? 'failed' : age(p.lastReadAt, 'analytics', now)) as Freshness }))
      .filter((p) => (want === 'failed' ? p.f === 'failed' : p.f !== 'fresh'))
      .sort((a, b) => rank[a.f] - rank[b.f])
      .map((p) => p.id);
    return picked.length > 0 ? { ...base, sources: picked } : null;
  }
  return base;
}

/** Failed first, then never read, then the order of `SYNC_KINDS`, then the platform: what to retry or read first. */
function ordered(inputs: readonly SourceInput[], now: number): SourceInput[] {
  return [...inputs].sort(
    (a, b) =>
      rank[freshnessOf(a, now)] - rank[freshnessOf(b, now)] ||
      SYNC_KINDS.indexOf(a.kind) - SYNC_KINDS.indexOf(b.kind) ||
      a.platform.localeCompare(b.platform),
  );
}

export const targetsOf = (inputs: readonly SourceInput[], now: number, want: 'failed' | 'due' | 'all'): SyncTarget[] =>
  ordered(inputs, now).flatMap((i) => targetOf(i, want, now) ?? []);

/** How many things failed: an analytics source counts on its own, any other source once. */
export const failedCount = (targets: readonly SyncTarget[]): number => targets.reduce((n, t) => n + (t.sources ? t.sources.length : 1), 0);

export type MenuEntry = {
  kind: SyncKind;
  /** Of every record in scope: the worst. */
  freshness: Freshness;
  lastReadAt: number | null;
  targets: SyncTarget[];
  failed: number;
  onPage: boolean;
};

export type MainAction = {
  /** retry: the failed ones of this page; due: what is not fresh; fresh: all of the page again (nothing was due). */
  mode: 'retry' | 'due' | 'fresh';
  targets: SyncTarget[];
  /** Failed things (only in `retry`). */
  count: number;
};

export type SyncPlan = {
  page: SyncPage;
  /** Null when nothing the page needs applies here (its source is off, not linked, or the role may not run it). */
  main: MainAction | null;
  menu: MenuEntry[];
  everything: SyncTarget[];
  failed: SyncTarget[];
};

/**
 * The plan of a page. `inputs` are the readings of the records in scope (any kinds); `allowed` says whether the role may run a kind.
 * The main action: the failed things of the page (retry); else what is not fresh; else, when everything is fresh, the page's kinds again.
 */
export function planPage(
  inputs: readonly SourceInput[],
  opts: { page: SyncPage; now: number; allowed: (kind: SyncKind) => boolean },
): SyncPlan {
  const { page, now } = opts;
  const mine = inputs.filter((i) => opts.allowed(i.kind));
  const onPage = mine.filter((i) => PAGE_KINDS[page].includes(i.kind));
  const failed = targetsOf(onPage, now, 'failed');
  const due = targetsOf(onPage, now, 'due');
  const all = targetsOf(onPage, now, 'all');
  const main: MainAction | null =
    failed.length > 0
      ? { mode: 'retry', targets: failed, count: failedCount(failed) }
      : due.length > 0
        ? { mode: 'due', targets: due, count: 0 }
        : all.length > 0
          ? { mode: 'fresh', targets: all, count: 0 }
          : null;
  const menu: MenuEntry[] = SYNC_KINDS.flatMap((kind) => {
    const rows = mine.filter((i) => i.kind === kind);
    if (rows.length === 0) return [];
    const reads = rows.map((r) => r.reading.lastReadAt).filter((v): v is number => v !== null);
    const worst = rows.map((r) => freshnessOf(r, now)).reduce((w, f) => (rank[f] < rank[w] ? f : w), 'fresh' as Freshness);
    const failedTargets = targetsOf(rows, now, 'failed');
    return [
      {
        kind,
        freshness: worst,
        // A kind that has been read on every record: the oldest of the newest reads is how stale the kind is; one never read says never.
        lastReadAt: reads.length === rows.length ? Math.min(...reads) : null,
        targets: targetsOf(rows, now, 'all'),
        failed: failedCount(failedTargets),
        onPage: PAGE_KINDS[page].includes(kind),
      },
    ];
  });
  // The page's own kinds first, then the rest in the usual order.
  menu.sort((a, b) => Number(b.onPage) - Number(a.onPage));
  return { page, main, menu, everything: targetsOf(mine, now, 'all'), failed: targetsOf(mine, now, 'failed') };
}

/** The label of the main button: a key of the `app` namespace, and the count when it is a retry. */
const LABELS: Record<SyncPage, string> = {
  listing: k('app:syncButton.label.listing'),
  reviews: k('app:syncButton.label.reviews'),
  analytics: k('app:syncButton.label.analytics'),
  health: k('app:syncButton.label.health'),
  timeline: k('app:syncButton.label.timeline'),
  products: k('app:syncButton.label.products'),
  builds: k('app:syncButton.label.builds'),
  ads: k('app:syncButton.label.ads'),
};
export const RETRY_KEY = k('app:syncButton.retry');
export function mainLabelKey(plan: SyncPlan): { key: string; failed: number | null } {
  if (plan.main?.mode === 'retry') return { key: RETRY_KEY, failed: plan.main.count };
  return { key: LABELS[plan.page], failed: null };
}

/** Progress of a run, from the shell's per `appId:kind` states: how many of the started kinds ended. */
export function runProgress(runs: Readonly<Record<string, RunState | undefined>>): { done: number; total: number } {
  const states = Object.values(runs).filter((s): s is RunState => s !== undefined && s !== 'skipped');
  return { done: states.filter((s) => s === 'done' || s === 'failed').length, total: states.length };
}

export { sourceState };
