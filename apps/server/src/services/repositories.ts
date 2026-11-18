import { randomUUID } from 'node:crypto';
import type { ActorType, Listing, ListingProblem } from '@mrm/core';
import { validateListing } from '@mrm/core';
import {
  detectProject,
  GithubError,
  GithubRateLimitError,
  GithubRepoConnector,
  githubAuthFromSecret,
  type ListingSnapshot,
  type ProjectDetection,
  PullRequestFailedError,
  type RepoConnector,
  redactSecrets,
  secretStrings,
} from '@mrm/connectors';
import type { Database, Sql } from '@mrm/db';
import { recordAudit } from './audit.ts';
import { useCredentialSecret } from './credentials.ts';
import {
  type DetectedSources,
  detectedSources,
  type ListingSources,
  listingSources,
  listingWarnings,
  mergedListing,
  type RepositoryListings,
  readListings,
} from './listing-sources.ts';

type Actor = { type: ActorType; id: string };

/** A repo connector that can also say which branch is the default (the GitHub one can). */
export type RepoClient = RepoConnector & { defaultBranch(): Promise<string> };

/** Builds the connector for one repository. Replaced by a fake in tests. */
export type ConnectorFactory = (
  kind: 'github_app' | 'github_token',
  secret: string,
  repo: { owner: string; repo: string },
) => RepoClient;

export const defaultConnectorFactory: ConnectorFactory = (kind, secret, { owner, repo }) =>
  new GithubRepoConnector({ owner, repo, auth: githubAuthFromSecret(kind, secret) });

/** What the repository services need. Built once in createApp. */
export type RepoContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  connectorFactory: ConnectorFactory;
  /** Longest a synchronous GitHub job (scan, listing, apply) may take. */
  timeoutMs: number;
};

export const DEFAULT_REPO_TIMEOUT_MS = 90_000;

/** A failed request: the status and JSON body to send, and extra headers (Retry-After). */
export type Failure = {
  ok: false;
  status: 403 | 404 | 409 | 422 | 429 | 502 | 504;
  body: Record<string, unknown> & { error: string };
  headers?: Record<string, string>;
};
export type Outcome<T> = ({ ok: true } & T) | Failure;

export const failure = (
  status: Failure['status'],
  error: string,
  message?: string,
  extra: Record<string, unknown> = {},
): Failure => ({
  ok: false,
  status,
  body: { error, ...(message ? { message } : {}), ...extra },
});

class TimeoutError extends Error {}

export const isTimeoutError = (error: unknown): boolean => error instanceof TimeoutError;

/**
 * Rejects with a timeout error after `ms`. That does not stop the work: `onTimeout` runs first,
 * for the caller to cancel it (abort an AbortSignal). Work that ignores the cancellation keeps
 * running in the background; its result is dropped.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(new TimeoutError('timeout'));
      }
    }, ms);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turns whatever a connector threw into a response. Messages of GithubError are written to be
 * shown; they are redacted once more against the secret in use. Anything else is not ours to
 * explain and is rethrown.
 */
export function githubFailure(error: unknown, secret = ''): Failure {
  const clean = (text: string) => redactSecrets(text, secret ? secretStrings(secret) : []);
  if (error instanceof TimeoutError) {
    return failure(504, 'timeout', 'GitHub did not answer in time. Try again.');
  }
  if (error instanceof GithubRateLimitError) {
    const wait = error.retryAfterSeconds;
    return {
      ok: false,
      status: 429,
      body: { error: 'rate_limited', message: clean(error.message), retryAfterSeconds: wait },
      headers: { 'Retry-After': String(wait) },
    };
  }
  if (!(error instanceof GithubError)) throw error;
  const message = clean(error.message);
  switch (error.kind) {
    case 'auth':
      return failure(422, 'github_auth', message);
    case 'forbidden':
      return failure(422, 'github_forbidden', message);
    case 'not_found':
      return failure(422, 'github_not_found', message);
    case 'validation':
    case 'invalid_input':
    case 'blocked_path':
    case 'not_text':
    case 'too_large':
      return failure(422, 'github_invalid', message);
    case 'conflict':
    case 'branch_exists':
    case 'default_branch':
    case 'no_changes':
      return failure(409, error.kind, message);
    case 'change_conflict': {
      const paths = (error as { paths?: string[] }).paths ?? [];
      return failure(409, 'change_conflict', message, {
        paths,
        hint: 'The repository changed after this change set was made. Discard it, read the listing again and create a new change set.',
      });
    }
    case 'pull_request_failed': {
      const e = error as PullRequestFailedError;
      return failure(502, 'pull_request_failed', message, {
        branch: e.branch,
        commitSha: e.commitSha,
      });
    }
    default:
      return failure(502, 'github_unavailable', message);
  }
}

// ---------------------------------------------------------------------------------------------
// Rows

export type Repository = {
  id: string;
  credentialId: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  projectKind: string | null;
  detectedAt: number | null;
  createdAt: number;
};

type Row = Record<string, unknown>;
const orNull = <T>(v: unknown, f: (x: unknown) => T): T | null =>
  v === null || v === undefined ? null : f(v);

