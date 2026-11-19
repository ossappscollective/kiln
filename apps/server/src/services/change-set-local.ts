import type { ActorType, FileChange } from '@mrm/core';
import { recordAudit } from './audit.ts';
import {
  APPLY_CLAIM_TTL_MS,
  type ApplyResult,
  type ChangeSetView,
  changeOf,
  getChangeSet,
  invalidState,
  type LocalOutcome,
  neutraliseText,
  parseFiles,
  parseOutcome,
  pullRequestBody,
  rowOf,
  toView,
} from './change-sets.ts';
import {
  type BranchCommitOutcome,
  type CommitIdentity,
  checkNewBranchName,
  cleanIdentity,
  createBranchCommit,
  inspectLocalRepo,
  type PushOutcome,
  pushBranchCommit,
  validateLocalPath,
} from './local-git.ts';
import { localAvailability, localWriteAvailability, WRITE_ENV_NAME } from './local-reads.ts';
import {
  cloneToken,
  type Failure,
  failure,
  getRepository,
  githubFailure,
  isTimeoutError,
  type Opened,
  type Outcome,
  openConnectorForRepository,
  type RepoContext,
  type Repository,
  withTimeout,
} from './repositories.ts';

/**
 * Applying a change set as a commit on a new branch of the repository's local clone, with an
 * optional push and an optional pull request (docs/adr/0005-local-clone-reads.md, "Writing to a
 * local clone"). The git work is in local-git.ts; this file is the state machine around it.
 *
 * State machine (the statuses of the GitHub apply, unchanged): `approved` -> `applying` (one atomic
 * claim, so two requests cannot both commit) -> `applied`, which means the COMMIT exists. The push
 * and the pull request are steps after that, recorded in `outcome_json` (and `branch`, `commit_sha`,
 * `pr_url`, `pr_number`): a failed push or pull request leaves the status `applied`, never rolls
 * the commit back, and is retried with `publishLocalCommit` (POST .../push), which is guarded by
 * its own claim (`publish_claim_at`). A failure before the branch exists (the base changed, the
 * name is taken, no change left) puts the change set back to `approved` with the reason: nothing
 * was written to the repository.
 */

type Actor = { type: ActorType; id: string };

export const PUBLISH_CLAIM_TTL_MS = APPLY_CLAIM_TTL_MS;

export type LocalApplyInput = {
  workspaceId: string;
  id: string;
  /** The branch to create. Default: `mrm/<slug of the summary>-<short id>`. */
  branch?: string | undefined;
  push: boolean;
  openPr: boolean;
};

/** `mrm/<slug of the summary>-<first 8 of the id>`: a valid branch name, unique per change set. */
export function localBranchNameFor(id: string, summary: string): string {
  const slug = summary
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `mrm/${slug || 'update'}-${id.replace(/-/g, '').slice(0, 8)}`;
}

/**
 * The commit message: the summary, then the files. Never a secret. When the repository has a GitHub
 * connection the commit may be pushed, and GitHub acts on @mentions and "fixes #1" in what a
 * person typed, so the summary is neutralised as it is for a pull request; a local-only
 * repository keeps the text as typed.
 */
export function commitMessageFor(
  id: string,
  summary: string,
  files: FileChange[],
  neutralise: boolean,
): string {
  const line = summary.replace(/\s+/g, ' ').trim();
  const shown = files.slice(0, 50).map((f) => `- ${f.path} (${changeOf(f)})`);
  if (files.length > 50) shown.push(`- and ${files.length - 50} more`);
  return [
    neutralise ? neutraliseText(line) : line,
    '',
    `Changed files (${files.length}):`,
    ...shown,
    '',
    `Change set ${id}, approved in Mobile Release Manager.`,
  ].join('\n');
}

const LOCAL_PATH_CODES = new Set([
  'invalid_path',
  'not_found',
  'not_accessible',
  'not_directory',
  'outside_roots',
  'data_folder',
  'bare_repository',
  'not_a_repository',
]);

