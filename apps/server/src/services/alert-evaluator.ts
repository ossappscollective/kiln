import type { Database, Row, Sql } from '@mrm/db';
import { type AlertData, type AlertTypeId, alertDef, redactAlertData } from './alert-catalog.ts';
import { listRuleViews, type RuleView } from './alert-prefs.ts';
import { raiseAlert } from './alerts.ts';

/**
 * The evaluator for conditions that exist only as state (docs/alerts.md): a store sync that keeps failing, a credential whose test
 * fails, analytics that cannot sync, a listing that changed in the store behind this tool's back, staged changes left waiting, a
 * rating that fell, a mail server that does not take our mail. It reads the tables the app already keeps, never calls a store, and
 * never writes anything but alerts and its own memory (alert_conditions).
 *
 * Each pass compares what is true now with what it saw last time: a condition that starts raises an alert once; while it lasts it
 * raises again only after the type's collapse window (so a long failure is a reminder a day, not a flood); when it ends the alert
 * is marked resolved. The scheduler runs a pass every few minutes (scheduler.ts, `alerts`).
 */

const DAY = 24 * 3_600_000;
const MINUTE = 60_000;

type Found = AlertData;
type Check = {
  type: AlertTypeId;
  run: (sql: Sql, workspaceId: string, at: number, rule: RuleView) => Promise<Found[]>;
};

const apps = async (sql: Sql, workspaceId: string): Promise<Map<string, Row>> =>
  new Map(
    (
      await sql.query('SELECT id, name, platform FROM apps WHERE workspace_id = ?', [workspaceId])
    ).map((r) => [String(r.id), r]),
  );

