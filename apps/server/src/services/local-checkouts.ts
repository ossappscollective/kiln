import { randomUUID } from 'node:crypto';
import type { ActorType } from '@kiln/core';
import { recordAudit } from './audit.ts';
import {
  type GitProblemCode,
  inspectLocalRepo,
  type LocalInspection,
  type PathCheck,
  validateLocalPath,
} from './local-git.ts';
import {
  ENV_NAME,
  LOCAL_ONLY_APPLY_MESSAGE,
  type LocalAvailability,
  localAvailability,
  localCloneId,
  localWriteAvailability,
  WRITE_ENV_NAME,
} from './local-reads.ts';
import {
  type Failure,
  failure,
  getRepository,
  type Outcome,
  type RepoContext,
  type Repository,
} from './repositories.ts';

import { coded } from '../i18n/problem.ts';
/**
 * Attaching a folder on this machine to a repository, or connecting it as a repository of its
 * own (docs/adr/0005-local-clone-reads.md). Reading from it is in local-reads.ts. Every function
 * here needs the role `repositories.write` (the routes check it), is refused unless
 * KILN_LOCAL_REPO_ROOTS is set, and audits the path (not secret) and never any content.
 */

type Actor = { type: ActorType; id: string };

const MAX_NAME = 100;

export type LocalConfigView = {
  enabled: boolean;
  envName: string;
  /** Why not, in words, when disabled. */
  message?: string;
  reason?: string;
  /** The allowed folders. Only given to people who may attach a folder. */
  roots?: string[];
  /** Whether a change set may be committed to a new branch of a local clone (KILN_LOCAL_REPO_WRITE), and if not, why not. */
  write: { enabled: boolean; envName: string; message?: string };
  /** Whether the commits are signed (KILN_GIT_SIGN) and how. Never the key or where it is. */
  signing: { enabled: boolean; format?: 'ssh' | 'gpg' };
};

export function localConfigView(
  ctx: Pick<RepoContext, 'reads' | 'localWrite'>,
  includeRoots: boolean,
): LocalConfigView {
  const available: LocalAvailability = localAvailability(ctx.reads);
  const writable = localWriteAvailability(ctx.localWrite);
  const write = writable.enabled
    ? { enabled: true, envName: WRITE_ENV_NAME }
    : { enabled: false, envName: WRITE_ENV_NAME, message: writable.message };
  const format = ctx.localWrite?.signing?.format;
  const signing = format ? { enabled: true, format } : { enabled: false };
  return available.enabled
    ? {
        enabled: true,
        envName: ENV_NAME,
        ...(includeRoots ? { roots: available.roots } : {}),
        write,
        signing,
      }
    : {
        enabled: false,
        envName: ENV_NAME,
        reason: available.reason,
        message: available.message,
        write,
        signing,
      };
}

const refusal = (available: LocalAvailability): Failure | undefined =>
  available.enabled
    ? undefined
    : failure(
        409,
        available.reason === 'no_roots'
          ? 'local_not_enabled'
          : available.reason === 'reads_api'
            ? 'local_reads_disabled'
            : 'local_git_missing',
        available.message,
      );

const GIT_PROBLEM_STATUS: Record<GitProblemCode, 409 | 422> = {
  git_missing: 409,
  git_timeout: 422,
  dubious_ownership: 422,
  not_a_repository: 422,
  git_failed: 422,
  no_commits: 422,
  detached_head: 422,
  branch_not_found: 422,
  invalid_branch: 422,
};

const pathProblem = (check: Extract<PathCheck, { ok: false }>): Failure =>
  failure(422, `local_${check.code}`, check.message);

type Validated = { realPath: string; worktree: boolean; inspection: LocalInspection };

/** The common start of check, connect and attach: enabled, path valid, repository inspected. */
async function examine(
  ctx: RepoContext,
  input: { path: string; branch?: string | undefined; skipStatus?: boolean },
): Promise<Outcome<Validated>> {
  const available = localAvailability(ctx.reads);
  const off = refusal(available);
  if (off || !ctx.reads)
    return off ?? failure(
      409,
      'local_not_enabled',
      'Local clones are not enabled.',
      coded('local.notEnabled'),
    );
  const check = await validateLocalPath(input.path, ctx.reads.local ?? { roots: [], excluded: [] });
  if (!check.ok) return pathProblem(check);
  const inspected = await inspectLocalRepo({
    gitPath: ctx.reads.gitPath ?? 'git',
    realPath: check.realPath,
    worktree: check.worktree,
    branch: input.branch,
    ...(input.skipStatus ? { skipStatus: true } : {}),
  });
  if (!inspected.ok) {
    return failure(
      GIT_PROBLEM_STATUS[inspected.code],
      `local_${inspected.code}`,
      inspected.message,
    );
  }
  return {
    ok: true,
    realPath: check.realPath,
    worktree: check.worktree,
    inspection: inspected.inspection,
  };
}