/** A failed commit as a response a person can act on. */
export function commitFailure(outcome: {
  code: string;
  message: string;
  paths?: string[] | undefined;
  reason?: string | undefined;
}): Failure {
  const extra = outcome.paths ? { paths: outcome.paths } : {};
  switch (outcome.code) {
    case 'base_changed':
    case 'branch_exists':
    case 'branch_moved':
    case 'branch_checked_out':
      return failure(409, outcome.code, outcome.message, extra);
    case 'not_text':
      return failure(422, outcome.code, outcome.message, extra);
    case 'git_missing':
      return failure(409, 'local_git_missing', outcome.message);
    case 'timeout':
      return failure(504, 'timeout', outcome.message);
    case 'signing_failed':
      return failure(outcome.reason === 'timeout' ? 504 : 502, 'signing_failed', outcome.message, {
        reason: outcome.reason ?? 'failed',
      });
    case 'branch_not_found':
      return failure(422, 'local_branch_missing', outcome.message);
    case 'no_changes':
    case 'invalid_file_path':
    case 'unsupported_entry':
    case 'path_conflict':
    case 'too_large':
    case 'invalid_branch':
      return failure(422, outcome.code, outcome.message, extra);
    default:
      return failure(
        422,
        LOCAL_PATH_CODES.has(outcome.code) || outcome.code.startsWith('git_')
          ? `local_${outcome.code}`
          : outcome.code,
        outcome.message,
      );
  }
}

const unavailable = (ctx: RepoContext): Failure | undefined => {
  const available = localAvailability(ctx.reads);
  if (available.enabled) return undefined;
  return failure(
    409,
    available.reason === 'no_roots'
      ? 'local_not_enabled'
      : available.reason === 'reads_api'
        ? 'local_reads_disabled'
        : 'local_git_missing',
    available.message,
  );
};

/**
 * Everything that can be refused without writing anything or touching the change set: the write
 * switch, a local clone, the options, and for a push the GitHub connection and that the clone's
 * `origin` is the connected repository.
 */
export async function preflight(
  ctx: RepoContext,
  repository: Repository,
  want: { branch?: string | undefined; push: boolean; openPr: boolean },
): Promise<Failure | undefined> {
  const write = localWriteAvailability(ctx.localWrite);
  if (!write.enabled)
    return failure(409, 'local_write_disabled', write.message, { envName: WRITE_ENV_NAME });
  if (!repository.local) {
    return failure(
      409,
      'no_local_checkout',
      'This repository has no local clone. Attach one (Local clone on the repository page) to commit to it.',
    );
  }
  const off = unavailable(ctx);
  if (off) return off;
  if (want.branch !== undefined) {
    const named = checkNewBranchName(want.branch);
    if (!named.ok) return failure(422, 'invalid_branch', named.message);
  }
  if (want.openPr && !want.push) {
    return failure(
      422,
      'invalid_request',
      'A pull request needs the branch on GitHub: turn on "push" as well.',
    );
  }
  if (!want.push) return undefined;
  if (repository.localOnly) {
    return failure(
      409,
      'local_only',
      'A local-only repository has no GitHub connection, so there is nothing to push to.',
    );
  }
  const check = await validateLocalPath(
    repository.local.path,
    ctx.reads?.local ?? { roots: [], excluded: [] },
  );
  if (!check.ok) return failure(422, `local_${check.code}`, check.message);
  const inspected = await inspectLocalRepo({
    gitPath: ctx.reads?.gitPath ?? 'git',
    realPath: check.realPath,
    worktree: check.worktree,
    skipStatus: true,
  });
  if (!inspected.ok)
    return failure(
      inspected.code === 'git_missing' ? 409 : 422,
      `local_${inspected.code}`,
      inspected.message,
    );
  const remote = inspected.inspection.remote;
  if (
    !remote?.github ||
    remote.owner.toLowerCase() !== repository.owner.toLowerCase() ||
    remote.repo.toLowerCase() !== repository.repo.toLowerCase()
  ) {
    return failure(
      409,
      'remote_mismatch',
      remote?.github
        ? `The local clone's origin is ${remote.owner}/${remote.repo}, not ${repository.owner}/${repository.repo}, so the branch is not pushed. Commit without pushing, or attach the right clone.`
        : `The local clone has no GitHub origin for ${repository.owner}/${repository.repo}, so the branch is not pushed. Add the remote, or commit without pushing.`,
      {
        origin: remote ? `${remote.owner}/${remote.repo}` : null,
        repository: `${repository.owner}/${repository.repo}`,
      },
    );
  }
  return undefined;
}