const toRepository = (r: Row): Repository => ({
  id: String(r.id),
  credentialId: String(r.credential_id),
  owner: String(r.owner),
  repo: String(r.repo),
  defaultBranch: String(r.default_branch),
  projectKind: orNull(r.project_kind, String),
  detectedAt: orNull(r.detected_at, Number),
  createdAt: Number(r.created_at),
});

const COLUMNS =
  'id, credential_id, owner, repo, default_branch, project_kind, detected_at, created_at';

export async function listRepositories(sql: Sql, workspaceId: string): Promise<Repository[]> {
  const rows = await sql.query(
    `SELECT ${COLUMNS} FROM repositories WHERE workspace_id = ? ORDER BY created_at, id`,
    [workspaceId],
  );
  return rows.map(toRepository);
}

export async function getRepository(
  sql: Sql,
  workspaceId: string,
  id: string,
): Promise<Repository | undefined> {
  const [row] = await sql.query(
    `SELECT ${COLUMNS} FROM repositories WHERE id = ? AND workspace_id = ?`,
    [id, workspaceId],
  );
  return row ? toRepository(row) : undefined;
}

export async function getDetection(
  sql: Sql,
  workspaceId: string,
  id: string,
): Promise<ProjectDetection | null> {
  const [row] = await sql.query(
    'SELECT detection_json FROM repositories WHERE id = ? AND workspace_id = ?',
    [id, workspaceId],
  );
  return row?.detection_json ? (JSON.parse(String(row.detection_json)) as ProjectDetection) : null;
}

// ---------------------------------------------------------------------------------------------
// Opening a connector from a stored credential

export type Opened = { connector: RepoClient; secret: string };

/**
 * Reads the credential's secret (audited as `credential.use`) and builds the connector.
 * Every failure here happens before anything is sent to GitHub.
 */
export async function openConnector(
  ctx: RepoContext,
  input: { workspaceId: string; credentialId: string; owner: string; repo: string },
  actor: Actor,
  purpose: string,
): Promise<Outcome<Opened>> {
  const [cred] = await ctx.db.query('SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?', [
    input.credentialId,
    input.workspaceId,
  ]);
  if (!cred) {
    return failure(
      422,
      'credential_not_found',
      'That credential does not exist in this workspace (it may have been deleted).',
    );
  }
  const kind = String(cred.kind);
  if (kind !== 'github_app' && kind !== 'github_token') {
    return failure(
      422,
      'credential_kind',
      'A repository needs a GitHub App or a GitHub token credential.',
    );
  }
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      ctx.db,
      ctx.masterKey,
      { workspaceId: input.workspaceId, id: input.credentialId, purpose },
      actor,
      ctx.now(),
    );
  } catch {
    return failure(
      422,
      'credential_unreadable',
      'The credential could not be decrypted. Enter its secret again.',
    );
  }
  if (secret === undefined) return failure(422, 'credential_not_found', 'That credential does not exist.');
  try {
    const connector = ctx.connectorFactory(kind, secret, { owner: input.owner, repo: input.repo });
    return { ok: true, connector, secret };
  } catch (error) {
    return githubFailure(error, secret);
  }
}

const openFor = (ctx: RepoContext, ws: string, r: Repository, actor: Actor, purpose: string) =>
  openConnector(
    ctx,
    { workspaceId: ws, credentialId: r.credentialId, owner: r.owner, repo: r.repo },
    actor,
    purpose,
  );

// ---------------------------------------------------------------------------------------------
// Connect, disconnect

export async function connectRepository(
  ctx: RepoContext,
  input: { workspaceId: string; credentialId: string; owner: string; repo: string },
  actor: Actor,
): Promise<Outcome<{ repository: Repository }>> {
  const { db } = ctx;
  const lower = [input.workspaceId, input.owner.toLowerCase(), input.repo.toLowerCase()];
  const taken = async () =>
    (
      await db.query(
        'SELECT id FROM repositories WHERE workspace_id = ? AND lower(owner) = ? AND lower(repo) = ?',
        lower,
      )
    ).length > 0;
  const duplicate = () =>
    failure(409, 'already_connected', `${input.owner}/${input.repo} is already connected.`);
  if (await taken()) return duplicate();

  const opened = await openConnector(ctx, input, actor, 'repository.connect');
  if (!opened.ok) return opened;
  let defaultBranch: string;
  try {
    defaultBranch = await withTimeout(opened.connector.defaultBranch(), ctx.timeoutMs);
  } catch (error) {
    return githubFailure(error, opened.secret);
  }

  const id = randomUUID();
  const now = ctx.now();
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO repositories
           (id, workspace_id, credential_id, owner, repo, default_branch, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, input.workspaceId, input.credentialId, input.owner, input.repo, defaultBranch, now],
      );
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor,
        action: 'repository.connect',
        target: { type: 'repository', id },
        detail: { owner: input.owner, repo: input.repo, credentialId: input.credentialId },
        at: now,
      });
    });
  } catch (error) {
    // Two requests at once: the unique index decides.
    if (await taken()) return duplicate();
    throw error;
  }
  const repository = await getRepository(db, input.workspaceId, id);
  return { ok: true, repository: repository as Repository };
}