export type ConnectedMatch = {
  id: string;
  name: string;
  owner: string;
  repo: string;
  /** It already has a local folder (the one in `path`). */
  localPath: string | null;
};

export type LocalCheck = LocalInspection & {
  /** The connected GitHub repository that `origin` names, if there is one. */
  match: ConnectedMatch | null;
  /** The repository this folder is already attached to or connected as, if any. */
  existing: { id: string; name: string; localOnly: boolean } | null;
  /** Things to show next to the result. */
  warnings: string[];
};

async function findMatch(
  ctx: RepoContext,
  workspaceId: string,
  inspection: LocalInspection,
): Promise<ConnectedMatch | null> {
  const remote = inspection.remote;
  if (!remote?.github) return null;
  const [row] = await ctx.db.query(
    `SELECT r.id, r.owner, r.repo, k.path AS local_path
       FROM repositories r LEFT JOIN repository_local_checkouts k ON k.repository_id = r.id
      WHERE r.workspace_id = ? AND lower(r.owner) = ? AND lower(r.repo) = ?`,
    [workspaceId, remote.owner.toLowerCase(), remote.repo.toLowerCase()],
  );
  if (!row) return null;
  return {
    id: String(row.id),
    name: `${String(row.owner)}/${String(row.repo)}`,
    owner: String(row.owner),
    repo: String(row.repo),
    localPath:
      row.local_path === null || row.local_path === undefined ? null : String(row.local_path),
  };
}

async function findByPath(ctx: RepoContext, workspaceId: string, realPath: string) {
  const [row] = await ctx.db.query(
    'SELECT repository_id, name FROM repository_local_checkouts WHERE workspace_id = ? AND path = ?',
    [workspaceId, realPath],
  );
  if (!row) return undefined;
  const repository = await getRepository(ctx.db, workspaceId, String(row.repository_id));
  return repository
    ? { id: repository.id, name: repository.name, localOnly: repository.localOnly }
    : undefined;
}

/**
 * What is at a path: its real path, branch, tip, remote and uncommitted files, and the connected
 * repository it matches. Writes nothing but an audit row (the path, and whether it was usable).
 */
export async function checkLocalPath(
  ctx: RepoContext,
  input: { workspaceId: string; path: string; branch?: string | undefined },
  actor: Actor,
): Promise<Outcome<{ check: LocalCheck }>> {
  const done = await examine(ctx, { path: input.path, branch: input.branch });
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor,
    action: 'repository.local_check',
    target: { type: 'local_path', id: done.ok ? done.realPath : input.path.slice(0, 200) },
    detail: {
      path: done.ok ? done.realPath : input.path.slice(0, 200),
      ok: done.ok,
      ...(done.ok ? {} : { code: done.body.error }),
    },
    at: ctx.now(),
  });
  if (!done.ok) return done;
  const { inspection } = done;
  const warnings: string[] = [];
  if (inspection.checkedOutBranch === null)
    warnings.push('HEAD is detached: choose the branch to read.');
  if (inspection.dirtyCount === null) warnings.push('Uncommitted changes could not be counted.');
  if (!inspection.remote) {
    warnings.push(
      'The repository has no GitHub `origin` remote, so it cannot be matched to a connected repository.',
    );
  }
  return {
    ok: true,
    check: {
      ...inspection,
      match: await findMatch(ctx, input.workspaceId, inspection),
      existing: (await findByPath(ctx, input.workspaceId, inspection.realPath)) ?? null,
      warnings,
    },
  };
}

const cleanName = (name: string | undefined, fallback: string): string => {
  const trimmed = (name ?? '').trim().replace(/\s+/g, ' ');
  return (trimmed === '' ? fallback : trimmed).slice(0, MAX_NAME);
};

const isUniqueViolation = (error: unknown) =>
  error instanceof Error && /unique|duplicate key/i.test(error.message);

function chosenBranch(inspection: LocalInspection): string | undefined {
  return inspection.branch ?? undefined;
}

