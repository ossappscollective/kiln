import {
  type AnalyticsOverview,
  type AnalyticsStatus,
  DEFAULT_RANGE,
  previousRange,
  type ResolvedRange,
  resolveRange,
} from './analytics.ts';
import { buildStrip, hasStoredData, type Strip } from './view.ts';
import type { Api } from '../api.ts';

/**
 * Reads for the Analytics screen and the dashboard strip. Reading only: nothing here reaches a store. Per app record there
 * are two reads for the screen (this period with the app-version breakdown, and the previous period for the comparison) and,
 * only when the app is on and has stored data, two for the strip's page (the status, then one overview).
 */

export type AnalyticsReads = Pick<Api, 'analyticsStatus' | 'analyticsOverview'>;

export type Loaded = { current: AnalyticsOverview; previous: AnalyticsOverview | null };

/** The current period (with the app-version breakdown) and the previous one. A failed previous read only loses the comparison. */
export async function loadOverviews(
  api: AnalyticsReads,
  workspaceId: string,
  app: { id: string; platform: string },
  range: ResolvedRange,
): Promise<Loaded> {
  const before = previousRange(range);
  const [current, previous] = await Promise.all([
    api.analyticsOverview(workspaceId, app.id, {
      platform: app.platform,
      from: range.from,
      to: range.to,
      granularity: 'day',
      breakdown: 'app_version',
    }),
    api
      .analyticsOverview(workspaceId, app.id, {
        platform: app.platform,
        from: before.from,
        to: before.to,
        granularity: 'day',
      })
      .then((o): AnalyticsOverview | null => o)
      .catch(() => null),
  ]);
  return { current, previous };
}

/**
 * The "Last 28 days" strip of the dashboard: nothing (null) when analytics is off, has no data, or a read fails. One status read,
 * then one overview read only when there is data to show.
 */
export async function loadStrip(
  api: AnalyticsReads,
  workspaceId: string,
  app: { id: string; platform: string },
  now: number,
): Promise<Strip | null> {
  try {
    const status: AnalyticsStatus = await api.analyticsStatus(workspaceId, app.id);
    if (!status.enabled || !hasStoredData(status)) return null;
    const range = resolveRange(DEFAULT_RANGE, now);
    const overview = await api.analyticsOverview(workspaceId, app.id, {
      platform: app.platform,
      from: range.from,
      to: range.to,
      granularity: 'day',
    });
    return buildStrip(overview);
  } catch {
    return null;
  }
}
