import {
  PROPOSAL_SUMMARY_TTL_MS,
  PROPOSAL_SUMMARY_MAX_ENTRIES as SUMMARY_MAX_ENTRIES,
} from '@kiln/core';
import type { Sql } from '@kiln/db';
import { getApp, listAppReleases, type ManagedApp } from '../../services/apps.ts';
import { registerMapCache } from '../../services/cache-registry.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import {
  EDITABLE_STATES,
  getAssetProposal,
  type ProposalContext,
  type ProposalQuery,
  readProposalState,
} from './asset-proposal.ts';

export { SUMMARY_MAX_ENTRIES };

/**
 * The count-only form of the release asset proposal (docs/api/release-asset-proposal.md "Summary", ADR 0064): "3 store asset changes proposed" on
 * the Releases list. The full proposal reads the repository at two commits; a list must not do that on every render, so the answer is cached,
 * keyed by what Kiln stores about the inputs (no request to the repository or a store to find out whether the cache is still good), computed at most
 * once at a time per app, at most a few at a time overall, and cut off after a time limit (the computation then finishes in the background and
 * fills the cache for the next read).
 */
export type SummaryReason =
  | 'no_repository'
  | 'no_repo_metadata'
  | 'target_unreadable'
  | 'busy'
  | 'computing'
  | 'unreadable';
export type ProposalSummary = {
  /** True when the repository was compared; false says why not in `reason`. */
  available: boolean;
  reason: SummaryReason | null;
  /** The release the count is for: the app's editable release (App Store: its version; Google Play: its track), else null. */
  version: string | null;
  track: string | null;
  state: 'open' | 'skipped' | 'later';
  /** Changed texts + changed graphics sets, not yet in the cart. 0 when unavailable. */
  count: number;
  texts: number;
  graphics: number;
  /** Apple's metadata lock: the changes cannot be staged until a new version exists. */
  locked: boolean;
  /** Answered from the cache (nothing was read). */
  cached: boolean;
  /** When the count was computed (epoch ms). */
  computedAt: number;
};

/** `PROPOSAL_SUMMARY_TTL_MS` of `@kiln/core`'s timings. */
export const SUMMARY_TTL_MS = PROPOSAL_SUMMARY_TTL_MS;
export const SUMMARY_TIMEOUT_MS = 8_000;
export const SUMMARY_MAX_CONCURRENT = 2;

type Entry = { fingerprint: string; at: number; value: Omit<ProposalSummary, 'cached'> };
const cache = new Map<string, Entry>();
// Its fingerprint already covers our own tables (sync, staged, builds, releases); the events drop it at once instead of at the next read.
registerMapCache(cache, {
  name: 'listing.proposal_summary',
  owner: 'modules/listing/asset-proposal-summary.ts',
  ttlMs: SUMMARY_TTL_MS,
  invalidatedBy: ['sync', 'staged_changed', 'release_changed', 'build_changed', 'publish'],
  keys: 'workspace_app',
});
const inflight = new Map<string, Promise<Entry>>();
let running = 0;

/** Tests start clean. */
export const resetProposalSummaryCache = (): void => {
  cache.clear();
  inflight.clear();
  running = 0;
};

/** The release the Releases list is about: the editable release of the app, newest first (a Google Play draft names its track). */
async function releaseOf(
  sql: Sql,
  workspaceId: string,
  app: ManagedApp,
): Promise<{ version: string | null; track: string | null; stamp: string }> {
  const releases = await listAppReleases(sql, workspaceId, app.id);
  const editable = releases.filter((r) => r.status !== null && EDITABLE_STATES.includes(r.status));
  const mine = editable[0];
  const stamp = `${releases.length}:${Math.max(0, ...releases.map((r) => r.storeUpdatedAt ?? 0))}:${editable.map((r) => `${r.version}/${r.track ?? ''}/${r.status}`).join(',')}`;
  return { version: mine?.version ?? null, track: mine?.track ?? null, stamp };
}