/** A repository that is only a folder on this machine: no credential, owner or repo. */
export async function connectLocalRepository(
  ctx: RepoContext,
  input: {
    workspaceId: string;
    path: string;
    branch?: string | undefined;
    name?: string | undefined;
  },
  actor: Actor,
): Promise<Outcome<{ repository: Repository }>> {
  const done = await examine(ctx, { path: input.path, branch: input.branch, skipStatus: true });
  if (!done.ok) return done;
  const branch = chosenBranch(done.inspection);
  if (!branch) {
    return failure(
      422,
      'local_detached_head',
      'HEAD is detached in that repository. Choose the branch to read.',
      coded('local.detachedHead'),
    );
  }
  const taken = await findByPath(ctx, input.workspaceId, done.realPath);
  if (taken) {
    return failure(409, 'already_connected', `That folder is already connected as ${taken.name}.`, {
      repositoryId: taken.id,
      ...coded('local.folderConnected', { name: taken.name }),
    });
  }
  const id = randomUUID();
  const now = ctx.now();
  const name = cleanName(input.name, done.inspection.folderName);
  try {
    await ctx.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO repositories (id, workspace_id, credential_id, owner, repo, default_branch, created_at)
         VALUES (?, ?, NULL, NULL, NULL, ?, ?)`,
        [id, input.workspaceId, branch, now],
      );
      await tx.execute(
        `INSERT INTO repository_local_checkouts
           (repository_id, workspace_id, path, branch, name, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.workspaceId, done.realPath, branch, name, actor.id, now, now],
      );
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor,
        action: 'repository.local_connect',
        target: { type: 'repository', id },
        detail: { path: done.realPath, branch, name },
        at: now,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await findByPath(ctx, input.workspaceId, done.realPath);
      if (again)
        return failure(
          409,
          'already_connected',
          `That folder is already connected as ${again.name}.`,
          { repositoryId: again.id, ...coded('local.folderConnected', { name: again.name }) },
        );
    }
    throw error;
  }
  return {
    ok: true,
    repository: (await getRepository(ctx.db, input.workspaceId, id)) as Repository,
  };
}

/**
 * Attaches a folder to a repository, or changes the folder or branch of the one it has. With no
 * `path` the stored folder is kept (a branch change). A GitHub repository whose clone's `origin`
 * names another repository is refused unless `allowRemoteMismatch` (a fork, a mirror).
 */
