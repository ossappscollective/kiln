import { randomUUID } from 'node:crypto';
import { PullRequestFailedError } from '@mrm/connectors';
import {
  type ActorType,
  type ChangeSet,
  type ChangeSetStatus,
  type FileChange,
  type Listing,
  type ListingProblem,
  validateListing,
} from '@mrm/core';
import { mapOrNull, type Row, type Sql } from '@mrm/db';
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
  type Repository,
  readRepositoryListing,
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
  /** An image (store assets sync): its content is never shown or returned as text, only its size. */
  binary?: true;
  /** The size of the new content in bytes (binary files). */
  bytes?: number;
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
  /**
   * Set when the commit carries a signature (MRM_GIT_SIGN): the commit object has a signature
   * header of this format. It says "signed", never "verified": that needs the verifier's keys.
   */
  signature?: { status: 'signed'; format: 'ssh' | 'gpg' };
  /**
   * `behind`: the branch on GitHub is behind the local branch, because a fix-up commit was added
   * after the push and not pushed yet (`POST .../push` pushes the latest commit).
   */
  push: {
    status: 'not_requested' | 'pushed' | 'failed' | 'behind';
    at?: number;
    code?: string;
    error?: string;
  };
  pr: {
    status: 'not_requested' | 'opened' | 'failed' | 'skipped';
    at?: number;
    url?: string;
    number?: number;
    code?: string;
    error?: string;
  };
  /** Fix-up commits added on top of the branch, oldest first (docs/adr/0005-local-clone-reads.md, "Fixing up a branch"). */
  fixups?: FixupRecord[];
};

/**
 * One fix-up: a commit added on top of the branch of an applied (or failed) change set. For the
 * GitHub pull request apply it is kept in `outcome_json` as `{ mode: 'github_pr', fixups }`. No
 * text, no path of the server, no secret.
 */
export type FixupRecord = {
  at: number;
  /** The new commit and the tip it was added on. */
  commit: string;
  parent: string;
  /** Files the commit changes. */
  files: number;
  /** Local mode: the commit was pushed by the same request. */
  pushed: boolean;
  signature?: { status: 'signed'; format: 'ssh' | 'gpg' };
};

/** What a change set was made from, enough to make it again (the store pull). Stored as `origin_json`. */
export type ChangeSetOrigin = { v: 1; source: string; appId?: string; channel?: string } & Record<
  string,
  unknown
>;

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
  /** Fix-up commits added to its branch, oldest first (empty when there is none). */
  fixups: FixupRecord[];
  /** Where it came from, when it can be recomputed (the store pull); null otherwise. Never the request itself. */
  origin: { source: string; appId?: string; channel?: string } | null;
  filesChanged: number;
  files: ChangeSetFile[];
};

export const changeOf = (f: FileChange): ChangeSetFile['change'] =>
  f.before === undefined ? 'added' : f.after === undefined ? 'deleted' : 'modified';

