import type { SubmitBlocker } from '@kiln/core';
import { getApp } from '../../services/apps.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { type DraftContext, previewDraftPush } from './store-draft.ts';
import { dropStoreReadCaches, onStoreMayHaveChanged } from './store-read-events.ts';
import { readStateForPlan, type SubmitContext } from './store-submit.ts';
import { submitReadinessOf } from './submit-readiness.ts';

/**
 * What stands in the way of a submit NOW, read from the store as it is now (docs/api/pending.md "Current readiness").
 *
 * The blockers a publish run keeps (`lastPublish.results[].blockers`) are true of the moment the run made them: a person who removes
 * two screenshots in App Store Connect, fills a locale or adds the review contact afterwards does not change that record. This is the
 * answer to "and now?": ONE fresh read of the store (the version, the build, every locale with its texts and its sets of screenshots, the
 * review information) plus the staged push (when something is staged, as `predictDraft` would leave the draft), judged by the same pure
 * rules as the submit and the plan (`submitReadinessOf`, `evaluateDraftContent` of `@kiln/core`). The browser owns no rule.
 *
 * Kept for `CURRENT_READINESS_TTL_MS` per app; a push, a sync, "Read again" of the graphics and `fresh` (the "Check again" button) drop it.
 */
export const CURRENT_READINESS_TTL_MS = 30_000;

export type CurrentReadiness = {
  appId: string;
  ready: boolean;
  blockers: SubmitBlocker[];
  unknown: string[];
  /** The staged push was merged into the store's draft. */
  predicted: boolean;
  /** The version the submit would send, null when none. */
  versionString: string | null;
  /** When the store was read (epoch ms): the age of the images and texts behind the answer. */
  storeReadAt: number;
  /** Served from the 30 second cache (the store was not asked again). */
  cached: boolean;
};

const cache = new Map<string, { at: number; value: CurrentReadiness }>();
const keyOf = (workspaceId: string, appId: string) => `${workspaceId}|${appId}`;

/** Drops the cached answer of an app (a push, a sync, a fresh read of the store's graphics). */
export function invalidateCurrentReadiness(workspaceId: string, appId: string): void {
  cache.delete(keyOf(workspaceId, appId));
}
onStoreMayHaveChanged(invalidateCurrentReadiness);

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
    dropStoreReadCaches(input.workspaceId, input.appId);
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
  const readiness: CurrentReadiness = {
    appId: app.id,
    ready: plan.submit.ready,
    blockers: plan.submit.blockers,
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