const checks: Check[] = [
  {
    type: 'store.sync_failed',
    run: async (sql, ws, at) => {
      const rows = await sql.query(
        `SELECT id, last_sync_attempt_at, last_synced_at, created_at FROM apps WHERE workspace_id = ? AND last_sync_error IS NOT NULL`,
        [ws],
      );
      // A blip is not news: the app must have been without a good sync for half an hour.
      return rows
        .filter((r) => at - Number(r.last_synced_at ?? r.created_at) >= 30 * MINUTE)
        .map((r) => ({
          appId: String(r.id),
          since: new Date(Number(r.last_sync_attempt_at ?? at)).toISOString().slice(0, 16),
        }));
    },
  },
  {
    type: 'credential.invalid',
    run: async (sql, ws) => {
      const rows = await sql.query(
        'SELECT id, kind, label FROM credentials WHERE workspace_id = ? AND last_test_ok = 0',
        [ws],
      );
      return rows.map((r) => ({
        credentialId: String(r.id),
        kind: String(r.kind),
        label: String(r.label),
      }));
    },
  },
  {
    type: 'listing.read_failing',
    run: async (sql, ws, _at, rule) => {
      const rows = await sql.query(
        'SELECT app_id, listing_failures FROM app_listing_status WHERE workspace_id = ? AND listing_failures >= ?',
        [ws, rule.params.failures ?? 3],
      );
      return rows.map((r) => ({ appId: String(r.app_id), failures: Number(r.listing_failures) }));
    },
  },
  {
    type: 'pending.stale',
    run: async (sql, ws, at, rule) => {
      const days = rule.params.days ?? 7;
      const rows = await sql.query(
        `SELECT app_id, COUNT(*) AS n, MIN(created_at) AS oldest FROM staged_changes
          WHERE workspace_id = ? AND pushed_at IS NULL AND created_at < ? GROUP BY app_id`,
        [ws, at - days * DAY],
      );
      return rows.map((r) => ({
        appId: String(r.app_id),
        days,
        count: Number(r.n),
        oldest: new Date(Number(r.oldest)).toISOString().slice(0, 10),
      }));
    },
  },
  {
    type: 'analytics.sync_failing',
    run: async (sql, ws, at, rule) => {
      const n = rule.params.failures ?? 3;
      const rows = await sql.query(
        `SELECT app_id, status, error_code FROM analytics_sync_runs
          WHERE workspace_id = ? AND status <> 'running' AND started_at > ? ORDER BY app_id, started_at DESC LIMIT 20000`,
        [ws, at - 30 * DAY],
      );
      const byApp = new Map<string, Row[]>();
      for (const r of rows)
        byApp.set(String(r.app_id), [...(byApp.get(String(r.app_id)) ?? []), r]);
      const out: Found[] = [];
      for (const [appId, runs] of byApp) {
        const last = runs.slice(0, n);
        if (last.length === n && last.every((r) => String(r.status) === 'failed')) {
          out.push({
            appId,
            failures: n,
            code: last[0]?.error_code ? String(last[0].error_code) : 'unknown',
          });
        }
      }
      return out;
    },
  },
  {
    type: 'rating.dropped',
    run: async (sql, ws, at, rule) => {
      const windowDays = rule.params.windowDays ?? 7;
      const limit = (rule.params.dropHundredths ?? 20) * 10;
      const rows = await sql.query(
        `SELECT app_id, store, territory, COALESCE(current_average_milli, average_milli) AS milli, observed_at FROM app_rating_summaries
          WHERE workspace_id = ? AND observed_at > ? ORDER BY app_id, store, territory, observed_at DESC LIMIT 20000`,
        [ws, at - (windowDays + 14) * DAY],
      );
      const groups = new Map<string, Row[]>();
      for (const r of rows) {
        const k = `${r.app_id}\u0000${r.store}\u0000${r.territory}`;
        groups.set(k, [...(groups.get(k) ?? []), r]);
      }
      const worst = new Map<string, { drop: number; found: Found }>();
      for (const list of groups.values()) {
        const latest = list[0];
        if (!latest || latest.milli === null || at - Number(latest.observed_at) > 2 * DAY) continue;
        // The reference: the newest reading at least `windowDays` older than the latest one.
        const ref = list.find(
          (r) =>
            Number(r.observed_at) <= Number(latest.observed_at) - windowDays * DAY &&
            r.milli !== null,
        );
        if (!ref) continue;
        const drop = Number(ref.milli) - Number(latest.milli);
        if (drop < limit) continue;
        const appId = String(latest.app_id);
        const found: Found = {
          appId,
          store: String(latest.store),
          territory: String(latest.territory),
          from: Math.round(Number(ref.milli) / 10) / 100,
          to: Math.round(Number(latest.milli) / 10) / 100,
          windowDays,
          // A bucket of a week: a rating that stays low is one alert a week, not one a day.
          day: `w${Math.floor(Number(latest.observed_at) / (7 * DAY))}`,
        };
        if (!worst.has(appId) || (worst.get(appId)?.drop ?? 0) < drop)
          worst.set(appId, { drop, found });
      }
      return [...worst.values()].map((w) => w.found);
    },
  },
  {
    type: 'listing.drift',
    run: async (sql, ws, at) => {
      const since = at - 3 * DAY;
      const rows = await sql.query(
        `SELECT s.app_id, s.observed_at, s.value_hash,
                (SELECT p.value_hash FROM listing_snapshots p
                  WHERE p.app_id = s.app_id AND p.locale = s.locale AND p.field = s.field AND p.source = 'store' AND p.channel = 'live'
                    AND p.observed_at < s.observed_at ORDER BY p.observed_at DESC LIMIT 1) AS prev_hash,
                (SELECT p.observed_at FROM listing_snapshots p
                  WHERE p.app_id = s.app_id AND p.locale = s.locale AND p.field = s.field AND p.source = 'store' AND p.channel = 'live'
                    AND p.observed_at < s.observed_at ORDER BY p.observed_at DESC LIMIT 1) AS prev_at
           FROM listing_snapshots s
          WHERE s.workspace_id = ? AND s.source = 'store' AND s.channel = 'live' AND s.observed_at > ?`,
        [ws, since],
      );
      const perApp = new Map<string, { fields: number; from: number; to: number }>();
      for (const r of rows) {
        if (
          r.prev_hash === null ||
          r.prev_hash === undefined ||
          String(r.prev_hash) === String(r.value_hash)
        )
          continue;
        const id = String(r.app_id);
        const cur = perApp.get(id) ?? {
          fields: 0,
          from: Number(r.prev_at),
          to: Number(r.observed_at),
        };
        cur.fields++;
        cur.from = Math.min(cur.from, Number(r.prev_at));
        cur.to = Math.max(cur.to, Number(r.observed_at));
        perApp.set(id, cur);
      }
      const out: Found[] = [];
      for (const [appId, c] of perApp) {
        // A push, a submit, a publish, a release or a new live version explains a change; only an unexplained one is drift.
        const [explained] = await sql.query(
          `SELECT COUNT(*) AS n FROM events
            WHERE workspace_id = ? AND app_id = ? AND created_at BETWEEN ? AND ?
              AND type IN ('listing.draft_pushed', 'listing.submitted', 'pending.published', 'release.started', 'release.rollout_changed', 'app.release.status_changed')`,
          [ws, appId, c.from, c.to],
        );
        if (Number(explained?.n ?? 0) === 0)
          out.push({ appId, fields: c.fields, observedAt: c.to });
      }
      return out;
    },
  },
  {
    type: 'system.smtp_failing',
    run: async (sql, ws, _at, rule) => {
      const n = rule.params.failures ?? 3;
      const rows = await sql.query(
        `SELECT status, outcome FROM alert_deliveries
          WHERE workspace_id = ? AND channel = 'email' AND status IN ('sent', 'failed') ORDER BY updated_at DESC, id LIMIT ?`,
        [ws, n],
      );
      if (
        rows.length < n ||
        !rows.every((r) => String(r.status) === 'failed' && String(r.outcome).startsWith('smtp_'))
      )
        return [];
      return [{ failures: n, code: String(rows[0]?.outcome ?? 'unknown') }];
    },
  },
];

