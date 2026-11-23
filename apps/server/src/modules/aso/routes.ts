import { createHash } from 'node:crypto';
import { APPLE_DOCUMENTED_CALLS_PER_MINUTE, PLAY_UNOFFICIAL_NOTICE } from '@kiln/connectors';
import {
  type Action,
  can,
  COMPETITOR_CHANGE_RETENTION_DAYS,
  FIT_ASSUMPTIONS,
  INDEXED_FIELDS,
  normalizeCountry,
  supports,
} from '@kiln/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { type AppEnv, parseBody, queryInt } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import { checkSearchTermsQuery, searchTermsFor } from '../../services/play-search-terms.ts';
import type { Failure } from '../../services/repositories.ts';
import { rankMoveThresholdFor } from '../../services/workspace-settings.ts';
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
} from './insights.ts';
import {
  COMPETITOR_REVIEW_RETENTION_DAYS,
  competitorReviewStats,
  ownReviewStats,
  refreshCompetitorReviews,
} from './competitor-reviews.ts';
import {
  COMPETITOR_IMAGE_REF,
  competitorImageSizeOf,
  competitorThumbnail,
  resolveSearchImage,
  resolveStoredImage,
  SEARCH_IMAGE_REF,
} from './competitor-images.ts';
import { COMPETITOR_QUERY_MAX, COMPETITOR_QUERY_MIN } from './competitor-search.ts';
import { CHANGES_PAGE_MAX, listCompetitorChanges } from './competitor-watch.ts';
import { IMAGE_TYPES, matchesEtag, safeImageHeaders } from '../listing/asset-routes.ts';
import { THUMB_CACHE_CONTROL } from '../listing/asset-sync-routes.ts';
import type { StoreImageNet } from '../listing/store-image-net.ts';
import { estimateDetail, estimatesForApp, suggestionsForApp } from './estimates.ts';
import { checkRankDownloadsQuery, rankVsDownloadsFor } from './rank-downloads.ts';
import { queueAsoRefreshAll } from './schedule.ts';
import {
  type AsoContext,
  addCompetitor,
  checkCompetitorNow,
  addKeywords,
  asoFailure,
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
  searchCompetitors,
  updateKeyword,
} from './service.ts';

import { coded } from '../../i18n/problem.ts';
export type AsoRoutesContext = AsoContext & {
  /** Store lookups and refreshes per workspace per minute (default 10, built in createApp). */
  limiter: TestLimiter;
  /** Address checks and the exchange of the competitor image proxy (tests and development). */
  net?: StoreImageNet;
  /** Thumbnails fetched from Apple's image CDN, per workspace (default 300 a minute). */
  imageLimiter?: TestLimiter;
};

