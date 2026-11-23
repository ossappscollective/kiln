import { type Action, can, listingStoreOf } from '@kiln/core';
import type { Database } from '@kiln/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { coded } from '../../i18n/problem.ts';
import { type AppEnv, parseBody } from '../../http.ts';
import { enqueue } from '../../jobs.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';
import type { Failure } from '../../services/repositories.ts';
import type { AdsDeps } from './index.ts';
import { getAdsLink, readAdAccounts, removeAdsLink, setAdsLink } from './link.ts';
import { ADS_SYNC_QUEUE, adsRangeFor, notLinkedFailure } from './sync.ts';
import { adsCampaigns, adsOverview, adsTerms, getAdsSync, parseWindow, TERM_SORTS } from './view.ts';

/** The body of `PUT .../apps/{appId}/ads`: the Apple Ads credential, the ad account and (optionally) the Apple id of the app. */
export const setAdsLinkBody = z.strictObject({
  credentialId: z.string().min(1).max(100),
  adAccountId: z.string().regex(/^[0-9]{1,20}$/, 'An ad account id is a number.'),
  adamId: z.string().regex(/^[0-9]{5,15}$/, "The Apple id is the number in the app's App Store address.").optional(),
});

/** The body of `POST .../apps/{appId}/ads/sync`. */
export const adsSyncBody = z.strictObject({ days: z.number().int().min(1).max(90).optional() });

const windowQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const termsQuery = windowQuery.extend({
  kind: z.enum(['term', 'keyword']).default('term'),
  country: z.string().regex(/^[a-z]{2}$/).optional(),
  campaignId: z.string().regex(/^[0-9]{1,20}$/).optional(),
  q: z.string().max(100).optional(),
  sort: z.enum(TERM_SORTS).default('impressions'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });
const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

export type AdsRoutesContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  deps: AdsDeps | undefined;
  limiter: TestLimiter;
  syncLimiter: TestLimiter;
};

const tooMany = (wait: number) =>
  ({
    ok: false,
    status: 429,
    body: { error: 'rate_limited', message: `Too many Apple Ads checks. Try again in ${wait} seconds.`, ...coded('rate.ads', { count: wait }), retryAfterSeconds: wait },
    headers: { 'Retry-After': String(wait) },
  }) satisfies Failure;

/**
 * Apple Ads of one app (docs/api/apple-ads.md). Reading the link needs `apps.read`; linking and unlinking need `apps.write`; a sync needs
 * `apps.sync`; the views of Insights need `aso.read`. Only the link calls and the sync reach Apple, and only to read.
 */