/** `MRM_GIT_AUTHOR_*`, else the acting person's name and email, else a fixed name. */
export async function identityFor(ctx: RepoContext, actor: Actor): Promise<CommitIdentity> {
  let name = ctx.localWrite?.authorName;
  let email = ctx.localWrite?.authorEmail;
  if ((!name || !email) && actor.type === 'user') {
    const [row] = await ctx.db.query('SELECT display_name, email FROM users WHERE id = ?', [
      actor.id,
    ]);
    if (row) {
      name ||= String(row.display_name);
      email ||= String(row.email);
    }
  }
  return cleanIdentity({ ...(name ? { name } : {}), ...(email ? { email } : {}) });
}

// ---------------------------------------------------------------------------------------------
// Push and pull request

const stepFailure = (message: string): string => message.replace(/\s+/g, ' ').slice(0, 300);

/**
 * Pushes the commit and, when asked, opens the pull request. Returns the new outcome and the first
 * failure, if any. It never throws for a failed step: a failure is recorded, not raised, so the
 * commit stays and the step can be retried. Steps already done (`pushed`, `opened`) are skipped.
 */
export async function publish(
  ctx: RepoContext,
  args: {
    workspaceId: string;
    repository: Repository;
    changeSetId: string;
    summary: string;
    files: FileChange[];
    outcome: LocalOutcome;
    openPr: boolean;
    opened: Opened;
  },
): Promise<{
  outcome: LocalOutcome;
  failed?: { step: 'push' | 'pr'; code: string; message: string };
}> {
  const { repository, opened } = args;
  const next: LocalOutcome = structuredClone(args.outcome);
  next.requested = { push: true, openPr: args.openPr || next.requested.openPr };
  const branch = next.commit.branch;
  let failed: { step: 'push' | 'pr'; code: string; message: string } | undefined;

  if (next.push.status !== 'pushed') {
    let result: PushOutcome;
    try {
      const minted = cloneToken(opened.kind ?? 'github_token', opened.secret, opened.connector);
      const token = typeof minted === 'function' ? await minted() : minted;
      if (token === undefined || token === '') {
        result = {
          ok: false,
          code: 'push_auth',
          message: 'This credential cannot give git a token, so the branch cannot be pushed.',
        };
      } else {
        const test = ctx.localWrite?.push;
        result = await pushBranchCommit({
          gitPath: ctx.reads?.gitPath ?? 'git',
          path: repository.local?.path ?? '',
          roots: ctx.reads?.local ?? { roots: [], excluded: [] },
          commit: next.commit.sha,
          branch,
          url: test?.url
            ? test.url(repository.owner, repository.repo)
            : `https://github.com/${repository.owner}/${repository.repo}.git`,
          token,
          ...(test?.protocol ? { protocol: test.protocol } : {}),
          timeoutMs: Math.min(ctx.timeoutMs, test?.timeoutMs ?? 60_000),
        });
      }
    } catch (error) {
      let message = 'The push did not work.';
      try {
        message = String(githubFailure(error, opened.secret).body.message ?? message);
      } catch {
        // Not a connector error: the generic message stands.
      }
      result = { ok: false, code: 'push_failed', message };
    }
    if (result.ok) {
      next.push = { status: 'pushed', at: ctx.now() };
    } else {
      const message = stepFailure(result.message);
      next.push = { status: 'failed', at: ctx.now(), code: result.code, error: message };
      failed = { step: 'push', code: result.code, message };
    }
  }

  if (args.openPr && next.pr.status !== 'opened') {
    if (failed) {
      next.pr = {
        status: 'skipped',
        code: 'push_failed',
        error: 'Not opened: the branch is not on GitHub yet.',
      };
    } else {
      const connector = opened.connector;
      const controller = new AbortController();
      try {
        if (typeof connector.openPullRequest !== 'function') {
          throw new TypeError('openPullRequest is not available');
        }
        const pr = await withTimeout(
          connector.openPullRequest({
            branch,
            base: next.base.branch,
            title: neutraliseText(args.summary),
            body: pullRequestBody(args.changeSetId, args.summary, args.files),
            signal: controller.signal,
          }),
          ctx.timeoutMs,
          () => controller.abort(),
        );
        next.pr = {
          status: 'opened',
          at: ctx.now(),
          ...(pr.url ? { url: pr.url } : {}),
          ...(pr.number !== undefined ? { number: pr.number } : {}),
        };
      } catch (error) {
        let code = 'pr_failed';
        let message = 'GitHub could not open the pull request.';
        if (isTimeoutError(error)) {
          code = 'timeout';
          message = `GitHub did not answer within ${Math.round(ctx.timeoutMs / 1000)} seconds. The pull request may exist: check GitHub before trying again.`;
        } else if (error instanceof TypeError) {
          code = 'pr_unsupported';
          message = 'This connector cannot open a pull request for an existing branch.';
        } else {
          try {
            const f = githubFailure(error, opened.secret);
            code = f.body.error;
            message = String(f.body.message ?? message);
          } catch {
            // Not a connector error: the generic message stands.
          }
        }
        message = stepFailure(message);
        next.pr = { status: 'failed', at: ctx.now(), code, error: message };
        failed = { step: 'pr', code, message };
      }
    }
  }
  return { outcome: next, ...(failed ? { failed } : {}) };
}