const asBody = (bytes: Uint8Array) => bytes as unknown as ConstructorParameters<typeof Response>[0];

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
  const imageLimiter = ctx.imageLimiter ?? createTestLimiter({ limit: 300, now: ctx.now });
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
        ...coded('rate.lookups', { count: wait }),
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
        howToEnable: 'The operator sets KILN_ASO_PLAY_UNOFFICIAL_ENABLED=true on the server.',
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
    if (!supports(app.platform, 'searchTermsImport')) {
      return c.json(
        {
          error: 'not_google_play_app',
          message: 'Search terms are a Google Play report. This app is an iOS or macOS app.',
          ...coded('aso.playOnly'),
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

  // ----- keyword estimates (database only; docs/api/aso.md#estimates). Estimates, never Apple's or Google's popularity. ------
  routes.get('/:workspaceId/apps/:id/aso/keyword-estimates', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    return c.json(await estimatesForApp(db, ws(c), app));
  });

  routes.get('/:workspaceId/apps/:id/aso/keywords/:keywordId/estimate', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const keyword = await getKeyword(db, ws(c), app.id, param(c, 'keywordId'));
    if (!keyword) return notFound(c);
    return c.json(await estimateDetail(db, ws(c), app, keyword));
  });

  routes.get('/:workspaceId/apps/:id/aso/keyword-suggestions', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const limit = queryInt(c.req.query('limit'), { fallback: 30, max: 100 });
    const country = c.req.query('country');
    const issues: Issue[] = [];
    if (limit === undefined) issues.push({ path: 'limit', message: 'A whole number from 1 to 100.' });
    if (country !== undefined && country !== '' && !/^[a-z]{2}$/.test(country))
      issues.push({ path: 'country', message: 'Two lower case letters.' });
    if (issues.length > 0 || limit === undefined) return bad(c, issues);
    return c.json(await suggestionsForApp(db, ws(c), app, { limit, ...(country ? { country } : {}) }));
  });

  // ----- competitors ----------------------------------------------------------------------------------
  routes.get('/:workspaceId/apps/:id/aso/competitors', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    return c.json({
      competitors: await listCompetitors(db, ws(c), app.id),
      limits: { maxCompetitorsPerApp: ctx.limits.maxCompetitorsPerApp },
    });
  });

  // Search by name for an app to follow (App Store). Reads the public store (cache, rate limit), so `aso.write` like adding one; nothing is stored.
  routes.get('/:workspaceId/apps/:id/aso/competitors/search', needs('aso.write'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const q = (c.req.query('q') ?? '').replace(/\s+/g, ' ').trim();
    const rawCountry = c.req.query('country');
    const country = rawCountry === undefined || rawCountry === '' ? 'us' : normalizeCountry(rawCountry);
    const issues: Issue[] = [];
    if (q.length < COMPETITOR_QUERY_MIN || q.length > COMPETITOR_QUERY_MAX)
      issues.push({ path: 'q', message: `${COMPETITOR_QUERY_MIN} to ${COMPETITOR_QUERY_MAX} characters.` });
    if (!country) issues.push({ path: 'country', message: 'Two letters, such as us or de.' });
    if (issues.length > 0 || !country) return bad(c, issues);
    const stop = limited(c);
    if (stop) return stop;
    const done = await searchCompetitors(ctx, { workspaceId: ws(c), app, q, country });
    return done.ok
      ? c.json({ country: done.country, results: done.results, cached: done.cached })
      : respond(c, done);
  });

  routes.post('/:workspaceId/apps/:id/aso/competitors', needs('aso.write'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const body = await parseBody(c, addCompetitorBody);
    if (!body.ok) return body.response;
    // Not for an app that cannot be looked up at all: no slot is spent on it.
    if (supports(app.platform, 'unofficialSearch') && !ctx.sources.playEnabled)
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

  // ----- the listing watch of a competitor (docs/adr/0056-competitor-listing-watch.md) ------------------
  routes.get('/:workspaceId/apps/:id/aso/competitors/:competitorId/changes', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const competitor = await getCompetitor(db, ws(c), app.id, param(c, 'competitorId'));
    if (!competitor) return notFound(c);
    const limit = limitQuery(c, 10, CHANGES_PAGE_MAX);
    const rawBefore = c.req.query('before');
    const before = rawBefore === undefined || rawBefore === '' ? undefined : Number(rawBefore);
    if (limit === undefined) return bad(c, [{ path: 'limit', message: `A whole number from 1 to ${CHANGES_PAGE_MAX}.` }]);
    if (before !== undefined && !(Number.isInteger(before) && before > 0))
      return bad(c, [{ path: 'before', message: 'A time in milliseconds (the detectedAt of the last change you have).' }]);
    const page = await listCompetitorChanges(db, {
      workspaceId: ws(c),
      competitorId: competitor.id,
      limit,
      ...(before !== undefined ? { before } : {}),
    });
    return c.json({
      competitorId: competitor.id,
      // Honest about where the history starts: Kiln can only compare what it read after the competitor was followed.
      watching: competitor.store === 'app_store' ? { state: 'watched', since: competitor.addedAt } : { state: 'not_watched', reason: 'play_pages_not_read' },
      lastCheckedAt: competitor.lastCheckedAt,
      retentionDays: COMPETITOR_CHANGE_RETENTION_DAYS,
      ...page,
    });
  });

  routes.post('/:workspaceId/apps/:id/aso/competitors/:competitorId/check', needs('aso.write'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const competitor = await getCompetitor(db, ws(c), app.id, param(c, 'competitorId'));
    if (!competitor) return notFound(c);
    if (competitor.store !== 'app_store') return respond(c, (await checkCompetitorNow(ctx, { workspaceId: ws(c), app, competitorId: competitor.id })) as Failure);
    const stop = limited(c);
    if (stop) return stop;
    const done = await checkCompetitorNow(ctx, { workspaceId: ws(c), app, competitorId: competitor.id });
    if (!done) return notFound(c);
    return done.ok ? c.json({ competitorId: competitor.id, state: done.state, changes: done.changes, checkedAt: done.checkedAt }) : respond(c, done);
  });

  const imageResponse = async (c: Context<AppEnv>, url: string, etagBase: string) => {
    const size = competitorImageSizeOf(c.req.query('size'));
    const etag = `"ci-${etagBase}-${size}"`;
    if (matchesEtag(c.req.header('If-None-Match'), etag))
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': THUMB_CACHE_CONTROL, 'X-Content-Type-Options': 'nosniff' } });
    const done = await competitorThumbnail({ ...(ctx.net ? { net: ctx.net } : {}), limiter: imageLimiter }, { workspaceId: ws(c), url, size });
    if (!done.ok) return respond(c, done);
    return new Response(asBody(done.bytes), { status: 200, headers: safeImageHeaders(IMAGE_TYPES[done.format], etag, done.bytes.length, THUMB_CACHE_CONTROL) });
  };

  // A thumbnail of a stored screenshot or icon: the client sends a ref into what Kiln stored, never an address.
  routes.get('/:workspaceId/apps/:id/aso/competitors/:competitorId/image', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const competitor = await getCompetitor(db, ws(c), app.id, param(c, 'competitorId'));
    if (!competitor) return notFound(c);
    const ref = c.req.query('ref') ?? '';
    if (!COMPETITOR_IMAGE_REF.test(ref)) return bad(c, [{ path: 'ref', message: 'The ref of a stored image: icon, s.p.<n>, s.i.<n> or c.<change>.<b|a>.<icon|p|i>.<n>.' }]);
    const url = await resolveStoredImage(db, ws(c), competitor.id, ref);
    if (url === undefined) return notFound(c);
    return imageResponse(c, url, `${competitor.id}-${ref}-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`);
  });

  // The icon of a search result (the add dialog): an opaque ref the search handed out.
  routes.get('/:workspaceId/apps/:id/aso/competitors/search-image', needs('aso.write'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const ref = c.req.query('ref') ?? '';
    if (!SEARCH_IMAGE_REF.test(ref)) return bad(c, [{ path: 'ref', message: 'The iconRef of a search result.' }]);
    const url = resolveSearchImage(ref, ws(c), app.id, ctx.now());
    if (url === undefined) return notFound(c);
    return imageResponse(c, url, `s-${ref}`);
  });

  // ----- reviews of the followed competitors: Apple's public feed only ----------------------------------
  routes.get('/:workspaceId/apps/:id/aso/competitor-reviews', needs('aso.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const days = queryInt(c.req.query('days'), { fallback: 28, max: 90 });
    if (days === undefined) return bad(c, [{ path: 'days', message: 'A whole number from 1 to 90.' }]);
    const at = ctx.now();
    const stats = await competitorReviewStats(db, { workspaceId: ws(c), appId: app.id, days, now: at });
    // Our own side needs the right to read reviews; without it the comparison is left out, not guessed.
    const own = can(c.get('role'), 'reviews.read')
      ? await ownReviewStats(db, { workspaceId: ws(c), appId: app.id, days, now: at })
      : null;
    c.header('Cache-Control', 'no-store');
    return c.json({
      ...stats,
      own,
      retentionDays: COMPETITOR_REVIEW_RETENTION_DAYS,
      source: 'App Store customer reviews feed (public)',
      notice: 'Google Play has no official way to read the reviews of an app you do not own, and Kiln does not scrape it: Play competitors have no reviews here.',
    });
  });

  routes.post(
    '/:workspaceId/apps/:id/aso/competitors/:competitorId/reviews/refresh',
    needs('aso.write'),
    async (c) => {
      const app = await getApp(db, ws(c), param(c, 'id'));
      if (!app) return notFound(c);
      const competitor = await getCompetitor(db, ws(c), app.id, param(c, 'competitorId'));
      if (!competitor) return notFound(c);
      if (competitor.store !== 'app_store')
        return c.json(
          { error: 'play_reviews_not_available', message: 'Google Play has no official way to read the reviews of another app, and Kiln does not scrape it.' },
          409,
        );
      const read = ctx.sources.appleReviews?.bind(ctx.sources);
      if (!read) return respond(c, asoFailure(undefined));
      const stop = limited(c);
      if (stop) return stop;
      try {
        const done = await refreshCompetitorReviews(
          { db, now: ctx.now, read },
          { workspaceId: ws(c), competitor, actorId: c.get('user').id },
        );
        if (!done.ok) return notFound(c);
        return c.json({ competitorId: competitor.id, state: done.state, fetched: done.fetched, stored: done.stored, checkedAt: done.checkedAt });
      } catch (error) {
        return respond(c, asoFailure(error));
      }
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
    if (supports(app.platform, 'unofficialSearch') && !ctx.sources.playEnabled)
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
