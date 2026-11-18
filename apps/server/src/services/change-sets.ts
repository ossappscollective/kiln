import { randomUUID } from 'node:crypto';
import {
  type ActorType,
  type ChangeSet,
  type ChangeSetStatus,
  type FileChange,
  type Listing,
  type ListingProblem,
  validateListing,
} from '@mrm/core';
import { PullRequestFailedError } from '@mrm/connectors';
import type { Sql } from '@mrm/db';
import { recordAudit } from './audit.ts';
import { listingChanges, type RepositoryListings } from './listing-sources.ts';
import type { ListingSelection, ListingTarget } from './listing-targets.ts';
import {
  type Failure,
  failure,
  getRepository,
  githubFailure,
  isForeignKeyViolation,
  isTimeoutError,
  type Outcome,
  openConnectorForRepository,
  type RepoContext,
  readRepositoryListing,
  type Repository,
  withTimeout,
} from './repositories.ts';

type Actor = { type: ActorType; id: string };

/** An `applying` claim older than this is taken to be abandoned (a crash) and may be re-claimed. */
export const APPLY_CLAIM_TTL_MS = 10 * 60 * 1000;

export type ChangeSetFile = {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  before?: string;
  after?: string;
};

/**
 * What applying a change set as a commit on a new branch of a local clone did, step by step
 * (docs/adr/0005-local-clone-reads.md). Stored as `outcome_json`; no path and no secret. A failed
 * push or pull request does not undo the commit: it is recorded here and can be retried.
 */
export type LocalOutcome = {
  mode: 'local_branch';
  /** The local branch the commit was made on top of, and the commit that was its tip. */
  base: { branch: string; commit: string };
  commit: { branch: string; sha: string; at: number };
  /** What the person asked for when applying. */
  requested: { push: boolean; openPr: boolean };
  push: { status: 'not_requested' | 'pushed' | 'failed'; at?: number; code?: string; error?: string };
  pr: {
    status: 'not_requested' | 'opened' | 'failed' | 'skipped';
    at?: number;
    url?: string;
    number?: number;
    code?: string;
    error?: string;
  };
};

export type ChangeSetView = {
  id: string;
  repositoryId: string;
  summary: string;
  status: ChangeSetStatus;
  createdBy: { type: ActorType; id: string };
  branch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  commitSha: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  approvedBy: string | null;
  approvedAt: number | null;
  appliedAt: number | null;
  /** How it was applied, step by step, for a commit in a local clone. Null for the GitHub pull request apply. */
  outcome: LocalOutcome | null;
  filesChanged: number;
  files: ChangeSetFile[];
};

type Row = Record<string, unknown>;
const orNull = <T>(v: unknown, f: (x: unknown) => T): T | null =>
  v === null || v === undefined ? null : f(v);

export const changeOf = (f: FileChange): ChangeSetFile['change'] =>
  f.before === undefined ? 'added' : f.after === undefined ? 'deleted' : 'modified';

export const parseOutcome = (row: Row): LocalOutcome | null => {
  if (row.outcome_json === null || row.outcome_json === undefined) return null;
  try {
    return JSON.parse(String(row.outcome_json)) as LocalOutcome;
  } catch {
    return null;
  }
};

export const parseFiles = (row: Row): FileChange[] => JSON.parse(String(row.files_json)) as FileChange[];

export function toView(row: Row, withContent: boolean): ChangeSetView {
  const files = parseFiles(row).map((f): ChangeSetFile => {
    const base = { path: f.path, change: changeOf(f) };
    if (!withContent) return base;
    return {
      ...base,
      ...(f.before !== undefined ? { before: f.before } : {}),
      ...(f.after !== undefined ? { after: f.after } : {}),
    };
  });
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    summary: String(row.summary),
    status: String(row.status) as ChangeSetStatus,
    createdBy: { type: String(row.created_by_type) as ActorType, id: String(row.created_by_id) },
    branch: orNull(row.branch, String),
    prUrl: orNull(row.pr_url, String),
    prNumber: orNull(row.pr_number, Number),
    commitSha: orNull(row.commit_sha, String),
    error: orNull(row.error, String),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    approvedBy: orNull(row.approved_by, String),
    approvedAt: orNull(row.approved_at, Number),
    appliedAt: orNull(row.applied_at, Number),
    outcome: parseOutcome(row),
    filesChanged: files.length,
    files,
  };
}

