import { k, t } from './i18n/t.ts';

/**
 * The sources an app is synced from, as ONE list (the Status popover of the app header; docs/ux-ia.md "One Sync"). Pure functions: what each
 * source last read, in which state, and what to do about it. The header's single Sync runs all of them; pages show "Updated X ago" and, for a
 * source that could not be read, a link to this list instead of a sync button of their own.
 *   app         store listing and release state         reviews    customer reviews       analytics   the analytics sources
 *   eas         EAS builds and submissions              products   in-app products and RevenueCat figures      testflight  beta feedback and crashes
 */
export type SyncKind = 'app' | 'reviews' | 'eas' | 'analytics' | 'products' | 'testflight' | 'ads';

/** Critical first, the order the server queues them in (docs/adr/0050-sync-pipeline.md); products and TestFlight have no queue and follow. */
export const SYNC_KINDS: readonly SyncKind[] = [
  'app',
  'reviews',
  'eas',
  'analytics',
  'products',
  'testflight',
  'ads',
];

/** What the server's `POST /apps/:id/sync-all` answers for one queued kind (docs/api/apps.md). */
export type SyncPlanEntry =
  | { kind: 'app' | 'reviews' | 'eas' | 'analytics' | 'ads'; state: 'queued'; jobId: string }
  | {
      kind: 'app' | 'reviews' | 'eas' | 'analytics' | 'ads';
      state: 'skipped';
      reason: 'forbidden' | 'not_linked' | 'off' | 'not_ready' | 'already_queued';
    };

/** What one source reports about itself; the screens fill it from the source's own stored status (never from a store). */
export type Reading = {
  lastReadAt: number | null;
  lastAttemptAt: number | null;
  /** The last attempt failed. */
  failed: boolean;
  /** Analytics only: each source on its own, so a retry can name the failed ones and a fresh one is left alone. */
  parts?: { id: string; lastReadAt: number | null; failed: boolean }[];
};

export type RunState = 'queued' | 'running' | 'done' | 'failed' | 'skipped';
export type SourceState = 'ok' | 'failed' | 'never' | 'running';

/** A run in progress wins; then a failed last attempt (even with older data); then never read; else fine. */
export function sourceState(reading: Reading, run?: RunState): SourceState {
  if (run === 'queued' || run === 'running') return 'running';
  if (reading.failed || run === 'failed') return 'failed';
  return reading.lastReadAt === null ? 'never' : 'ok';
}

const LABELS: Record<SyncKind, string> = {
  app: k('app:sync.kind.app'),
  reviews: k('app:sync.kind.reviews'),
  eas: k('app:sync.kind.eas'),
  analytics: k('app:sync.kind.analytics'),
  products: k('app:sync.kind.products'),
  testflight: k('app:sync.kind.testflight'),
  ads: k('app:sync.kind.ads'),
};
const HINTS: Record<SyncKind, string> = {
  app: k('app:sync.hint.app'),
  reviews: k('app:sync.hint.reviews'),
  eas: k('app:sync.hint.eas'),
  analytics: k('app:sync.hint.analytics'),
  products: k('app:sync.hint.products'),
  testflight: k('app:sync.hint.testflight'),
  ads: k('app:sync.hint.ads'),
};
export const kindLabel = (kind: SyncKind): string => t(LABELS[kind]);

export type SourceInput = { appId: string; platform: string; kind: SyncKind; reading: Reading };
export type SourceRow = {
  key: string;
  appId: string;
  platform: string;
  kind: SyncKind;
  label: string;
  state: SourceState;
  lastReadAt: number | null;
  /** What to try when the source failed or was never read; null when all is well. */
  hint: string | null;
};

/** The rows of the list: a source that needs a look first, then the order of `SYNC_KINDS`, then the platform. `runs` is keyed `appId:kind`. */
export function buildSourceRows(
  inputs: readonly SourceInput[],
  runs: Readonly<Record<string, RunState | undefined>> = {},
): SourceRow[] {
  const rows = inputs.map((i): SourceRow => {
    const state = sourceState(i.reading, runs[`${i.appId}:${i.kind}`]);
    return {
      key: `${i.appId}:${i.kind}`,
      appId: i.appId,
      platform: i.platform,
      kind: i.kind,
      label: kindLabel(i.kind),
      state,
      lastReadAt: i.reading.lastReadAt,
      hint: state === 'failed' || state === 'never' ? t(HINTS[i.kind]) : null,
    };
  });
  const weight = (s: SourceState) => (s === 'failed' ? 0 : s === 'never' ? 1 : 2);
  return rows.sort(
    (a, b) =>
      weight(a.state) - weight(b.state) ||
      SYNC_KINDS.indexOf(a.kind) - SYNC_KINDS.indexOf(b.kind) ||
      a.platform.localeCompare(b.platform),
  );
}

/** The newest successful read of any source: the "Updated X ago" of a page. */
export function newestRead(rows: readonly Pick<SourceRow, 'lastReadAt'>[]): number | null {
  let best: number | null = null;
  for (const r of rows)
    if (r.lastReadAt !== null && (best === null || r.lastReadAt > best)) best = r.lastReadAt;
  return best;
}

/** How many sources failed their last read. */
export const failedSources = (rows: readonly Pick<SourceRow, 'state'>[]): number =>
  rows.filter((r) => r.state === 'failed').length;

/** The kinds a page cares about, for its quiet line: "Updated 5 minutes ago", or the failed ones named. */
export function pageStatus(
  rows: readonly SourceRow[],
  kinds: readonly SyncKind[],
): { failed: SyncKind[]; newest: number | null } {
  const mine = rows.filter((r) => kinds.includes(r.kind));
  return {
    failed: [...new Set(mine.filter((r) => r.state === 'failed').map((r) => r.kind))],
    newest: newestRead(mine),
  };
}

/** The per kind state of a run: what the server queued (`plan`) and what the client ran itself (`extra`), keyed `appId:kind`. */
export function runStates(
  appId: string,
  plan: readonly SyncPlanEntry[],
  extra: Readonly<Partial<Record<SyncKind, RunState>>>,
): Record<string, RunState> {
  const out: Record<string, RunState> = {};
  for (const p of plan) out[`${appId}:${p.kind}`] = p.state === 'queued' ? 'queued' : 'skipped';
  for (const [kind, state] of Object.entries(extra)) if (state) out[`${appId}:${kind}`] = state;
  return out;
}

/** Whether a run is still going: some kind queued or running. */
export const runActive = (runs: Readonly<Record<string, RunState | undefined>>): boolean =>
  Object.values(runs).some((s) => s === 'queued' || s === 'running');