/** A statement refused by a foreign key: a row that points at one being deleted (or at one gone). */
export const isForeignKeyViolation = (error: unknown) =>
  error instanceof Error && /foreign key/i.test(error.message);

export async function disconnectRepository(
  ctx: RepoContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<Outcome<Record<never, never>>> {
  try {
    return await disconnect(ctx, input, actor);
  } catch (error) {
    // A change set was created for this repository after the check below and before the delete.
    // Nothing was deleted (the transaction rolled back): the person can discard it and retry.
    if (isForeignKeyViolation(error)) {
      return failure(
        409,
        'open_change_sets',
        'A change set was just created for this repository. Discard or finish it first.',
      );
    }
    throw error;
  }
}

async function disconnect(
  ctx: RepoContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<Outcome<Record<never, never>>> {
  return ctx.db.transaction(async (tx): Promise<Outcome<Record<never, never>>> => {
    const repository = await getRepository(tx, input.workspaceId, input.id);
    if (!repository) return failure(404, 'not_found');
    const [open] = await tx.query(
      `SELECT id FROM change_sets
        WHERE repository_id = ? AND status IN ('draft', 'approved', 'applying')`,
      [input.id],
    );
    if (open) {
      return failure(
        409,
        'open_change_sets',
        'Discard or finish the open change sets of this repository first.',
      );
    }
    // Only the finished ones. A set that is open by now (created since the check above) is left,
    // so the delete of the repository below refuses it instead of silently destroying it.
    await tx.execute(
      `DELETE FROM change_sets
        WHERE repository_id = ? AND workspace_id = ?
          AND status NOT IN ('draft', 'approved', 'applying')`,
      [input.id, input.workspaceId],
    );
    await tx.execute('DELETE FROM repositories WHERE id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'repository.disconnect',
      target: { type: 'repository', id: input.id },
      detail: { owner: repository.owner, repo: repository.repo },
      at: ctx.now(),
    });
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------------------------
// Scan and listing

export async function scanRepository(
  ctx: RepoContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<
  Outcome<{
    repository: Repository;
    detection: ProjectDetection;
    listingSources: DetectedSources;
  }>
> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.id);
  if (!repository) return failure(404, 'not_found');
  const opened = await openFor(ctx, input.workspaceId, repository, actor, 'repository.scan');
  if (!opened.ok) return opened;
  const { connector, secret } = opened;
  let detection: ProjectDetection;
  let fileCount = 0;
  try {
    detection = await withTimeout(
      (async () => {
        const files = await connector.listFiles(repository.defaultBranch);
        fileCount = files.length;
        return detectProject(files, (path) => connector.readFile(path, repository.defaultBranch));
      })(),
      ctx.timeoutMs,
    );
  } catch (error) {
    return githubFailure(error, secret);
  }
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE repositories SET project_kind = ?, detected_at = ?, detection_json = ?
        WHERE id = ? AND workspace_id = ?`,
      [detection.kind, now, JSON.stringify(detection), input.id, input.workspaceId],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'repository.scan',
      target: { type: 'repository', id: input.id },
      detail: { kind: detection.kind, files: fileCount },
      at: now,
    });
  });
  const updated = (await getRepository(ctx.db, input.workspaceId, input.id)) as Repository;
  return { ok: true, repository: updated, detection, listingSources: detectedSources(detection) };
}

/**
 * Reads where the listing lives at the default branch: the Expo store config and the fastlane
 * folders. Shared by the listing and change set routes.
 */
export async function readRepositoryListing(
  ctx: RepoContext,
  repository: Repository,
  connector: RepoClient,
): Promise<RepositoryListings> {
  return withTimeout(
    (async () => {
      const files = await connector.listFiles(repository.defaultBranch);
      return readListings(files, (path) => connector.readFile(path, repository.defaultBranch));
    })(),
    ctx.timeoutMs,
  );
}

export type ListingView = {
  listing: Listing;
  found: ListingSnapshot['found'];
  roots: ListingSnapshot['roots'];
  warnings: string[];
  problems: ListingProblem[];
  /** Where each store's listing comes from: its source, file or folder, and the source's warnings. */
  sources: ListingSources;
};

export async function getRepositoryListing(
  ctx: RepoContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<Outcome<ListingView>> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.id);
  if (!repository) return failure(404, 'not_found');
  const opened = await openFor(ctx, input.workspaceId, repository, actor, 'repository.listing');
  if (!opened.ok) return opened;
  try {
    const listings = await readRepositoryListing(ctx, repository, opened.connector);
    const listing = mergedListing(listings);
    const sources = listingSources(listings);
    return {
      ok: true,
      listing,
      found: { appStore: sources.appStore.found, googlePlay: sources.googlePlay.found },
      roots: listings.fastlane.roots,
      warnings: listingWarnings(listings),
      problems: validateListing(listing),
      sources,
    };
  } catch (error) {
    return githubFailure(error, opened.secret);
  }
}

export { openFor as openConnectorForRepository };
