import type { ActorType, FileChange } from '@mrm/core';
import { recordAudit } from './audit.ts';
import { isCloneBacked } from './clone-reads.ts';
import {
  type ChangeSetView,
  getChangeSet,
  invalidState,
  parseFiles,
  rowOf,
} from './change-sets.ts';
import {
  type Failure,
  failure,
  getRepository,
  githubFailure,
  type Outcome,
  openConnectorForRepository,
  type RepoContext,
  withTimeout,
} from './repositories.ts';
import { openRepoSnapshot } from './repo-snapshot.ts';
import { mergeText } from './text-merge.ts';

/**
 * Refreshing a stale change set (docs/api/repositories.md, "Refresh a change set"). A change set
 * records, per file, the text it was made against (`before`) and the text it wants (`after`). When
 * the repository has moved on, applying it fails (a conflict on GitHub, `base_changed` for a
 * commit in a local clone). Instead of discarding it, the change is re-based: each file is read
 * again, and three texts are compared:
 *
 *   base   the stored `before`            (absent for a file the change set adds)
 *   ours   the stored `after`             (absent for a file the change set deletes)
 *   theirs what the repository holds now  (absent when the file is gone)
 *
 *   theirs == base              the file is unchanged: nothing to do
 *   theirs == ours              the change is already there: the file leaves the change set
 *   otherwise                   a three-way merge of the text (text-merge.ts). A clean merge is the
 *                               new `after` (and `theirs` the new `before`); anything else is a
 *                               conflict, reported with all three texts and never guessed.
 *
 * A conflict stops the refresh, and the change set is left exactly as it was, until the caller says
 * per file `mine` (keep our text, overwrite theirs) or `theirs` (drop our change). A change set
 * whose content changes goes back to `draft` and loses its approval: the approver approved other
 * text. One whose content did not change keeps everything (nothing to approve again).
 */

type Actor = { type: ActorType; id: string };

export type FileState = 'same' | 'changed' | 'already_applied' | 'conflict';
export type Resolution = 'mine' | 'theirs';
export type ConflictReason =
  | 'overlap'
  | 'added_upstream'
  | 'edited_upstream'
  | 'deleted_upstream'
  | 'invalid_json'
  | 'too_large';

/** What re-basing one file comes to. Pure: no I/O. */
export type Evaluation =
  | { state: 'same' }
  | { state: 'already_applied' }
  | { state: 'changed'; file: FileChange }
  | {
      state: 'conflict';
      reason: ConflictReason;
      /** The three texts, `undefined` where the file does not exist. */
      base: string | undefined;
      ours: string | undefined;
      theirs: string | undefined;
    };

const isJsonPath = (path: string): boolean => path.toLowerCase().endsWith('.json');

const parses = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** `file` as the change set has it, and `current` as the repository has it now (`undefined`: no such file). */
export function evaluateFile(file: FileChange, current: string | undefined): Evaluation {
  const base = file.before;
  const ours = file.after;
  if (current === base) return { state: 'same' };
  if (current === ours) return { state: 'already_applied' };
  const conflict = (reason: ConflictReason): Evaluation => ({
    state: 'conflict',
    reason,
    base,
    ours,
    theirs: current,
  });
  // No text to merge: somebody added, deleted or edited the file the other way round.
  if (base === undefined) return conflict('added_upstream');
  if (ours === undefined) return conflict('edited_upstream');
  if (current === undefined) return conflict('deleted_upstream');

  const merged = mergeText(base, ours, current);
  if (!merged.ok) return conflict(merged.reason === 'too_large' ? 'too_large' : 'overlap');
  // The merge may land on what is there already (both sides made the same changes in pieces).
  if (merged.text === current) return { state: 'already_applied' };
  // A merged JSON file that no longer parses (an Expo store config) is never offered as clean.
  if (isJsonPath(file.path) && parses(ours) && !parses(merged.text)) return conflict('invalid_json');
  return { state: 'changed', file: { path: file.path, before: current, after: merged.text } };
}

