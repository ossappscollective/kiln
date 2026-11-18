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
  type ReviewReplyConnectorFactory,
  type ReviewReplyContext,
  type TranslateDraft,
  attachReplies,
  createTemplate,
  defaultReplyConnectorFactory,
  deleteReplyDraft,
  deleteTemplate,
  getReviewView,
  listTemplates,
  replyConfig,
  replyDisabledFailure,
  saveReplyDraft,
  sendReviewReply,
  translateReplyDraft,
  updateTemplate,
} from '../services/review-replies.ts';
import {
  DEFAULT_TREND_WEEKS,
  MAX_TREND_WEEKS,
  reviewsSummary,
  workspaceReviewsSummary,
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
  type InboxFilter,
  type ReviewFilter,
  type ReviewSort,
  type ReviewStatus,
  isReviewStatus,
  listReviews,
  listWorkspaceReviews,
  reviewSorts,
  reviewStatuses,
  triageReview,
} from '../services/reviews.ts';
import { lowRatingThresholdFor } from '../services/workspace-settings.ts';

export type ReviewRoutesContext = ReviewsContext & {
  /** Reads per workspace per minute: the budget the app sync routes use (built in createApp). */
  limiter: TestLimiter;
  /** MRM_REVIEW_RETENTION_DAYS, shown to people; the pruning itself is the scheduler's. */
  retentionDays?: number;
  /**
   * Replying to reviews (a store write, docs/adr/0007-review-replies.md). `enabled` is
   * MRM_REVIEW_REPLY_ENABLED (default false). The rest is for tests and wiring: `connectorFactory`
   * builds the connector that can reply, `translateDraft` is the optional translation seam.
   */
  reply?: {
    enabled?: boolean;
    connectorFactory?: ReviewReplyConnectorFactory;
    timeoutMs?: number;
    claimTtlMs?: number;
    sendsPerHour?: number;
    translateDraft?: TranslateDraft;
  };
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const hash64 = /^[0-9a-f]{64}$/;
const draftBody = z
  .object({
    text: z.string().max(20_000).optional(),
    templateId: z.string().min(1).max(100).optional(),
  })
  .strict()
  .refine((v) => (v.text === undefined) !== (v.templateId === undefined), 'Send either text or templateId.');
const sendBody = z.object({ confirmHash: z.string().regex(hash64, 'The hash of the draft, 64 hexadecimal characters.') }).strict();
const templateBody = z.object({ name: z.string().max(200), body: z.string().max(20_000) }).strict();
const translateBody = z
  .object({
    text: z.string().min(1).max(5000),
    target: z.string().regex(/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/),
    source: z.string().regex(/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/).optional(),
  })
  .strict();

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

/** The filter of the workspace-wide inbox: everything `GET /apps/{id}/reviews` takes, and who and which apps. */
function parseInbox(c: Context<AppEnv>, userId: string, tokenApps: readonly string[] | undefined):
  | { ok: true; filter: InboxFilter; sort: ReviewSort; cursor?: string; limit: number }
  | { ok: false; issues: Issue[] } {
  const base = parseQuery(c);
  const issues: Issue[] = base.ok ? [] : [...base.issues];
  const filter: InboxFilter = base.ok ? { ...base.filter } : {};
  const asked = [...list(c, 'appIds'), ...list(c, 'appId')];
  if (asked.some((id) => !/^[A-Za-z0-9_-]{1,100}$/.test(id))) issues.push({ path: 'appIds', message: 'Not app ids.' });
  else if (asked.length > 50) issues.push({ path: 'appIds', message: 'At most 50 apps.' });
  else if (asked.length > 0 || tokenApps !== undefined) {
    const wanted = asked.length > 0 ? [...new Set(asked)] : undefined;
    // A token limited to some apps sees only those, whatever it asks for.
    filter.appIds = tokenApps === undefined ? (wanted as string[]) : wanted === undefined ? [...tokenApps] : wanted.filter((id) => tokenApps.includes(id));
  }
  const store = (base.ok ? (base.filter as InboxFilter).store : undefined) as InboxFilter['store'];
  if (store !== undefined) filter.store = store;
  const assignee = c.req.query('assignee');
  if (assignee) {
    if (assignee === 'me') filter.assigneeUserId = userId;
    else if (/^[A-Za-z0-9_-]{1,100}$/.test(assignee)) filter.assigneeUserId = assignee;
    else issues.push({ path: 'assignee', message: 'Use me or a user id.' });
  }
  const unassigned = c.req.query('unassigned');
  if (unassigned !== undefined && unassigned !== '') {
    if (unassigned === 'true' || unassigned === 'false') filter.unassigned = unassigned === 'true';
    else issues.push({ path: 'unassigned', message: 'Use true or false.' });
  }
  if (filter.assigneeUserId && filter.unassigned) issues.push({ path: 'unassigned', message: 'Not together with assignee.' });
  const unanswered = c.req.query('unanswered');
  if (unanswered !== undefined && unanswered !== '') {
    if (unanswered === 'true' || unanswered === 'false') filter.hasResponse = unanswered === 'false';
    else issues.push({ path: 'unanswered', message: 'Use true or false.' });
  }
  if (issues.length > 0 || !base.ok) return { ok: false, issues };
  return { ok: true, filter, sort: base.sort, ...(base.cursor ? { cursor: base.cursor } : {}), limit: base.limit };
}

/** Customer reviews of an app: an inbox with internal triage, and replies (off by default). Mounted under /api/workspaces. */
export function reviewRoutes(ctx: ReviewRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  const replyCtx: ReviewReplyContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    replyEnabled: ctx.reply?.enabled ?? false,
    replyConnectorFactory: ctx.reply?.connectorFactory ?? defaultReplyConnectorFactory,
    ...(ctx.reply?.timeoutMs !== undefined ? { replyTimeoutMs: ctx.reply.timeoutMs } : {}),
    ...(ctx.reply?.claimTtlMs !== undefined ? { claimTtlMs: ctx.reply.claimTtlMs } : {}),
    ...(ctx.reply?.sendsPerHour !== undefined ? { sendsPerHour: ctx.reply.sendsPerHour } : {}),
    ...(ctx.reply?.translateDraft ? { translateDraft: ctx.reply.translateDraft } : {}),
  };
  const replyOff = (c: Context<AppEnv>) => respond(c, replyDisabledFailure());

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
    return c.json({ reviews: await attachReplies(db, ws(c), page.reviews), nextCursor: page.nextCursor });
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
      lowRatingThreshold: await lowRatingThresholdFor(db, ws(c), ctx.lowRatingThreshold ?? LOW_RATING_THRESHOLD),
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

  // ----- the workspace-wide inbox (every app; an app limited token sees only its apps) -----------
  routes.get('/:workspaceId/reviews', needs('reviews.read'), async (c) => {
    const query = parseInbox(c, c.get('user').id, c.get('token')?.appIds ?? undefined);
    if (!query.ok) return c.json({ error: 'invalid_request', issues: query.issues }, 400);
    const page = await listWorkspaceReviews(db, ws(c), query.filter, {
      sort: query.sort,
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    if ('error' in page) {
      return c.json({ error: 'invalid_request', issues: [{ path: 'cursor', message: 'Not a cursor of this list and sort.' }] }, 400);
    }
    const withReplies = await attachReplies(db, ws(c), page.reviews);
    const apps = new Map(page.reviews.map((r) => [r.id, r.app]));
    return c.json({
      reviews: withReplies.map((r) => ({ ...r, app: apps.get(r.id) })),
      nextCursor: page.nextCursor,
    });
  });

  routes.get('/:workspaceId/reviews/summary', needs('reviews.read'), async (c) => {
    const summary = await workspaceReviewsSummary(db, ws(c), {
      lowRatingThreshold: await lowRatingThresholdFor(db, ws(c), ctx.lowRatingThreshold ?? LOW_RATING_THRESHOLD),
      ...((c.get('token')?.appIds ?? undefined) ? { appIds: c.get('token')?.appIds as string[] } : {}),
    });
    return c.json(summary);
  });

  // ----- replying: configuration and templates -----------------------------------------------------
  routes.get('/:workspaceId/reviews/reply-config', needs('reviews.read'), (c) => c.json(replyConfig(replyCtx)));

  routes.get('/:workspaceId/reviews/reply-templates', needs('reviews.read'), async (c) =>
    c.json({ templates: await listTemplates(db, ws(c)) }),
  );

  routes.post('/:workspaceId/reviews/reply-templates', needs('reviews.triage'), async (c) => {
    if (!replyCtx.replyEnabled) return replyOff(c);
    const body = await parseBody(c, templateBody);
    if (!body.ok) return body.response;
    const done = await createTemplate(replyCtx, { workspaceId: ws(c), ...body.data, actorId: c.get('user').id });
    if (!done.ok) return respond(c, done);
    return c.json({ template: done.template }, 201);
  });

  routes.put('/:workspaceId/reviews/reply-templates/:templateId', needs('reviews.triage'), async (c) => {
    if (!replyCtx.replyEnabled) return replyOff(c);
    const body = await parseBody(c, templateBody);
    if (!body.ok) return body.response;
    const done = await updateTemplate(replyCtx, { workspaceId: ws(c), id: param(c, 'templateId'), ...body.data });
    if (!done.ok) return respond(c, done);
    return c.json({ template: done.template });
  });

  routes.delete('/:workspaceId/reviews/reply-templates/:templateId', needs('reviews.triage'), async (c) => {
    if (!replyCtx.replyEnabled) return replyOff(c);
    const done = await deleteTemplate(replyCtx, { workspaceId: ws(c), id: param(c, 'templateId') });
    return done.ok ? c.body(null, 204) : respond(c, done);
  });

  // ----- one review, its reply draft and the send ---------------------------------------------------
  routes.get('/:workspaceId/apps/:id/reviews/:reviewId', needs('reviews.read'), async (c) => {
    const review = await getReviewView(db, ws(c), param(c, 'id'), param(c, 'reviewId'));
    if (!review || !(await getApp(db, ws(c), param(c, 'id')))) return notFound(c);
    return c.json({ review });
  });

  routes.put('/:workspaceId/apps/:id/reviews/:reviewId/reply-draft', needs('reviews.triage'), async (c) => {
    if (!replyCtx.replyEnabled) return replyOff(c);
    const body = await parseBody(c, draftBody);
    if (!body.ok) return body.response;
    const base = { workspaceId: ws(c), appId: param(c, 'id'), reviewId: param(c, 'reviewId'), actor: actor(c) };
    const done = await saveReplyDraft(
      replyCtx,
      body.data.templateId !== undefined ? { ...base, templateId: body.data.templateId } : { ...base, text: body.data.text ?? '' },
    );
    if (!done.ok) return respond(c, done);
    return c.json({ draft: done.draft });
  });

  routes.delete('/:workspaceId/apps/:id/reviews/:reviewId/reply-draft', needs('reviews.triage'), async (c) => {
    if (!replyCtx.replyEnabled) return replyOff(c);
    const done = await deleteReplyDraft(replyCtx, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      reviewId: param(c, 'reviewId'),
      actor: actor(c),
    });
    return done.ok ? c.body(null, 204) : respond(c, done);
  });

  routes.post('/:workspaceId/apps/:id/reviews/:reviewId/reply-draft/translate', needs('reviews.triage'), async (c) => {
    if (!replyCtx.replyEnabled) return replyOff(c);
    if (!(await getApp(db, ws(c), param(c, 'id')))) return notFound(c);
    const body = await parseBody(c, translateBody);
    if (!body.ok) return body.response;
    const done = await translateReplyDraft(replyCtx, { workspaceId: ws(c), ...body.data });
    return done.ok ? c.json({ text: done.text }) : respond(c, done);
  });

  // The only route that publishes anything in a store. One review per request: no bulk send.
  routes.post('/:workspaceId/apps/:id/reviews/:reviewId/reply', needs('reviews.reply'), async (c) => {
    if (!replyCtx.replyEnabled) return replyOff(c);
    const body = await parseBody(c, sendBody);
    if (!body.ok) return body.response;
    const done = await sendReviewReply(replyCtx, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      reviewId: param(c, 'reviewId'),
      confirmHash: body.data.confirmHash,
      actor: actor(c),
    });
    if (!done.ok) return respond(c, done);
    return c.json({ reply: done.reply, review: done.review, confirmedByReread: done.confirmedByReread });
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
