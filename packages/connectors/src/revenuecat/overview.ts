import type { RevenueCatClient } from './client.ts';

/**
 * The metrics overview of a RevenueCat project (docs/adr/0043-revenuecat-metrics.md): `GET /v2/projects/{project_id}/metrics/overview`,
 * a read of the Charts & Metrics domain (permission `charts_metrics:overview:read`, 25 requests a minute per key). Read only, one request.
 *
 * Confirmed from RevenueCat's API reference (https://www.revenuecat.com/docs/api-v2/charts-and-metrics, read 2026-11-21):
 * - the answer is `{ object: "overview_metrics", metrics: [...], currency }` and each metric is `{ object: "overview_metric", id, name,
 *   description, unit, period, value, last_updated_at (ms since epoch), last_updated_at_iso8601 }`;
 * - `period` is `P0D` (collected now: a current count) or `P28D` (the last 28 days); `unit` is free text (`$` in the sample);
 * - the top-level `currency` is "the currency that monetary metric values are expressed in", default USD; an optional `currency` query
 *   asks for another of 26 listed codes;
 * - from the dashboard page (https://www.revenuecat.com/docs/dashboard-and-metrics/overview): Active Trials and Active Subscriptions are
 *   current counts, MRR is current, Revenue is the gross of the last 28 days "before any store fees, taxes, etc.", New Customers and
 *   Active Customers are 28-day windows.
 *
 * UNVERIFIED (nothing ran against a real project): the metric ids other than the documented sample `active_trials` (the strip looks for
 * `active_subscriptions`, `mrr`, `revenue`, `new_customers`, `active_customers`, and falls back to the display name); whether `value` is
 * always a number (RevenueCat says MRR and revenue may be rounded to whole units and that the type "may change", so a numeric string
 * is read too and anything else is left out); whether the figures are production only (the dashboard has a sandbox toggle; the API
 * page does not say); the status RevenueCat answers when the key lacks the permission (403 is assumed, as for the configuration reads).
 */

export type RevenueCatOverviewMetric = {
  /** RevenueCat's id, verbatim. */
  id: string;
  name: string;
  /** RevenueCat's unit, verbatim (`$` for money); null when it said none. */
  unit: string | null;
  /** `P0D` (now) or `P28D` (the last 28 days), verbatim; null when it said none. */
  period: string | null;
  value: number;
  /** Ms since epoch, when RevenueCat said. */
  lastUpdatedAt: number | null;
};

export type RevenueCatOverview = {
  /** The currency of the money figures (MRR, Revenue), as RevenueCat reported it. Never converted here. */
  currency: string | null;
  metrics: RevenueCatOverviewMetric[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;
const numeric = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
};

/** Reads the overview. A metric without an id or a numeric value is left out; the others are kept in RevenueCat's order. */
export async function readRevenueCatOverview(
  client: RevenueCatClient,
  input: { projectId: string },
  options: { signal?: AbortSignal | undefined } = {},
): Promise<RevenueCatOverview> {
  const body = await client.get(
    `/projects/${encodeURIComponent(input.projectId)}/metrics/overview`,
    {},
    options,
  );
  const currency = text(body.currency, 3)?.toUpperCase() ?? null;
  const metrics: RevenueCatOverviewMetric[] = [];
  for (const item of Array.isArray(body.metrics) ? body.metrics.slice(0, 50) : []) {
    if (!isRecord(item)) continue;
    const id = text(item.id, 100);
    const value = numeric(item.value);
    if (!id || value === null) continue;
    metrics.push({
      id,
      name: text(item.name, 200) ?? id,
      unit: text(item.unit, 20),
      period: text(item.period, 20),
      value,
      lastUpdatedAt: numeric(item.last_updated_at),
    });
  }
  return { currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null, metrics };
}

/** The four figures of the strip and the ones next to them, by RevenueCat's id with the display name as a fallback. */
export type RevenueCatStripKey =
  | 'active_subscriptions'
  | 'active_trials'
  | 'mrr'
  | 'revenue'
  | 'new_customers'
  | 'active_customers';

const NAMES: Record<RevenueCatStripKey, string[]> = {
  active_subscriptions: ['active subscriptions'],
  active_trials: ['active trials'],
  mrr: ['mrr', 'monthly recurring revenue'],
  revenue: ['revenue'],
  new_customers: ['new customers'],
  active_customers: ['active customers'],
};

/** The metric for a strip figure: its documented-style id, else its display name; null when the overview has none (never zero). */
export function pickOverviewMetric(
  metrics: readonly RevenueCatOverviewMetric[],
  key: RevenueCatStripKey,
): RevenueCatOverviewMetric | null {
  const byId = metrics.find((m) => m.id.toLowerCase() === key);
  if (byId) return byId;
  return metrics.find((m) => NAMES[key].indexOf(m.name.trim().toLowerCase()) >= 0) ?? null;
}