/** What the answer depends on, from our own tables only: the repository as Kiln last read it, the store as Kiln last read it, the cart, the decision. */
async function fingerprintOf(
  sql: Sql,
  workspaceId: string,
  app: ManagedApp,
  stamp: string,
  state: { state: string; at: number | null },
): Promise<string> {
  const [repo] = await sql.query(
    "SELECT source_ref, observed_at FROM listing_snapshots WHERE workspace_id = ? AND app_id = ? AND source = 'repo' ORDER BY observed_at DESC LIMIT 1",
    [workspaceId, app.id],
  );
  const [snaps] = await sql.query(
    'SELECT COUNT(*) AS n, MAX(observed_at) AS at FROM listing_snapshots WHERE workspace_id = ? AND app_id = ?',
    [workspaceId, app.id],
  );
  const [staged] = await sql.query(
    'SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM staged_changes WHERE workspace_id = ? AND app_id = ?',
    [workspaceId, app.id],
  );
  const [builds] = await sql.query(
    'SELECT COUNT(*) AS n, MAX(head_sha) AS sha FROM build_links WHERE workspace_id = ? AND app_id = ?',
    [workspaceId, app.id],
  );
  return [
    app.repositoryId,
    app.lastSyncedAt,
    repo ? `${String(repo.source_ref)}@${String(repo.observed_at)}` : '-',
    `${String(snaps?.n)}@${String(snaps?.at)}`,
    `${String(staged?.n)}@${String(staged?.at)}`,
    `${String(builds?.n)}@${String(builds?.sha)}`,
    stamp,
    `${state.state}@${state.at}`,
  ].join('|');
}

const none = (
  query: ProposalQuery,
  state: ProposalSummary['state'],
  reason: SummaryReason,
  now: number,
): Omit<ProposalSummary, 'cached'> => ({
  available: false,
  reason,
  version: query.version,
  track: query.track,
  state,
  count: 0,
  texts: 0,
  graphics: 0,
  locked: false,
  computedAt: now,
});

export async function getProposalSummary(
  ctx: ProposalContext,
  input: {
    workspaceId: string;
    appId: string;
    actor: { type: 'user' | 'token' | 'system'; id: string };
    gate?: () => Failure | undefined;
  },
): Promise<{ ok: true; summary: ProposalSummary } | Failure> {
  const sql = ctx.staged.db;
  const now = ctx.staged.now();
  const app = await getApp(sql, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const release = await releaseOf(sql, input.workspaceId, app);
  const query: ProposalQuery = { version: release.version, track: release.track, build: null };
  // No repository: nothing to compare, nothing is read, nothing is cached.
  if (!app.repositoryId)
    return { ok: true, summary: { ...none(query, 'open', 'no_repository', now), cached: false } };
  const state = await readProposalState(sql, input.workspaceId, app.id, query.version, query.track);
  // Dismissed (skip): the list shows nothing, and the repository is not read for it.
  if (state.state === 'skipped')
    return {
      ok: true,
      summary: {
        ...none(query, 'skipped', 'no_repository', now),
        available: true,
        reason: null,
        cached: false,
      },
    };

  const key = `${input.workspaceId}|${app.id}|${query.version ?? '-'}|${query.track ?? '-'}`;
  const fingerprint = await fingerprintOf(sql, input.workspaceId, app, release.stamp, state);
  const hit = cache.get(key);
  if (hit && hit.fingerprint === fingerprint && now - hit.at < SUMMARY_TTL_MS)
    return { ok: true, summary: { ...hit.value, cached: true } };

  let work = inflight.get(key);
  if (!work) {
    if (running >= SUMMARY_MAX_CONCURRENT)
      return { ok: true, summary: { ...none(query, state.state, 'busy', now), cached: false } };
    running += 1;
    work = (async (): Promise<Entry> => {
      try {
        const done = await getAssetProposal(ctx, {
          workspaceId: input.workspaceId,
          appId: app.id,
          query,
          actor: input.actor,
          ...(input.gate ? { gate: input.gate } : {}),
        });
        const at = ctx.staged.now();
        let value: Omit<ProposalSummary, 'cached'>;
        if (!done.ok) value = none(query, state.state, 'unreadable', at);
        else if (done.view.unavailable !== null)
          value = none(query, state.state, done.view.unavailable as SummaryReason, at);
        else {
          const { texts, graphics } = done.view.summary;
          value = {
            available: true,
            reason: null,
            version: query.version,
            track: query.track,
            state: done.view.state.state,
            count: texts + graphics,
            texts,
            graphics,
            locked: done.view.locked.locked,
            computedAt: at,
          };
        }
        const entry: Entry = { fingerprint, at, value };
        // A rate limit or a failed read is not remembered: the next read tries again.
        if (done.ok) {
          cache.set(key, entry);
          if (cache.size > SUMMARY_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
        }
        return entry;
      } finally {
        running -= 1;
        inflight.delete(key);
      }
    })();
    inflight.set(key, work);
  }
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), SUMMARY_TIMEOUT_MS).unref?.(),
  );
  const entry = await Promise.race([work, timeout]);
  if (entry === null)
    return { ok: true, summary: { ...none(query, state.state, 'computing', now), cached: false } };
  return { ok: true, summary: { ...entry.value, cached: false } };
}
