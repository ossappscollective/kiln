import type { Context, Hono, Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import type { Failure } from '../../services/repositories.ts';
import {
  getAssetProposal,
  isReleaseLabel,
  type ProposalContext,
  type ProposalQuery,
  setProposalState,
  stageProposal,
} from './asset-proposal.ts';
import { getProposalSummary } from './asset-proposal-summary.ts';
import {
  AFTER_STAGE_DEADLINE_MS,
  STAGE_BUDGET_MS,
  STAGE_DEADLINE_MS,
  withinDeadline,
  withinStageDeadline,
} from './compare-deadline.ts';

/**
 * The routes of the release asset proposal (docs/api/release-asset-proposal.md). Mounted by `assetSyncRoutes`, which owns the contexts and the
 * helpers (`needs`, `gate`) used here.
 */
export type ProposalRoutesDeps = {
  ctx: ProposalContext;
  needs: (
    action: 'listing.read' | 'changesets.write',
  ) => (c: Context<AppEnv>, next: Next) => Promise<unknown>;
  gate: (c: Context<AppEnv>) => () => Failure | undefined;
  respond: (c: Context<AppEnv>, f: Failure) => Response;
  /** The time limit of the proposal and stage reads (default `COMPARE_DEADLINE_MS`; tests make it short). */
  deadlineMs?: number | undefined;
};

const label = z.string().max(40).refine(isReleaseLabel, 'A version or track name.');
const build = z.string().regex(/^[A-Za-z0-9._-]{1,40}$/, 'A build number.');
const queryShape = z
  .object({ version: label.optional(), track: label.optional(), build: build.optional() })
  .strict();
const stageBody = z
  .object({
    version: label.nullable().optional(),
    track: label.nullable().optional(),
    build: build.nullable().optional(),
    itemIds: z.array(z.string().min(3).max(200)).min(1).max(400),
    acceptIssues: z.boolean().optional(),
    addLanguages: z.array(z.string().min(2).max(20)).max(60).optional(),
  })
  .strict();
const decideBody = z
  .object({
    version: label.nullable().optional(),
    track: label.nullable().optional(),
    mode: z.enum(['skip', 'later', 'reopen']),
  })
  .strict();

const queryOf = (v: {
  version?: string | null | undefined;
  track?: string | null | undefined;
  build?: string | null | undefined;
}): ProposalQuery => ({
  version: v.version ?? null,
  track: v.track ?? null,
  build: v.build ?? null,
});

export function mountAssetProposalRoutes(routes: Hono<AppEnv>, deps: ProposalRoutesDeps): void {
  const { ctx, needs, gate, respond, deadlineMs } = deps;
  const ws = (c: Context<AppEnv>) => c.req.param('workspaceId') ?? '';
  const appId = (c: Context<AppEnv>) => c.req.param('id') ?? '';
  const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });
  const base = '/:workspaceId/apps/:id/release/asset-proposal';

  routes.get(base, needs('listing.read'), async (c) => {
    const parsed = queryShape.safeParse({
      ...(c.req.query('version') !== undefined ? { version: c.req.query('version') } : {}),
      ...(c.req.query('track') !== undefined ? { track: c.req.query('track') } : {}),
      ...(c.req.query('build') !== undefined ? { build: c.req.query('build') } : {}),
    });
    if (!parsed.success)
      return c.json(
        {
          error: 'invalid_request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    const done = await withinDeadline(
      getAssetProposal(ctx, {
        workspaceId: ws(c),
        appId: appId(c),
        query: queryOf(parsed.data),
        actor: actor(c),
        gate: gate(c),
      }),
      deadlineMs,
    );
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ proposal: done.view }) : respond(c, done);
  });

  // The count only (the Releases list): cached, one computation at a time, a time limit; no item and no text leaves the server.
  routes.get(`${base}/summary`, needs('listing.read'), async (c) => {
    const done = await getProposalSummary(ctx, {
      workspaceId: ws(c),
      appId: appId(c),
      actor: actor(c),
      gate: gate(c),
    });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ summary: done.summary }) : respond(c, done);
  });

  routes.post(`${base}/stage`, needs('changesets.write'), async (c) => {
    const body = await parseBody(c, stageBody);
    if (!body.ok) return body.response;
    // Bounded as a whole (a hanging repository or store must not keep the button busy for ever): the item loop stops at its budget and
    // answers the items it did not reach `failed` / `stage_timeout`; the request stops at the deadline with `504 stage_timeout`.
    const stageMs = deadlineMs === undefined ? STAGE_DEADLINE_MS : deadlineMs * 2;
    const done = await withinStageDeadline(
      stageProposal(ctx, {
        workspaceId: ws(c),
        appId: appId(c),
        query: queryOf(body.data),
        itemIds: body.data.itemIds,
        acceptIssues: body.data.acceptIssues === true,
        ...(body.data.addLanguages ? { addLanguages: body.data.addLanguages } : {}),
        actor: actor(c),
        gate: gate(c),
        budgetMs: deadlineMs === undefined ? STAGE_BUDGET_MS : Math.floor(stageMs * 0.75),
      }),
      stageMs,
    );
    if (!done.ok) return respond(c, done);
    // The proposal as it stands now (what is left, and what is in the cart), so the card needs no second request. Left out when it is slow:
    // the staged items are saved either way and the card reads again.
    const after = await withinDeadline(
      getAssetProposal(ctx, {
        workspaceId: ws(c),
        appId: appId(c),
        query: queryOf(body.data),
        actor: actor(c),
        gate: gate(c),
      }),
      deadlineMs === undefined ? AFTER_STAGE_DEADLINE_MS : deadlineMs,
    );
    c.header('Cache-Control', 'no-store');
    return c.json({ results: done.results, ...(after.ok ? { proposal: after.view } : {}) });
  });

  routes.post(`${base}/dismiss`, needs('changesets.write'), async (c) => {
    const body = await parseBody(c, decideBody);
    if (!body.ok) return body.response;
    const done = await setProposalState(
      ctx.staged.db,
      {
        workspaceId: ws(c),
        appId: appId(c),
        query: queryOf(body.data),
        mode: body.data.mode,
        actor: actor(c),
      },
      ctx.staged.now(),
    );
    return done.ok ? c.json({ state: done.state }) : respond(c, done);
  });
}
