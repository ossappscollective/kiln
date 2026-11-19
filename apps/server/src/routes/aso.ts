import { APPLE_DOCUMENTED_CALLS_PER_MINUTE, PLAY_UNOFFICIAL_NOTICE } from '@mrm/connectors';
import {
  type Action,
  can,
  FIT_ASSUMPTIONS,
  INDEXED_FIELDS,
  isGooglePlatform,
  normalizeCountry,
} from '@mrm/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { type AppEnv, parseBody, queryInt } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { getApp } from '../services/apps.ts';
import {
  type AsoContext,
  addCompetitor,
  addKeywords,
  competitorHistory,
  deleteKeyword,
  enqueueAsoRefresh,
  getCompetitor,
  getKeyword,
  keywordHistory,
  listCompetitors,
  listKeywords,
  MAX_HISTORY_LIMIT,
  playDisabledFailure,
  refreshApp,
  removeCompetitor,
  updateKeyword,
} from '../services/aso.ts';
import {
  checkLocale,
  coachFor,
  gapsFor,
  ideasFor,
  listingFitFor,
  listingKeywordsFor,
  listingLocalesFor,
  marketsFor,
  suggestionsFor,
  summaryFor,
} from '../services/aso-insights.ts';
import { checkRankDownloadsQuery, rankVsDownloadsFor } from '../services/aso-rank-downloads.ts';
import { queueAsoRefreshAll } from '../services/aso-schedule.ts';
import { recordAudit } from '../services/audit.ts';
import type { TestLimiter } from '../services/credential-tests.ts';
import { checkSearchTermsQuery, searchTermsFor } from '../services/play-search-terms.ts';
import type { Failure } from '../services/repositories.ts';
import { rankMoveThresholdFor } from '../services/workspace-settings.ts';

