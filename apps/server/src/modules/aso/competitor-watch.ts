import { randomUUID } from 'node:crypto';
import {
  carryOver,
  changeKinds,
  COMPETITOR_CHANGE_RETENTION_DAYS,
  COMPETITOR_CHANGES_MAX_PER_COMPETITOR,
  diffListing,
  isListingChange,
  type ListingChange,
  type ListingState,
  type ListingStore,
} from '@kiln/core';
import type { Row, Sql } from '@kiln/db';
import { emitEvent } from '../../services/events.ts';
import type { PublicApp } from './net.ts';

/**
 * The competitor listing watch (docs/adr/0056-competitor-listing-watch.md). Called by the competitor check of the ASO refresh (and by
 * "Check now", which is the same check): the new read is compared with `aso_competitors.listing_state`, the differences are stored as one
 * `aso_competitor_changes` row, the state is replaced, rows past the retention are dropped, and one `aso.competitor_listing_changed`
 * event is emitted when something other than rating drift changed. The first read stores the state and records no change. Only App Store
 * competitors are watched: Kiln does not read Google Play pages. Everything stored is public store data; nothing here logs.
 */

const DAY_MS = 24 * 60 * 60_000;
const STATE_MAX_CHARS = 60_000;

const textOrNull = (v: string | undefined): string | null =>
  v === undefined || v === '' ? null : v;

/** What the watch compares, from what the store said. */
export function listingStateOf(app: PublicApp): ListingState {
  return {
    name: textOrNull(app.name),
    description: textOrNull(app.description),
    releaseNotes: textOrNull(app.releaseNotes),
    version: textOrNull(app.version),
    price: textOrNull(app.price),
    category: textOrNull(app.category),
    icon: textOrNull(app.iconUrl),
    iphone: app.iphoneScreenshotUrls ?? app.screenshotUrls ?? [],
    ipad: app.ipadScreenshotUrls ?? [],
    ratingMilli: app.ratingMilli ?? null,
    ratingCount: app.ratingCount ?? null,
  };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function parseListingState(raw: unknown): ListingState | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null) return undefined;
    return {
      name: str(v.name),
      description: str(v.description),
      releaseNotes: str(v.releaseNotes),
      version: str(v.version),
      price: str(v.price),
      category: str(v.category),
      icon: str(v.icon),
      iphone: strings(v.iphone),
      ipad: strings(v.ipad),
      ratingMilli: numOrNull(v.ratingMilli),
      ratingCount: numOrNull(v.ratingCount),
    };
  } catch {
    return undefined;
  }
}

export function parseChanges(raw: unknown): ListingChange[] {
  if (typeof raw !== 'string') return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as ListingChange[]) : [];
  } catch {
    return [];
  }
}

const serialise = (state: ListingState): string => {
  const raw = JSON.stringify(state);
  return raw.length <= STATE_MAX_CHARS
    ? raw
    : JSON.stringify({ ...state, description: null, releaseNotes: null });
};

/** The first state of a competitor that was just added (no change is recorded). */
export async function storeInitialListingState(
  tx: Sql,
  competitorId: string,
  store: ListingStore,
  app: PublicApp,
): Promise<void> {
  if (store !== 'app_store') return;
  await tx.execute('UPDATE aso_competitors SET listing_state = ? WHERE id = ?', [
    serialise(listingStateOf(app)),
    competitorId,
  ]);
}

export type WatchOutcome = { changes: ListingChange[]; stored: boolean };

