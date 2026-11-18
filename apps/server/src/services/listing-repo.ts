import type { ActorType, FileChange, Listing } from '@mrm/core';
import type { Database, Sql } from '@mrm/db';
import { flattenListing, hasStoreListing, hashListingValue, fieldKey } from './listing-drift.ts';
import {
  type ListingApp,
  recordChangeSetValues,
  recordStream,
  updateListingStatus,
} from './listing-live.ts';
import { mergedListing, readListings } from './listing-sources.ts';
import { listListingTargets } from './listing-targets.ts';
import {
  type Failure,
  failure,
  getRepository,
  githubFailure,
  openConnectorForRepository,
  type Outcome,
  type RepoContext,
  readRepositoryListing,
} from './repositories.ts';

/**
 * The adapter between an app and the repository side of its listing. It only calls the exported
 * functions of the repository services (`readRepositoryListing`, `readListings`, `mergedListing`,
 * `listListingTargets`) and keeps its own state in `listing_snapshots`; it changes none of them.
 *
 * How an app finds its listing in the repository: the app's `repository_id` names the repository.
 * Within it, a saved listing target whose `app_id` is this app's id (the field is informational
 * for the target editor and is used here as the link) selects the folders; otherwise the default
 * of the repository read applies (the detected target, or the only one). In a monorepo whose
 * targets are not linked to apps, the default may be another app's folder: link the target.
 */

type Actor = { type: ActorType; id: string };

type LinkedApp = ListingApp & { repositoryId: string | null };

/** The listing target to read for an app: a saved one that names the app, else the default. */
async function selectionFor(sql: Sql, workspaceId: string, repositoryId: string, appId: string) {
  const targets = await listListingTargets(sql, workspaceId, repositoryId);
  const mine = targets.find((t) => t.appId === appId);
  return mine ? { target: mine.id } : undefined;
}

export type RepoRefresh = {
  /** The commit (or branch) that was read. */
  ref: string;
  /** False when the repository has no listing for this app's store. Nothing was recorded then. */
  found: boolean;
  changed: number;
  removed: number;
  unchanged: number;
};

/**
 * Reads the listing of the app's linked repository at its default branch (one GitHub read, like
 * `GET /repositories/:id/listing`, audited as `credential.use` with purpose `repository.listing`)
 * and records the values of the app's store as repository snapshots. A listing that is not found is
 * not recorded: an empty read must not look like every field having been deleted.
 */
export async function refreshRepoListing(
  ctx: RepoContext,
  input: { workspaceId: string; app: LinkedApp },
  actor: Actor,
): Promise<Outcome<RepoRefresh>> {
  const { workspaceId, app } = input;
  if (!app.repositoryId) {
    return failure(422, 'no_repository', 'This app is not linked to a repository. Link one to compare it.');
  }
  const repository = await getRepository(ctx.db, workspaceId, app.repositoryId);
  if (!repository) {
    return failure(422, 'no_repository', 'The repository of this app is not connected any more.');
  }
  const opened = await openConnectorForRepository(ctx, workspaceId, repository, actor, 'repository.listing');
  if (!opened.ok) return remember(ctx.db, workspaceId, app.id, ctx.now(), opened);
  let listing: Listing;
  let ref = repository.defaultBranch;
  try {
    const selection = await selectionFor(ctx.db, workspaceId, repository.id, app.id);
    const read = await readRepositoryListing(ctx, workspaceId, repository, opened.connector, selection);
    if (!read.ok) return remember(ctx.db, workspaceId, app.id, ctx.now(), read);
    listing = mergedListing(read.listings);
    const resolve = opened.connector.resolveCommit;
    if (typeof resolve === 'function') {
      try {
        ref = await resolve.call(opened.connector, repository.defaultBranch);
      } catch {
        // The branch name is a fine reference when the commit cannot be resolved.
      }
    }
  } catch (error) {
    return remember(ctx.db, workspaceId, app.id, ctx.now(), githubFailure(error, opened.secret));
  }

  const at = ctx.now();
  const found = hasStoreListing(listing, app.platform);
  const result = await ctx.db.transaction(async (tx) => {
    const [still] = await tx.query('SELECT id FROM apps WHERE id = ? AND workspace_id = ?', [
      app.id,
      workspaceId,
    ]);
    if (!still) return { changed: 0, removed: 0, unchanged: 0 };
    const recorded = found
      ? await recordStream(
          tx,
          { workspaceId, app, source: 'repo', channel: 'default', sourceRef: ref, observedAt: at, actor },
          flattenListing(listing, app.platform),
        )
      : { changed: 0, removed: 0, unchanged: 0 };
    await updateListingStatus(tx, workspaceId, app.id, {
      repo_read_at: at,
      repo_ref: ref,
      repo_error: found
        ? null
        : `No ${app.platform === 'ios' ? 'App Store' : 'Google Play'} listing files were found in the repository for this app.`,
    });
    return recorded;
  });
  await recordAppliedChangeSets(ctx.db, workspaceId, app, ctx.now());
  return { ok: true, ref, found, ...result };
}