export const rowOf = async (sql: Sql, workspaceId: string, id: string): Promise<Row | undefined> =>
  (await sql.query('SELECT * FROM change_sets WHERE id = ? AND workspace_id = ?', [id, workspaceId]))[0];

export async function listChangeSets(
  sql: Sql,
  workspaceId: string,
  filter: { repositoryId?: string; status?: string } = {},
): Promise<ChangeSetView[]> {
  const where = ['workspace_id = ?'];
  const params: string[] = [workspaceId];
  if (filter.repositoryId) {
    where.push('repository_id = ?');
    params.push(filter.repositoryId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  const rows = await sql.query(
    `SELECT * FROM change_sets WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 200`,
    params,
  );
  return rows.map((r) => toView(r, false));
}

export async function getChangeSet(
  sql: Sql,
  workspaceId: string,
  id: string,
): Promise<ChangeSetView | undefined> {
  const row = await rowOf(sql, workspaceId, id);
  return row ? toView(row, true) : undefined;
}

export const invalidState = (status: string, wanted: string) =>
  failure(409, 'invalid_state', `This change set is ${status}; it must be ${wanted} for that.`, {
    status,
  });

// ---------------------------------------------------------------------------------------------
// Create

/**
 * A listing that is made from what the repository holds now: it is called once with the listings
 * that were just read (so the change is computed against the same files the change set is made
 * from) and returns the desired listing, or a failure to send back as it is. Used by changes that
 * start from the repository's own values (the store pull); a plain `Listing` works as before.
 */
export type ListingBuilder = (read: {
  listings: RepositoryListings;
  /** The saved target the read used, when one was named. */
  custom?: ListingTarget;
}) => Listing | Failure;

const isFailure = (value: Listing | Failure): value is Failure =>
  (value as { ok?: unknown }).ok === false;

export async function createChangeSet(
  ctx: RepoContext,
  input: {
    workspaceId: string;
    repositoryId: string;
    summary: string;
    listing: Listing | ListingBuilder;
    /** Which target's folders the change is made in (the same choice the listing was read with). */
    selection?: ListingSelection;
    /** Extra keys of the `changeset.create` audit event (`source`, ...). They never replace its own. */
    auditDetail?: Record<string, unknown>;
  },
  actor: Actor,
): Promise<
  Outcome<{ changeSet: ChangeSetView; problems: ListingProblem[]; warnings: string[] }>
> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.repositoryId);
  if (!repository) return failure(404, 'not_found');
  const opened = await openConnectorForRepository(
    ctx,
    input.workspaceId,
    repository,
    actor,
    'changeset.create',
  );
  if (!opened.ok) return opened;

  let files: FileChange[];
  let warnings: string[];
  let desired: Listing;
  try {
    const read = await readRepositoryListing(
      ctx,
      input.workspaceId,
      repository,
      opened.connector,
      input.selection,
    );
    if (!read.ok) return read;
    const wanted = typeof input.listing === 'function' ? input.listing(read) : input.listing;
    if (isFailure(wanted)) return wanted;
    desired = wanted;
    const changes = listingChanges(read.listings, desired);
    if (!changes.ok) {
      if (changes.code === 'outside_target') {
        return failure(422, 'outside_target', changes.error, { path: changes.path });
      }
      return failure(
        422,
        'store_config_invalid',
        `${changes.error} The App Store listing cannot be changed until the file is fixed in the repository.`,
        { path: changes.path },
      );
    }
    files = changes.files;
    warnings = changes.warnings;
  } catch (error) {
    return githubFailure(error, opened.secret);
  }
  if (files.length === 0) {
    return failure(422, 'no_changes', 'The listing is the same as in the repository.', {
      warnings,
    });
  }

  const id = randomUUID();
  const now = ctx.now();
  try {
    await insertDraft(ctx, { id, now, files, input, actor });
  } catch (error) {
    // The repository was disconnected while GitHub was being read.
    if (isForeignKeyViolation(error)) {
      return failure(404, 'not_found', 'The repository was disconnected while this was being made.');
    }
    throw error;
  }
  const changeSet = (await getChangeSet(ctx.db, input.workspaceId, id)) as ChangeSetView;
  return { ok: true, changeSet, problems: validateListing(desired), warnings };
}

