import { type Action, can } from '@mrm/core';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody, queryInt } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { getApp } from '../services/apps.ts';
import { recordAudit } from '../services/audit.ts';
import type { TestLimiter } from '../services/credential-tests.ts';
import type { Failure } from '../services/repositories.ts';
import {
  DEFAULT_TREND_WEEKS,
  MAX_TREND_WEEKS,
  reviewsSummary,
} from '../services/review-summary.ts';
import {
  type ReviewsContext,
  LOW_RATING_THRESHOLD,
  enqueueReviewSync,
  getSyncState,
  storeFor,
  syncReviews,
} from '../services/review-sync.ts';
import {
  DEFAULT_REVIEWS_PAGE,
  MAX_REVIEWS_PAGE,
  MAX_NOTE_LENGTH,
  MAX_SEARCH_LENGTH,
  type ReviewFilter,
  type ReviewSort,
  type ReviewStatus,
  isReviewStatus,
  listReviews,
  reviewSorts,
  reviewStatuses,
  triageReview,
} from '../services/reviews.ts';

export type ReviewRoutesContext = ReviewsContext & {
  /** Reads per workspace per minute: the budget the app sync routes use (built in createApp). */
  limiter: TestLimiter;
  /** MRM_REVIEW_RETENTION_DAYS, shown to people; the pruning itself is the scheduler's. */
  retentionDays?: number;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const triageBody = z
  .object({
    status: z.enum(reviewStatuses).optional(),
    assigneeUserId: z.string().min(1).max(100).nullable().optional(),
    internalNote: z.string().max(MAX_NOTE_LENGTH).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one of status, assigneeUserId and internalNote.');

type Issue = { path: string; message: string };

/** A comma separated or repeated query parameter as a list of strings. */
const list = (c: Context<AppEnv>, name: string): string[] =>
  (c.req.queries(name) ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v !== '');

const epoch = (raw: string | undefined): number | undefined | 'bad' => {
  if (raw === undefined || raw === '') return undefined;
  return /^[0-9]{1,15}$/.test(raw) ? Number(raw) : 'bad';
};

/** The filter and paging of `GET /reviews`, or the issues to answer 400 with. */
function parseQuery(c: Context<AppEnv>):
  | { ok: true; filter: ReviewFilter; sort: ReviewSort; cursor?: string; limit: number }
  | { ok: false; issues: Issue[] } {
  const issues: Issue[] = [];
  const filter: ReviewFilter = {};
  const ratings = list(c, 'rating');
  if (ratings.length > 0) {
    if (ratings.every((r) => /^[1-5]$/.test(r))) filter.ratings = [...new Set(ratings.map(Number))];
    else issues.push({ path: 'rating', message: 'Use whole numbers from 1 to 5, for example rating=1,2.' });
  }
  const territory = c.req.query('territory');
  if (territory) {
    if (/^[A-Za-z0-9_-]{1,10}$/.test(territory)) filter.territory = territory.toUpperCase();
    else issues.push({ path: 'territory', message: 'Not a territory code.' });
  }
  const language = c.req.query('language');
  if (language) {
    if (/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/.test(language)) filter.language = language;
    else issues.push({ path: 'language', message: 'Not a language code.' });
  }
  const version = c.req.query('version');
  if (version) {
    if (version.length <= 100) filter.version = version;
    else issues.push({ path: 'version', message: 'At most 100 characters.' });
  }
  const statuses = list(c, 'status');
  if (statuses.length > 0) {
    if (statuses.every(isReviewStatus)) filter.statuses = [...new Set(statuses)] as ReviewStatus[];
    else issues.push({ path: 'status', message: `Use ${reviewStatuses.join(', ')}.` });
  }
  const hasResponse = c.req.query('hasResponse');
  if (hasResponse !== undefined && hasResponse !== '') {
    if (hasResponse === 'true' || hasResponse === 'false') filter.hasResponse = hasResponse === 'true';
    else issues.push({ path: 'hasResponse', message: 'Use true or false.' });
  }
  const q = c.req.query('q')?.trim();
  if (q) {
    if (q.length <= MAX_SEARCH_LENGTH) filter.q = q;
    else issues.push({ path: 'q', message: `At most ${MAX_SEARCH_LENGTH} characters.` });
  }
  for (const name of ['since', 'until'] as const) {
    const value = epoch(c.req.query(name));
    if (value === 'bad') issues.push({ path: name, message: 'Epoch milliseconds, a whole number.' });
    else if (value !== undefined) filter[name] = value;
  }
  const store = c.req.query('store');
  const platform = c.req.query('platform');
  const sortRaw = c.req.query('sort') ?? 'newest';
  const sort = (reviewSorts as readonly string[]).includes(sortRaw) ? (sortRaw as ReviewSort) : undefined;
  if (!sort) issues.push({ path: 'sort', message: `Use ${reviewSorts.join(', ')}.` });
  if (store !== undefined && store !== '' && store !== 'appstoreconnect' && store !== 'googleplay') {
    issues.push({ path: 'store', message: 'Use appstoreconnect or googleplay.' });
  }
  if (platform !== undefined && platform !== '' && platform !== 'ios' && platform !== 'android') {
    issues.push({ path: 'platform', message: 'Use ios or android.' });
  }
  const limit = queryInt(c.req.query('limit'), { fallback: DEFAULT_REVIEWS_PAGE, max: MAX_REVIEWS_PAGE });
  if (limit === undefined) issues.push({ path: 'limit', message: `A whole number from 1 to ${MAX_REVIEWS_PAGE}.` });
  const cursor = c.req.query('cursor');
  if (issues.length > 0 || !sort || limit === undefined) return { ok: false, issues };
  // `store` and `platform` narrow to a store; an app has one, so they only ever empty the list.
  if (store || platform) {
    (filter as ReviewFilter & { store?: string }).store = store || (platform === 'ios' ? 'appstoreconnect' : 'googleplay');
  }
  return { ok: true, filter, sort, ...(cursor ? { cursor } : {}), limit };
}

/** Customer reviews of an app: a read-only inbox with internal triage. Mounted under /api/workspaces. */
export function reviewRoutes(ctx: ReviewRoutesContext) {
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

  routes.get('/:workspaceId/apps/:id/reviews', needs('reviews.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const query = parseQuery(c);
    if (!query.ok) return c.json({ error: 'invalid_request', issues: query.issues }, 400);
    const storeFilter = (query.filter as ReviewFilter & { store?: string }).store;
    if (storeFilter !== undefined && storeFilter !== storeFor(app.platform)) {
      return c.json({ reviews: [], nextCursor: null });
    }
    const { store: _ignored, ...filter } = query.filter as ReviewFilter & { store?: string };
    const page = await listReviews(db, ws(c), app.id, filter, {
      sort: query.sort,
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    if ('error' in page) {
      return c.json({ error: 'invalid_request', issues: [{ path: 'cursor', message: 'Not a cursor of this list and sort.' }] }, 400);
    }
    return c.json(page);
  });

  routes.get('/:workspaceId/apps/:id/reviews/summary', needs('reviews.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const weeks = queryInt(c.req.query('weeks'), { fallback: DEFAULT_TREND_WEEKS, max: MAX_TREND_WEEKS });
    if (weeks === undefined) {
      return c.json({ error: 'invalid_request', issues: [{ path: 'weeks', message: `A whole number from 1 to ${MAX_TREND_WEEKS}.` }] }, 400);
    }
    const store = storeFor(app.platform);
    const summary = await reviewsSummary(db, ws(c), app.id, ctx.now(), { weeks });
    return c.json({
      app: { id: app.id, platform: app.platform, store },
      stored: summary.stored,
      storeWide: summary.storeWide,
      byStatus: summary.byStatus,
      sync: await getSyncState(db, ws(c), app.id, store),
      lowRatingThreshold: ctx.lowRatingThreshold ?? LOW_RATING_THRESHOLD,
      retentionDays: ctx.retentionDays ?? null,
    });
  });

  routes.post('/:workspaceId/apps/:id/reviews/sync', needs('reviews.sync'), async (c) => {
    const id = param(c, 'id');
    // An unknown id is a 404 and costs no slot; a known one is counted before any decrypting or
    // network call.
    if (!(await getApp(db, ws(c), id))) return notFound(c);
    const wait = ctx.limiter.take(ws(c));
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(
        { error: 'rate_limited', message: `Too many syncs. Try again in ${wait} seconds.`, retryAfterSeconds: wait },
        429,
      );
    }
    if (c.req.query('background') === 'true') {
      const jobId = await enqueueReviewSync(ctx, { workspaceId: ws(c), appId: id, requestedBy: c.get('user').id });
      return c.json({ jobId }, 202);
    }
    const done = await syncReviews(ctx, { workspaceId: ws(c), id }, actor(c));
    if (!done.ok) return respond(c, done);
    return c.json({ sync: done.sync, state: done.state });
  });

  routes.patch('/:workspaceId/apps/:id/reviews/:reviewId', needs('reviews.triage'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const body = await parseBody(c, triageBody);
    if (!body.ok) return body.response;
    const at = ctx.now();
    const done = await db.transaction(async (tx) => {
      const result = await triageReview(tx, {
        workspaceId: ws(c),
        appId: app.id,
        id: param(c, 'reviewId'),
        actorId: c.get('user').id,
        at,
        ...body.data,
      });
      if (!result.ok) return result;
      if (result.changed.length > 0) {
        // Which fields changed and the status and assignee; never the note or the review text.
        await recordAudit(tx, {
          workspaceId: ws(c),
          actor: actor(c),
          action: 'review.triage',
          target: { type: 'review', id: result.review.id },
          detail: {
            appId: app.id,
            changed: result.changed,
            ...(result.changed.includes('status') ? { statusFrom: result.from.status, statusTo: result.review.status } : {}),
            ...(result.changed.includes('assignee')
              ? { assigneeFrom: result.from.assigneeUserId, assigneeTo: result.review.assigneeUserId }
              : {}),
          },
          at,
        });
      }
      return result;
    });
    if (!done.ok) {
      return done.error === 'not_found'
        ? notFound(c)
        : c.json({ error: 'assignee_not_member', message: 'The assignee is not a member of this workspace.' }, 422);
    }
    return c.json({ review: done.review });
  });

  return routes;
}
