import {
  type Action,
  analyticsLimits,
  analyticsSources,
  can,
  isApplePlatform,
  sourcesForPlatform,
} from '@mrm/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { getPlayBucket, setPlayBucket, testPlayBucket } from '../services/analytics-bucket.ts';
import { applyEnable, previewEnable } from '../services/analytics-enable.ts';
import { applyImport, previewImport } from '../services/analytics-import.ts';
import { checkOverviewQuery, overview, status } from '../services/analytics-query.ts';
import { type AnalyticsContext, syncAnalytics } from '../services/analytics-sync.ts';
import { getApp } from '../services/apps.ts';
import type { TestLimiter } from '../services/credential-tests.ts';
import { applySearchTermsImport, previewSearchTermsImport } from '../services/play-search-terms.ts';
import type { Failure } from '../services/repositories.ts';
import { requireStepUp } from '../services/step-up.ts';

/**
 * Analytics: daily metrics from the stores (docs/api/analytics.md, docs/adr/0017-analytics-foundation.md). Mounted under /api/workspaces.
 *
 * - Reading (`overview`, `status`) needs `analytics.read`, which every role holds. Everything that reaches a store or stores a file
 *   (`sync`, the Apple enable action, the import) needs `analytics.manage` (admins and owners), EXPLICIT-ONLY for API tokens.
 * - Every route is about one app (`/apps/:id/analytics/...`), so a token restricted to apps is limited to its apps.
 * - Nothing here changes a store except the explicit, two step "enable Apple analytics" (a report request is created at Apple).
 */