/** Writes the result of `publish` and audits each step. Releases the publish claim. */
export async function savePublished(
  ctx: RepoContext,
  args: {
    workspaceId: string;
    repositoryId: string;
    id: string;
    before: LocalOutcome;
    result: Awaited<ReturnType<typeof publish>>;
    actor: Actor;
  },
): Promise<void> {
  const { before, result } = args;
  const { outcome } = result;
  const at = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE change_sets
          SET outcome_json = ?, pr_url = ?, pr_number = ?, updated_at = ?, publish_claim_at = NULL
        WHERE id = ? AND workspace_id = ? AND status = 'applied'`,
      [
        JSON.stringify(outcome),
        outcome.pr.url ?? null,
        outcome.pr.number ?? null,
        at,
        args.id,
        args.workspaceId,
      ],
    );
    const base = {
      repositoryId: args.repositoryId,
      branch: outcome.commit.branch,
      commitSha: outcome.commit.sha,
    };
    const audit = (action: string, detail: Record<string, unknown>) =>
      recordAudit(tx, {
        workspaceId: args.workspaceId,
        actor: args.actor,
        action,
        target: { type: 'change_set', id: args.id },
        detail: { ...base, ...detail },
        at,
      });
    if (before.push.status !== 'pushed' && outcome.push.status === 'pushed')
      await audit('changeset.push', {});
    if (outcome.push.status === 'failed' && before.push.at !== outcome.push.at) {
      await audit('changeset.push_failed', { code: outcome.push.code });
    }
    if (before.pr.status !== 'opened' && outcome.pr.status === 'opened') {
      await audit('changeset.pr_open', {
        prNumber: outcome.pr.number ?? null,
        prUrl: outcome.pr.url ?? null,
      });
    }
    if (outcome.pr.status === 'failed' && before.pr.at !== outcome.pr.at) {
      await audit('changeset.pr_failed', { code: outcome.pr.code });
    }
  });
}

/** Releases the publish claim without a result (an unexpected error). */
export const releasePublishClaim = (ctx: RepoContext, workspaceId: string, id: string) =>
  ctx.db
    .execute('UPDATE change_sets SET publish_claim_at = NULL WHERE id = ? AND workspace_id = ?', [
      id,
      workspaceId,
    ])
    .catch(() => undefined);

export const failedStep = (
  step: { step: 'push' | 'pr'; code: string; message: string },
  changeSet: ChangeSetView,
): Failure => ({
  ...failure(502, step.code, step.message, { step: step.step }),
  body: { error: step.code, message: step.message, step: step.step, changeSet },
});

/**
 * Pushes the branch of an applied local commit to GitHub, and with `openPr` opens the pull request
 * (`POST /change-sets/:id/push`). Safe to repeat: a step that is done is skipped, and a push of
 * the same commit to the same branch changes nothing. A failure is answered with 502 and the
 * change set, whose `outcome` says what is done and what is not.
 */
export async function publishLocalCommit(
  ctx: RepoContext,
  input: { workspaceId: string; id: string; openPr: boolean },
  actor: Actor,
): Promise<Outcome<{ changeSet: ChangeSetView; alreadyDone?: true }>> {
  const { db } = ctx;
  const { workspaceId, id } = input;
  const row = await rowOf(db, workspaceId, id);
  if (!row) return failure(404, 'not_found');
  const outcome = parseOutcome(row);
  if (String(row.status) !== 'applied') return invalidState(String(row.status), 'applied');
  if (!outcome) {
    return failure(
      409,
      'not_local_commit',
      'This change set was applied as a pull request through GitHub: there is no local commit to push.',
    );
  }
  const repository = await getRepository(db, workspaceId, String(row.repository_id));
  if (!repository) return failure(404, 'not_found', 'The repository of this change set is gone.');
  const refused = await preflight(ctx, repository, { push: true, openPr: input.openPr });
  if (refused) return refused;
  if (outcome.push.status === 'pushed' && (!input.openPr || outcome.pr.status === 'opened')) {
    return { ok: true, changeSet: toView(row, true), alreadyDone: true };
  }

  const now = ctx.now();
  const claimed = await db.execute(
    `UPDATE change_sets SET publish_claim_at = ?
      WHERE id = ? AND workspace_id = ? AND status = 'applied' AND outcome_json IS NOT NULL
        AND (publish_claim_at IS NULL OR publish_claim_at < ?)`,
    [now, id, workspaceId, now - PUBLISH_CLAIM_TTL_MS],
  );
  if (claimed === 0)
    return failure(409, 'publish_in_progress', 'This change set is being pushed right now.');
  try {
    const opened = await openConnectorForRepository(
      ctx,
      workspaceId,
      repository,
      actor,
      'changeset.push',
    );
    if (!opened.ok) {
      await releasePublishClaim(ctx, workspaceId, id);
      return opened;
    }
    const result = await publish(ctx, {
      workspaceId,
      repository,
      changeSetId: id,
      summary: String(row.summary),
      files: parseFiles(row),
      outcome,
      openPr: input.openPr,
      opened,
    });
    await savePublished(ctx, {
      workspaceId,
      repositoryId: repository.id,
      id,
      before: outcome,
      result,
      actor,
    });
    const changeSet = (await getChangeSet(db, workspaceId, id)) as ChangeSetView;
    return result.failed ? failedStep(result.failed, changeSet) : { ok: true, changeSet };
  } catch (error) {
    await releasePublishClaim(ctx, workspaceId, id);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Apply as a commit on a new branch

/**
 * Commits an approved change set on a new branch of the repository's local clone, then (when
 * asked) pushes it and opens a pull request. Refusals that need no write (`local_write_disabled`,
 * no clone, bad options, a push that cannot work) leave the change set approved. The claim is the
 * GitHub apply's: of two requests exactly one commits. The step results are in `changeSet.outcome`.
 */
export async function applyChangeSetLocally(
  ctx: RepoContext,
  input: LocalApplyInput,
  actor: Actor,
): Promise<Outcome<ApplyResult>> {
  const { db } = ctx;
  const { workspaceId, id } = input;
  const row = await rowOf(db, workspaceId, id);
  if (!row) return failure(404, 'not_found');
  if (String(row.status) === 'applied')
    return { ok: true, changeSet: toView(row, true), alreadyApplied: true };
  const repository = await getRepository(db, workspaceId, String(row.repository_id));
  if (!repository) return failure(404, 'not_found', 'The repository of this change set is gone.');
  const refused = await preflight(ctx, repository, input);
  if (refused) return refused;

  const now = ctx.now();
  const claimed = await db.execute(
    `UPDATE change_sets SET status = 'applying', error = NULL, updated_at = ?
      WHERE id = ? AND workspace_id = ?
        AND (status = 'approved' OR (status = 'applying' AND updated_at < ?))`,
    [now, id, workspaceId, now - APPLY_CLAIM_TTL_MS],
  );
  if (claimed === 0) {
    const fresh = await rowOf(db, workspaceId, id);
    const status = String(fresh?.status ?? row.status);
    if (status === 'applied' && fresh)
      return { ok: true, changeSet: toView(fresh, true), alreadyApplied: true };
    if (status === 'applying')
      return failure(409, 'apply_in_progress', 'This change set is being applied right now.');
    return invalidState(status, 'approved');
  }

  /** Back to approved: no branch was made, so the same change set can be applied again. */
  const release = async (f: Failure): Promise<Outcome<ApplyResult>> => {
    await db.execute(
      `UPDATE change_sets SET status = 'approved', error = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'applying'`,
      [String(f.body.message ?? f.body.error), ctx.now(), id, workspaceId],
    );
    return { ...f, body: { ...f.body, changeSet: await getChangeSet(db, workspaceId, id) } };
  };

  const wantsPublish = input.push || input.openPr;
  let opened: Opened | undefined;
  if (wantsPublish) {
    const connector = await openConnectorForRepository(
      ctx,
      workspaceId,
      repository,
      actor,
      'changeset.push',
    );
    if (!connector.ok) return release(connector);
    opened = connector;
  }

  const files = parseFiles(row);
  const summary = String(row.summary);
  const branch = input.branch ?? localBranchNameFor(id, summary);
  let committed: BranchCommitOutcome;
  try {
    committed = await createBranchCommit({
      gitPath: ctx.reads?.gitPath ?? 'git',
      path: repository.local?.path ?? '',
      roots: ctx.reads?.local ?? { roots: [], excluded: [] },
      baseBranch: repository.local?.branch ?? repository.defaultBranch,
      branch,
      files,
      message: commitMessageFor(id, summary, files, !repository.localOnly),
      author: await identityFor(ctx, actor),
      now: ctx.now(),
      deadline: Date.now() + ctx.timeoutMs,
      ...(ctx.localWrite?.signing ? { signing: ctx.localWrite.signing } : {}),
    });
  } catch (error) {
    await release(
      failure(502, 'local_git_failed', 'Committing to the local clone failed unexpectedly.'),
    );
    throw error;
  }
  if (!committed.ok) return release(commitFailure(committed));

  const at = ctx.now();
  const outcome: LocalOutcome = {
    mode: 'local_branch',
    base: { branch: repository.local?.branch ?? repository.defaultBranch, commit: committed.base },
    commit: { branch, sha: committed.commit, at },
    requested: { push: input.push, openPr: input.openPr },
    ...(committed.signature
      ? { signature: { status: 'signed' as const, format: committed.signature.format } }
      : {}),
    push: { status: 'not_requested' },
    pr: { status: 'not_requested' },
  };
  // The branch exists now. From here nothing rolls it back; a failure to record it is left to the
  // stale claim (the next apply reports `branch_exists`, and the branch is in the clone).
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE change_sets
          SET status = 'applied', branch = ?, commit_sha = ?, pr_url = NULL, pr_number = NULL, outcome_json = ?,
              error = NULL, applied_at = ?, updated_at = ?, publish_claim_at = ?
        WHERE id = ? AND workspace_id = ?`,
      [
        branch,
        committed.commit,
        JSON.stringify(outcome),
        at,
        at,
        wantsPublish ? at : null,
        id,
        workspaceId,
      ],
    );
    await recordAudit(tx, {
      workspaceId,
      actor,
      action: 'changeset.apply_local',
      target: { type: 'change_set', id },
      detail: {
        repositoryId: repository.id,
        mode: 'local_branch',
        branch,
        commitSha: committed.commit,
        baseBranch: outcome.base.branch,
        baseCommit: committed.base,
        path: repository.local?.path ?? null,
        files: files.length,
        signed: committed.signature !== undefined,
        signature: committed.signature?.format ?? null,
        pushRequested: input.push,
        prRequested: input.openPr,
      },
      at,
    });
  });

  if (opened) {
    try {
      const result = await publish(ctx, {
        workspaceId,
        repository,
        changeSetId: id,
        summary,
        files,
        outcome,
        openPr: input.openPr,
        opened,
      });
      await savePublished(ctx, {
        workspaceId,
        repositoryId: repository.id,
        id,
        before: outcome,
        result,
        actor,
      });
    } catch (error) {
      await releasePublishClaim(ctx, workspaceId, id);
      throw error;
    }
  }
  return { ok: true, changeSet: (await getChangeSet(db, workspaceId, id)) as ChangeSetView };
}
