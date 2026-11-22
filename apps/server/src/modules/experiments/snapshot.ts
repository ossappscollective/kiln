import type {
  ListExperimentsResult,
  StoreCustomPage,
  StoreCustomPageVersion,
  StoreExperiment,
  StoreExperimentLocale,
  StoreExperimentState,
  StoreExperimentTreatment,
} from '@kiln/connectors';
import type { Sql } from '@kiln/db';

/**
 * The stored copy of an app's experiments and custom product pages (migration 53): what the last successful sync read, how the last sync went,
 * and the views the routes answer with. Nothing here talks to a store. A complete read of a part REPLACES that part in one transaction; a part
 * the store refused is left as it was, and a part cut at a cap replaces only the items it lists.
 */

export type ExperimentView = {
  id: string;
  name: string;
  platform: string | null;
  state: StoreExperimentState;
  rawState: string | null;
  trafficProportion: number | null;
  reviewRequired: boolean | null;
  startsAt: number | null;
  endsAt: number | null;
  treatments: StoreExperimentTreatment[];
  syncedAt: number;
};

export type CustomPageView = {
  id: string;
  name: string;
  state: StoreExperimentState;
  rawState: string | null;
  url: string | null;
  visible: boolean | null;
  deepLink: string | null;
  versions: StoreCustomPageVersion[];
  locales: StoreExperimentLocale[];
  syncedAt: number;
};

export type ExperimentsSyncStatus = {
  lastAttemptAt: number | null;
  lastSyncedAt: number | null;
  /** A redacted sentence about the last failure; null after a good sync. */
  lastError: string | null;
  failures: number;
  experimentCount: number;
  pageCount: number;
  /** False when the last sync stopped at a cap: the lists may not be everything the store has. */
  complete: boolean;
  warnings: string[];
};

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function insertRows(
  tx: Sql,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  const perStatement = Math.max(1, Math.floor(500 / columns.length));
  for (let at = 0; at < rows.length; at += perStatement) {
    const chunk = rows.slice(at, at + perStatement);
    const marks = `(${columns.map(() => '?').join(', ')})`;
    await tx.execute(
      `INSERT INTO store_experiments (${columns.join(', ')}) VALUES ${chunk.map(() => marks).join(', ')}`,
      chunk.flat() as never[],
    );
  }
}

const COLUMNS = [
  'app_id',
  'kind',
  'item_id',
  'workspace_id',
  'name',
  'state',
  'raw_state',
  'starts_at',
  'ends_at',
  'url',
  'detail_json',
  'synced_at',
] as const;

const experimentRow = (workspaceId: string, appId: string, at: number, e: StoreExperiment) => [
  appId,
  'experiment',
  e.id,
  workspaceId,
  e.name,
  e.state,
  e.rawState,
  e.startedAt,
  e.endedAt,
  null,
  JSON.stringify({
    platform: e.platform,
    trafficProportion: e.trafficProportion,
    reviewRequired: e.reviewRequired,
    treatments: e.treatments,
  }),
  at,
];

const pageRow = (workspaceId: string, appId: string, at: number, p: StoreCustomPage) => [
  appId,
  'custom_page',
  p.id,
  workspaceId,
  p.name,
  p.state,
  p.rawState,
  null,
  null,
  p.url,
  JSON.stringify({
    visible: p.visible,
    deepLink: p.deepLink,
    versions: p.versions,
    locales: p.locales,
  }),
  at,
];

/** Stores what a sync read (see the top of the file for which parts are replaced), and the status of the sync. */
export async function replaceSnapshot(
  tx: Sql,
  input: { workspaceId: string; appId: string; result: ListExperimentsResult; at: number },
): Promise<void> {
  const { workspaceId, appId, result, at } = input;
  const parts = [
    {
      kind: 'experiment',
      read: result.experimentsRead,
      ids: result.experiments.map((e) => e.id),
      rows: result.experiments.map((e) => experimentRow(workspaceId, appId, at, e)),
    },
    {
      kind: 'custom_page',
      read: result.customPagesRead,
      ids: result.customPages.map((p) => p.id),
      rows: result.customPages.map((p) => pageRow(workspaceId, appId, at, p)),
    },
  ];
  for (const part of parts) {
    if (!part.read) continue;
    if (result.complete) {
      await tx.execute(
        'DELETE FROM store_experiments WHERE app_id = ? AND workspace_id = ? AND kind = ?',
        [appId, workspaceId, part.kind],
      );
    } else {
      for (const itemId of part.ids) {
        await tx.execute(
          'DELETE FROM store_experiments WHERE app_id = ? AND workspace_id = ? AND kind = ? AND item_id = ?',
          [appId, workspaceId, part.kind, itemId],
        );
      }
    }
    await insertRows(tx, COLUMNS, part.rows);
  }
  const count = async (kind: string) => {
    const [row] = await tx.query(
      'SELECT COUNT(*) AS n FROM store_experiments WHERE app_id = ? AND workspace_id = ? AND kind = ?',
      [appId, workspaceId, kind],
    );
    return Number(row?.n ?? 0);
  };
  await tx.execute(
    `INSERT INTO store_experiments_sync (app_id, workspace_id, last_attempt_at, last_synced_at, last_error, failures, experiment_count, page_count, complete, warnings_json)
     VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET workspace_id = excluded.workspace_id, last_attempt_at = excluded.last_attempt_at,
       last_synced_at = excluded.last_synced_at, last_error = NULL, failures = 0, experiment_count = excluded.experiment_count,
       page_count = excluded.page_count, complete = excluded.complete, warnings_json = excluded.warnings_json`,
    [
      appId,
      workspaceId,
      at,
      at,
      await count('experiment'),
      await count('custom_page'),
      result.complete ? 1 : 0,
      JSON.stringify(result.warnings.slice(0, 50).map((w) => w.slice(0, 300))),
    ],
  );
}