export type EvaluatorSummary = { checked: number; raised: number; resolved: number };

async function reconcile(
  db: Database,
  workspaceId: string,
  type: AlertTypeId,
  found: readonly Found[],
  at: number,
  summary: EvaluatorSummary,
): Promise<void> {
  const def = alertDef(type);
  if (!def) return;
  const active = new Map(
    (
      await db.query(
        'SELECT dedupe_key, raised_at, alert_id FROM alert_conditions WHERE workspace_id = ? AND type = ? AND active = 1',
        [workspaceId, type],
      )
    ).map((r) => [String(r.dedupe_key), r]),
  );
  const seen = new Set<string>();
  const names = await apps(db, workspaceId);
  for (const item of found) {
    const appId = typeof item.appId === 'string' ? item.appId : null;
    if (appId && !names.has(appId)) continue; // an app that was deleted
    const key = def.dedupeKey(redactAlertData({ ...item }));
    seen.add(key);
    const existing = active.get(key);
    const due = !existing || at - Number(existing.raised_at) >= def.dedupeWindowMs;
    if (!due) {
      await db.execute(
        'UPDATE alert_conditions SET last_seen_at = ? WHERE workspace_id = ? AND dedupe_key = ?',
        [at, workspaceId, key],
      );
      continue;
    }
    await db.transaction(async (tx) => {
      const result = await raiseAlert(tx, { workspaceId, type, appId, data: item, at });
      if (result.status === 'disabled') return;
      summary.raised += result.status === 'raised' ? 1 : 0;
      await tx.execute(
        `INSERT INTO alert_conditions (workspace_id, dedupe_key, type, app_id, first_seen_at, last_seen_at, raised_at, active, alert_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT (workspace_id, dedupe_key) DO UPDATE SET
           type = excluded.type, app_id = excluded.app_id, last_seen_at = excluded.last_seen_at, raised_at = excluded.raised_at,
           active = 1, alert_id = excluded.alert_id`,
        [workspaceId, key, type, appId, at, at, at, result.alertId],
      );
    });
  }
  for (const [key, row] of active) {
    if (seen.has(key)) continue;
    await db.execute(
      'UPDATE alert_conditions SET active = 0, last_seen_at = ? WHERE workspace_id = ? AND dedupe_key = ?',
      [at, workspaceId, key],
    );
    if (row.alert_id)
      await db.execute('UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL', [
        at,
        String(row.alert_id),
      ]);
    summary.resolved++;
  }
}

/** One pass over every workspace. A failing check is skipped and reported to `onError`; the others still run. */
export async function runAlertEvaluator(
  db: Database,
  at: number,
  options: { onError?: (message: string, error: unknown) => void } = {},
): Promise<EvaluatorSummary> {
  const summary: EvaluatorSummary = { checked: 0, raised: 0, resolved: 0 };
  const workspaces = await db.query('SELECT id FROM workspaces');
  for (const w of workspaces) {
    const workspaceId = String(w.id);
    const views = new Map((await listRuleViews(db, workspaceId)).map((v) => [v.alertType, v]));
    for (const check of checks) {
      const rule = views.get(check.type);
      if (!rule?.enabled) continue;
      try {
        const found = await check.run(db, workspaceId, at, rule);
        summary.checked++;
        await reconcile(db, workspaceId, check.type, found, at, summary);
      } catch (error) {
        options.onError?.(`alert check ${check.type} failed`, error);
      }
    }
  }
  return summary;
}