export type AnalyticsRoutesContext = AnalyticsContext & {
  /** Syncs, previews and enables per workspace per minute (default 10, built in createApp). */
  limiter: TestLimiter;
  /** MRM_ANALYTICS_INTERVAL_MINUTES, shown by `status`. */
  intervalMinutes: number;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

/** A path of the import routes, Apple reports and Google Play search terms (the one place a body may be larger than the API's usual limit). */
export const analyticsImportPath =
  /^\/api\/workspaces\/[^/]+\/apps\/[^/]+\/analytics\/(import|search-terms\/import)(\/preview)?$/;
const IMPORT_BODY_LIMIT = analyticsLimits.maxFileBytes + 1024;

export const syncBody = z
  .object({
    sources: z.array(z.enum(analyticsSources)).min(1).max(analyticsSources.length).optional(),
  })
  .strict();
export const enableBody = z
  .object({
    confirmHash: z.string().regex(/^[0-9a-f]{64}$/),
    backfill: z.boolean().optional(),
    stepUp: z.string().max(200).optional(),
  })
  .strict();

/** `bucket`: `gs://pubsite_prod_rev_<digits>/` or the bare id (validated by the service: `bucket_invalid`), or null to clear. */
export const playBucketBody = z
  .object({
    bucket: z.string().trim().max(200).nullable(),
    scope: z.enum(['account', 'app']).optional(),
  })
  .strict();
export const playBucketTestBody = z
  .object({ bucket: z.string().trim().max(200).optional() })
  .strict();

type Issue = { path: string; message: string };
const bad = (c: Context<AppEnv>, issues: Issue[]) =>
  c.json({ error: 'invalid_request', issues }, 400);

export function analyticsRoutes(ctx: AnalyticsRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const notFound = (c: Context<AppEnv>) => c.json({ error: 'not_found' }, 404);
  const tooLarge = (c: Context) =>
    c.json({ error: 'payload_too_large', message: 'The file is too large.' }, 413);
  const limited = (c: Context<AppEnv>) => {
    const wait = ctx.limiter.take(ws(c));
    if (wait <= 0) return undefined;
    c.header('Retry-After', String(wait));
    return c.json(
      {
        error: 'rate_limited',
        message: `Too many analytics requests. Try again in ${wait} seconds.`,
        retryAfterSeconds: wait,
      },
      429,
    );
  };

  routes.get('/:workspaceId/apps/:id/analytics/overview', needs('analytics.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const q = (name: string) => c.req.query(name);
    const query = {
      ...(q('platform') !== undefined ? { platform: q('platform') as string } : {}),
      ...(q('from') !== undefined ? { from: q('from') as string } : {}),
      ...(q('to') !== undefined ? { to: q('to') as string } : {}),
      ...(q('granularity') !== undefined ? { granularity: q('granularity') as string } : {}),
      ...(q('breakdown') !== undefined ? { breakdown: q('breakdown') as string } : {}),
    };
    const checked = checkOverviewQuery(app, query, ctx.now());
    if (!checked.ok) return c.json(checked.body, checked.status);
    return c.json(
      await overview(db, {
        workspaceId: ws(c),
        app,
        from: checked.from,
        to: checked.to,
        granularity: checked.granularity,
        ...(checked.breakdown ? { breakdown: checked.breakdown } : {}),
        now: ctx.now(),
      }),
    );
  });

  routes.get('/:workspaceId/apps/:id/analytics/status', needs('analytics.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    return c.json(
      await status(db, { workspaceId: ws(c), app, intervalMinutes: ctx.intervalMinutes }),
    );
  });

  routes.post(
    '/:workspaceId/apps/:id/analytics/sync',
    needs('analytics.manage'),
    bodyLimit({ maxSize: 4 * 1024, onError: tooLarge }),
    async (c) => {
      const app = await getApp(db, ws(c), param(c, 'id'));
      if (!app) return notFound(c);
      const raw = await c.req.text();
      let sources: ReturnType<typeof sourcesForPlatform> | undefined;
      if (raw.trim() !== '') {
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          return bad(c, [{ path: 'body', message: 'Send JSON, or no body.' }]);
        }
        const parsed = syncBody.safeParse(json);
        if (!parsed.success)
          return bad(
            c,
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          );
        const allowed = sourcesForPlatform(app.platform);
        const wrong = (parsed.data.sources ?? []).filter((s) => !allowed.includes(s));
        if (wrong.length > 0)
          return bad(c, [
            {
              path: 'sources',
              message: `Not a source of a ${app.platform} app: ${wrong.join(', ')}.`,
            },
          ]);
        sources = parsed.data.sources;
      }
      const wait = limited(c);
      if (wait) return wait;
      const done = await syncAnalytics(ctx, { workspaceId: ws(c), appId: app.id }, actor(c), {
        trigger: 'manual',
        ...(sources ? { sources } : {}),
      });
      if (!done.ok) return respond(c, done);
      return c.json({
        sync: done.sync,
        status: await status(db, { workspaceId: ws(c), app, intervalMinutes: ctx.intervalMinutes }),
      });
    },
  );

  // ----- Google Play reports bucket (one per developer account, shared by its Android apps) ---------------
  routes.get('/:workspaceId/apps/:id/analytics/play-bucket', needs('analytics.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    if (isApplePlatform(app.platform))
      return c.json(
        { error: 'not_an_android_app', message: 'The Play reports bucket is for Android apps.' },
        422,
      );
    return c.json({ playBucket: await getPlayBucket(db, ws(c), app) });
  });

  routes.put(
    '/:workspaceId/apps/:id/analytics/play-bucket',
    needs('analytics.manage'),
    bodyLimit({ maxSize: 1024, onError: tooLarge }),
    async (c) => {
      const body = await parseBody(c, playBucketBody);
      if (!body.ok) return body.response;
      const done = await setPlayBucket(
        db,
        ctx.now,
        {
          workspaceId: ws(c),
          appId: param(c, 'id'),
          bucket: body.data.bucket,
          scope: body.data.scope ?? 'app',
        },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      return c.json({ playBucket: done.view });
    },
  );

  routes.post(
    '/:workspaceId/apps/:id/analytics/play-bucket/test',
    needs('analytics.manage'),
    bodyLimit({ maxSize: 1024, onError: tooLarge }),
    async (c) => {
      const raw = await c.req.text();
      let json: unknown = {};
      if (raw.trim() !== '') {
        try {
          json = JSON.parse(raw);
        } catch {
          return bad(c, [{ path: 'body', message: 'Send JSON, or no body.' }]);
        }
      }
      const parsed = playBucketTestBody.safeParse(json);
      if (!parsed.success)
        return bad(
          c,
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      const wait = limited(c);
      if (wait) return wait;
      const done = await testPlayBucket(
        ctx,
        {
          workspaceId: ws(c),
          appId: param(c, 'id'),
          ...(parsed.data.bucket !== undefined ? { bucket: parsed.data.bucket } : {}),
        },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      return c.json({ result: done.result });
    },
  );

  // ----- Apple: enable analytics (the one store write), preview then confirm ------------------------------
  routes.get(
    '/:workspaceId/apps/:id/analytics/apple/enable',
    needs('analytics.manage'),
    async (c) => {
      const wait = limited(c);
      if (wait) return wait;
      const backfill = c.req.query('backfill') === 'true';
      const done = await previewEnable(
        ctx,
        { workspaceId: ws(c), appId: param(c, 'id'), backfill },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      return c.json({ plan: done.plan, confirmHash: done.confirmHash, canCreate: done.canCreate });
    },
  );

  routes.post(
    '/:workspaceId/apps/:id/analytics/apple/enable',
    needs('analytics.manage'),
    bodyLimit({ maxSize: 4 * 1024, onError: tooLarge }),
    async (c) => {
      const stepUpRefusal = await requireStepUp({ db, now: ctx.now }, c, 'analytics.enable_apple', {
        id: param(c, 'id'),
        hashField: 'confirmHash',
      });
      if (stepUpRefusal) return stepUpRefusal;
      const body = await parseBody(c, enableBody);
      if (!body.ok) return body.response;
      const wait = limited(c);
      if (wait) return wait;
      const done = await applyEnable(
        ctx,
        {
          workspaceId: ws(c),
          appId: param(c, 'id'),
          backfill: body.data.backfill === true,
          confirmHash: body.data.confirmHash,
        },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      return c.json({ enabled: { steps: done.steps, appleMode: done.appleMode } }, 201);
    },
  );

  // ----- Import a report file (raw body) ---------------------------------------------------------------------
  const fileName = (
    c: Context<AppEnv>,
  ): { ok: true; name?: string } | { ok: false; issue: Issue } => {
    const raw = c.req.query('fileName');
    if (raw === undefined || raw === '') return { ok: true };
    return raw.length <= 200
      ? { ok: true, name: raw }
      : { ok: false, issue: { path: 'fileName', message: 'At most 200 characters.' } };
  };
  const fileBytes = async (c: Context<AppEnv>): Promise<Uint8Array | undefined> => {
    const buffer = await c.req.arrayBuffer().catch(() => undefined);
    return buffer && buffer.byteLength > 0 ? new Uint8Array(buffer) : undefined;
  };

  routes.post(
    '/:workspaceId/apps/:id/analytics/import/preview',
    needs('analytics.manage'),
    bodyLimit({ maxSize: IMPORT_BODY_LIMIT, onError: tooLarge }),
    async (c) => {
      const app = await getApp(db, ws(c), param(c, 'id'));
      if (!app) return notFound(c);
      const name = fileName(c);
      if (!name.ok) return bad(c, [name.issue]);
      const bytes = await fileBytes(c);
      if (!bytes)
        return bad(c, [{ path: 'body', message: 'Send the report file as the request body.' }]);
      const wait = limited(c);
      if (wait) return wait;
      const done = await previewImport(db, {
        workspaceId: ws(c),
        appId: app.id,
        bytes,
        ...(name.name ? { fileName: name.name } : {}),
      });
      if (!done.ok) return respond(c, done);
      return c.json({ plan: done.plan, confirmHash: done.confirmHash });
    },
  );

  routes.post(
    '/:workspaceId/apps/:id/analytics/import',
    needs('analytics.manage'),
    bodyLimit({ maxSize: IMPORT_BODY_LIMIT, onError: tooLarge }),
    async (c) => {
      const app = await getApp(db, ws(c), param(c, 'id'));
      if (!app) return notFound(c);
      const name = fileName(c);
      if (!name.ok) return bad(c, [name.issue]);
      const confirmHash = c.req.query('confirmHash') ?? '';
      if (!/^[0-9a-f]{64}$/.test(confirmHash))
        return bad(c, [{ path: 'confirmHash', message: 'Send the confirmHash of the preview.' }]);
      const bytes = await fileBytes(c);
      if (!bytes)
        return bad(c, [{ path: 'body', message: 'Send the report file as the request body.' }]);
      const wait = limited(c);
      if (wait) return wait;
      const done = await applyImport(
        db,
        ctx.now,
        {
          workspaceId: ws(c),
          appId: app.id,
          bytes,
          confirmHash,
          ...(name.name ? { fileName: name.name } : {}),
        },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      return c.json(
        {
          imported: {
            source: done.source,
            points: done.points,
            written: done.written,
            unchanged: done.unchanged,
            dateFrom: done.dateFrom,
            dateTo: done.dateTo,
          },
        },
        201,
      );
    },
  );

  // ----- Import a Google Play search terms export (raw body: .csv, .zip or .gz; docs/api/aso.md) -----------------
  const periodQuery = (
    c: Context<AppEnv>,
  ): { ok: true; from?: string; to?: string } | { ok: false; issue: Issue } => {
    const from = c.req.query('from');
    const to = c.req.query('to');
    const given = (v: string | undefined) => v !== undefined && v !== '';
    if (given(from) !== given(to))
      return {
        ok: false,
        issue: { path: given(from) ? 'to' : 'from', message: 'Send both from and to, or neither.' },
      };
    return { ok: true, ...(given(from) ? { from: from as string, to: to as string } : {}) };
  };

  routes.post(
    '/:workspaceId/apps/:id/analytics/search-terms/import/preview',
    needs('analytics.manage'),
    bodyLimit({ maxSize: IMPORT_BODY_LIMIT, onError: tooLarge }),
    async (c) => {
      const app = await getApp(db, ws(c), param(c, 'id'));
      if (!app) return notFound(c);
      const period = periodQuery(c);
      if (!period.ok) return bad(c, [period.issue]);
      const bytes = await fileBytes(c);
      if (!bytes)
        return bad(c, [{ path: 'body', message: 'Send the exported file as the request body.' }]);
      const wait = limited(c);
      if (wait) return wait;
      const done = await previewSearchTermsImport(db, {
        workspaceId: ws(c),
        appId: app.id,
        bytes,
        ...(period.from ? { from: period.from, to: period.to } : {}),
      });
      if (!done.ok) return respond(c, done);
      return c.json({ plan: done.plan, confirmHash: done.confirmHash });
    },
  );

  routes.post(
    '/:workspaceId/apps/:id/analytics/search-terms/import',
    needs('analytics.manage'),
    bodyLimit({ maxSize: IMPORT_BODY_LIMIT, onError: tooLarge }),
    async (c) => {
      const app = await getApp(db, ws(c), param(c, 'id'));
      if (!app) return notFound(c);
      const period = periodQuery(c);
      if (!period.ok) return bad(c, [period.issue]);
      const confirmHash = c.req.query('confirmHash') ?? '';
      if (!/^[0-9a-f]{64}$/.test(confirmHash))
        return bad(c, [{ path: 'confirmHash', message: 'Send the confirmHash of the preview.' }]);
      const bytes = await fileBytes(c);
      if (!bytes)
        return bad(c, [{ path: 'body', message: 'Send the exported file as the request body.' }]);
      const wait = limited(c);
      if (wait) return wait;
      const done = await applySearchTermsImport(
        db,
        ctx.now,
        {
          workspaceId: ws(c),
          appId: app.id,
          bytes,
          confirmHash,
          ...(period.from ? { from: period.from, to: period.to } : {}),
        },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      return c.json(
        {
          imported: {
            rows: done.rows,
            written: done.written,
            unchanged: done.unchanged,
            dateFrom: done.dateFrom,
            dateTo: done.dateTo,
          },
        },
        201,
      );
    },
  );

  return routes;
}
