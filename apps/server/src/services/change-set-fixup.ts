import {
  BranchMissingError,
  BranchMovedError,
  DefaultBranchError,
  GithubError,
  type PullRequestInfo,
} from '@kiln/connectors';
import type { ActorType, FileChange } from '@kiln/core';
import { coded } from '../i18n/problem.ts';
import { recordAudit } from './audit.ts';
import {
  commitFailure,
  failedStep,
  identityFor,
  PUBLISH_CLAIM_TTL_MS,
  preflight,
  publish,
  releasePublishClaim,
  savePublished,
} from './change-set-local.ts';
import {
  type ConflictReason,
  evaluateFile,
  type FileState,
  REFRESH_PURPOSE,
  type Resolution,
  readCurrent,
  resolveConflict,
} from './change-set-refresh.ts';
import {
  type ChangeSetOrigin,
  type ChangeSetView,
  type FixupRecord,
  getChangeSet,
  invalidState,
  type LocalOutcome,
  neutraliseText,
  parseFiles,
  parseOutcome,
  pullRequestBody,
  rowOf,
} from './change-sets.ts';
import { fixupBranchCommit, readBranchFiles } from './local-git.ts';
import {
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
 * Fixing up a branch (docs/adr/0005-local-clone-reads.md, "Fixing up a branch"): refresh the
 * content of a change set whose branch ALREADY EXISTS, and add ONE new commit on top of that
 * branch with the difference. History is never rewritten, the ref is only ever moved forward from
 * the exact tip that was read, nothing is forced.
 *
 * Two comparisons, in this order, both three-way merges of text (text-merge.ts):
 *
 *  1. against the repository (the default branch, or the local clone's branch), exactly like a
 *     refresh: base = the stored `before`, ours = the stored `after`, theirs = the repository now.
 *     The result is the desired text `D` of each file; a file that leaves the set (already in the
 *     repository, or "keep theirs") is reset on the branch to what the repository has.
 *  2. against the branch: base = `A`, the text this tool last committed on the branch (the stored
 *     `after`), ours = `D`, theirs = `T`, what the branch holds now. When nobody touched the file
 *     on the branch (`T == A`) the answer is simply `D`; when a person edited it, the edits are
 *     merged, and an overlap is a conflict with a choice per file (keep mine / keep theirs).
 *
 * The delta of the files whose text on the branch must change is ONE commit. An empty delta is
 * `nothing_to_fix`. The refusals that write nothing are listed in the ADR: `branch_moved`,
 * `branch_checked_out`, `pr_closed`, `remote_diverged` (a push that is not a fast-forward).
 */

type Actor = { type: ActorType; id: string };

export type FixupInput = {
  workspaceId: string;
  id: string;
  /** Conflicts with the repository (stage 1), by path. */
  resolutions?: Record<string, Resolution> | undefined;
  /** Conflicts with the branch (stage 2), by path. */
  branchResolutions?: Record<string, Resolution> | undefined;
  /** Local mode: push the new tip, and open the pull request when there is none. */
  push?: boolean | undefined;
  openPr?: boolean | undefined;
  /** Work out and report everything, write nothing. */
  dryRun?: boolean | undefined;
  /**
   * The content to use instead of the stored one (a recompute of a store pull): files made against
   * the repository as it is now. The stored files not in it are reset on the branch. Stage 1 is
   * then a plain replacement.
   */
  desired?: { files: FileChange[]; origin?: ChangeSetOrigin } | undefined;
};

export type FixupFile = {
  path: string;
  /** Stage 1: what the repository comparison found (`recomputed` / `removed` for a recomputed set). */
  state: FileState | 'recomputed' | 'removed';
  /**
   * `commit`: the file is in the new commit. `unchanged`: the branch already has the right text.
   * `kept_branch`: the branch's own text stays (a person's edit that merges, or "keep theirs").
   * `kept_mine`: our text overwrites theirs by the person's choice. `conflict`: waiting for a choice.
   */
  outcome: 'commit' | 'unchanged' | 'kept_branch' | 'kept_mine' | 'kept_theirs' | 'conflict';
  /** The file leaves the change set (the repository has it already, or "keep theirs"). */
  leavesSet: boolean;
  /** For a conflict: which comparison found it, why, and the three texts (`null` where the file does not exist). */
  stage?: 'repository' | 'branch';
  reason?: ConflictReason;
  base?: string | null;
  ours?: string | null;
  theirs?: string | null;
};

export type FixupResult = {
  changeSet: ChangeSetView;
  mode: 'local_branch' | 'github_pr';
  branch: string;
  /** Nothing to commit and no step left: nothing was written. */
  nothingToFix: boolean;
  files: FixupFile[];
  /** The commit the repository was read at (or the branch name). */
  refreshedFrom: string;
  /** The branch tip the comparison was made against. */
  tip: string;
  /** The files that are (or, for a dry run, would be) in the new commit. */
  willCommit: string[];
  /** Set when a commit was added. */
  commit?: { sha: string; parent: string; files: number; signed: boolean };
  /** The pull request: `updates` (open, follows the branch), `opened` (made now), `none`. */
  pullRequest: { state: 'open' | 'opened' | 'none'; number?: number; url?: string };
  dryRun?: true;
  /** For a dry run: how many files wait for a choice. */
  conflicts?: number;
};

const text = (value: string | undefined): string | null => (value === undefined ? null : value);

// ---------------------------------------------------------------------------------------------
// The pure part: one file against the branch

export type BranchPlan =
  | {
      kind: 'keep';
      final: string | undefined;
      why: 'same' | 'nothing_new' | 'merged_in_place' | 'chose_theirs';
    }
  | {
      kind: 'write';
      content: string | undefined;
      final: string | undefined;
      why: 'clean' | 'merged' | 'chose_mine';
    }
  | {
      kind: 'conflict';
      reason: ConflictReason;
      base: string | undefined;
      ours: string | undefined;
      theirs: string | undefined;
    };

/**
 * What to do with one file on the branch. `committed` is the text this tool last wrote there
 * (`A`), `desired` the text the file should have (`D`), `tip` what the branch holds now (`T`);
 * `undefined` is "no such file". Pure.
 */
export function planBranchFile(
  path: string,
  committed: string | undefined,
  desired: string | undefined,
  tip: string | undefined,
  choice?: Resolution,
): BranchPlan {
  if (tip === desired) return { kind: 'keep', final: tip, why: 'same' };
  // Nothing new is wanted for this file: whatever else is on the branch stays.
  if (desired === committed) return { kind: 'keep', final: tip, why: 'nothing_new' };
  // Nobody touched it on the branch since we wrote it.
  if (tip === committed) return { kind: 'write', content: desired, final: desired, why: 'clean' };
  const evaluation = evaluateFile(
    {
      path,
      ...(committed !== undefined ? { before: committed } : {}),
      ...(desired !== undefined ? { after: desired } : {}),
    },
    tip,
  );
  switch (evaluation.state) {
    case 'same':
      return { kind: 'write', content: desired, final: desired, why: 'clean' };
    case 'already_applied':
      return { kind: 'keep', final: tip, why: 'merged_in_place' };
    case 'changed':
      return {
        kind: 'write',
        content: evaluation.file.after,
        final: evaluation.file.after,
        why: 'merged',
      };
    case 'conflict':
      if (choice === 'mine')
        return { kind: 'write', content: desired, final: desired, why: 'chose_mine' };
      if (choice === 'theirs') return { kind: 'keep', final: tip, why: 'chose_theirs' };
      return {
        kind: 'conflict',
        reason: evaluation.reason,
        base: committed,
        ours: desired,
        theirs: tip,
      };
  }
}

/** The commit message of a fix-up: the summary, then the files. Never a secret. */
export function fixupMessageFor(
  id: string,
  summary: string,
  changes: readonly { path: string; content?: string | undefined; existed: boolean }[],
  neutralise: boolean,
): string {
  const line = summary.replace(/\s+/g, ' ').trim();
  const label = (c: { content?: string | undefined; existed: boolean }) =>
    c.content === undefined ? 'deleted' : c.existed ? 'modified' : 'added';
  const shown = changes.slice(0, 50).map((c) => `- ${c.path} (${label(c)})`);
  if (changes.length > 50) shown.push(`- and ${changes.length - 50} more`);
  return [
    `Fix up: ${neutralise ? neutraliseText(line) : line}`,
    '',
    `Changed files (${changes.length}):`,
    ...shown,
    '',
    `Change set ${id}, fixed up in Kiln.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// The service

const FIXABLE = ['applied', 'failed'];

type Branch = { tip: string; texts: Map<string, string | undefined> };

const stepMessage = (message: string) => message.replace(/\s+/g, ' ').slice(0, 300);

export async function fixupChangeSet(
  ctx: RepoContext,
  input: FixupInput,
  actor: Actor,
): Promise<Outcome<{ result: FixupResult }>> {
  const { db } = ctx;
  const { workspaceId, id } = input;
  const row = await rowOf(db, workspaceId, id);
  if (!row) return failure(404, 'not_found');
  const status = String(row.status);
  if (!FIXABLE.includes(status)) return invalidState(status, 'applied or failed');
  const branch = row.branch ? String(row.branch) : undefined;
  if (!branch) {
    return failure(
      409,
      'no_branch',
      'This change set has no branch to fix up. Refresh it (or recompute it) instead.',
      coded('changeSet.noBranchFixup'),
    );
  }
  const localOutcome = parseOutcome(row);
  const mode: FixupResult['mode'] = localOutcome ? 'local_branch' : 'github_pr';
  const repository = await getRepository(db, workspaceId, String(row.repository_id));
  if (!repository)
    return failure(
      404,
      'not_found',
      'The repository of this change set is gone.',
      coded('changeSet.repositoryGone'),
    );
  const push = input.push === true;
  const openPr = input.openPr === true;
  if (mode === 'github_pr' && (push || openPr)) {
    return failure(
      422,
      'invalid_request',
      '"push" and "openPr" apply to a change set applied as a local commit only. A pull request through GitHub is updated by the new commit.',
      coded('changeSet.pushOnlyLocal'),
    );
  }
  if (mode === 'local_branch') {
    const refused = await preflight(ctx, repository, { push, openPr });
    if (refused) return refused;
  }
  const summary = String(row.summary);
  const stored = parseFiles(row);
  if (stored.some((f) => f.encoding === 'base64')) {
    return failure(
      422,
      'binary_change_set',
      'This change set holds images, which are applied as they are. A fix-up works on text files only: discard it and make the change again.',
      coded('changeSet.hasImagesFixup'),
    );
  }
  const known = new Set(stored.map((f) => f.path));
  const unknown = Object.keys(input.resolutions ?? {}).filter((p) => !known.has(p));
  if (unknown.length > 0) {
    return failure(422, 'unknown_path', 'A choice names a file that is not in this change set.', {
      paths: unknown.slice(0, 50),
      ...coded('changeSet.unknownFile'),
    });
  }
  const universe = [
    ...new Set([...stored.map((f) => f.path), ...(input.desired?.files ?? []).map((f) => f.path)]),
  ];
  const stray = Object.keys(input.branchResolutions ?? {}).filter((p) => !universe.includes(p));
  if (stray.length > 0) {
    return failure(422, 'unknown_path', 'A choice names a file that is not in this change set.', {
      paths: stray.slice(0, 50),
      ...coded('changeSet.unknownFile'),
    });
  }

  // The claim (a push, a fix-up and another fix-up exclude each other). A dry run takes none.
  const dryRun = input.dryRun === true;
  const claimedAt = ctx.now();
  if (!dryRun) {
    const claimed = await db.execute(
      `UPDATE change_sets SET publish_claim_at = ?
        WHERE id = ? AND workspace_id = ? AND status IN ('applied', 'failed') AND branch IS NOT NULL
          AND (publish_claim_at IS NULL OR publish_claim_at < ?)`,
      [claimedAt, id, workspaceId, claimedAt - PUBLISH_CLAIM_TTL_MS],
    );
    if (claimed === 0) {
      return failure(
        409,
        'fixup_in_progress',
        'This change set is being pushed or fixed up right now.',
        coded('changeSet.fixupBusy'),
      );
    }
  }
  try {
    return await run(
      ctx,
      { ...input, dryRun },
      { row, status, branch, mode, repository, localOutcome, summary, stored, universe },
      actor,
    );
  } catch (error) {
    if (!dryRun) await releasePublishClaim(ctx, workspaceId, id);
    throw error;
  }
}

type Loaded = {
  row: Record<string, unknown>;
  status: string;
  branch: string;
  mode: FixupResult['mode'];
  repository: Repository;
  localOutcome: LocalOutcome | null;
  summary: string;
  stored: FileChange[];
  universe: string[];
};

/** `run` owns the claim from here: every path out releases it (or leaves it to `savePublished`). */
async function run(
  ctx: RepoContext,
  input: FixupInput & { dryRun: boolean },
  loaded: Loaded,
  actor: Actor,
): Promise<Outcome<{ result: FixupResult }>> {
  const { db } = ctx;
  const { workspaceId, id } = input;
  const { row, status, branch, mode, repository, localOutcome, summary, stored, universe } = loaded;
  const push = input.push === true;
  const openPr = input.openPr === true;
  const release = () =>
    input.dryRun ? Promise.resolve() : releasePublishClaim(ctx, workspaceId, id);
  const refuse = async (f: Failure): Promise<Failure> => {
    await release();
    return { ...f, body: { ...f.body, changeSet: await getChangeSet(db, workspaceId, id) } };
  };
  const auditFailure = async (f: Failure) => {
    if (input.dryRun) return;
    await recordAudit(db, {
      workspaceId,
      actor,
      action: 'changeset.fixup_failed',
      target: { type: 'change_set', id },
      detail: {
        repositoryId: repository.id,
        mode,
        branch,
        reason: f.body.error,
        files: universe.length,
      },
      at: ctx.now(),
    }).catch(() => undefined);
  };
  const stop = async (f: Failure, audit = true): Promise<Failure> => {
    if (audit) await auditFailure(f);
    return refuse(f);
  };

  // Stage 1: the repository now.
  const read = await readCurrent(
    ctx,
    { workspaceId, repositoryId: repository.id, paths: universe, purpose: REFRESH_PURPOSE },
    actor,
  );
  if (!read.ok) return stop(read, false);
  const current = read.current;

  type Item = {
    path: string;
    desired: string | undefined;
    base: string | undefined;
    committed: string | undefined;
    entry?: FileChange;
    state: FixupFile['state'];
    leavesSet: boolean;
  };
  const items: Item[] = [];
  const files: FixupFile[] = [];
  let repoConflicts = 0;
  const storedByPath = new Map(stored.map((f) => [f.path, f]));
  if (input.desired) {
    const wanted = new Map(input.desired.files.map((f) => [f.path, f]));
    for (const path of universe) {
      const theirs = current.texts.get(path);
      const old = storedByPath.get(path);
      const next = wanted.get(path);
      const committed = old ? old.after : theirs;
      if (next)
        items.push({
          path,
          desired: next.after,
          base: next.before,
          committed,
          entry: next,
          state: 'recomputed',
          leavesSet: false,
        });
      else
        items.push({
          path,
          desired: theirs,
          base: theirs,
          committed,
          state: 'removed',
          leavesSet: true,
        });
    }
  } else {
    for (const file of stored) {
      const theirs = current.texts.get(file.path);
      const evaluation = evaluateFile(file, theirs);
      const base = { path: file.path, committed: file.after };
      switch (evaluation.state) {
        case 'same':
          items.push({
            ...base,
            desired: file.after,
            base: theirs,
            entry: file,
            state: 'same',
            leavesSet: false,
          });
          break;
        case 'already_applied':
          items.push({
            ...base,
            desired: theirs,
            base: theirs,
            state: 'already_applied',
            leavesSet: true,
          });
          break;
        case 'changed':
          items.push({
            ...base,
            desired: evaluation.file.after,
            base: theirs,
            entry: evaluation.file,
            state: 'changed',
            leavesSet: false,
          });
          break;
        case 'conflict': {
          const choice = input.resolutions?.[file.path];
          if (choice === 'mine') {
            const mine = resolveConflict(file, theirs, 'mine');
            items.push({
              ...base,
              desired: file.after,
              base: theirs,
              ...(mine ? { entry: mine } : {}),
              state: 'conflict',
              leavesSet: false,
            });
          } else if (choice === 'theirs') {
            items.push({
              ...base,
              desired: theirs,
              base: theirs,
              state: 'conflict',
              leavesSet: true,
            });
          } else {
            repoConflicts++;
            files.push({
              path: file.path,
              state: 'conflict',
              outcome: 'conflict',
              leavesSet: false,
              stage: 'repository',
              reason: evaluation.reason,
              base: text(evaluation.base),
              ours: text(evaluation.ours),
              theirs: text(evaluation.theirs),
            });
          }
        }
      }
    }
  }
  if (repoConflicts > 0 && !input.dryRun) {
    await release();
    return {
      ...failure(
        409,
        'refresh_conflicts',
        `${repoConflicts === 1 ? 'One file' : `${repoConflicts} files`} changed in the repository in the same place as this change set. Choose for each: keep your text (overwriting theirs) or keep theirs (dropping your change). Nothing was changed.`,
        { files, conflicts: repoConflicts, refreshedFrom: current.ref },
      ),
    };
  }

  // The branch now: its tip, the text of each file there, and the state of its pull request.
  let branchNow: Branch;
  let opened: Opened | undefined;
  let pr: PullRequestInfo | undefined;
  const knownNumber =
    mode === 'local_branch'
      ? localOutcome?.pr.number
      : row.pr_number === null || row.pr_number === undefined
        ? undefined
        : Number(row.pr_number);
  const needsConnector = mode === 'github_pr' || push || openPr || knownNumber !== undefined;
  if (needsConnector) {
    const connector = await openConnectorForRepository(
      ctx,
      workspaceId,
      repository,
      actor,
      'changeset.fixup',
    );
    if (!connector.ok) return stop(connector, false);
    opened = connector;
  }
  const controller = new AbortController();
  try {
    if (opened && typeof opened.connector.findPullRequest === 'function') {
      const finder = opened.connector.findPullRequest.bind(opened.connector);
      pr = await withTimeout(
        finder(
          knownNumber !== undefined
            ? { number: knownNumber, signal: controller.signal }
            : { branch, signal: controller.signal },
        ),
        ctx.timeoutMs,
        () => controller.abort(),
      );
    }
    if (mode === 'github_pr') {
      const connector = (opened as Opened).connector;
      if (
        typeof connector.commitOnBranch !== 'function' ||
        typeof connector.branchTip !== 'function'
      ) {
        return stop(
          failure(
            422,
            'fixup_unsupported',
            'This connector cannot add a commit to an existing branch.',
            coded('changeSet.noCommitToBranch'),
          ),
          false,
        );
      }
      const tip = await withTimeout(
        connector.branchTip(branch, controller.signal),
        ctx.timeoutMs,
        () => controller.abort(),
      );
      if (tip === undefined) {
        return stop(
          failure(
            409,
            'branch_missing',
            `The branch ${branch} does not exist on GitHub any more. Discard this change set and create a new one.`,
            coded('changeSet.branchGone', { branch }),
          ),
        );
      }
      const texts = new Map<string, string | undefined>();
      for (let i = 0; i < universe.length; i += 8) {
        const batch = universe.slice(i, i + 8);
        const got = await withTimeout(
          Promise.all(batch.map((path) => connector.readFile(path, tip))),
          ctx.timeoutMs,
          () => controller.abort(),
        );
        batch.forEach((path, n) => texts.set(path, got[n]));
      }
      branchNow = { tip, texts };
    } else {
      const reading = await readBranchFiles({
        gitPath: ctx.reads?.gitPath ?? 'git',
        path: repository.local?.path ?? '',
        roots: ctx.reads?.local ?? { roots: [], excluded: [] },
        branch,
        paths: universe,
      });
      if (!reading.ok) return stop(commitFailure(reading));
      branchNow = { tip: reading.tip, texts: reading.texts };
    }
  } catch (error) {
    if (isTimeoutError(error)) {
      return stop(
        failure(
          504,
          'timeout',
          `GitHub did not answer within ${Math.round(ctx.timeoutMs / 1000)} seconds. Nothing was changed.`,
          coded('changeSet.githubTimeout', { count: Math.round(ctx.timeoutMs / 1000) }),
        ),
        false,
      );
    }
    let f: Failure;
    try {
      f = githubFailure(error, opened?.secret);
    } catch (unknown) {
      await release();
      throw unknown;
    }
    return stop(f, false);
  }

  // A pull request that is merged or closed is finished: its branch is not fixed up.
  if (pr && pr.state !== 'open') {
    return stop(
      failure(
        409,
        'pr_closed',
        `Pull request #${pr.number} is ${pr.state}. A fix-up would not reach the repository. Create a new change set instead.`,
        { number: pr.number, state: pr.state },
      ),
    );
  }

  // Stage 2: each file against the branch.
  const changes: { path: string; content?: string | undefined; existed: boolean }[] = [];
  const finals = new Map<string, string | undefined>();
  let branchConflicts = 0;
  const stageOne = new Map(files.map((f) => [f.path, f]));
  const outFiles: FixupFile[] = [];
  for (const item of items) {
    const tipText = branchNow.texts.get(item.path);
    const choice = input.branchResolutions?.[item.path];
    const plan = planBranchFile(item.path, item.committed, item.desired, tipText, choice);
    const common = { path: item.path, state: item.state, leavesSet: item.leavesSet };
    if (plan.kind === 'conflict') {
      branchConflicts++;
      outFiles.push({
        ...common,
        outcome: 'conflict',
        stage: 'branch',
        reason: plan.reason,
        base: text(plan.base),
        ours: text(plan.ours),
        theirs: text(plan.theirs),
      });
      continue;
    }
    finals.set(item.path, plan.final);
    if (plan.kind === 'write') {
      changes.push({ path: item.path, content: plan.content, existed: tipText !== undefined });
      outFiles.push({ ...common, outcome: plan.why === 'chose_mine' ? 'kept_mine' : 'commit' });
    } else {
      outFiles.push({
        ...common,
        outcome:
          plan.why === 'chose_theirs'
            ? 'kept_theirs'
            : plan.why === 'same' || plan.why === 'nothing_new'
              ? 'unchanged'
              : 'kept_branch',
      });
    }
  }
  const allFiles = [...stageOne.values(), ...outFiles];
  if (branchConflicts + repoConflicts > 0 && !input.dryRun) {
    await release();
    return {
      ...failure(
        409,
        'fixup_conflicts',
        `${branchConflicts === 1 ? 'One file was' : `${branchConflicts} files were`} also changed on the branch ${branch}, in the same place. Choose for each: keep your text (overwriting the branch's) or keep the branch's. Nothing was changed.`,
        {
          files: outFiles,
          conflicts: branchConflicts,
          refreshedFrom: current.ref,
          tip: branchNow.tip,
        },
      ),
    };
  }

  // What is left to do besides the commit.
  const hasPr = pr !== undefined && pr.state === 'open';
  const prWork =
    mode === 'github_pr' &&
    !hasPr &&
    (status === 'failed' || row.pr_url === null || row.pr_url === undefined);
  // A failed set whose pull request exists after all (found by its head branch) is applied.
  const statusWork = mode === 'github_pr' && status === 'failed' && hasPr;
  const publishWork =
    mode === 'local_branch' &&
    localOutcome !== null &&
    push &&
    (changes.length > 0 ||
      localOutcome.push.status !== 'pushed' ||
      (openPr && localOutcome.pr.status !== 'opened'));
  const base = {
    mode,
    branch,
    files: allFiles,
    refreshedFrom: current.ref,
    tip: branchNow.tip,
    willCommit: changes.map((c) => c.path),
  } as const;
  const view = async () => (await getChangeSet(db, workspaceId, id)) as ChangeSetView;
  const prState = (): FixupResult['pullRequest'] =>
    hasPr && pr
      ? { state: 'open', number: pr.number, ...(pr.url ? { url: pr.url } : {}) }
      : { state: 'none' };

  if (input.dryRun) {
    return {
      ok: true,
      result: {
        ...base,
        changeSet: await view(),
        nothingToFix:
          changes.length === 0 &&
          !prWork &&
          !publishWork &&
          !statusWork &&
          branchConflicts + repoConflicts === 0,
        pullRequest: prState(),
        dryRun: true,
        conflicts: branchConflicts + repoConflicts,
      },
    };
  }
  if (changes.length === 0 && !prWork && !publishWork && !statusWork) {
    await release();
    return {
      ok: true,
      result: { ...base, changeSet: await view(), nothingToFix: true, pullRequest: prState() },
    };
  }

  // The new content of the change set: what the branch will hold for the files that stay in it.
  const kept: FileChange[] = [];
  for (const item of items) {
    if (item.leavesSet) continue;
    const final = finals.get(item.path);
    if (final === item.base) continue; // the branch no longer differs from the repository here
    kept.push({
      path: item.path,
      ...(item.base !== undefined ? { before: item.base } : {}),
      ...(final !== undefined ? { after: final } : {}),
    });
  }

  // The commit.
  let committed:
    | { sha: string; parent: string; files: number; signature?: { format: 'ssh' | 'gpg' } }
    | undefined;
  const writtenAt = ctx.now();
  if (changes.length > 0) {
    const message = fixupMessageFor(id, summary, changes, !repository.localOnly);
    if (mode === 'local_branch') {
      let made: Awaited<ReturnType<typeof fixupBranchCommit>>;
      try {
        made = await fixupBranchCommit({
          gitPath: ctx.reads?.gitPath ?? 'git',
          path: repository.local?.path ?? '',
          roots: ctx.reads?.local ?? { roots: [], excluded: [] },
          branch,
          expectedTip: branchNow.tip,
          changes: changes.map((c) => ({
            path: c.path,
            ...(c.content !== undefined ? { content: c.content } : {}),
          })),
          message,
          author: await identityFor(ctx, actor),
          now: writtenAt,
          deadline: Date.now() + ctx.timeoutMs,
          ...(ctx.localWrite?.signing ? { signing: ctx.localWrite.signing } : {}),
        });
      } catch (error) {
        await release();
        throw error;
      }
      if (!made.ok) {
        if (made.code === 'no_changes') {
          await release();
          return {
            ok: true,
            result: {
              ...base,
              changeSet: await view(),
              nothingToFix: true,
              pullRequest: prState(),
            },
          };
        }
        return stop(commitFailure(made));
      }
      committed = {
        sha: made.commit,
        parent: made.parent,
        files: made.changed,
        ...(made.signature ? { signature: made.signature } : {}),
      };
    } else {
      const connector = (opened as Opened).connector as Required<
        Pick<Opened['connector'], 'commitOnBranch'>
      >;
      const abort = new AbortController();
      try {
        const result = await withTimeout(
          connector.commitOnBranch({
            branch,
            expectedTip: branchNow.tip,
            changes: changes.map((c) => ({
              path: c.path,
              ...(c.content !== undefined ? { content: c.content } : {}),
            })),
            message,
            signal: abort.signal,
          }),
          ctx.timeoutMs,
          () => abort.abort(),
        );
        committed = { sha: result.commit, parent: result.parent, files: result.changed };
      } catch (error) {
        if (error instanceof BranchMovedError) {
          return stop(
            failure(
              409,
              'branch_moved',
              `The branch ${branch} moved while this was being prepared. Nothing was changed; look at it again and retry.`,
              coded('changeSet.branchMoved', { branch }),
            ),
          );
        }
        if (error instanceof BranchMissingError) {
          return stop(
            failure(
              409,
              'branch_missing',
              `The branch ${branch} does not exist on GitHub any more. Discard this change set and create a new one.`,
              coded('changeSet.branchGone', { branch }),
            ),
          );
        }
        if (error instanceof DefaultBranchError) {
          return stop(failure(409, 'default_branch', error.message));
        }
        if (error instanceof GithubError && error.kind === 'no_changes') {
          committed = undefined;
        } else if (isTimeoutError(error)) {
          return stop(
            failure(
              504,
              'timeout',
              `GitHub did not answer within ${Math.round(ctx.timeoutMs / 1000)} seconds and the request was cancelled. The commit may already be on ${branch}: look at the branch, then fix up again (a commit that landed is found and not repeated).`,
              coded('changeSet.fixupTimeout', { count: Math.round(ctx.timeoutMs / 1000), branch }),
            ),
          );
        } else {
          let f: Failure;
          try {
            f = githubFailure(error, opened?.secret);
          } catch (unknown) {
            await release();
            throw unknown;
          }
          if (f.status === 429) return refuse(f);
          return stop(f);
        }
      }
    }
  }

  // GitHub mode: a pull request when there is none.
  let prNow: { number?: number; url?: string } | undefined;
  let prFailure: Failure | undefined;
  if (mode === 'github_pr' && prWork) {
    const connector = (opened as Opened).connector;
    if (typeof connector.openPullRequest === 'function') {
      try {
        const base = await withTimeout(connector.defaultBranch(), ctx.timeoutMs);
        const made = await withTimeout(
          connector.openPullRequest({
            branch,
            base,
            title: neutraliseText(summary),
            body: pullRequestBody(id, summary, kept.length > 0 ? kept : stored),
          }),
          ctx.timeoutMs,
        );
        prNow = {
          ...(made.number !== undefined ? { number: made.number } : {}),
          ...(made.url ? { url: made.url } : {}),
        };
      } catch (error) {
        try {
          prFailure = isTimeoutError(error)
            ? failure(
                504,
                'timeout',
                'GitHub did not answer in time. The pull request may exist: check GitHub before trying again.',
                coded('changeSet.pullRequestTimeout'),
              )
            : githubFailure(error, opened?.secret);
        } catch (unknown) {
          await release();
          throw unknown;
        }
      }
    } else {
      prFailure = failure(
        422,
        'pr_unsupported',
        'This connector cannot open a pull request for an existing branch.',
        coded('changeSet.noPullRequestExisting'),
      );
    }
  }

  // Record it. Local mode keeps the publish claim while the push is still to come.
  const at = ctx.now();
  const signed = committed?.signature;
  const record: FixupRecord | undefined = committed
    ? {
        at,
        commit: committed.sha,
        parent: committed.parent,
        files: committed.files,
        pushed: false,
        ...(signed ? { signature: { status: 'signed', format: signed.format } } : {}),
      }
    : undefined;
  let nextOutcome: LocalOutcome | undefined;
  let outcomeJson: string | null =
    row.outcome_json === null || row.outcome_json === undefined ? null : String(row.outcome_json);
  if (mode === 'local_branch' && localOutcome) {
    nextOutcome = structuredClone(localOutcome);
    if (committed && record) {
      nextOutcome.commit = { branch, sha: committed.sha, at };
      if (signed) nextOutcome.signature = { status: 'signed', format: signed.format };
      else delete nextOutcome.signature;
      if (nextOutcome.push.status === 'pushed')
        nextOutcome.push = {
          status: 'behind',
          ...(nextOutcome.push.at !== undefined ? { at: nextOutcome.push.at } : {}),
        };
      nextOutcome.fixups = [...(nextOutcome.fixups ?? []), record];
    }
    outcomeJson = JSON.stringify(nextOutcome);
  } else if (record) {
    let fixups: FixupRecord[] = [];
    try {
      const parsed = outcomeJson ? (JSON.parse(outcomeJson) as { fixups?: FixupRecord[] }) : {};
      fixups = Array.isArray(parsed.fixups) ? parsed.fixups : [];
    } catch {
      fixups = [];
    }
    outcomeJson = JSON.stringify({ mode: 'github_pr', fixups: [...fixups, record] });
  }
  const filesJson =
    changes.length > 0 ||
    kept.length !== stored.length ||
    JSON.stringify(kept) !== JSON.stringify(stored)
      ? JSON.stringify(kept)
      : null;
  const holdClaim = mode === 'local_branch' && publishWork;
  const finalStatus =
    mode === 'github_pr' && status === 'failed' && prFailure === undefined && (prWork || statusWork)
      ? 'applied'
      : status;
  const prUrl = prNow?.url ?? (hasPr && pr?.url ? pr.url : undefined);
  const prNumber = prNow?.number ?? (hasPr ? pr?.number : undefined);
  const error =
    mode === 'github_pr' && prFailure
      ? stepMessage(String(prFailure.body.message ?? prFailure.body.error))
      : finalStatus === 'applied'
        ? null
        : row.error === null || row.error === undefined
          ? null
          : String(row.error);
  const wrote = await db.transaction(async (tx): Promise<boolean> => {
    const changed = await tx.execute(
      `UPDATE change_sets
          SET files_json = COALESCE(?, files_json), commit_sha = COALESCE(?, commit_sha), outcome_json = ?,
              status = ?, error = ?, pr_url = COALESCE(?, pr_url), pr_number = COALESCE(?, pr_number),
              origin_json = COALESCE(?, origin_json), updated_at = ?, publish_claim_at = ?
        WHERE id = ? AND workspace_id = ? AND status = ?`,
      [
        filesJson,
        committed?.sha ?? null,
        outcomeJson,
        finalStatus,
        error,
        prUrl ?? null,
        prNumber ?? null,
        input.desired?.origin ? JSON.stringify(input.desired.origin) : null,
        at,
        holdClaim ? at : null,
        id,
        workspaceId,
        status,
      ],
    );
    if (changed === 0) return false;
    // Counts, hashes and names only: never a text.
    await recordAudit(tx, {
      workspaceId,
      actor,
      action: 'changeset.fixup',
      target: { type: 'change_set', id },
      detail: {
        repositoryId: repository.id,
        mode,
        branch,
        commitSha: committed?.sha ?? null,
        parentSha: committed?.parent ?? null,
        files: committed?.files ?? 0,
        signed: signed !== undefined,
        signature: signed?.format ?? null,
        pushRequested: push,
        prRequested: openPr,
        recomputed: input.desired !== undefined,
      },
      at,
    });
    if (prNow) {
      await recordAudit(tx, {
        workspaceId,
        actor,
        action: 'changeset.pr_open',
        target: { type: 'change_set', id },
        detail: {
          repositoryId: repository.id,
          branch,
          prNumber: prNow.number ?? null,
          prUrl: prNow.url ?? null,
        },
        at,
      });
    }
    return true;
  });
  if (!wrote) {
    // Discarded (or otherwise changed) while the commit was made: the commit is on the branch.
    await release();
    return {
      ...failure(
        409,
        'changed_meanwhile',
        `This change set was changed while it was being fixed up.${committed ? ` The commit ${committed.sha.slice(0, 8)} was already added to ${branch}.` : ''} Look again.`,
      ),
    };
  }

  // Local mode: the push and the pull request.
  let failedPublish: Failure | undefined;
  let publishedPr: FixupResult['pullRequest'] | undefined;
  if (mode === 'local_branch' && nextOutcome && opened && publishWork) {
    try {
      const result = await publish(ctx, {
        workspaceId,
        repository,
        changeSetId: id,
        summary,
        files: kept.length > 0 ? kept : stored,
        outcome: nextOutcome,
        openPr,
        opened,
      });
      if (result.failed?.step === 'push' && result.failed.code === 'push_rejected') {
        const message =
          'The branch on GitHub has commits this clone does not have (or other history), so the new commit was not pushed. Nothing was forced. Look at the branch on GitHub, or create a new change set.';
        result.outcome.push = {
          status: 'failed',
          at: result.outcome.push.at ?? ctx.now(),
          code: 'remote_diverged',
          error: message,
        };
        result.failed = { step: 'push', code: 'remote_diverged', message };
      }
      const last = result.outcome.fixups?.[result.outcome.fixups.length - 1];
      if (last && committed && last.commit === committed.sha)
        last.pushed = result.outcome.push.status === 'pushed';
      await savePublished(ctx, {
        workspaceId,
        repositoryId: repository.id,
        id,
        before: nextOutcome,
        result,
        actor,
      });
      if (result.outcome.pr.status === 'opened') {
        publishedPr = {
          state: 'opened',
          ...(result.outcome.pr.number !== undefined ? { number: result.outcome.pr.number } : {}),
          ...(result.outcome.pr.url ? { url: result.outcome.pr.url } : {}),
        };
      }
      if (result.failed) {
        const changeSet = await view();
        failedPublish =
          result.failed.code === 'remote_diverged'
            ? {
                ...failure(409, 'remote_diverged', result.failed.message, { step: 'push' }),
                body: {
                  error: 'remote_diverged',
                  message: result.failed.message,
                  step: 'push',
                  changeSet,
                },
              }
            : failedStep(result.failed, changeSet);
      }
    } catch (error) {
      await releasePublishClaim(ctx, workspaceId, id);
      throw error;
    }
  }
  if (failedPublish) return failedPublish;
  if (prFailure) {
    return { ...prFailure, body: { ...prFailure.body, changeSet: await view(), branch } };
  }
  const pullRequest: FixupResult['pullRequest'] = prNow
    ? {
        state: 'opened',
        ...(prNow.number !== undefined ? { number: prNow.number } : {}),
        ...(prNow.url ? { url: prNow.url } : {}),
      }
    : (publishedPr ?? prState());
  return {
    ok: true,
    result: {
      ...base,
      changeSet: await view(),
      nothingToFix: false,
      ...(committed
        ? {
            commit: {
              sha: committed.sha,
              parent: committed.parent,
              files: committed.files,
              signed: signed !== undefined,
            },
          }
        : {}),
      pullRequest,
    },
  };
}
