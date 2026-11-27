import { CURRENT_READINESS_TTL_MS, type CurrentReadiness } from '@kiln/core';
import { getApp } from '../../services/apps.ts';
import { emitCacheEvent, registerMapCache } from '../../services/cache-registry.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { type DraftContext, previewDraftPush } from './store-draft.ts';
import { readComplianceBlockers, readStateForPlan, type SubmitContext } from './store-submit.ts';
import { submitReadinessOf } from './submit-readiness.ts';

export type { CurrentReadiness };
/**
 * What stands in the way of a submit NOW, read from the store as it is now (docs/api/pending.md "Current readiness").
 *
 * The blockers a publish run keeps (`lastPublish.results[].blockers`) are true of the moment the run made them: a person who removes
 * two screenshots in App Store Connect, fills a locale or adds the review contact afterwards does not change that record. This is the
 * answer to "and now?": ONE fresh read of the store (the version, the build, every locale with its texts and its sets of screenshots, the
 * review information) plus the staged push (when something is staged, as `predictDraft` would leave the draft), judged by the same pure
 * rules as the submit and the plan (`submitReadinessOf`, `evaluateDraftContent` of `@kiln/core`). The browser owns no rule.
 *
 * Kept for `CURRENT_READINESS_TTL_MS` (`@kiln/core` timings: the browser's reading derives from the same value) per app. It declares the events
 * that make it stale: `store_read` ("Read again", "Check again"), `sync`, `publish`, `release_changed` (a version was created),
 * `build_changed` (the build to submit changed) and `staged_changed` (the staged push is judged as the push would leave the draft).
 */
export { CURRENT_READINESS_TTL_MS };

const cache = new Map<string, { at: number; value: CurrentReadiness }>();
const keyOf = (workspaceId: string, appId: string) => `${workspaceId}|${appId}`;

registerMapCache(cache, {
  name: 'publish.current_readiness',
  owner: 'modules/publish/current-readiness.ts',
  ttlMs: CURRENT_READINESS_TTL_MS,
  invalidatedBy: [
    'store_read',
    'sync',
    'publish',
    'release_changed',
    'build_changed',
    'staged_changed',
  ],
  keys: 'workspace_app',
});

/**
 * The reading kept for this app, when one is still fresh: NO store read, nothing cached is created. The facts projection (`app-facts.ts`)
 * carries it next to the blockers a run kept, so a surface that only has the stored state can still tell history from now.
 */
export function peekCurrentReadiness(
  workspaceId: string,
  appId: string,
  now: number,
): CurrentReadiness | null {
  const hit = cache.get(keyOf(workspaceId, appId));
  return hit && now - hit.at < CURRENT_READINESS_TTL_MS ? { ...hit.value, cached: true } : null;
}

/** For tests. */
export const clearCurrentReadiness = (): void => cache.clear();

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export async function readCurrentReadiness(
  ctx: { draft: DraftContext; submit: SubmitContext },
  input: { workspaceId: string; appId: string; actor: Actor; fresh?: boolean },
): Promise<{ ok: true; readiness: CurrentReadiness } | Failure> {
  const now = ctx.submit.now();
  const key = keyOf(input.workspaceId, input.appId);
  if (input.fresh === true) {
    // "Check again": whatever anybody cached about this store is stale for this person, the graphics view included.
    emitCacheEvent('store_read', { workspaceId: input.workspaceId, appId: input.appId });
  } else {
    const hit = cache.get(key);
    if (hit && now - hit.at < CURRENT_READINESS_TTL_MS)
      return { ok: true, readiness: { ...hit.value, cached: true } };
  }
  const app = await getApp(ctx.submit.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const read = await readStateForPlan(ctx.submit, input);
  if (!read.ok) return read;
  // What is staged is judged as the push would leave it. A failed or empty preview says nothing: the draft is judged as the store holds it.
  const staged = ctx.draft.draftEnabled
    ? await previewDraftPush(ctx.draft, input).catch(() => null)
    : null;
  const push = staged?.ok === true ? staged.preview : undefined;
  const plan = submitReadinessOf({ app, state: read.state, push, now });
  // What Apple checks that the draft does not show (content rights, age rating, build compliance, privacy policy, category): read-only,
  // judged by the core rule; a version already in review has nothing left to check.
  const compliance = read.state.alreadySubmitted ? [] : await readComplianceBlockers(ctx.submit, input);
  const blockers = [...plan.submit.blockers, ...compliance];
  const readiness: CurrentReadiness = {
    appId: app.id,
    ready: blockers.length === 0,
    blockers,
    unknown: plan.submit.unknown,
    predicted: plan.submit.predicted,
    versionString: read.state.version?.versionString ?? null,
    storeReadAt: now,
    cached: false,
  };
  cache.set(key, { at: now, value: readiness });
  while (cache.size > 64) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return { ok: true, readiness };
}
