import type {
  RevenueCatEntitlement,
  RevenueCatOffering,
  RevenueCatProduct,
  RevenueCatState,
} from '@kiln/connectors';
import type { Sql } from '@kiln/db';

/**
 * The stored copy of an app's RevenueCat configuration (migration 48): what the last successful sync read and how the last sync went.
 * Nothing here talks to RevenueCat. A sync REPLACES the copy in one transaction, so a reader sees the old copy or the new one, and a
 * failed sync changes only the failure fields of `revenuecat_sync`. Configuration facts only: no money amounts, no customer data.
 */

export type RevenueCatSyncStatus = {
  lastAttemptAt: number | null;
  lastSyncedAt: number | null;
  /** A fixed sentence about the last failure (never RevenueCat's text); null after a good sync. */
  lastError: string | null;
  /** Syncs in a row that failed. */
  failures: number;
  productCount: number;
  /** Products of the RevenueCat project that belong to its other apps, left out. */
  otherAppProductCount: number;
  /** False when the last sync stopped at a cap: a list may be missing items. */
  complete: boolean;
  warnings: string[];
};

export type RevenueCatCache = {
  products: RevenueCatProduct[];
  entitlements: RevenueCatEntitlement[];
  offerings: RevenueCatOffering[];
};

export type RevenueCatConfigurationInput = RevenueCatCache & {
  otherAppProducts: number;
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

const TABLES = [
  'revenuecat_products',
  'revenuecat_entitlements',
  'revenuecat_offerings',
  'revenuecat_sync',
  // The metrics overview (migration 49, modules/revenuecat/metrics.ts) is about the linked project: a changed link clears it too.
  'revenuecat_metrics',
] as const;

/** Deletes the cached configuration and the sync state of an app record (its link was removed or now names another project or app). */
export async function clearRevenueCatCache(sql: Sql, workspaceId: string, appId: string): Promise<void> {
  for (const table of TABLES) {
    await sql.execute(`DELETE FROM ${table} WHERE app_id = ? AND workspace_id = ?`, [appId, workspaceId]);
  }
}

/** Multi-row inserts, in chunks small enough for every database's limit on parameters. */
async function insertRows(
  tx: Sql,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  const perStatement = Math.max(1, Math.floor(500 / columns.length));
  for (let at = 0; at < rows.length; at += perStatement) {
    const chunk = rows.slice(at, at + perStatement);
    const marks = `(${columns.map(() => '?').join(', ')})`;
    await tx.execute(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => marks).join(', ')}`,
      chunk.flat() as never[],
    );
  }
}

/** Replaces everything the app had with what a sync read, and records the good sync. */
export async function replaceRevenueCatSnapshot(
  tx: Sql,
  input: {
    workspaceId: string;
    appId: string;
    projectId: string;
    credentialId: string;
    config: RevenueCatConfigurationInput;
    at: number;
  },
): Promise<void> {
  const { workspaceId, appId, config, at } = input;
  for (const table of ['revenuecat_products', 'revenuecat_entitlements', 'revenuecat_offerings'] as const) {
    await tx.execute(`DELETE FROM ${table} WHERE app_id = ? AND workspace_id = ?`, [appId, workspaceId]);
  }
  await insertRows(
    tx,
    'revenuecat_products',
    [
      'app_id',
      'rc_product_id',
      'workspace_id',
      'store_identifier',
      'product_type',
      'state',
      'raw_state',
      'display_name',
      'duration',
      'grace_period',
      'trial_duration',
      'fetched_at',
    ],
    config.products.map((p) => [
      appId,
      p.id,
      workspaceId,
      p.storeIdentifier,
      p.type,
      p.state,
      p.rawState,
      p.displayName,
      p.duration,
      p.gracePeriod,
      p.trialDuration,
      at,
    ]),
  );
  await insertRows(
    tx,
    'revenuecat_entitlements',
    [
      'app_id',
      'entitlement_id',
      'workspace_id',
      'lookup_key',
      'display_name',
      'state',
      'raw_state',
      'product_ids_json',
      'project_product_count',
      'fetched_at',
    ],
    config.entitlements.map((e) => [
      appId,
      e.id,
      workspaceId,
      e.lookupKey,
      e.displayName,
      e.state,
      e.rawState,
      JSON.stringify(e.productIds),
      e.projectProductCount,
      at,
    ]),
  );
  await insertRows(
    tx,
    'revenuecat_offerings',
    [
      'app_id',
      'offering_id',
      'workspace_id',
      'lookup_key',
      'display_name',
      'is_current',
      'state',
      'raw_state',
      'packages_json',
      'fetched_at',
    ],
    config.offerings.map((o) => [
      appId,
      o.id,
      workspaceId,
      o.lookupKey,
      o.displayName,
      o.isCurrent ? 1 : 0,
      o.state,
      o.rawState,
      JSON.stringify(o.packages),
      at,
    ]),
  );
  await tx.execute(
    `INSERT INTO revenuecat_sync (app_id, workspace_id, project_id, credential_id, last_attempt_at, last_synced_at, last_error, failures,
                                  product_count, other_app_product_count, complete, warnings_json)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET workspace_id = excluded.workspace_id, project_id = excluded.project_id,
       credential_id = excluded.credential_id, last_attempt_at = excluded.last_attempt_at, last_synced_at = excluded.last_synced_at,
       last_error = NULL, failures = 0, product_count = excluded.product_count,
       other_app_product_count = excluded.other_app_product_count, complete = excluded.complete, warnings_json = excluded.warnings_json`,
    [
      appId,
      workspaceId,
      input.projectId,
      input.credentialId,
      at,
      at,
      config.products.length,
      config.otherAppProducts,
      config.complete ? 1 : 0,
      JSON.stringify(config.warnings.slice(0, 20).map((w) => w.slice(0, 300))),
    ],
  );
}

/** A failed sync keeps the last good copy and says what went wrong. `streak` false (a rate limit) records the sentence and not the count. */
export async function recordRevenueCatFailure(
  sql: Sql,
  input: { workspaceId: string; appId: string; message: string; at: number; streak: boolean },
): Promise<void> {
  const step = input.streak ? 1 : 0;
  await sql.execute(
    `INSERT INTO revenuecat_sync (app_id, workspace_id, last_attempt_at, last_error, failures)
     VALUES (?, ?, ?, ?, ${step})
     ON CONFLICT (app_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
       failures = revenuecat_sync.failures + ${step}`,
    [input.appId, input.workspaceId, input.at, input.message.slice(0, 500)],
  );
}

export async function readRevenueCatSyncStatus(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<RevenueCatSyncStatus | null> {
  const [row] = await sql.query(
    `SELECT last_attempt_at, last_synced_at, last_error, failures, product_count, other_app_product_count, complete, warnings_json
       FROM revenuecat_sync WHERE app_id = ? AND workspace_id = ?`,
    [appId, workspaceId],
  );
  if (!row) return null;
  return {
    lastAttemptAt: num(row.last_attempt_at),
    lastSyncedAt: num(row.last_synced_at),
    lastError: text(row.last_error),
    failures: Number(row.failures),
    productCount: Number(row.product_count),
    otherAppProductCount: Number(row.other_app_product_count),
    complete: Number(row.complete) === 1,
    warnings: parseJson<string[]>(row.warnings_json, []),
  };
}

export async function readRevenueCatCache(sql: Sql, workspaceId: string, appId: string): Promise<RevenueCatCache> {
  const products = await sql.query(
    'SELECT * FROM revenuecat_products WHERE app_id = ? AND workspace_id = ? ORDER BY store_identifier, rc_product_id',
    [appId, workspaceId],
  );
  const entitlements = await sql.query(
    'SELECT * FROM revenuecat_entitlements WHERE app_id = ? AND workspace_id = ? ORDER BY lookup_key',
    [appId, workspaceId],
  );
  const offerings = await sql.query(
    'SELECT * FROM revenuecat_offerings WHERE app_id = ? AND workspace_id = ? ORDER BY lookup_key',
    [appId, workspaceId],
  );
  return {
    products: products.map((r) => ({
      id: String(r.rc_product_id),
      storeIdentifier: String(r.store_identifier),
      type: String(r.product_type),
      state: String(r.state) as RevenueCatState,
      rawState: text(r.raw_state),
      displayName: text(r.display_name),
      appId: null,
      duration: text(r.duration),
      gracePeriod: text(r.grace_period),
      trialDuration: text(r.trial_duration),
    })),
    entitlements: entitlements.map((r) => ({
      id: String(r.entitlement_id),
      lookupKey: String(r.lookup_key),
      displayName: text(r.display_name),
      state: String(r.state) as RevenueCatState,
      rawState: text(r.raw_state),
      productIds: parseJson<string[]>(r.product_ids_json, []),
      projectProductCount: Number(r.project_product_count),
    })),
    offerings: offerings.map((r) => ({
      id: String(r.offering_id),
      lookupKey: String(r.lookup_key),
      displayName: text(r.display_name),
      isCurrent: Number(r.is_current) === 1,
      state: String(r.state) as RevenueCatState,
      rawState: text(r.raw_state),
      packages: parseJson<RevenueCatOffering['packages']>(r.packages_json, []),
    })),
  };
}
