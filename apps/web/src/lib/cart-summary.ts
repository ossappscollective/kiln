import type { Platform } from '@kiln/core';
import { type AppGroup, groupApps } from './app-groups.ts';
import { k, t } from './i18n/t.ts';
import type { AppSummary } from './types.ts';

/**
 * The workspace-wide count of pending changes (ADR 0064): the wire type of `GET /pending/cart-summary`, the rows of the pending overview (the
 * records of one product merged, like the app switcher does), the words of the nav badge, and the loader that keeps the count true without
 * polling (docs/ux-ia.md "Pending changes across the workspace"). No DOM, no framework: the rune store wraps `createSummaryLoader`.
 */

export type CartSummaryLine = {
  appId: string;
  id: string;
  app: { id: string; name: string; platform: Platform; store: string };
  count: number;
  kinds: Record<string, number | undefined>;
};
export type CartSummary = { apps: CartSummaryLine[]; totals: { apps: number; count: number }; generatedAt: number };

export const SUMMARY_KINDS = ['listing', 'graphics', 'release', 'price', 'review_reply'] as const;
export const KIND_LABEL: Readonly<Record<(typeof SUMMARY_KINDS)[number], string>> = {
  listing: k('app:cart.group.listing'),
  graphics: k('app:cart.group.graphics'),
  release: k('app:cart.group.release'),
  price: k('app:cart.group.price'),
  review_reply: k('app:cart.group.reviewReply'),
};

/** One product of the overview: its records' carts together. `key` is the id the app's address uses (the first record). */
export type PendingRow = {
  key: string;
  name: string;
  platforms: Platform[];
  count: number;
  kinds: { kind: (typeof SUMMARY_KINDS)[number]; count: number }[];
  appIds: string[];
};

/** The lines of the summary merged per product (records of the same product join, as everywhere else); most pending first, then by name. */
export function pendingRows(summary: CartSummary | null, apps: readonly AppSummary[] | null): PendingRow[] {
  if (summary === null) return [];
  const known = apps ?? [];
  const groups: AppGroup[] = groupApps(known);
  const byKey = new Map<string, PendingRow>();
  for (const line of summary.apps) {
    const group = groups.find((g) => g.members.some((m) => m.id === line.appId));
    const key = group?.key ?? line.appId;
    const row = byKey.get(key) ?? { key, name: group?.name ?? line.app.name, platforms: [], count: 0, kinds: [], appIds: [] };
    if (!row.platforms.includes(line.app.platform)) row.platforms.push(line.app.platform);
    row.count += line.count;
    row.appIds.push(line.appId);
    for (const kind of SUMMARY_KINDS) {
      const n = line.kinds[kind] ?? 0;
      if (n === 0) continue;
      const found = row.kinds.find((x) => x.kind === kind);
      if (found) found.count += n;
      else row.kinds.push({ kind, count: n });
    }
    byKey.set(key, row);
  }
  const rows = [...byKey.values()];
  for (const r of rows) r.kinds.sort((a, b) => SUMMARY_KINDS.indexOf(a.kind) - SUMMARY_KINDS.indexOf(b.kind));
  return rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || (a.key < b.key ? -1 : 1));
}

/** What the badge counts: the changes and the apps (products) that hold them; null when nothing is known, 0 apps when nothing is pending. */
export function pendingTotals(rows: readonly PendingRow[], summary: CartSummary | null): { changes: number; apps: number } | null {
  if (summary === null) return null;
  return { changes: rows.reduce((n, r) => n + r.count, 0), apps: rows.length };
}

/** "12 pending changes across 4 apps": the whole label of the badge, for assistive technology and the tooltip. */
export const pendingAcrossText = (totals: { changes: number; apps: number }): string =>
  t('shell:badge.pendingAcross', { count: totals.apps, changes: t('shell:badge.pendingChanges', { count: totals.changes }) });

// ---------------------------------------------------------------------------------------------
// The loader

type Timer = (fn: () => void, ms: number) => () => void;
const realTimer: Timer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/**
 * Keeps ONE summary for the workspace in view. `request` (a stage, discard or publish was announced) coalesces a burst into one read after
 * `debounceMs`; `ensure` (focus, first paint) reads only when nothing is known or what is known is older than `minAgeMs`. A change of workspace
 * drops the old summary and everything in flight for it at once, and an answer that is not the latest read of the current workspace is ignored.
 * A failed read keeps what was shown.
 */
export function createSummaryLoader(opts: {
  read: (workspaceId: string) => Promise<CartSummary>;
  onChange: () => void;
  now?: () => number;
  timer?: Timer;
  debounceMs?: number;
  minAgeMs?: number;
}) {
  const now = opts.now ?? Date.now;
  const timer = opts.timer ?? realTimer;
  const debounceMs = opts.debounceMs ?? 400;
  const minAgeMs = opts.minAgeMs ?? 30_000;
  let workspace = '';
  let summary: CartSummary | null = null;
  let loadedAt = 0;
  let token = 0;
  let stop: (() => void) | null = null;

  const scope = (workspaceId: string) => {
    if (workspaceId === workspace) return;
    workspace = workspaceId;
    summary = null;
    loadedAt = 0;
    token += 1;
    stop?.();
    stop = null;
    opts.onChange();
  };
  async function refresh(workspaceId: string): Promise<void> {
    scope(workspaceId);
    const mine = ++token;
    try {
      const read = await opts.read(workspaceId);
      if (mine !== token || workspaceId !== workspace) return;
      summary = read;
      loadedAt = now();
      opts.onChange();
    } catch {
      // Keep what was shown: a badge that vanishes on a failed read is worse than one that is a little old.
    }
  }
  return {
    summaryOf: (workspaceId: string): CartSummary | null => (workspaceId === workspace ? summary : null),
    refresh,
    request(workspaceId: string): void {
      scope(workspaceId);
      if (stop !== null) return;
      stop = timer(() => {
        stop = null;
        void refresh(workspaceId);
      }, debounceMs);
    },
    async ensure(workspaceId: string): Promise<void> {
      scope(workspaceId);
      if (summary !== null && now() - loadedAt < minAgeMs) return;
      await refresh(workspaceId);
    },
    reset(): void {
      workspace = '';
      summary = null;
      token += 1;
      stop?.();
      stop = null;
    },
  };
}
