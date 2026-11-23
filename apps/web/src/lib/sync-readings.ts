import { type Platform, type Role, can } from '@kiln/core';
import type { Api } from './api.ts';
import { lastReadAt } from './analytics/view.ts';
import { overallState } from './analytics/view.ts';
import type { Reading, SourceInput, SyncKind } from './sync-sources.ts';

/**
 * What each source last read, for the Status popover and the quiet "Updated X ago" line of a page. Everything comes from the sources' own STORED
 * status (our database): nothing here reaches a store. A source the role may not read, that does not apply to the record, or whose read failed
 * (the request, not the source) simply has no row. Pure of the DOM; the api is injected.
 */
type ReadApi = Pick<Api, 'appReviewsSummary' | 'easStatus' | 'analyticsStatus' | 'appProducts' | 'appTestflight'>;
type AppLike = { id: string; platform: Platform; lastSyncedAt: number | null; lastSyncAttemptAt: number | null; lastSyncError: string | null };

const attempt = (lastReadAt: number | null, lastAttemptAt: number | null, error: string | null | undefined): Reading => ({
  lastReadAt,
  lastAttemptAt,
  failed: error !== null && error !== undefined && error !== '',
});

export async function loadReadings(
  api: ReadApi,
  workspaceId: string,
  role: Role,
  apps: readonly AppLike[],
  kinds: readonly SyncKind[],
): Promise<SourceInput[]> {
  const out: SourceInput[] = [];
  const one = async (app: AppLike, kind: SyncKind): Promise<void> => {
    const add = (reading: Reading) => void out.push({ appId: app.id, platform: app.platform, kind, reading });
    try {
      if (kind === 'app') {
        add(attempt(app.lastSyncedAt, app.lastSyncAttemptAt, app.lastSyncError));
      } else if (kind === 'reviews' && can(role, 'reviews.read')) {
        const s = (await api.appReviewsSummary(workspaceId, app.id)).sync;
        add(attempt(s.lastSuccessAt, s.lastAttemptAt, s.lastError));
      } else if (kind === 'eas' && can(role, 'builds.read')) {
        const s = (await api.easStatus(workspaceId, app.id)).status;
        if (s.project) add(attempt(s.sync.readAt, s.sync.lastAttemptAt, s.sync.lastError));
      } else if (kind === 'analytics' && can(role, 'analytics.read')) {
        const s = await api.analyticsStatus(workspaceId, app.id);
        if (s.enabled) add({ lastReadAt: lastReadAt(s), lastAttemptAt: null, failed: overallState(s) === 'error' });
      } else if (kind === 'products' && can(role, 'apps.read')) {
        const s = (await api.appProducts(workspaceId, app.id)).sync;
        if (s) add(attempt(s.lastSyncedAt, s.lastAttemptAt, s.lastError));
      } else if (kind === 'testflight' && app.platform === 'ios' && can(role, 'reviews.read')) {
        const s = (await api.appTestflight(workspaceId, app.id, 'limit=1')).sync;
        if (s) add(attempt(s.lastSyncedAt, s.lastAttemptAt, s.lastError));
      }
    } catch {
      // The request failed (not applicable, not allowed, offline): the source has no row rather than a wrong one.
    }
  };
  await Promise.all(apps.flatMap((a) => kinds.map((k) => one(a, k))));
  return out;
}