export type AsoRoutesContext = AsoContext & {
  /** Store lookups and refreshes per workspace per minute (default 10, built in createApp). */
  limiter: TestLimiter;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

export const MAX_KEYWORDS_PER_REQUEST = 50;
const BODY_LIMIT = 64 * 1024;

const keywordItem = z
  .object({
    term: z.string().max(400),
    country: z.string().max(10).optional(),
    locale: z.string().max(20).optional(),
    tag: z.string().max(200).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    priority: z.number().int().min(1).max(3).optional(),
  })
  .strict();
export const addKeywordsBody = z
  .object({ keywords: z.array(keywordItem).min(1).max(MAX_KEYWORDS_PER_REQUEST) })
  .strict();
export const updateKeywordBody = z
  .object({
    tag: z.string().max(200).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    priority: z.number().int().min(1).max(3).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one of tag, notes and priority.');
export const addCompetitorBody = z
  .object({ externalId: z.string().trim().min(1).max(300), country: z.string().max(10).optional() })
  .strict();

type Issue = { path: string; message: string };
const bad = (c: Context<AppEnv>, issues: Issue[]) =>
  c.json({ error: 'invalid_request', issues }, 400);

/** ASO: keyword ranks and competitors from public store data (docs/api/aso.md). Mounted under /api/workspaces. */
export function asoRoutes(ctx: AsoRoutesContext) {
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
    c.json({ error: 'payload_too_large', message: 'The request body is too large.' }, 413);
  const limited = (c: Context<AppEnv>) => {
    const wait = ctx.limiter.take(ws(c));
    if (wait <= 0) return undefined;
    c.header('Retry-After', String(wait));
    return c.json(
      {
        error: 'rate_limited',
        message: `Too many store lookups. Try again in ${wait} seconds.`,
        retryAfterSeconds: wait,
      },
      429,
    );
  };

  /** The `locale` query parameter, or the issue to answer 400 with. */
  const localeQuery = (
    c: Context<AppEnv>,
  ): { ok: true; locale?: string } | { ok: false; issue: Issue } => {
    const raw = c.req.query('locale');
    if (raw === undefined || raw === '') return { ok: true };
    const locale = checkLocale(raw);
    return locale
      ? { ok: true, locale }
      : { ok: false, issue: { path: 'locale', message: 'A language tag such as en-US or pt-BR.' } };
  };
  const limitQuery = (c: Context<AppEnv>, fallback: number, max: number) =>
    queryInt(c.req.query('limit'), { fallback, max });

  // ----- configuration (what is switched on, the limits, the warning) ---------------------------------
  routes.get('/:workspaceId/aso/config', needs('aso.read'), async (c) =>
    c.json({
      apple: {
        enabled: true,
        source: 'iTunes Search API',
        documentedCallsPerMinute: APPLE_DOCUMENTED_CALLS_PER_MINUTE,
      },
      play: {
        enabled: ctx.sources.playEnabled,
        unofficial: true,
        // The Terms of Service warning, in the same words the docs use.
        notice: PLAY_UNOFFICIAL_NOTICE,
        howToEnable: 'The operator sets MRM_ASO_PLAY_UNOFFICIAL_ENABLED=true on the server.',
      },
      schedule: { intervalMinutes: Math.round(ctx.limits.intervalMs / 60_000) },
      retentionDays: ctx.limits.retentionDays,
      limits: {
        maxKeywordsPerApp: ctx.limits.maxKeywordsPerApp,
        maxCompetitorsPerApp: ctx.limits.maxCompetitorsPerApp,
        maxChecksPerRun: ctx.limits.maxChecksPerRun,
        rankDepth: ctx.limits.rankDepth,
        maxKeywordsPerRequest: MAX_KEYWORDS_PER_REQUEST,
      },
      rankMoveThreshold: await rankMoveThresholdFor(db, ws(c)),
    }),
  );

  // ----- the overview of one app ----------------------------------------------------------------------
  routes.get('/:workspaceId/apps/:id/aso/summary', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    return c.json(await summaryFor(db, ws(c), app, ctx.now()));
  });

  // The next steps for one app, worked out from what is stored (no store is read).
  routes.get('/:workspaceId/apps/:id/aso/coach', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    return c.json(await coachFor(db, ws(c), app, ctx.now()));
  });

  // Google Play search terms imported from a Play Console export (reads the database only; docs/api/aso.md). Never contacts a store.
  routes.get('/:workspaceId/apps/:id/aso/search-terms', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    if (!isGooglePlatform(app.platform)) {
      return c.json(
        {
          error: 'not_google_play_app',
          message: 'Search terms are a Google Play report. This app is an iOS or macOS app.',
        },
        422,
      );
    }
    const limit = queryInt(c.req.query('limit'), { fallback: 50, max: 200 });
    const locale = localeQuery(c);
    const q = (name: string) => c.req.query(name);
    const checked = checkSearchTermsQuery({
      ...(q('from') !== undefined ? { from: q('from') as string } : {}),
      ...(q('to') !== undefined ? { to: q('to') as string } : {}),
      ...(q('country') !== undefined ? { country: q('country') as string } : {}),
      ...(q('sort') !== undefined ? { sort: q('sort') as string } : {}),
      ...(locale.ok && locale.locale ? { locale: locale.locale } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const issues: Issue[] = checked.ok ? [] : checked.issues;
    if (limit === undefined)
      issues.push({ path: 'limit', message: 'A whole number from 1 to 200.' });
    if (!locale.ok) issues.push(locale.issue);
    if (!checked.ok || issues.length > 0) return bad(c, issues);
    return c.json(await searchTermsFor(db, ws(c), app, checked));
  });

  // Rank versus downloads: rank history and downloads on the same days, from stored data only (docs/api/aso.md). A correlation, never a cause.
  routes.get('/:workspaceId/apps/:id/aso/rank-vs-downloads', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const q = (name: string) => c.req.query(name);
    const checked = checkRankDownloadsQuery(
      app,
      {
        ...(q('platform') !== undefined ? { platform: q('platform') as string } : {}),
        ...(q('country') !== undefined ? { country: q('country') as string } : {}),
        ...(q('keywords') !== undefined ? { keywords: q('keywords') as string } : {}),
        ...(q('from') !== undefined ? { from: q('from') as string } : {}),
        ...(q('to') !== undefined ? { to: q('to') as string } : {}),
      },
      ctx.now(),
    );
    if (!checked.ok) return bad(c, checked.issues);
    const done = await rankVsDownloadsFor(db, ws(c), app, checked, ctx.now());
    if (!done.ok) return bad(c, done.issues);
    return c.json(done.answer);
  });

  // ----- keywords -------------------------------------------------------------------------------------
  routes.get('/:workspaceId/apps/:id/aso/keywords', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const issues: Issue[] = [];
    const filter: { country?: string; locale?: string; tag?: string } = {};
    const country = c.req.query('country');
    if (country) {
      const normalized = normalizeCountry(country);
      if (normalized) filter.country = normalized;
      else issues.push({ path: 'country', message: 'Two letters, such as us or de.' });
    }
    const locale = localeQuery(c);
    if (!locale.ok) issues.push(locale.issue);
    else if (locale.locale) filter.locale = locale.locale;
    const tag = c.req.query('tag');
    if (tag) {
      if (tag.length <= 100) filter.tag = tag;
      else issues.push({ path: 'tag', message: 'At most 100 characters.' });
    }
    if (issues.length > 0) return bad(c, issues);
    return c.json({
      keywords: await listKeywords(db, ws(c), app.id, filter),
      limits: { maxKeywordsPerApp: ctx.limits.maxKeywordsPerApp },
    });
  });

  routes.post(
    '/:workspaceId/apps/:id/aso/keywords',
    needs('aso.write'),
    bodyLimit({ maxSize: BODY_LIMIT, onError: tooLarge }),
    async (c) => {
      const app = await getApp(db, ws(c), param(c, 'id'));
      if (!app) return notFound(c);
      const body = await parseBody(c, addKeywordsBody);
      if (!body.ok) return body.response;
      const items = body.data.keywords.map((k) => ({
        term: k.term,
        ...(k.country !== undefined ? { country: k.country } : {}),
        ...(k.locale !== undefined ? { locale: k.locale } : {}),
        ...(k.tag !== undefined ? { tag: k.tag } : {}),
        ...(k.notes !== undefined ? { notes: k.notes } : {}),
        ...(k.priority !== undefined ? { priority: k.priority } : {}),
      }));
      const results = await addKeywords(ctx, { workspaceId: ws(c), app, actor: actor(c), items });
      const summary = { created: 0, exists: 0, invalid: 0, limit: 0 };
      for (const r of results) summary[r.status] += 1;
      return c.json({ results, summary }, summary.created > 0 ? 201 : 200);
    },
  );

  routes.patch('/:workspaceId/apps/:id/aso/keywords/:keywordId', needs('aso.write'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const body = await parseBody(c, updateKeywordBody);
    if (!body.ok) return body.response;
    const done = await updateKeyword(ctx, {
      workspaceId: ws(c),
      appId: app.id,
      id: param(c, 'keywordId'),
      actor: actor(c),
      ...(body.data.tag !== undefined ? { tag: body.data.tag } : {}),
      ...(body.data.notes !== undefined ? { notes: body.data.notes } : {}),
      ...(body.data.priority !== undefined ? { priority: body.data.priority } : {}),
    });
    return done.ok ? c.json({ keyword: done.keyword }) : respond(c, done);
  });

  routes.delete('/:workspaceId/apps/:id/aso/keywords/:keywordId', needs('aso.write'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const done = await deleteKeyword(ctx, {
      workspaceId: ws(c),
      appId: app.id,
      id: param(c, 'keywordId'),
      actor: actor(c),
    });
    return done ? c.body(null, 204) : notFound(c);
  });

  routes.get(
    '/:workspaceId/apps/:id/aso/keywords/:keywordId/history',
    needs('aso.read'),
    async (c) => {
      const app = await getApp(db, ws(c), param(c, 'id'));
      if (!app) return notFound(c);
      const keyword = await getKeyword(db, ws(c), app.id, param(c, 'keywordId'));
      if (!keyword) return notFound(c);
      const limit = limitQuery(c, 100, MAX_HISTORY_LIMIT);
      const sinceRaw = c.req.query('since');
      const issues: Issue[] = [];
      if (limit === undefined)
        issues.push({ path: 'limit', message: `A whole number from 1 to ${MAX_HISTORY_LIMIT}.` });
      if (sinceRaw !== undefined && sinceRaw !== '' && !/^[0-9]{1,15}$/.test(sinceRaw))
        issues.push({ path: 'since', message: 'Epoch milliseconds, a whole number.' });
      if (issues.length > 0 || limit === undefined) return bad(c, issues);
      const history = await keywordHistory(db, {
        workspaceId: ws(c),
        appId: app.id,
        keywordId: keyword.id,
        limit,
        ...(sinceRaw ? { since: Number(sinceRaw) } : {}),
      });
      return c.json({ keyword, ...history });
    },
  );

  // ----- competitors ----------------------------------------------------------------------------------
  routes.get('/:workspaceId/apps/:id/aso/competitors', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    return c.json({
      competitors: await listCompetitors(db, ws(c), app.id),
      limits: { maxCompetitorsPerApp: ctx.limits.maxCompetitorsPerApp },
    });
  });

  routes.post('/:workspaceId/apps/:id/aso/competitors', needs('aso.write'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const body = await parseBody(c, addCompetitorBody);
    if (!body.ok) return body.response;
    // Not for an app that cannot be looked up at all: no slot is spent on it.
    if (app.platform === 'android' && !ctx.sources.playEnabled)
      return respond(c, playDisabledFailure());
    const stop = limited(c);
    if (stop) return stop;
    const done = await addCompetitor(ctx, {
      workspaceId: ws(c),
      app,
      actor: actor(c),
      externalId: body.data.externalId,
      ...(body.data.country !== undefined ? { country: body.data.country } : {}),
    });
    return done.ok ? c.json({ competitor: done.competitor }, 201) : respond(c, done);
  });

  routes.delete(
    '/:workspaceId/apps/:id/aso/competitors/:competitorId',
    needs('aso.write'),
    async (c) => {
      const app = await getApp(db, ws(c), param(c, 'id'));
      if (!app) return notFound(c);
      const done = await removeCompetitor(ctx, {
        workspaceId: ws(c),
        appId: app.id,
        id: param(c, 'competitorId'),
        actor: actor(c),
      });
      return done ? c.body(null, 204) : notFound(c);
    },
  );

  routes.get(
    '/:workspaceId/apps/:id/aso/competitors/:competitorId/history',
    needs('aso.read'),
    async (c) => {
      const app = await getApp(db, ws(c), param(c, 'id'));
      if (!app) return notFound(c);
      const competitor = await getCompetitor(db, ws(c), app.id, param(c, 'competitorId'));
      if (!competitor) return notFound(c);
      const limit = limitQuery(c, 50, 500);
      if (limit === undefined)
        return bad(c, [{ path: 'limit', message: 'A whole number from 1 to 500.' }]);
      const history = await competitorHistory(db, {
        workspaceId: ws(c),
        appId: app.id,
        competitorId: competitor.id,
        limit,
      });
      return c.json({ competitor, ...history });
    },
  );

  // ----- what can be worked out from what is stored (no store is read) --------------------------------
  routes.get('/:workspaceId/apps/:id/aso/fit', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const locale = localeQuery(c);
    if (!locale.ok) return bad(c, [locale.issue]);
    const fit = await listingFitFor(db, ws(c), app, locale.locale ? { locale: locale.locale } : {});
    const stored = await listingLocalesFor(db, ws(c), app);
    return c.json({
      ...fit,
      listingLocales: stored.locales.map((l) => l.locale),
      indexedFields: INDEXED_FIELDS[app.platform],
      assumptions: FIT_ASSUMPTIONS,
    });
  });

  // The terms the listing sets, per locale: the stored text of every locale of the listing (the web works the terms out).
  routes.get('/:workspaceId/apps/:id/aso/listing-keywords', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    return c.json({
      ...(await listingKeywordsFor(db, ws(c), app)),
      indexedFields: INDEXED_FIELDS[app.platform],
    });
  });

  routes.get('/:workspaceId/apps/:id/aso/ideas', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const locale = localeQuery(c);
    const limit = limitQuery(c, 30, 100);
    const issues: Issue[] = [];
    if (!locale.ok) issues.push(locale.issue);
    if (limit === undefined)
      issues.push({ path: 'limit', message: 'A whole number from 1 to 100.' });
    if (issues.length > 0 || !locale.ok || limit === undefined) return bad(c, issues);
    return c.json(
      await ideasFor(db, ws(c), app, {
        ...(locale.locale ? { locale: locale.locale } : {}),
        limit,
      }),
    );
  });

  routes.get('/:workspaceId/apps/:id/aso/gaps', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const locale = localeQuery(c);
    const limit = limitQuery(c, 30, 100);
    const issues: Issue[] = [];
    if (!locale.ok) issues.push(locale.issue);
    if (limit === undefined)
      issues.push({ path: 'limit', message: 'A whole number from 1 to 100.' });
    if (issues.length > 0 || !locale.ok || limit === undefined) return bad(c, issues);
    return c.json(
      await gapsFor(db, ws(c), app, { ...(locale.locale ? { locale: locale.locale } : {}), limit }),
    );
  });

  routes.get('/:workspaceId/apps/:id/aso/suggestions', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const minKeywords = queryInt(c.req.query('minKeywords'), { fallback: 2, max: 50 });
    const limit = limitQuery(c, 20, 50);
    const issues: Issue[] = [];
    if (minKeywords === undefined)
      issues.push({ path: 'minKeywords', message: 'A whole number from 1 to 50.' });
    if (limit === undefined)
      issues.push({ path: 'limit', message: 'A whole number from 1 to 50.' });
    if (issues.length > 0 || minKeywords === undefined || limit === undefined)
      return bad(c, issues);
    return c.json(await suggestionsFor(db, ws(c), app, { minKeywords, limit }));
  });

  routes.get('/:workspaceId/apps/:id/aso/markets', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    return c.json({ terms: await marketsFor(db, ws(c), app.id) });
  });

  // ----- refreshing (reads the public store pages) ----------------------------------------------------
  routes.post('/:workspaceId/apps/:id/aso/refresh', needs('aso.write'), async (c) => {
    const id = param(c, 'id');
    const app = await getApp(db, ws(c), id);
    if (!app) return notFound(c);
    const scope = c.req.query('scope') ?? 'all';
    if (scope !== 'all' && scope !== 'keywords' && scope !== 'competitors') {
      return bad(c, [{ path: 'scope', message: 'Use all, keywords or competitors.' }]);
    }
    if (app.platform === 'android' && !ctx.sources.playEnabled)
      return respond(c, playDisabledFailure());
    const stop = limited(c);
    if (stop) return stop;
    if (c.req.query('background') === 'true') {
      const jobId = await enqueueAsoRefresh(ctx, {
        workspaceId: ws(c),
        appId: id,
        requestedBy: c.get('user').id,
        force: true,
        scope,
      });
      return c.json({ jobId }, 202);
    }
    const done = await refreshApp(
      ctx,
      { workspaceId: ws(c), id },
      actor(c),
      { trigger: 'request' },
      { force: true, scope },
    );
    if (!done.ok) return respond(c, done);
    return c.json({ result: done.result, state: done.state });
  });

  // Every app of the workspace: an admin's decision, because it spends the stores' goodwill on all of them.
  routes.post('/:workspaceId/aso/refresh', needs('aso.manage'), async (c) => {
    const stop = limited(c);
    if (stop) return stop;
    const summary = await queueAsoRefreshAll(db, {
      workspaceId: ws(c),
      now: ctx.now(),
      playEnabled: ctx.sources.playEnabled,
      requestedBy: c.get('user').id,
    });
    await recordAudit(db, {
      workspaceId: ws(c),
      actor: actor(c),
      action: 'aso.refresh_all',
      detail: { queued: summary.queued, skipped: summary.skipped },
      at: ctx.now(),
    });
    return c.json({ queued: summary.queued, skipped: summary.skipped }, 202);
  });

  return routes;
}
