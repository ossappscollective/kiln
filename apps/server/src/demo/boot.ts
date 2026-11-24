import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDatabase, type Database, migrate } from '@kiln/db';
import { Hono } from 'hono';
import { type AppDeps, createApp } from '../app.ts';
import type { AppEnv } from '../http.ts';
import { createWorker } from '../jobs.ts';
import { runAlertEvaluator } from '../modules/alerts/evaluator.ts';
import { ALERT_PASS_INTERVAL_MS, createAlertRunner } from '../modules/alerts/runner.ts';
import {
  ANALYTICS_SYNC_QUEUE,
  createAnalyticsSyncHandler,
  DEFAULT_ANALYTICS_TIMEOUT_MS,
} from '../modules/analytics/sync.ts';
import {
  COMPETITOR_REVIEWS_QUEUE,
  createCompetitorReviewsHandler,
} from '../modules/aso/competitor-review-schedule.ts';
import {
  ASO_REFRESH_QUEUE,
  createAsoRefreshHandler,
  DEFAULT_ASO_LIMITS,
} from '../modules/aso/service.ts';
import { CI_POLL_QUEUE, createCiContext, createCiPollHandler } from '../modules/ci/service.ts';
import {
  createListingReadHandler,
  DEFAULT_LISTING_TIMEOUT_MS,
  LISTING_READ_QUEUE,
} from '../modules/listing/schedule.ts';
import {
  createReviewSyncHandler,
  DEFAULT_REVIEW_TIMEOUT_MS,
  REVIEW_SYNC_QUEUE,
} from '../modules/reviews/sync.ts';
import { createEventStreamHub } from '../routes/events.ts';
import { createScheduler } from '../scheduler.ts';
import { APP_SYNC_QUEUE, createAppSyncHandler, DEFAULT_SYNC_TIMEOUT_MS } from '../services/apps.ts';
import { createTestLimiter } from '../services/credential-tests.ts';
import { DEFAULT_REPO_TIMEOUT_MS } from '../services/repositories.ts';
import { createWebhookHandler, WEBHOOK_QUEUE } from '../services/webhooks.ts';
import { VERSION } from '../version.ts';
import { DEMO_MARKER, type DemoConfig, hasDemoMarker } from './config.ts';
import { createSeams } from './connectors.ts';
import { createDemoRoutes } from './routes.ts';
import { seedDemo } from './seed.ts';
import { DemoWorld } from './world.ts';

export type DemoRuntime = {
  /** The whole server: demo routes first, then the app (API and web UI). */
  app: Hono<AppEnv>;
  db: Database;
  world: DemoWorld;
  config: DemoConfig;
  warnings: string[];
  reset(): Promise<void>;
  close(): Promise<void>;
  /** Writes the simulated stores to disk now. */
  save(): Promise<void>;
  seededAt(): number | null;
};

const cheap = { N: 1024, r: 8, p: 1 };

async function prepareDir(config: DemoConfig) {
  await mkdir(config.dataDir, { recursive: true });
  if (!hasDemoMarker(config.dataDir))
    await writeFile(
      join(config.dataDir, DEMO_MARKER),
      `${JSON.stringify({ kind: 'kiln demo data', note: 'Safe to delete. Made by KILN_DEMO.' })}\n`,
    );
}

export async function wipe(config: DemoConfig) {
  for (const name of await readdir(config.dataDir).catch(() => [] as string[])) {
    if (name === DEMO_MARKER) continue;
    await rm(join(config.dataDir, name), { recursive: true, force: true });
  }
}

/**
 * Builds the demo server: database, simulated stores, the app with every write switch on, the job worker and the scheduler,
 * and the first seed when the workspace is empty. Nothing here reads the environment.
 */
