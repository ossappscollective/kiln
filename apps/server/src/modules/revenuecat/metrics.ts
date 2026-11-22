import {
  pickOverviewMetric,
  readRevenueCatOverview,
  type RevenueCatClient,
  RevenueCatError,
  type RevenueCatOverview,
  type RevenueCatOverviewMetric,
  type RevenueCatStripKey,
} from '@kiln/connectors';
import type { Sql } from '@kiln/db';
import { revenueCatFailure } from './client.ts';
import { getRevenueCatLink } from './link.ts';

/**
 * The RevenueCat metrics overview of a linked app's project (docs/adr/0043-revenuecat-metrics.md): a read of
 * `GET /v2/projects/{project_id}/metrics/overview`, a cached copy (migration 49, `revenuecat_metrics`) written by the RevenueCat sync, and
 * the view the Products page, the API and the MCP server read. Reading the view never asks RevenueCat.
 *
 * What the figures are: RevenueCat's own, for the WHOLE project (every app and every store it knows), not for this app alone and not
 * the stores' figures. Money carries the currency RevenueCat reported and is never converted or summed with another currency. Revenue is
 * RevenueCat's gross of a window (28 days), before store fees and taxes. Viewers can see these figures: they see the same copy of the
 * store's sales (ADR 0043).
 */

export type RevenueCatMetric = {
  /** RevenueCat's id, verbatim. */
  id: string;
  name: string;
  /** `money` carries `currency`; a `count` is a plain number of things (subscriptions, trials, customers). */
  kind: 'count' | 'money';
  value: number;
  /** The currency RevenueCat reported for its money figures; null for a count, and for money when RevenueCat named none. */
  currency: string | null;
  /** RevenueCat's period verbatim (`P0D` is "now", `P28D` the last 28 days); null when it said none. */
  period: string | null;
  /** The period in days: 0 for now, 28 for `P28D`; null when it is not a number of days. */
  windowDays: number | null;
  /** When RevenueCat last updated the figure; null when it did not say. */
  lastUpdatedAt: number | null;
};

export type RevenueCatMetricsView = {
  /** Always the project: the figures cover every app and store of it. */
  scope: 'project';
  projectId: string;
  projectName: string;
  currency: string | null;
  /** When the figures were read from RevenueCat. */
  fetchedAt: number;
  figures: {
    activeSubscriptions: RevenueCatMetric | null;
    activeTrials: RevenueCatMetric | null;
    mrr: RevenueCatMetric | null;
    revenue: RevenueCatMetric | null;
  };
  /** The other metrics RevenueCat reported, in its order (customers, for one). */
  others: RevenueCatMetric[];
};

export type RevenueCatMetricsStatus = {
  lastAttemptAt: number | null;
  /** A fixed sentence about the last failure (never RevenueCat's text); null after a good read. */
  lastError: string | null;
  failures: number;
};

export type RevenueCatMetricsAnswer = {
  /** Null before the first good read, and for an app without a link. */
  metrics: RevenueCatMetricsView | null;
  status: RevenueCatMetricsStatus | null;
};

/** What a sync reports for its metrics step: how many figures it read, or a code and a fixed sentence. */
export type RevenueCatMetricsStep =
  | { ok: true; metrics: number; fetchedAt: number }
  | { ok: false; code: string; message: string; retryAfterSeconds?: number };

const MONEY_KEYS: RevenueCatStripKey[] = ['mrr', 'revenue'];

const windowOf = (period: string | null): number | null => {
  const days = period?.match(/^P(\d{1,4})D$/);
  return days ? Number(days[1]) : null;
};

/** Count or money: the figures of the strip by key (MRR and Revenue are money), the others by RevenueCat's unit (`$`). UNVERIFIED for other ids. */
function metricOf(
  m: RevenueCatOverviewMetric,
  all: readonly RevenueCatOverviewMetric[],
  currency: string | null,
): RevenueCatMetric {
  const money =
    MONEY_KEYS.some((key) => pickOverviewMetric(all, key) === m) ||
    (m.unit !== null && m.unit !== '#' && /^[^\w\s]$/u.test(m.unit));
  return {
    id: m.id,
    name: m.name,
    kind: money ? 'money' : 'count',
    value: m.value,
    currency: money ? currency : null,
    period: m.period,
    windowDays: windowOf(m.period),
    lastUpdatedAt: m.lastUpdatedAt,
  };
}

/** The view of stored metrics: the four figures of the strip (null when RevenueCat reported none: never zero) and the rest. */
export function viewOfOverview(input: {
  projectId: string;
  projectName: string;
  fetchedAt: number;
  overview: RevenueCatOverview;
}): RevenueCatMetricsView {
  const { overview } = input;
  const all = overview.metrics;
  const pick = (key: RevenueCatStripKey) => {
    const found = pickOverviewMetric(all, key);
    return found ? metricOf(found, all, overview.currency) : null;
  };
  const figures = {
    activeSubscriptions: pick('active_subscriptions'),
    activeTrials: pick('active_trials'),
    mrr: pick('mrr'),
    revenue: pick('revenue'),
  };
  const used = new Set(
    (['active_subscriptions', 'active_trials', 'mrr', 'revenue'] as const).map(
      (k) => pickOverviewMetric(all, k)?.id,
    ),
  );
  return {
    scope: 'project',
    projectId: input.projectId,
    projectName: input.projectName,
    currency: overview.currency,
    fetchedAt: input.fetchedAt,
    figures,
    others: all.filter((m) => !used.has(m.id)).map((m) => metricOf(m, all, overview.currency)),
  };
}