/** A failed sync keeps the last good snapshot and says what went wrong. */
export async function recordSyncFailure(
  sql: Sql,
  input: { workspaceId: string; appId: string; message: string; at: number },
): Promise<void> {
  await sql.execute(
    `INSERT INTO store_experiments_sync (app_id, workspace_id, last_attempt_at, last_error, failures)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (app_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
       failures = store_experiments_sync.failures + 1`,
    [input.appId, input.workspaceId, input.at, input.message.slice(0, 500)],
  );
}

export async function readSyncStatus(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<ExperimentsSyncStatus | null> {
  const [row] = await sql.query(
    `SELECT last_attempt_at, last_synced_at, last_error, failures, experiment_count, page_count, complete, warnings_json
       FROM store_experiments_sync WHERE app_id = ? AND workspace_id = ?`,
    [appId, workspaceId],
  );
  if (!row) return null;
  return {
    lastAttemptAt: num(row.last_attempt_at),
    lastSyncedAt: num(row.last_synced_at),
    lastError: text(row.last_error),
    failures: Number(row.failures),
    experimentCount: Number(row.experiment_count),
    pageCount: Number(row.page_count),
    complete: Number(row.complete) === 1,
    warnings: parseJson<string[]>(row.warnings_json, []),
  };
}

type Row = Record<string, unknown>;
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const experimentOf = (row: Row): ExperimentView => {
  const d = parseJson<Record<string, unknown>>(row.detail_json, {});
  return {
    id: String(row.item_id),
    name: String(row.name),
    platform: text(d.platform),
    state: String(row.state) as StoreExperimentState,
    rawState: text(row.raw_state),
    trafficProportion: typeof d.trafficProportion === 'number' ? d.trafficProportion : null,
    reviewRequired: typeof d.reviewRequired === 'boolean' ? d.reviewRequired : null,
    startsAt: num(row.starts_at),
    endsAt: num(row.ends_at),
    treatments: list<StoreExperimentTreatment>(d.treatments),
    syncedAt: Number(row.synced_at),
  };
};

const pageOf = (row: Row): CustomPageView => {
  const d = parseJson<Record<string, unknown>>(row.detail_json, {});
  return {
    id: String(row.item_id),
    name: String(row.name),
    state: String(row.state) as StoreExperimentState,
    rawState: text(row.raw_state),
    url: text(row.url),
    visible: typeof d.visible === 'boolean' ? d.visible : null,
    deepLink: text(d.deepLink),
    versions: list<StoreCustomPageVersion>(d.versions),
    locales: list<StoreExperimentLocale>(d.locales),
    syncedAt: Number(row.synced_at),
  };
};

export async function listStored(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<{ experiments: ExperimentView[]; customPages: CustomPageView[] }> {
  const rows = await sql.query(
    'SELECT * FROM store_experiments WHERE app_id = ? AND workspace_id = ?',
    [appId, workspaceId],
  );
  const experiments = rows
    .filter((r) => r.kind === 'experiment')
    .map(experimentOf)
    // The newest first; one with no start date yet (a draft) leads, since it is the one being worked on.
    .sort(
      (a, b) =>
        (b.startsAt ?? Number.MAX_SAFE_INTEGER) - (a.startsAt ?? Number.MAX_SAFE_INTEGER) ||
        a.name.localeCompare(b.name),
    );
  const customPages = rows
    .filter((r) => r.kind === 'custom_page')
    .map(pageOf)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { experiments, customPages };
}
