import type { JobHandler } from '../../jobs.ts';
import type { ServerModule } from '../module.ts';
import { testflightRoutes } from './routes.ts';
import { syncTestflight } from './service.ts';
import {
  DEFAULT_TESTFLIGHT_SYNC_TIMEOUT_MS,
  defaultTestflightConnectorFactory,
  type TestflightConnectorFactory,
  type TestflightContext,
} from './shared.ts';

export type { TestflightConnectorFactory } from './shared.ts';

/**
 * TestFlight beta feedback and crash submissions (docs/adr/0049-testflight-feedback.md, docs/api/testflight-feedback.md): Apple's feedback read from
 * App Store Connect into a stored copy (a sync, read-only toward Apple), shown per app next to the customer reviews, with local triage and two alert
 * types. Nothing is deleted or changed in App Store Connect: the design for that is in the ADR. The seams below are what tests replace.
 */
export type TestflightDeps = {
  read?:
    | {
        connectorFactory?: TestflightConnectorFactory | undefined;
        timeoutMs?: number | undefined;
      }
    | undefined;
};

export const testflightModule: ServerModule<TestflightDeps> = {
  id: 'testflight',
  mount(app, services, deps, shared) {
    const { db, masterKey, now } = services;
    app.route(
      '/api/workspaces',
      testflightRoutes({
        db,
        masterKey,
        now,
        // The budget of the app sync: a TestFlight sync is the same kind of request.
        limiter: shared.appSyncLimiter,
        readFactory: deps?.read?.connectorFactory ?? defaultTestflightConnectorFactory,
        readTimeoutMs: deps?.read?.timeoutMs ?? DEFAULT_TESTFLIGHT_SYNC_TIMEOUT_MS,
      }),
    );
  },
};

const hasIds = (value: unknown): value is { workspaceId: string; appId: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { workspaceId?: unknown }).workspaceId === 'string' &&
  typeof (value as { appId?: unknown }).appId === 'string';

/**
 * The TestFlight read that follows a scheduled review read of the same app: the scheduler queues `review.sync` jobs (modules/reviews/schedule.ts)
 * and this runs after the reviews of the job's app were read, so there is no second scheduler and no second budget. It never throws (a failure is
 * recorded on the app's TestFlight sync state) and does nothing for an app whose store has no TestFlight.
 */
export function createTestflightAfterReviews(ctx: Omit<TestflightContext, 'limiter'>): JobHandler {
  return async (payload) => {
    if (!hasIds(payload)) return;
    await syncTestflight(
      { ...ctx, limiter: { take: () => 0 } },
      { workspaceId: payload.workspaceId, appId: payload.appId, actor: { type: 'system', id: 'testflight.sync' } },
    ).catch(() => undefined);
  };
}

/** Runs the review read of a `review.sync` job, then the TestFlight read of the same app. Each never throws, so the second always runs. */
export const reviewThenTestflight =
  (reviews: JobHandler, testflight: JobHandler): JobHandler =>
  async (payload, job) => {
    await reviews(payload, job);
    await testflight(payload, job);
  };