export function adsRoutes(ctx: AdsRoutesContext) {
  const { db, masterKey, now, deps } = ctx;
  const app = new Hono<AppEnv>();
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const appOf = (c: Context<AppEnv>) => getApp(db, ws(c), param(c, 'appId'));
  const bad = (c: Context<AppEnv>, error: z.ZodError) =>
    c.json({ error: 'invalid_request', issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 400);

  app.get('/:workspaceId/apps/:appId/ads', needs('apps.read'), async (c) => {
    const found = await appOf(c);
    if (!found) return c.json({ error: 'not_found' }, 404);
    return c.json({
      supported: listingStoreOf(found.platform) === 'app_store',
      link: await getAdsLink(db, ws(c), found.id),
      sync: await getAdsSync(db, ws(c), found.id),
    });
  });

  app.get('/:workspaceId/apps/:appId/ads/accounts', needs('apps.write'), async (c) => {
    const found = await appOf(c);
    if (!found) return c.json({ error: 'not_found' }, 404);
    const credentialId = c.req.query('credentialId') ?? '';
    if (credentialId === '' || credentialId.length > 100) return c.json({ error: 'invalid_request', issues: [{ path: 'credentialId', message: 'Choose an Apple Ads credential.' }] }, 400);
    const wait = ctx.limiter.take(ws(c));
    if (wait > 0) return respond(c, tooMany(wait));
    const done = await readAdAccounts({ db, masterKey, now, deps }, { workspaceId: ws(c), appId: found.id, credentialId }, actor(c));
    return done.ok ? c.json({ accounts: done.accounts }) : respond(c, done);
  });

  app.put('/:workspaceId/apps/:appId/ads', needs('apps.write'), async (c) => {
    const body = await parseBody(c, setAdsLinkBody);
    if (!body.ok) return body.response;
    if (!(await appOf(c))) return c.json({ error: 'not_found' }, 404);
    const wait = ctx.limiter.take(ws(c));
    if (wait > 0) return respond(c, tooMany(wait));
    const done = await setAdsLink({ db, masterKey, now, deps }, { workspaceId: ws(c), appId: param(c, 'appId'), ...body.data }, actor(c));
    return done.ok ? c.json({ link: done.link }) : respond(c, done);
  });

  app.delete('/:workspaceId/apps/:appId/ads', needs('apps.write'), async (c) => {
    if (!(await appOf(c))) return c.json({ error: 'not_found' }, 404);
    const removed = await removeAdsLink({ db, now }, { workspaceId: ws(c), appId: param(c, 'appId') }, actor(c));
    return removed ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  app.post('/:workspaceId/apps/:appId/ads/sync', needs('apps.sync'), async (c) => {
    const raw = await c.req.text();
    let json: unknown = {};
    if (raw.trim() !== '') {
      try {
        json = JSON.parse(raw);
      } catch {
        return c.json({ error: 'invalid_request', issues: [{ path: '', message: 'The body is not JSON.' }] }, 400);
      }
    }
    const parsed = adsSyncBody.safeParse(json);
    if (!parsed.success) return bad(c, parsed.error);
    const found = await appOf(c);
    if (!found) return c.json({ error: 'not_found' }, 404);
    if (listingStoreOf(found.platform) !== 'app_store') return respond(c, { ok: false, status: 422, body: { error: 'ads_not_supported', message: 'Apple Ads is for App Store apps. This app is not one.', ...coded('ads.notSupported') } });
    if (!(await getAdsLink(db, ws(c), found.id))) return respond(c, notLinkedFailure());
    const [queued] = await db.query("SELECT id FROM jobs WHERE queue = ? AND status IN ('queued', 'running') AND payload LIKE ?", [ADS_SYNC_QUEUE, `%"appId":"${found.id.replace(/[%_"\\]/g, '')}"%`]);
    if (queued) return c.json({ queued: false, reason: 'already_queued' }, 200);
    const wait = ctx.syncLimiter.take(ws(c));
    if (wait > 0) return respond(c, tooMany(wait));
    const jobId = await enqueue(db, ADS_SYNC_QUEUE, { workspaceId: ws(c), appId: found.id, requestedBy: c.get('user').id, ...(parsed.data.days ? { days: parsed.data.days } : {}) }, { now: now() });
    return c.json({ queued: true, jobId }, 202);
  });

  /** The link and the default window (the last 30 days of the last read, else ending yesterday) of a view, or the response that says why not. */
  const viewOf = async (c: Context<AppEnv>, from: string | undefined, to: string | undefined) => {
    const found = await appOf(c);
    if (!found) return { response: c.json({ error: 'not_found' }, 404) };
    const link = await getAdsLink(db, ws(c), found.id);
    if (!link) return { response: respond(c, notLinkedFailure()) };
    const sync = await getAdsSync(db, ws(c), found.id);
    const window = parseWindow(from, to, sync?.rangeEnd ?? adsRangeFor(now(), 1).end);
    if (!window) return { response: c.json({ error: 'invalid_request', issues: [{ path: 'from', message: 'Use dates as YYYY-MM-DD, from before to, at most a year apart.' }] }, 400) };
    return { appId: found.id, link, sync, window };
  };

  app.get('/:workspaceId/apps/:appId/ads/overview', needs('aso.read'), async (c) => {
    const q = windowQuery.safeParse(c.req.query());
    if (!q.success) return bad(c, q.error);
    const v = await viewOf(c, q.data.from, q.data.to);
    if ('response' in v) return v.response;
    return c.json({ sync: v.sync, overview: await adsOverview(db, ws(c), v.appId, v.link, v.window) });
  });

  app.get('/:workspaceId/apps/:appId/ads/campaigns', needs('aso.read'), async (c) => {
    const q = windowQuery.safeParse(c.req.query());
    if (!q.success) return bad(c, q.error);
    const v = await viewOf(c, q.data.from, q.data.to);
    if ('response' in v) return v.response;
    return c.json({ currency: v.link.currency, window: v.window, sync: v.sync, campaigns: await adsCampaigns(db, ws(c), v.appId, v.link, v.window) });
  });

  app.get('/:workspaceId/apps/:appId/ads/terms', needs('aso.read'), async (c) => {
    const q = termsQuery.safeParse(c.req.query());
    if (!q.success) return bad(c, q.error);
    const v = await viewOf(c, q.data.from, q.data.to);
    if ('response' in v) return v.response;
    const { from: _from, to: _to, ...rest } = q.data;
    const result = await adsTerms(db, ws(c), v.appId, v.link, { ...rest, window: v.window });
    return c.json({ currency: v.link.currency, window: v.window, sync: v.sync, kind: q.data.kind, limit: q.data.limit, offset: q.data.offset, ...result });
  });

  return app;
}