export async function attachLocalCheckout(
  ctx: RepoContext,
  input: {
    workspaceId: string;
    repositoryId: string;
    path?: string | undefined;
    branch?: string | undefined;
    allowRemoteMismatch?: boolean | undefined;
  },
  actor: Actor,
): Promise<Outcome<{ repository: Repository }>> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.repositoryId);
  if (!repository) return failure(404, 'not_found');
  const stored = repository.local;
  const path = input.path ?? stored?.path;
  if (path === undefined) {
    return failure(
      422,
      'local_path_required',
      'Enter the path of the local clone to attach.',
      coded('local.pathRequired'),
    );
  }
  const pathChanged = stored !== null && input.path !== undefined && input.path !== stored.path;
  // A new folder starts on its own checked out branch; the same folder keeps its branch.
  const wanted = input.branch ?? (stored && !pathChanged ? stored.branch : undefined);
  const done = await examine(ctx, { path, branch: wanted, skipStatus: true });
  if (!done.ok) return done;
  const branch = chosenBranch(done.inspection);
  if (!branch) {
    return failure(
      422,
      'local_detached_head',
      'HEAD is detached in that repository. Choose the branch to read.',
      coded('local.detachedHead'),
    );
  }
  const remote = done.inspection.remote;
  if (
    !repository.localOnly &&
    remote?.github &&
    !input.allowRemoteMismatch &&
    (remote.owner.toLowerCase() !== repository.owner.toLowerCase() ||
      remote.repo.toLowerCase() !== repository.repo.toLowerCase())
  ) {
    return failure(
      409,
      'remote_mismatch',
      `That clone's origin is ${remote.owner}/${remote.repo}, but this repository is ${repository.owner}/${repository.repo}. If it is a fork or a mirror of it, confirm and try again.`,
      {
        origin: `${remote.owner}/${remote.repo}`,
        repository: `${repository.owner}/${repository.repo}`,
        ...coded('local.originMismatch', {
          remoteOwner: remote.owner,
          remoteRepo: remote.repo,
          repoOwner: repository.owner,
          repoRepo: repository.repo,
        }),
      },
    );
  }
  const taken = await findByPath(ctx, input.workspaceId, done.realPath);
  if (taken && taken.id !== repository.id) {
    return failure(409, 'path_in_use', `That folder is already used by ${taken.name}.`, {
      repositoryId: taken.id,
      ...coded('local.folderUsedBy', { name: taken.name }),
    });
  }

  const now = ctx.now();
  const changed = stored !== null;
  try {
    await ctx.db.transaction(async (tx) => {
      if (stored) {
        await tx.execute(
          `UPDATE repository_local_checkouts
              SET path = ?, branch = ?, last_commit = NULL, last_read_at = NULL, updated_at = ?
            WHERE repository_id = ? AND workspace_id = ?`,
          [done.realPath, branch, now, repository.id, input.workspaceId],
        );
      } else {
        await tx.execute(
          `INSERT INTO repository_local_checkouts
             (repository_id, workspace_id, path, branch, name, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            repository.id,
            input.workspaceId,
            done.realPath,
            branch,
            done.inspection.folderName,
            actor.id,
            now,
            now,
          ],
        );
      }
      // A local-only repository reads this branch as its default.
      if (repository.localOnly) {
        await tx.execute(
          'UPDATE repositories SET default_branch = ? WHERE id = ? AND workspace_id = ?',
          [branch, repository.id, input.workspaceId],
        );
      }
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor,
        action: changed ? 'repository.local_change' : 'repository.local_attach',
        target: { type: 'repository', id: repository.id },
        detail: {
          path: done.realPath,
          branch,
          ...(stored ? { previousPath: stored.path, previousBranch: stored.branch } : {}),
          ...(input.allowRemoteMismatch && remote
            ? { originConfirmed: `${remote.owner}/${remote.repo}` }
            : {}),
        },
        at: now,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return failure(
        409,
        'path_in_use',
        'That folder is already used by another repository.',
        coded('local.folderUsedByOther'),
      );
    }
    // The repository was disconnected while the folder was being checked.
    if (error instanceof Error && /foreign key/i.test(error.message))
      return failure(404, 'not_found');
    throw error;
  }
  return {
    ok: true,
    repository: (await getRepository(ctx.db, input.workspaceId, repository.id)) as Repository,
  };
}

/** Takes the local folder off a GitHub repository: reads go back to GitHub. A local-only repository is disconnected instead. */
export async function detachLocalCheckout(
  ctx: RepoContext,
  input: { workspaceId: string; repositoryId: string },
  actor: Actor,
): Promise<Outcome<{ repository: Repository }>> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.repositoryId);
  if (!repository) return failure(404, 'not_found');
  if (repository.localOnly) {
    return failure(
      409,
      'local_only',
      'A local-only repository is only its folder. Disconnect the repository instead of detaching the folder.',
      coded('local.onlyFolder'),
    );
  }
  if (!repository.local)
    return failure(
      404,
      'no_local_checkout',
      'This repository has no local clone attached.',
      coded('local.noClone'),
    );
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      'DELETE FROM repository_local_checkouts WHERE repository_id = ? AND workspace_id = ?',
      [repository.id, input.workspaceId],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'repository.local_detach',
      target: { type: 'repository', id: repository.id },
      detail: { path: repository.local?.path, branch: repository.local?.branch },
      at: now,
    });
  });
  // The managed copy of the folder is a cache: gone with the attachment (errors are logged, not thrown).
  await ctx.reads?.remove(input.workspaceId, localCloneId(repository.id));
  return {
    ok: true,
    repository: (await getRepository(ctx.db, input.workspaceId, repository.id)) as Repository,
  };
}

/**
 * A change set of a local-only repository cannot be applied yet (see docs/adr/0005): this is the
 * refusal, checked before the change set is claimed, so it stays approved and nothing changes.
 */
export async function localOnlyApplyRefusal(
  ctx: RepoContext,
  input: { workspaceId: string; changeSetId: string },
): Promise<Failure | undefined> {
  const [row] = await ctx.db.query(
    `SELECT c.id FROM change_sets c JOIN repositories r ON r.id = c.repository_id
      WHERE c.id = ? AND c.workspace_id = ? AND r.credential_id IS NULL`,
    [input.changeSetId, input.workspaceId],
  );
  return row ? failure(409, 'local_only', LOCAL_ONLY_APPLY_MESSAGE) : undefined;
}