/** What a person's choice does to a conflicting file: our text over theirs, or the file leaves the set. */
export function resolveConflict(
  file: FileChange,
  current: string | undefined,
  choice: Resolution,
): FileChange | undefined {
  if (choice === 'theirs') return undefined;
  return {
    path: file.path,
    ...(current !== undefined ? { before: current } : {}),
    ...(file.after !== undefined ? { after: file.after } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the repository now

/** Refresh and staleness may read from a clone, like a listing does (see CLONE_READ_PURPOSES). */
export const REFRESH_PURPOSE = 'changeset.refresh';
export const STALENESS_PURPOSE = 'changeset.staleness';

const READ_BATCH = 8;

type Current = {
  /** The commit that was read, or the branch name when the connector cannot name commits. */
  ref: string;
  texts: Map<string, string | undefined>;
};

async function readCurrent(
  ctx: RepoContext,
  input: { workspaceId: string; repositoryId: string; paths: string[]; purpose: string },
  actor: Actor,
): Promise<Outcome<{ current: Current }>> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.repositoryId);
  if (!repository) return failure(404, 'not_found', 'The repository of this change set is gone.');
  const opened = await openConnectorForRepository(ctx, input.workspaceId, repository, actor, input.purpose);
  if (!opened.ok) return opened;
  const { connector, secret } = opened;
  const controller = new AbortController();
  if (isCloneBacked(connector)) connector.useSignal(controller.signal);
  try {
    const current = await withTimeout(
      (async (): Promise<Current> => {
        // The point is to see what changed: the newest tip, not the one fetched a minute ago.
        if (isCloneBacked(connector)) await connector.refresh(repository.defaultBranch, controller.signal);
        const snapshot = await openRepoSnapshot({
          repositoryId: repository.id,
          connector,
          branch: repository.defaultBranch,
          now: ctx.now,
          signal: controller.signal,
        });
        const present = input.paths.filter((p) => snapshot.files.includes(p));
        if (isCloneBacked(connector) && present.length > 0) {
          await connector.warm(present, snapshot.ref, controller.signal);
        }
        const texts = new Map<string, string | undefined>();
        for (let i = 0; i < input.paths.length; i += READ_BATCH) {
          const batch = input.paths.slice(i, i + READ_BATCH);
          const read = await Promise.all(
            batch.map((path) => (snapshot.files.includes(path) ? snapshot.read(path) : Promise.resolve(undefined))),
          );
          batch.forEach((path, n) => texts.set(path, read[n]));
        }
        return { ref: snapshot.ref, texts };
      })(),
      ctx.timeoutMs,
      () => controller.abort(),
    );
    return { ok: true, current };
  } catch (error) {
    return githubFailure(error, secret);
  }
}

// ---------------------------------------------------------------------------------------------
// The views

export type StalenessFile = { path: string; state: FileState };
export type Staleness = {
  /** Some file is not what the change set was made from. */
  stale: boolean;
  files: StalenessFile[];
  /** The commit that was read (or the branch name when it cannot be named). */
  readAt: string;
};

export type RefreshFile = {
  path: string;
  state: FileState;
  /** What happened to the file in the refresh. */
  outcome: 'unchanged' | 'merged' | 'dropped' | 'kept_mine' | 'kept_theirs' | 'conflict';
  /** For a conflict only. */
  reason?: ConflictReason;
  /** For an unresolved conflict only: the three texts, `null` where the file does not exist. */
  base?: string | null;
  ours?: string | null;
  theirs?: string | null;
};

export type RefreshResult = {
  changeSet: ChangeSetView;
  files: RefreshFile[];
  /** The commit the change set was re-based onto (or the branch name). */
  refreshedFrom: string;
  /** Nothing in the change set changed (the repository has not moved where it matters). */
  unchanged: boolean;
  /** No file is left: there is nothing to apply, and the change set can be discarded. */
  nothingLeft: boolean;
  /** The change set had been approved and is a draft again. */
  approvalCleared: boolean;
};

const REFRESHABLE = ['draft', 'approved', 'failed'];

type Loaded = {
  row: Record<string, unknown>;
  files: FileChange[];
  current: Current;
  evaluations: Evaluation[];
};

async function load(
  ctx: RepoContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
  purpose: string,
): Promise<Outcome<{ loaded: Loaded }>> {
  const row = await rowOf(ctx.db, input.workspaceId, input.id);
  if (!row) return failure(404, 'not_found');
  const status = String(row.status);
  if (!REFRESHABLE.includes(status)) return invalidState(status, 'a draft, approved or failed');
  if (status === 'failed' && row.branch) {
    return failure(
      409,
      'branch_created',
      'A branch was created for this change set before it failed, so it cannot be refreshed. Discard it and create a new one.',
    );
  }
  const files = parseFiles(row);
  const read = await readCurrent(
    ctx,
    { workspaceId: input.workspaceId, repositoryId: String(row.repository_id), paths: files.map((f) => f.path), purpose },
    actor,
  );
  if (!read.ok) return read;
  const evaluations = files.map((file) => evaluateFile(file, read.current.texts.get(file.path)));
  return { ok: true, loaded: { row, files, current: read.current, evaluations } };
}

/** Read-only: which files of the change set differ from the repository now. Writes nothing, not even an audit row. */
export async function changeSetStaleness(
  ctx: RepoContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<Outcome<Staleness>> {
  const done = await load(ctx, input, actor, STALENESS_PURPOSE);
  if (!done.ok) return done;
  const { files, evaluations, current } = done.loaded;
  const rows = files.map((file, i): StalenessFile => ({
    path: file.path,
    state: (evaluations[i] as Evaluation).state,
  }));
  return { ok: true, stale: rows.some((f) => f.state !== 'same'), files: rows, readAt: current.ref };
}

const content = (text: string | undefined): string | null => (text === undefined ? null : text);

export async function refreshChangeSet(
  ctx: RepoContext,
  input: { workspaceId: string; id: string; resolutions?: Record<string, Resolution> },
  actor: Actor,
): Promise<Outcome<RefreshResult>> {
  const resolutions = input.resolutions ?? {};
  const done = await load(ctx, input, actor, REFRESH_PURPOSE);
  if (!done.ok) return done;
  const { row, files, evaluations, current } = done.loaded;

  const known = new Set(files.map((f) => f.path));
  const unknown = Object.keys(resolutions).filter((p) => !known.has(p));
  if (unknown.length > 0) {
    return failure(422, 'unknown_path', 'A choice names a file that is not in this change set.', {
      paths: unknown.slice(0, 50),
    });
  }

  const kept: FileChange[] = [];
  const results: RefreshFile[] = [];
  const counts = { unchanged: 0, merged: 0, dropped: 0, keptMine: 0, keptTheirs: 0, conflicts: 0 };
  let contentChanged = false;
  files.forEach((file, i) => {
    const evaluation = evaluations[i] as Evaluation;
    const theirs = current.texts.get(file.path);
    switch (evaluation.state) {
      case 'same':
        kept.push(file);
        counts.unchanged++;
        results.push({ path: file.path, state: 'same', outcome: 'unchanged' });
        return;
      case 'already_applied':
        counts.dropped++;
        contentChanged = true;
        results.push({ path: file.path, state: 'already_applied', outcome: 'dropped' });
        return;
      case 'changed':
        kept.push(evaluation.file);
        counts.merged++;
        contentChanged = true;
        results.push({ path: file.path, state: 'changed', outcome: 'merged' });
        return;
      case 'conflict': {
        const choice = resolutions[file.path];
        if (choice === 'mine') {
          const mine = resolveConflict(file, theirs, 'mine');
          if (mine) kept.push(mine);
          counts.keptMine++;
          contentChanged = true;
          results.push({ path: file.path, state: 'conflict', outcome: 'kept_mine', reason: evaluation.reason });
        } else if (choice === 'theirs') {
          counts.keptTheirs++;
          contentChanged = true;
          results.push({ path: file.path, state: 'conflict', outcome: 'kept_theirs', reason: evaluation.reason });
        } else {
          counts.conflicts++;
          results.push({
            path: file.path,
            state: 'conflict',
            outcome: 'conflict',
            reason: evaluation.reason,
            base: content(evaluation.base),
            ours: content(evaluation.ours),
            theirs: content(evaluation.theirs),
          });
        }
      }
    }
  });

  if (counts.conflicts > 0) {
    // All or nothing: the change set is as it was, and the answer says what to choose.
    return failure(
      409,
      'refresh_conflicts',
      `${counts.conflicts === 1 ? 'One file' : `${counts.conflicts} files`} changed in the repository in the same place as this change set. Choose for each: keep your text (overwriting theirs) or keep theirs (dropping your change). Nothing was changed.`,
      { files: results, conflicts: counts.conflicts, refreshedFrom: current.ref },
    );
  }

  const status = String(row.status);
  const nothingLeft = kept.length === 0;
  // A failed set always goes back to draft (it cannot be approved otherwise); the others only when their text changed.
  if (!contentChanged && status !== 'failed') {
    const view = (await getChangeSet(ctx.db, input.workspaceId, input.id)) as ChangeSetView;
    return {
      ok: true,
      changeSet: view,
      files: results,
      refreshedFrom: current.ref,
      unchanged: true,
      nothingLeft: view.filesChanged === 0,
      approvalCleared: false,
    };
  }

  const approvalCleared = status === 'approved' || row.approved_by !== null;
  const written = await ctx.db.transaction(async (tx): Promise<Failure | undefined> => {
    const at = ctx.now();
    const changed = await tx.execute(
      `UPDATE change_sets
          SET files_json = ?, status = 'draft', approved_by = NULL, approved_at = NULL, error = NULL, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = ? AND updated_at = ?`,
      [JSON.stringify(kept), at, input.id, input.workspaceId, status, Number(row.updated_at)],
    );
    if (changed === 0) {
      return failure(
        409,
        'changed_meanwhile',
        'This change set was changed while it was being refreshed (approved, applied or refreshed by someone else). Look again and retry.',
      );
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'changeset.refresh',
      target: { type: 'change_set', id: input.id },
      // Counts and the commit: never a path's content.
      detail: {
        repositoryId: String(row.repository_id),
        was: status,
        refreshedFrom: current.ref,
        files: { before: files.length, after: kept.length },
        ...counts,
        approvalCleared,
      },
      at,
    });
    return undefined;
  });
  if (written) return written;
  return {
    ok: true,
    changeSet: (await getChangeSet(ctx.db, input.workspaceId, input.id)) as ChangeSetView,
    files: results,
    refreshedFrom: current.ref,
    unchanged: false,
    nothingLeft,
    approvalCleared,
  };
}
