import { type Action, type Platform, type Role, can } from '@kiln/core';
import type { Api } from './api.ts';
import { ApiError } from './api.ts';
import type { RunState, SyncKind, SyncPlanEntry } from './sync-sources.ts';

/**
 * The header's one Sync for an app record, in the order of docs/adr/0050-sync-pipeline.md: the store listing and release state first (run
 * directly, so the releases are on screen when it ends), then the rest of the server's queue in one request (`POST /apps/:id/sync-all?without=app`:
 * reviews, EAS, analytics, critical first), then the two kinds that have no queue yet (products with the RevenueCat figures, TestFlight feedback).
 * A kind the role may not run, or that does not apply, is left out and reported; a failure of one never stops the others.
 */
export type ClientKind = Extract<SyncKind, 'products' | 'testflight'>;

type RunApi = Pick<Api, 'syncAppAll' | 'syncAppProducts' | 'syncAppTestflight'>;

/** The kinds the browser runs after the queue, for this record and role. Pure. */
export function clientKinds(platform: Platform, allowed: (action: Action) => boolean): ClientKind[] {
  const out: ClientKind[] = [];
  if (allowed('apps.sync')) out.push('products');
  if (allowed('apps.sync') && platform === 'ios') out.push('testflight');
  return out;
}

export type EverythingResult = { plan: SyncPlanEntry[]; extra: Partial<Record<ClientKind, RunState>>; problem: string | null };

/** `onextra` is told when a client kind starts and ends, so the Status popover can show each kind's progress. */
export async function syncRest(
  api: RunApi,
  workspaceId: string,
  app: { id: string; platform: Platform },
  role: Role,
  onextra?: (kind: ClientKind, state: RunState) => void,
): Promise<EverythingResult> {
  const result: EverythingResult = { plan: [], extra: {}, problem: null };
  try {
    result.plan = (await api.syncAppAll(workspaceId, app.id, 'app')).plan;
  } catch (e) {
    result.problem = e instanceof ApiError ? e.message : String(e);
  }
  for (const kind of clientKinds(app.platform, (a) => can(role, a))) {
    onextra?.(kind, 'running');
    let state: RunState = 'done';
    try {
      if (kind === 'products') await api.syncAppProducts(workspaceId, app.id);
      else await api.syncAppTestflight(workspaceId, app.id);
    } catch (e) {
      // A store that has no products or no TestFlight is not a failure of the sync: 4xx means "does not apply here".
      state = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429 ? 'skipped' : 'failed';
    }
    result.extra[kind] = state;
    onextra?.(kind, state);
  }
  return result;
}