const parseOutcomeJson = (row: Row): Record<string, unknown> | null => {
  if (row.outcome_json === null || row.outcome_json === undefined) return null;
  try {
    const parsed = JSON.parse(String(row.outcome_json)) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** The outcome of a commit in a local clone. A GitHub pull request apply has none (its column holds only fix-ups). */
export const parseOutcome = (row: Row): LocalOutcome | null => {
  const parsed = parseOutcomeJson(row);
  return parsed && parsed.mode === 'local_branch' ? (parsed as unknown as LocalOutcome) : null;
};

export const parseFixups = (row: Row): FixupRecord[] => {
  const parsed = parseOutcomeJson(row);
  return parsed && Array.isArray(parsed.fixups) ? (parsed.fixups as FixupRecord[]) : [];
};

/** The stored origin, or null for a row that has none (an old row, or a source that cannot be recomputed). */
export const parseOrigin = (row: Row): ChangeSetOrigin | null => {
  if (row.origin_json === null || row.origin_json === undefined) return null;
  try {
    const parsed = JSON.parse(String(row.origin_json)) as ChangeSetOrigin;
    return typeof parsed === 'object' && parsed !== null && typeof parsed.source === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
};

export const parseFiles = (row: Row): FileChange[] =>
  JSON.parse(String(row.files_json)) as FileChange[];

export function toView(row: Row, withContent: boolean): ChangeSetView {
  const files = parseFiles(row).map((f): ChangeSetFile => {
    const base = { path: f.path, change: changeOf(f) };
    if (f.encoding === 'base64') {
      // Bytes, not text: never put base64 into a view. The size is enough to review.
      const text = f.after ?? f.before ?? '';
      return {
        ...base,
        binary: true,
        bytes:
          Math.floor((text.length * 3) / 4) -
          (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0),
      };
    }
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
    branch: mapOrNull(row.branch, String),
    prUrl: mapOrNull(row.pr_url, String),
    prNumber: mapOrNull(row.pr_number, Number),
    commitSha: mapOrNull(row.commit_sha, String),
    error: mapOrNull(row.error, String),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    approvedBy: mapOrNull(row.approved_by, String),
    approvedAt: mapOrNull(row.approved_at, Number),
    appliedAt: mapOrNull(row.applied_at, Number),
    outcome: parseOutcome(row),
    fixups: parseFixups(row),
    origin: summariseOrigin(parseOrigin(row)),
    filesChanged: files.length,
    files,
  };
}

const summariseOrigin = (origin: ChangeSetOrigin | null): ChangeSetView['origin'] =>
  origin
    ? {
        source: origin.source,
        ...(origin.appId ? { appId: origin.appId } : {}),
        ...(origin.channel ? { channel: origin.channel } : {}),
      }
    : null;

export const rowOf = async (sql: Sql, workspaceId: string, id: string): Promise<Row | undefined> =>
  (
    await sql.query('SELECT * FROM change_sets WHERE id = ? AND workspace_id = ?', [
      id,
      workspaceId,
    ])
  )[0];

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

/**
 * Reads the repository's listing now and works out which files turn it into `listing`. Writes
 * nothing. Shared by `createChangeSet` (a new draft) and the recompute of a store pull (the files
 * of an existing draft are replaced). An empty `files` is not a failure here: the caller decides.
 */
export async function computeListingFiles(
  ctx: RepoContext,
  input: {
    workspaceId: string;
    repositoryId: string;
    listing: Listing | ListingBuilder;
    selection?: ListingSelection | undefined;
    /** The purpose of the credential use (audited); a read purpose that is in CLONE_READ_PURPOSES may use a clone. */
    purpose: string;
  },
  actor: Actor,
): Promise<Outcome<{ files: FileChange[]; warnings: string[]; desired: Listing }>> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.repositoryId);
  if (!repository) return failure(404, 'not_found');
  const opened = await openConnectorForRepository(
    ctx,
    input.workspaceId,
    repository,
    actor,
    input.purpose,
  );
  if (!opened.ok) return opened;
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
    const changes = listingChanges(read.listings, wanted);
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
    return { ok: true, files: changes.files, warnings: changes.warnings, desired: wanted };
  } catch (error) {
    return githubFailure(error, opened.secret);
  }
}

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
    /**
     * What the change set is made from, stored as `origin_json` so it can be made again (the store
     * pull). A function is called once the listing builder has run, so it may use what it computed.
     */
    origin?: ChangeSetOrigin | (() => ChangeSetOrigin);
  },
  actor: Actor,
): Promise<Outcome<{ changeSet: ChangeSetView; problems: ListingProblem[]; warnings: string[] }>> {
  const computed = await computeListingFiles(
    ctx,
    {
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      listing: input.listing,
      selection: input.selection,
      purpose: 'changeset.create',
    },
    actor,
  );
  if (!computed.ok) return computed;
  const { files, warnings, desired } = computed;
  if (files.length === 0) {
    return failure(422, 'no_changes', 'The listing is the same as in the repository.', {
      warnings,
    });
  }
  const origin = typeof input.origin === 'function' ? input.origin() : input.origin;

  const id = randomUUID();
  const now = ctx.now();
  try {
    await insertDraft(ctx, { id, now, files, input, actor, origin });
  } catch (error) {
    // The repository was disconnected while GitHub was being read.
    if (isForeignKeyViolation(error)) {
      return failure(
        404,
        'not_found',
        'The repository was disconnected while this was being made.',
      );
    }
    throw error;
  }
  const changeSet = (await getChangeSet(ctx.db, input.workspaceId, id)) as ChangeSetView;
  return { ok: true, changeSet, problems: validateListing(desired), warnings };
}