async function insertDraft(
  ctx: RepoContext,
  args: {
    id: string;
    now: number;
    files: FileChange[];
    input: {
      workspaceId: string;
      repositoryId: string;
      summary: string;
      auditDetail?: Record<string, unknown>;
    };
    actor: Actor;
  },
): Promise<void> {
  const { id, now, files, input, actor } = args;
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO change_sets
         (id, workspace_id, repository_id, summary, status, created_by_type, created_by_id,
          files_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      [
        id,
        input.workspaceId,
        input.repositoryId,
        input.summary,
        actor.type,
        actor.id,
        JSON.stringify(files),
        now,
        now,
      ],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'changeset.create',
      target: { type: 'change_set', id },
      detail: { ...input.auditDetail, repositoryId: input.repositoryId, files: files.length },
      at: now,
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Approve, discard

export async function approveChangeSet(
  ctx: RepoContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<Outcome<{ changeSet: ChangeSetView }>> {
  const result = await ctx.db.transaction(async (tx): Promise<Outcome<Record<never, never>>> => {
    const now = ctx.now();
    const changed = await tx.execute(
      `UPDATE change_sets SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'draft'`,
      [actor.id, now, now, input.id, input.workspaceId],
    );
    if (changed === 0) {
      const row = await rowOf(tx, input.workspaceId, input.id);
      return row ? invalidState(String(row.status), 'a draft') : failure(404, 'not_found');
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'changeset.approve',
      target: { type: 'change_set', id: input.id },
      at: now,
    });
    return { ok: true };
  });
  if (!result.ok) return result;
  return { ok: true, changeSet: (await getChangeSet(ctx.db, input.workspaceId, input.id)) as ChangeSetView };
}

/**
 * `mayDiscardAny`: the person can approve, so they may discard anyone's change set. Others may
 * discard only a draft they created.
 */
export async function discardChangeSet(
  ctx: RepoContext,
  input: { workspaceId: string; id: string; mayDiscardAny: boolean },
  actor: Actor,
): Promise<Outcome<{ changeSet: ChangeSetView }>> {
  const result = await ctx.db.transaction(async (tx): Promise<Outcome<Record<never, never>>> => {
    const row = await rowOf(tx, input.workspaceId, input.id);
    if (!row) return failure(404, 'not_found');
    const status = String(row.status);
    if (!['draft', 'approved', 'failed'].includes(status)) {
      return invalidState(status, 'a draft, approved or failed');
    }
    if (!input.mayDiscardAny) {
      const own = row.created_by_type === actor.type && row.created_by_id === actor.id;
      if (!own || status !== 'draft') {
        return failure(403, 'forbidden', 'You can discard only your own drafts.');
      }
    }
    const now = ctx.now();
    const changed = await tx.execute(
      `UPDATE change_sets SET status = 'discarded', updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = ?`,
      [now, input.id, input.workspaceId, status],
    );
    if (changed === 0) return invalidState('changed meanwhile', 'a draft, approved or failed');
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'changeset.discard',
      target: { type: 'change_set', id: input.id },
      detail: { was: status },
      at: now,
    });
    return { ok: true };
  });
  if (!result.ok) return result;
  return { ok: true, changeSet: (await getChangeSet(ctx.db, input.workspaceId, input.id)) as ChangeSetView };
}

// ---------------------------------------------------------------------------------------------
// Apply

/** `mrm/<first 8 of the id>-<slug of the summary>`: a valid git branch name, unique per set. */
export function branchNameFor(id: string, summary: string): string {
  const slug = summary
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `mrm/${id.replace(/-/g, '').slice(0, 8)}-${slug || 'update'}`;
}

const ZWSP = '\u200b';

/**
 * Text that a person typed, made safe to put in a pull request or a commit message. GitHub would
 * otherwise act on it: notify an @mentioned user or team, link an issue or pull request from #123
 * or owner/repo#123, close an issue on merge ("fixes #1", "closes <issue url>"). A zero-width
 * space after @ and # and inside "://" stops the link and the mention, and one after the first
 * letter of a closing keyword stops the keyword. The text reads the same to a person.
 */