/** Keeps the reason a repository read failed on the app, and passes the failure on. */
async function remember(
  db: Database,
  workspaceId: string,
  appId: string,
  at: number,
  failed: Failure,
): Promise<Failure> {
  try {
    await updateListingStatus(db, workspaceId, appId, {
      repo_error: String(failed.body.message ?? failed.body.error).slice(0, 500),
    });
  } catch {
    // The failure itself is what matters.
  }
  return failed;
}

// ---------------------------------------------------------------------------------------------
// Applied change sets

/** Change sets already handled in this process (the database check makes a repeat harmless), so they are not parsed again. */
const inspected = new Set<string>();
/** Newest applied change sets looked at per app. */
const MAX_CHANGE_SETS = 50;

/** The listing the given file contents hold (files that are not listing files add nothing). */
async function listingOfFiles(files: Map<string, string>): Promise<Listing> {
  if (files.size === 0) return {};
  const listings = await readListings([...files.keys()], async (path) => files.get(path));
  return mergedListing(listings);
}

/**
 * The fields a change set changes for an app's store: the listing in its `after` files against the
 * listing in its `before` files, so a field that only the change set's files mention but did not
 * change is not recorded. A deleted file removes its field (`null`).
 */
export async function changedFields(
  files: readonly FileChange[],
  platform: ListingApp['platform'],
): Promise<{ locale: string; field: string; value: string | null }[]> {
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  for (const f of files) {
    if (f.before !== undefined) before.set(f.path, f.before);
    if (f.after !== undefined) after.set(f.path, f.after);
  }
  const was = new Map(flattenListing(await listingOfFiles(before), platform).map((v) => [fieldKey(v.locale, v.field), v]));
  const now = new Map(flattenListing(await listingOfFiles(after), platform).map((v) => [fieldKey(v.locale, v.field), v]));
  const changes: { locale: string; field: string; value: string | null }[] = [];
  for (const [key, v] of now) {
    const old = was.get(key);
    if (!old || hashListingValue(old.value) !== hashListingValue(v.value)) {
      changes.push({ locale: v.locale, field: v.field, value: v.value });
    }
  }
  for (const [key, v] of was) {
    if (!now.has(key)) changes.push({ locale: v.locale, field: v.field, value: null });
  }
  return changes.sort((a, b) => a.locale.localeCompare(b.locale) || a.field.localeCompare(b.field));
}

/**
 * Records the proposed values of every applied change set of the app's repository that has not been
 * recorded yet (source `change_set`, source ref the change set id, time the apply time). It is
 * derived data: running it twice records nothing twice. Called by the sync, the repository refresh
 * and the drift and history reads, so applying a change set needs no hook of its own.
 *
 * Limit: a change set is attributed to every app linked to its repository. For a monorepo whose
 * apps share one repository, only the files under the app's own listing target belong to it, and
 * that is not known here; link a listing target to the app to narrow the repository read.
 */
export async function recordAppliedChangeSets(
  db: Database,
  workspaceId: string,
  app: LinkedApp,
  now: number,
): Promise<number> {
  if (!app.repositoryId) return 0;
  const rows = await db.query(
    `SELECT id, files_json, applied_at, created_by_type, created_by_id FROM change_sets
      WHERE workspace_id = ? AND repository_id = ? AND status = 'applied'
      ORDER BY applied_at DESC, id DESC LIMIT ?`,
    [workspaceId, app.repositoryId, MAX_CHANGE_SETS],
  );
  let written = 0;
  for (const row of rows.reverse()) {
    const id = String(row.id);
    const seen = `${app.id}:${id}`;
    if (inspected.has(seen)) continue;
    let files: FileChange[];
    try {
      files = JSON.parse(String(row.files_json)) as FileChange[];
    } catch {
      continue;
    }
    const changes = await changedFields(files, app.platform);
    const count = await db.transaction((tx) =>
      recordChangeSetValues(
        tx,
        {
          workspaceId,
          app,
          source: 'change_set',
          channel: 'default',
          sourceRef: id,
          observedAt: row.applied_at === null || row.applied_at === undefined ? now : Number(row.applied_at),
          actor: { type: String(row.created_by_type) as ActorType, id: String(row.created_by_id) },
        },
        changes,
      ),
    );
    inspected.add(seen);
    written += count;
  }
  return written;
}

/** For tests. */
export function forgetInspectedChangeSets(): void {
  inspected.clear();
}