/**
 * A draft change set made from files that are already worked out (the store assets sync: images pulled from a store,
 * staged images written to the repository). Nothing is read here. It then follows the usual review, approve and apply
 * flow. `origin.source` is never `store_pull`, so a refresh or a fix-up never recomputes it from the listing.
 */
export async function createFileChangeSet(
  ctx: RepoContext,
  input: {
    workspaceId: string;
    repositoryId: string;
    summary: string;
    files: FileChange[];
    origin: ChangeSetOrigin;
    auditDetail?: Record<string, unknown>;
  },
  actor: Actor,
): Promise<Outcome<{ changeSet: ChangeSetView }>> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.repositoryId);
  if (!repository) return failure(404, 'not_found');
  if (input.files.length === 0)
    return failure(422, 'no_changes', 'There is nothing to put in a change set.');
  const id = randomUUID();
  const now = ctx.now();
  try {
    await insertDraft(ctx, { id, now, files: input.files, input, actor, origin: input.origin });
  } catch (error) {
    if (isForeignKeyViolation(error))
      return failure(
        404,
        'not_found',
        'The repository was disconnected while this was being made.',
      );
    throw error;
  }
  return {
    ok: true,
    changeSet: (await getChangeSet(ctx.db, input.workspaceId, id)) as ChangeSetView,
  };
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
    origin?: ChangeSetOrigin | undefined;
  },
): Promise<void> {
  const { id, now, files, input, actor, origin } = args;
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO change_sets
         (id, workspace_id, repository_id, summary, status, created_by_type, created_by_id,
          files_json, created_at, updated_at, origin_json)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
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
        origin ? JSON.stringify(origin) : null,
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
    // A refresh can leave a change set with no file (the repository already has all of it).
    const current = await rowOf(tx, input.workspaceId, input.id);
    if (current && String(current.status) === 'draft' && parseFiles(current).length === 0) {
      return failure(
        422,
        'nothing_to_apply',
        'Nothing left to apply: the repository already has this change. Discard the change set.',
      );
    }
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
  return {
    ok: true,
    changeSet: (await getChangeSet(ctx.db, input.workspaceId, input.id)) as ChangeSetView,
  };
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
  return {
    ok: true,
    changeSet: (await getChangeSet(ctx.db, input.workspaceId, input.id)) as ChangeSetView,
  };
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
    .replace(
      /\b(clos(?:e[sd]?)|fix(?:e[sd])?|resolv(?:e[sd]?))\b/gi,
      (word) => `${word[0]}${ZWSP}${word.slice(1)}`,
    );
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
    if (status === 'applied')
      return { ok: true, changeSet: toView(row, true), alreadyApplied: true };
    if (status === 'applying') {
      return failure(409, 'apply_in_progress', 'This change set is being applied right now.');
    }
    return invalidState(status, 'approved');
  }

  const files = parseFiles(row);
  const createdBy = {
    type: String(row.created_by_type) as ActorType,
    id: String(row.created_by_id),
  };
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
  const opened = await openConnectorForRepository(
    ctx,
    workspaceId,
    repository,
    actor,
    'changeset.apply',
  );
  if (!opened.ok) {
    await release(opened);
    return withSet(opened);
  }

  const failed = async (f: Failure, extra: { branch?: string; commitSha?: string } = {}) => {
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