/** Compares a fresh read of an App Store competitor with the stored state and records what changed. Runs inside the caller's transaction. */
export async function recordListingChanges(
  tx: Sql,
  input: {
    workspaceId: string;
    appId: string;
    competitorId: string;
    store: ListingStore;
    country: string;
    previousState: unknown;
    found: PublicApp;
    at: number;
  },
): Promise<WatchOutcome> {
  if (input.store !== 'app_store') return { changes: [], stored: false };
  const previous = parseListingState(input.previousState);
  const next = listingStateOf(input.found);
  const changes = diffListing(previous, next);
  await tx.execute('UPDATE aso_competitors SET listing_state = ? WHERE id = ?', [
    serialise(carryOver(previous, next)),
    input.competitorId,
  ]);
  if (changes.length === 0) return { changes, stored: false };
  const kinds = changeKinds(changes);
  await tx.execute(
    `INSERT INTO aso_competitor_changes (id, workspace_id, competitor_id, app_id, detected_at, kinds, changes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      input.workspaceId,
      input.competitorId,
      input.appId,
      input.at,
      kinds.join(','),
      JSON.stringify(changes),
    ],
  );
  await tx.execute(
    'DELETE FROM aso_competitor_changes WHERE competitor_id = ? AND detected_at < ?',
    [input.competitorId, input.at - COMPETITOR_CHANGE_RETENTION_DAYS * DAY_MS],
  );
  await tx.execute(
    `DELETE FROM aso_competitor_changes WHERE competitor_id = ? AND id NOT IN (
       SELECT id FROM aso_competitor_changes WHERE competitor_id = ? ORDER BY detected_at DESC, id DESC LIMIT ${COMPETITOR_CHANGES_MAX_PER_COMPETITOR})`,
    [input.competitorId, input.competitorId],
  );
  if (changes.some(isListingChange)) {
    await emitEvent(tx, {
      workspaceId: input.workspaceId,
      type: 'aso.competitor_listing_changed',
      subject: { appId: input.appId },
      // Ids and the kinds of change; never a name, an address or a text.
      payload: {
        appId: input.appId,
        competitorId: input.competitorId,
        store: input.store,
        country: input.country,
        kinds: kinds.filter((k) => k !== 'rating' && k !== 'ratingCount'),
      },
      at: input.at,
    });
  }
  return { changes, stored: true };
}

export type CompetitorChangeView = {
  id: string;
  competitorId: string;
  detectedAt: number;
  kinds: string[];
  changes: ListingChange[];
};

const viewOf = (r: Row): CompetitorChangeView => ({
  id: String(r.id),
  competitorId: String(r.competitor_id),
  detectedAt: Number(r.detected_at),
  kinds: String(r.kinds).split(',').filter(Boolean),
  changes: parseChanges(r.changes),
});

export const CHANGES_PAGE_MAX = 50;

/** One competitor's changes, newest first, `before` (a `detectedAt`) pages. */
export async function listCompetitorChanges(
  sql: Sql,
  input: { workspaceId: string; competitorId: string; limit: number; before?: number },
): Promise<{ changes: CompetitorChangeView[]; hasMore: boolean }> {
  const rows = await sql.query(
    `SELECT id, competitor_id, detected_at, kinds, changes FROM aso_competitor_changes
      WHERE workspace_id = ? AND competitor_id = ? AND detected_at < ? ORDER BY detected_at DESC, id DESC LIMIT ?`,
    [
      input.workspaceId,
      input.competitorId,
      input.before ?? Number.MAX_SAFE_INTEGER,
      input.limit + 1,
    ],
  );
  return { changes: rows.slice(0, input.limit).map(viewOf), hasMore: rows.length > input.limit };
}

export async function getCompetitorChange(
  sql: Sql,
  workspaceId: string,
  competitorId: string,
  id: string,
): Promise<CompetitorChangeView | undefined> {
  const [row] = await sql.query(
    'SELECT id, competitor_id, detected_at, kinds, changes FROM aso_competitor_changes WHERE workspace_id = ? AND competitor_id = ? AND id = ?',
    [workspaceId, competitorId, id],
  );
  return row ? viewOf(row) : undefined;
}

/** How many changes each competitor of an app has (and the newest day), for the list. */
export async function changeCounts(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<Record<string, { count: number; latestAt: number }>> {
  const rows = await sql.query(
    `SELECT competitor_id, COUNT(*) AS n, MAX(detected_at) AS latest FROM aso_competitor_changes WHERE workspace_id = ? AND app_id = ? GROUP BY competitor_id`,
    [workspaceId, appId],
  );
  const out: Record<string, { count: number; latestAt: number }> = {};
  for (const r of rows)
    out[String(r.competitor_id)] = { count: Number(r.n), latestAt: Number(r.latest) };
  return out;
}