function parseOverview(json: unknown, currency: string | null): RevenueCatOverview {
  let list: unknown;
  try {
    list = typeof json === 'string' ? JSON.parse(json) : [];
  } catch {
    list = [];
  }
  const metrics: RevenueCatOverviewMetric[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.value !== 'number') continue;
    metrics.push({
      id: r.id,
      name: typeof r.name === 'string' ? r.name : r.id,
      unit: typeof r.unit === 'string' ? r.unit : null,
      period: typeof r.period === 'string' ? r.period : null,
      value: r.value,
      lastUpdatedAt: typeof r.lastUpdatedAt === 'number' ? r.lastUpdatedAt : null,
    });
  }
  return { currency, metrics };
}

/** The stored copy as an answer. Reads only the database. */
export async function getRevenueCatMetrics(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<RevenueCatMetricsAnswer> {
  const link = await getRevenueCatLink(sql, workspaceId, appId);
  if (!link) return { metrics: null, status: null };
  const [row] = await sql.query(
    'SELECT project_id, currency, metrics_json, fetched_at, last_attempt_at, last_error, failures FROM revenuecat_metrics WHERE app_id = ? AND workspace_id = ?',
    [appId, workspaceId],
  );
  if (!row) return { metrics: null, status: null };
  const status: RevenueCatMetricsStatus = {
    lastAttemptAt:
      row.last_attempt_at === null || row.last_attempt_at === undefined
        ? null
        : Number(row.last_attempt_at),
    lastError:
      row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    failures: Number(row.failures),
  };
  if (row.fetched_at === null || row.fetched_at === undefined) return { metrics: null, status };
  const currency =
    row.currency === null || row.currency === undefined ? null : String(row.currency);
  return {
    metrics: viewOfOverview({
      // The figures are about the project that was read, which is the linked one unless the link changed (a change clears this copy).
      projectId: String(row.project_id),
      projectName: link.projectName,
      fetchedAt: Number(row.fetched_at),
      overview: parseOverview(row.metrics_json, currency),
    }),
    status,
  };
}

/** Deletes the stored metrics of an app record. */
export async function clearRevenueCatMetrics(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<void> {
  await sql.execute('DELETE FROM revenuecat_metrics WHERE app_id = ? AND workspace_id = ?', [
    appId,
    workspaceId,
  ]);
}

const FORBIDDEN =
  'The RevenueCat key may not read metrics. Give the secret API key the permission to read Charts & Metrics (charts_metrics:overview:read) in RevenueCat, then sync again. Products and offerings are not affected.';

/** The fixed sentence and code of a failed metrics read. A forbidden key gets the metrics-specific sentence. */
export function metricsFailureOf(
  error: unknown,
  secret: string,
): Extract<RevenueCatMetricsStep, { ok: false }> {
  const f = revenueCatFailure(error, secret);
  if (f.ok)
    return {
      ok: false,
      code: 'revenuecat_unavailable',
      message: 'The RevenueCat metrics could not be read. Try again in a moment.',
    };
  const wait = f.body.retryAfterSeconds;
  const forbidden = error instanceof RevenueCatError && error.kind === 'forbidden';
  return {
    ok: false,
    code: String(f.body.error),
    message: forbidden ? FORBIDDEN : String(f.body.message ?? f.body.error),
    ...(typeof wait === 'number' ? { retryAfterSeconds: wait } : {}),
  };
}

/**
 * Reads the overview and replaces the stored copy; a failure keeps the old figures and records only the failure. Never throws: the
 * configuration the sync read before is kept whatever happens here.
 */
export async function syncRevenueCatMetrics(
  sql: Sql,
  input: {
    client: RevenueCatClient;
    secret: string;
    workspaceId: string;
    appId: string;
    projectId: string;
    signal: AbortSignal;
    at: number;
  },
): Promise<RevenueCatMetricsStep> {
  const { workspaceId, appId, at } = input;
  try {
    const overview = await readRevenueCatOverview(
      input.client,
      { projectId: input.projectId },
      { signal: input.signal },
    );
    const stored = JSON.stringify(
      overview.metrics.map((m) => ({
        id: m.id,
        name: m.name,
        unit: m.unit,
        period: m.period,
        value: m.value,
        lastUpdatedAt: m.lastUpdatedAt,
      })),
    );
    await sql.execute(
      `INSERT INTO revenuecat_metrics (app_id, workspace_id, project_id, currency, metrics_json, fetched_at, last_attempt_at, last_error, failures)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
       ON CONFLICT (app_id) DO UPDATE SET workspace_id = excluded.workspace_id, project_id = excluded.project_id,
         currency = excluded.currency, metrics_json = excluded.metrics_json, fetched_at = excluded.fetched_at,
         last_attempt_at = excluded.last_attempt_at, last_error = NULL, failures = 0`,
      [appId, workspaceId, input.projectId, overview.currency, stored, at, at],
    );
    return { ok: true, metrics: overview.metrics.length, fetchedAt: at };
  } catch (error) {
    const step = input.signal.aborted
      ? ({
          ok: false,
          code: 'timeout',
          message: 'RevenueCat did not answer in time. Try again in a minute.',
        } as const)
      : metricsFailureOf(error, input.secret);
    try {
      const streak = step.code === 'rate_limited' ? 0 : 1;
      // A row for a project whose first read failed has no figures and no time; a row of an earlier good read keeps both.
      await sql.execute(
        `INSERT INTO revenuecat_metrics (app_id, workspace_id, project_id, last_attempt_at, last_error, failures)
         VALUES (?, ?, ?, ?, ?, ${streak})
         ON CONFLICT (app_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
           failures = revenuecat_metrics.failures + ${streak}`,
        [appId, workspaceId, input.projectId, at, step.message.slice(0, 500)],
      );
    } catch {
      // The failure is still answered; a failed note about it must not hide it.
    }
    return step;
  }
}
