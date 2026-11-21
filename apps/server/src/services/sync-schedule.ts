import type { Sql } from '@kiln/db';

/**
 * The scheduled store refresh, per workspace. The server-wide switch is `KILN_SYNC_INTERVAL_MINUTES` (default 30; 0 turns scheduled
 * syncs off for every workspace). A workspace may then turn its own refresh off (`sync.enabled`, on by default) or choose how often
 * its apps are read (`sync.intervalMinutes`); a workspace that chose nothing uses the server's interval. See docs/api/ci.md and
 * docs/adr/0030-workspace-sync-setting.md.
 */

export const MIN_SYNC_INTERVAL_MINUTES = 5;
export const MAX_SYNC_INTERVAL_MINUTES = 7 * 24 * 60;
export const DEFAULT_SYNC_INTERVAL_MINUTES = 30;

/** What the Settings screen offers; any whole number of minutes between the bounds is accepted by the API. */
export const SYNC_INTERVAL_CHOICES = [15, 30, 60, 360, 1440] as const;

export type SyncPrefs = { enabled?: boolean; intervalMinutes?: number };

export const SYNC_ENABLED_KEY = 'sync.enabled';
export const SYNC_INTERVAL_KEY = 'sync.intervalMinutes';

export function isSyncIntervalMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_SYNC_INTERVAL_MINUTES &&
    value <= MAX_SYNC_INTERVAL_MINUTES
  );
}

/** The stored sync settings of every workspace that set one (a value that no longer validates is ignored). */
export async function loadSyncPrefs(sql: Sql): Promise<Map<string, SyncPrefs>> {
  const rows = await sql.query(
    'SELECT workspace_id, key, value_json FROM workspace_settings WHERE key IN (?, ?)',
    [SYNC_ENABLED_KEY, SYNC_INTERVAL_KEY],
  );
  const out = new Map<string, SyncPrefs>();
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(String(row.value_json));
    } catch {
      continue;
    }
    const id = String(row.workspace_id);
    const prefs = out.get(id) ?? {};
    if (row.key === SYNC_ENABLED_KEY && typeof value === 'boolean') prefs.enabled = value;
    if (row.key === SYNC_INTERVAL_KEY && isSyncIntervalMinutes(value))
      prefs.intervalMinutes = value;
    out.set(id, prefs);
  }
  return out;
}

/**
 * What applies to one workspace. `serverMinutes` is KILN_SYNC_INTERVAL_MINUTES (0: off for everyone). `minutes` is 0 when no scheduled
 * sync runs for the workspace, and says why in `reason`.
 */
export function effectiveSync(
  serverMinutes: number,
  prefs: SyncPrefs | undefined,
): { enabled: boolean; minutes: number; reason: 'server_off' | 'workspace_off' | null } {
  if (serverMinutes <= 0) return { enabled: false, minutes: 0, reason: 'server_off' };
  if (prefs?.enabled === false) return { enabled: false, minutes: 0, reason: 'workspace_off' };
  return { enabled: true, minutes: prefs?.intervalMinutes ?? serverMinutes, reason: null };
}

/**
 * When the last sync queued by the scheduler (a job with `requestedBy: "scheduler"`) finished or failed in this workspace, from
 * the audit trail of `app.sync`; null when none ran yet.
 */
export async function lastScheduledSyncAt(sql: Sql, workspaceId: string): Promise<number | null> {
  const [row] = await sql.query(
    `SELECT MAX(created_at) AS at FROM audit_events
      WHERE workspace_id = ? AND action = 'app.sync' AND detail LIKE '%"requestedBy":"scheduler"%'`,
    [workspaceId],
  );
  const at = row?.at;
  return at === null || at === undefined ? null : Number(at);
}