export function neutraliseText(text: string): string {
  return text
    .replace(/[@#]/g, (c) => `${c}${ZWSP}`)
    .replace(/:\/\//g, `:/${ZWSP}/`)
    .replace(/\b(clos(?:e[sd]?)|fix(?:e[sd])?|resolv(?:e[sd]?))\b/gi, (word) => `${word[0]}${ZWSP}${word.slice(1)}`);
}

/** One line of the summary as a quote, so it cannot start a heading, a list or a code block. */
const quoted = (summary: string) => `> ${neutraliseText(summary.replace(/\s+/g, ' ').trim())}`;

export function pullRequestBody(id: string, summary: string, files: FileChange[]): string {
  const shown = files.slice(0, 50).map((f) => `- \`${f.path}\` (${changeOf(f)})`);
  if (files.length > 50) shown.push(`- and ${files.length - 50} more`);
  return [
    quoted(summary),
    '',
    `Changed files (${files.length}):`,
    ...shown,
    '',
    `Change set ${id}, approved in Mobile Release Manager. Review the files before merging.`,
  ].join('\n');
}

export type ApplyResult = { changeSet: ChangeSetView; alreadyApplied?: true };

export async function applyChangeSet(
  ctx: RepoContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<Outcome<ApplyResult>> {
  const { db } = ctx;
  const { workspaceId, id } = input;

  // The claim is one atomic UPDATE: of two clicks, exactly one changes a row.
  const now = ctx.now();
  const claimed = await db.execute(
    `UPDATE change_sets SET status = 'applying', error = NULL, updated_at = ?
      WHERE id = ? AND workspace_id = ?
        AND (status = 'approved' OR (status = 'applying' AND updated_at < ?))`,
    [now, id, workspaceId, now - APPLY_CLAIM_TTL_MS],
  );
  const row = await rowOf(db, workspaceId, id);
  if (!row) return failure(404, 'not_found');
  if (claimed === 0) {
    const status = String(row.status);
    if (status === 'applied') return { ok: true, changeSet: toView(row, true), alreadyApplied: true };
    if (status === 'applying') {
      return failure(409, 'apply_in_progress', 'This change set is being applied right now.');
    }
    return invalidState(status, 'approved');
  }

  const files = parseFiles(row);
  const createdBy = { type: String(row.created_by_type) as ActorType, id: String(row.created_by_id) };
  const summary = String(row.summary);
  const repository = (await getRepository(db, workspaceId, String(row.repository_id))) as
    | Repository
    | undefined;

  /** Back to approved: nothing reached GitHub, so the same change set can be applied again. */
  const release = async (problem: { body: Record<string, unknown> }) => {
    await db.execute(
      `UPDATE change_sets SET status = 'approved', error = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'applying'`,
      [String(problem.body.message ?? problem.body.error), ctx.now(), id, workspaceId],
    );
  };
  const withSet = async (f: Failure): Promise<Outcome<ApplyResult>> => ({
    ...f,
    body: { ...f.body, changeSet: await getChangeSet(db, workspaceId, id) },
  });

  if (!repository) {
    const f = failure(404, 'not_found', 'The repository of this change set is gone.');
    await release(f);
    return withSet(f);
  }
  const opened = await openConnectorForRepository(ctx, workspaceId, repository, actor, 'changeset.apply');
  if (!opened.ok) {
    await release(opened);
    return withSet(opened);
  }

  const failed = async (
    f: Failure,
    extra: { branch?: string; commitSha?: string } = {},
  ) => {
    await db.transaction(async (tx) => {
      const at = ctx.now();
      const changed = await tx.execute(
        `UPDATE change_sets SET status = 'failed', error = ?, branch = ?, commit_sha = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND status = 'applying'`,
        [
          String(f.body.message ?? f.body.error),
          extra.branch ?? null,
          extra.commitSha ?? null,
          at,
          id,
          workspaceId,
        ],
      );
      if (changed === 0) return;
      await recordAudit(tx, {
        workspaceId,
        actor,
        action: 'changeset.apply_failed',
        target: { type: 'change_set', id },
        detail: { repositoryId: repository.id, reason: f.body.error, ...extra },
        at,
      });
    });
    return withSet(f);
  };

  const changeSet: ChangeSet = {
    id,
    workspaceId,
    summary,
    target: 'repo',
    status: 'approved',
    createdBy,
    files,
  };
  // What goes to GitHub (the commit message, the pull request title and body) is the neutralised
  // text; the change set keeps what the person typed.
  changeSet.summary = neutraliseText(summary);
  const branch = branchNameFor(id, summary);

  /**
   * The timeout cancels the connector (no further request is sent) but cannot take back what
   * GitHub already accepted: a branch, even a pull request, may exist. So a timeout is NOT
   * recorded as `failed` (which says "nothing was applied" and invites a retry that would collide
   * with that branch). The set stays `applying` with a note, which keeps it from being applied
   * again, discarded or approved, until the claim goes stale (APPLY_CLAIM_TTL_MS, counted from
   * now), when it may be applied again and the branch check reports what exists.
   */
  const timedOut = async (): Promise<Outcome<ApplyResult>> => {
    const f = failure(
      504,
      'timeout',
      `GitHub did not answer within ${Math.round(ctx.timeoutMs / 1000)} seconds and the request was cancelled. ` +
        `The branch ${branch} or its pull request may already exist on GitHub: check there. ` +
        `This change set stays "applying" and can be applied again after ${Math.round(APPLY_CLAIM_TTL_MS / 60_000)} minutes.`,
    );
    await db.transaction(async (tx) => {
      const at = ctx.now();
      const changed = await tx.execute(
        `UPDATE change_sets SET error = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND status = 'applying'`,
        [String(f.body.message), at, id, workspaceId],
      );
      if (changed === 0) return;
      await recordAudit(tx, {
        workspaceId,
        actor,
        action: 'changeset.apply_timeout',
        target: { type: 'change_set', id },
        detail: { repositoryId: repository.id, branch },
        at,
      });
    });
    return withSet(f);
  };

  const controller = new AbortController();
  let proposal: Awaited<ReturnType<typeof opened.connector.propose>>;
  try {
    proposal = await withTimeout(
      opened.connector.propose(changeSet, {
        branch,
        title: neutraliseText(summary),
        body: pullRequestBody(id, summary, files),
        signal: controller.signal,
      }),
      ctx.timeoutMs,
      () => controller.abort(),
    );
  } catch (error) {
    if (isTimeoutError(error)) return timedOut();
    let f: Failure;
    try {
      f = githubFailure(error, opened.secret);
    } catch (unknown) {
      // Not a connector error. Do not leave the change set claimed.
      await failed(failure(502, 'github_unavailable', 'Applying failed unexpectedly.'));
      throw unknown;
    }
    // A plain rate limit is refused before anything is written, so the set can be retried.
    if (f.status === 429) {
      await release(f);
      return withSet(f);
    }
    if (error instanceof PullRequestFailedError) {
      return failed(f, { branch: error.branch, commitSha: error.commitSha });
    }
    return failed(f);
  }

  if (!proposal.url && !proposal.commitSha) {
    return failed(
      failure(502, 'github_unavailable', 'GitHub did not return a pull request or a commit.'),
      proposal.branch ? { branch: proposal.branch } : {},
    );
  }

  const at = ctx.now();
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE change_sets
          SET status = 'applied', branch = ?, pr_url = ?, pr_number = ?, commit_sha = ?,
              error = NULL, applied_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
      [
        proposal.branch,
        proposal.url ?? null,
        proposal.number ?? null,
        proposal.commitSha ?? null,
        at,
        at,
        id,
        workspaceId,
      ],
    );
    await recordAudit(tx, {
      workspaceId,
      actor,
      action: 'changeset.apply',
      target: { type: 'change_set', id },
      detail: {
        repositoryId: repository.id,
        branch: proposal.branch,
        prNumber: proposal.number ?? null,
        prUrl: proposal.url ?? null,
        commitSha: proposal.commitSha ?? null,
        files: files.length,
      },
      at,
    });
  });
  return { ok: true, changeSet: (await getChangeSet(db, workspaceId, id)) as ChangeSetView };
}