export async function createDemoRuntime(
  config: DemoConfig,
  options: { worker?: boolean } = {},
): Promise<DemoRuntime> {
  await prepareDir(config);
  const outer = new Hono<AppEnv>();
  const warnings: string[] = [];
  let current: Inner | undefined;
  let dirty: ReturnType<typeof setTimeout> | undefined;

  type Inner = {
    db: Database;
    world: DemoWorld;
    app: Hono<AppEnv>;
    stop: () => Promise<void>;
    seededAt: number | null;
  };

  async function build(): Promise<Inner> {
    const db = await createDatabase(config.databaseUrl);
    await migrate(db);
    const hasWorkspace =
      ((await db.query('SELECT COUNT(*) AS n FROM workspaces'))[0]?.n as
        | number
        | bigint
        | undefined) ?? 0;
    const saved = await DemoWorld.load(config.worldFile);
    const fresh = Number(hasWorkspace) === 0;
    const world = new DemoWorld(fresh || !saved ? Date.now() : saved.seededAt);
    if (!fresh && saved) world.restore(saved);
    if (!fresh && !saved)
      warnings.push(
        'The demo database exists but its simulated stores were lost: the stores start from their seeded state. Run `pnpm demo:reset` to start clean.',
      );

    const seams = createSeams(world);
    const eventStreams = createEventStreamHub();
    const now = world.now;
    const port = config.port;
    const deps: AppDeps = {
      db,
      masterKey: config.masterKey,
      version: `${VERSION}-demo`,
      now,
      cost: cheap,
      eventStreams,
      trustedOrigins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
      ...(config.webDist && existsSync(config.webDist) ? { webDist: config.webDist } : {}),
      connectorFactory: seams.connectorFactory as never,
      credentialTests: { verifiers: seams.verifiers, now },
      appSync: {
        connectorFactory: seams.syncFactory,
        limiter: createTestLimiter({ now, limit: 600 }),
      },
      reviews: {
        connectorFactory: seams.reviewFactory as never,
        ratingFetcher: null,
        limiter: createTestLimiter({ now, limit: 600 }),
        reply: { enabled: true, connectorFactory: seams.reviewFactory as never },
      },
      rollout: { enabled: true, connectorFactory: seams.rolloutFactory },
      storeDraft: { enabled: true, connectorFactory: seams.draftFactory },
      storeSubmit: { enabled: true, connectorFactory: seams.submitFactory },
      storeRelease: { enabled: true, connectorFactory: seams.releaseFactory },
      storePublish: { enabled: true },
      aso: {
        sources: seams.aso,
        limits: DEFAULT_ASO_LIMITS,
        limiter: createTestLimiter({ now, limit: 600 }),
      },
      analytics: {
        connectors: seams.analytics,
        limiter: createTestLimiter({ now, limit: 600 }),
        intervalMinutes: 0,
      },
      translation: {
        fetch: seams.translateFetch,
        resolve: seams.resolve,
        limiter: createTestLimiter({ now, limit: 600 }),
      },
      ai: {
        enabled: true,
        clientFactory: () => seams.ai(),
        resolve: seams.resolve,
        limiter: createTestLimiter({ now, limit: 600 }),
      },
      webhooks: {
        resolve: seams.resolve,
        send: async () => ({
          ok: true,
          status: 200,
          body: 'received by the demo (nothing left this machine)',
        }),
      },
      assets: {
        limiter: createTestLimiter({ now, limit: 600 }),
        icons: { net: { resolve: seams.resolve, exchange: seams.exchange } },
      },
      ci: {
        limiter: createTestLimiter({ now, limit: 600 }),
        activeLimiter: createTestLimiter({ now, limit: 600 }),
      },
      // Test builds: the demo's artifacts are a few hundred bytes, so downloads are on (KILN_BUILDS_DOWNLOAD_ENABLED=false turns them
      // off to see that state), TestFlight links and Google Play internal sharing come from the simulated stores, and nobody is there to
      // confirm a hard action with a passkey.
      builds: {
        downloadEnabled: !/^(false|0)$/i.test(
          process.env.KILN_BUILDS_DOWNLOAD_ENABLED?.trim() ?? '',
        ),
        maxDownloadBytes: 5 * 1024 * 1024,
        internalSharingEnabled: true,
        storeConnectorFactory: seams.flightFactory,
        internalSharingConnectorFactory: seams.sharingFactory,
      },
      stepUpAutoApprove: true,
    };
    const app = createApp(deps);

    if (fresh) {
      const result = await seedDemo({ app, db, world });
      for (const w of result.warnings) warnings.push(`seed: ${w}`);
      await world.save(config.worldFile);
    }
    const seededRow = (await db.query('SELECT MIN(created_at) AS t FROM workspaces'))[0]?.t;
    const seededAt = seededRow === null || seededRow === undefined ? null : world.seededAt;

    let stop = async () => {};
    if (options.worker !== false) {
      const ci = createCiContext({
        db,
        masterKey: config.masterKey,
        now,
        connectorFactory: seams.connectorFactory as never,
        timeoutMs: DEFAULT_REPO_TIMEOUT_MS,
      });
      const worker = createWorker({
        sql: db,
        now,
        handlers: {
          [APP_SYNC_QUEUE]: createAppSyncHandler({
            db,
            masterKey: config.masterKey,
            now,
            connectorFactory: seams.syncFactory,
            timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
          }),
          [LISTING_READ_QUEUE]: createListingReadHandler({
            db,
            masterKey: config.masterKey,
            now,
            connectorFactory: seams.syncFactory,
            timeoutMs: DEFAULT_LISTING_TIMEOUT_MS,
            intervalMs: 0,
          }),
          [REVIEW_SYNC_QUEUE]: createReviewSyncHandler({
            db,
            masterKey: config.masterKey,
            now,
            connectorFactory: seams.reviewFactory as never,
            timeoutMs: DEFAULT_REVIEW_TIMEOUT_MS,
            translation: { fetch: seams.translateFetch, resolve: seams.resolve } as never,
          }),
          [ASO_REFRESH_QUEUE]: createAsoRefreshHandler({
            db,
            now,
            sources: seams.aso,
            limits: DEFAULT_ASO_LIMITS,
          }),
          [COMPETITOR_REVIEWS_QUEUE]: createCompetitorReviewsHandler({ db, now, sources: seams.aso }),
          [ANALYTICS_SYNC_QUEUE]: createAnalyticsSyncHandler({
            db,
            masterKey: config.masterKey,
            now,
            connectors: seams.analytics,
            timeoutMs: DEFAULT_ANALYTICS_TIMEOUT_MS,
          }),
          [WEBHOOK_QUEUE]: createWebhookHandler({
            db,
            masterKey: config.masterKey,
            now,
            allowPrivate: false,
            resolve: seams.resolve,
            send: async () => ({ ok: true, status: 200, body: 'received by the demo' }),
          } as never),
          [CI_POLL_QUEUE]: createCiPollHandler(ci),
        },
        onError: (message, error) => console.error(`[demo] ${message}`, error),
      });
      worker.start();
      // Release watch (stalled releases, unanswered reviews) runs every 15 minutes of the real clock, and the alert evaluator every five
      // (state alerts; the digests and the pruning ride with it). Nothing else is scheduled: syncs happen when a person asks, so the
      // simulated stores only change when the demo says so.
      const alerts = {
        intervalMs: ALERT_PASS_INTERVAL_MS,
        run: createAlertRunner({ db, now, onError: (m, e) => console.error(`[demo] ${m}`, e) }).run,
      };
      const scheduler = createScheduler({
        db,
        now,
        releaseWatchIntervalMs: 15 * 60_000,
        reminderIntervalMs: 15 * 60_000,
        alerts,
        onError: (m: string, e: unknown) => console.error(`[demo] ${m}`, e),
      } as never);
      scheduler.start();
      stop = async () => {
        await scheduler.stop();
        await worker.stop();
      };
    }
    return {
      db,
      world,
      app,
      stop: async () => {
        await stop();
        await db.close();
      },
      seededAt,
    };
  }

  const save = async () => {
    if (current) await current.world.save(config.worldFile);
  };
  const markDirty = () => {
    if (dirty) clearTimeout(dirty);
    dirty = setTimeout(
      () =>
        void save().catch((e) => console.error('[demo] could not save the simulated stores', e)),
      400,
    );
    dirty.unref?.();
  };

  current = await build();

  const doReset = async () => {
    const old = current as Inner;
    current = undefined;
    await old.stop();
    await wipe(config);
    current = await build();
  };

  const routes = createDemoRoutes({
    get db() {
      return (current as Inner).db;
    },
    get world() {
      return (current as Inner).world;
    },
    now: () => (current as Inner).world.now(),
    reset: doReset,
    seededAt: () => current?.seededAt ?? null,
    save: markDirty,
    evaluateAlerts: () => runAlertEvaluator((current as Inner).db, (current as Inner).world.now()),
    trustedOrigins: [`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`],
  } as never);
  outer.route('/demo', routes);
  outer.route('/api/demo', routes);
  outer.all('*', async (c) => {
    if (!current)
      return c.json(
        { error: 'resetting', message: 'The demo is resetting. Try again in a few seconds.' },
        503,
      );
    const res = await current.app.fetch(c.req.raw);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') markDirty();
    return res;
  });

  return {
    app: outer,
    get db() {
      return (current as Inner).db;
    },
    get world() {
      return (current as Inner).world;
    },
    config,
    warnings,
    reset: doReset,
    async close() {
      if (dirty) clearTimeout(dirty);
      await save();
      await current?.stop();
      current = undefined;
    },
    save,
    seededAt: () => current?.seededAt ?? null,
  } as DemoRuntime;
}
