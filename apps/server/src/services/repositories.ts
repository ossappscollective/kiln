import { randomUUID } from 'node:crypto';
import type { ActorType, Listing, ListingProblem } from '@mrm/core';
import { validateListing } from '@mrm/core';
import {
  detectProject,
  GithubError,
  GithubRateLimitError,
  GithubRepoConnector,
  githubAuthFromSecret,
  type ListingCandidate,
  type ListingDiagnostics,
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
  UnknownTargetError,
} from './listing-sources.ts';
import {
  type ListingSelection,
  type ListingTarget,
  listListingTargets,
  resolveSelection,
} from './listing-targets.ts';
import {
  type CloneReads,
  isCloneBacked,
  type ReadFallback,
  withCloneReads,
} from './clone-reads.ts';
import { openRepoSnapshot } from './repo-snapshot.ts';

export { type CloneReads, withCloneReads };

type Actor = { type: ActorType; id: string };

/**
 * A repo connector that can also say which branch is the default (the GitHub one can), and,
 * optionally, which commit a branch points to (then a request reads one consistent snapshot and
 * the file list and file texts are cached by commit, see repo-snapshot.ts).
 */
export type RepoClient = RepoConnector & {
  defaultBranch(): Promise<string>;
  resolveCommit?(ref?: string, signal?: AbortSignal): Promise<string>;
};

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
  /**
   * Local clones for scan and listing reads (docs/adr/0005-local-clone-reads.md). Omitted, or
   * inactive (`MRM_READS=api`): every read goes through the connector as before.
   */
  reads?: CloneReads;
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
 * The purposes whose reads may come from a clone. Everything else (connecting, applying a change
 * set, whatever a later feature asks for) gets the API connector as it is.
 */
export const CLONE_READ_PURPOSES: ReadonlySet<string> = new Set([
  'repository.scan',
  'repository.listing',
  'changeset.create',
]);

/** The token git authenticates with: the PAT, or the App's installation token as a function. */
function cloneToken(
  kind: 'github_app' | 'github_token',
  secret: string,
  api: RepoClient,
): string | (() => Promise<string>) | undefined {
  if (kind === 'github_token') return secret.trim();
  const mint = (api as { installationToken?: (signal?: AbortSignal) => Promise<string> })
    .installationToken;
  return typeof mint === 'function' ? () => mint.call(api) : undefined;
}

/** A read fell back to the API: one log line (with the redacted cause) and one audit row (without it). */
async function noteFallback(
  ctx: RepoContext,
  where: { workspaceId: string; repositoryId: string; purpose: string; secret: string },
  actor: Actor,
  fallback: ReadFallback,
): Promise<void> {
  const reason = fallback.reason ? `/${fallback.reason}` : '';
  const cause = redactSecrets(fallback.message, secretStrings(where.secret));
  ctx.reads?.log(
    `Reads: ${where.purpose} of repository ${where.repositoryId} used the GitHub API instead of the clone (${fallback.operation}: ${fallback.kind}${reason}). ${cause}`,
  );
  try {
    await recordAudit(ctx.db, {
      workspaceId: where.workspaceId,
      actor,
      action: 'repository.read_fallback',
      target: { type: 'repository', id: where.repositoryId },
      detail: {
        purpose: where.purpose,
        operation: fallback.operation,
        kind: fallback.kind,
        reason: fallback.reason,
      },
      at: ctx.now(),
    });
  } catch (error) {
    ctx.reads?.log(`Reads: could not record the fall back to the API (${(error as Error).name}).`);
  }
}

/**
 * Reads the credential's secret (audited as `credential.use`) and builds the connector.
 * Every failure here happens before anything is sent to GitHub.
 */
export async function openConnector(
  ctx: RepoContext,
  input: {
    workspaceId: string;
    credentialId: string;
    owner: string;
    repo: string;
    /** The stored repository. With it, a read purpose may be served from a clone. */
    repository?: Repository;
  },
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
    const api = ctx.connectorFactory(kind, secret, { owner: input.owner, repo: input.repo });
    const { repository, workspaceId } = input;
    const reads = ctx.reads;
    if (!repository || !reads?.active || !CLONE_READ_PURPOSES.has(purpose)) {
      return { ok: true, connector: api, secret };
    }
    const where = { workspaceId, repositoryId: repository.id, purpose, secret };
    try {
      const token = cloneToken(kind, secret, api);
      if (token === undefined) {
        throw new GithubError(
          'unexpected',
          'This credential cannot give git a token, so the repository cannot be read from a clone.',
        );
      }
      const reader = reads.reader(
        {
          workspaceId,
          repositoryId: repository.id,
          owner: repository.owner,
          repo: repository.repo,
          defaultBranch: repository.defaultBranch,
        },
        token,
      );
      const connector = withCloneReads(api, reader, {
        fallback: reads.fallback,
        onFallback: (fallback) => noteFallback(ctx, where, actor, fallback),
      });
      return { ok: true, connector, secret };
    } catch (error) {
      // The clone could not even be set up. `auto` reads this request through the API.
      if (!reads.fallback) return githubFailure(error, secret);
      await noteFallback(
        ctx,
        where,
        actor,
        {
          operation: 'open',
          kind: error instanceof GithubError ? error.kind : 'error',
          reason: null,
          message: error instanceof Error ? error.message : 'unknown error',
        },
      );
      return { ok: true, connector: api, secret };
    }
  } catch (error) {
    return githubFailure(error, secret);
  }
}

const openFor = (ctx: RepoContext, ws: string, r: Repository, actor: Actor, purpose: string) =>
  openConnector(
    ctx,
    { workspaceId: ws, credentialId: r.credentialId, owner: r.owner, repo: r.repo, repository: r },
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
    const result = await disconnect(ctx, input, actor);
    // After the commit: the clone is a cache, so a failure to remove it (logged) changes nothing.
    if (result.ok) await ctx.reads?.remove(input.workspaceId, input.id);
    return result;
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
    await tx.execute(
      'DELETE FROM repository_listing_targets WHERE repository_id = ? AND workspace_id = ?',
      [input.id, input.workspaceId],
    );
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

/** Where a scan read from, for the audit row: `clone`, or `api_fallback` with what failed. */
function readsDetail(connector: { reads: { fallbacks: ReadFallback[] } }): Record<string, unknown> {
  const [first] = connector.reads.fallbacks;
  return first
    ? { reads: 'api_fallback', fallback: { operation: first.operation, kind: first.kind, reason: first.reason } }
    : { reads: 'clone' };
}

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
  const controller = new AbortController();
  if (isCloneBacked(connector)) connector.useSignal(controller.signal);
  try {
    detection = await withTimeout(
      (async () => {
        // A scan somebody asked for should see the newest commit, not the one fetched a minute ago.
        if (isCloneBacked(connector)) {
          await connector.refresh(repository.defaultBranch, controller.signal);
        }
        const snapshot = await openRepoSnapshot({
          repositoryId: repository.id,
          connector,
          branch: repository.defaultBranch,
          now: ctx.now,
          signal: controller.signal,
        });
        fileCount = snapshot.files.length;
        return detectProject(snapshot.files, snapshot.read);
      })(),
      ctx.timeoutMs,
      () => controller.abort(),
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
      detail: {
        kind: detection.kind,
        files: fileCount,
        ...(isCloneBacked(connector) ? readsDetail(connector) : {}),
      },
      at: now,
    });
  });
  const updated = (await getRepository(ctx.db, input.workspaceId, input.id)) as Repository;
  return { ok: true, repository: updated, detection, listingSources: detectedSources(detection) };
}

const MAX_WARM_PATHS = 2000;

/** The text files under the chosen listing folders (not images), for downloading in one request. */
function listingTextFiles(
  files: readonly string[],
  roots: { appStore?: string; googlePlay?: string },
): string[] {
  const folders = [roots.appStore, roots.googlePlay]
    .filter((r): r is string => typeof r === 'string' && r !== '')
    .map((r) => `${r.replace(/\/+$/, '')}/`);
  if (folders.length === 0) return [];
  return files
    .filter((f) => /\.(?:txt|json)$/.test(f) && folders.some((r) => f.startsWith(r)))
    .slice(0, MAX_WARM_PATHS);
}

/**
 * Reads where the listing lives at the default branch: the Expo store config and the fastlane
 * folders of the chosen target (or the detected default). Shared by the listing and change set
 * routes. The tree is listed once and the files are read a few at a time, only those of the chosen
 * folders (see repo-snapshot.ts, listing-sources.ts). Stops sending requests once it times out.
 */
export async function readRepositoryListing(
  ctx: RepoContext,
  workspaceId: string,
  repository: Repository,
  connector: RepoClient,
  selection?: ListingSelection,
): Promise<Outcome<{ listings: RepositoryListings; custom?: ListingTarget }>> {
  const chosen = await resolveSelection(ctx.db, workspaceId, repository.id, selection);
  if (!chosen.ok) return failure(chosen.status, chosen.error, chosen.message);
  const controller = new AbortController();
  if (isCloneBacked(connector)) connector.useSignal(controller.signal);
  try {
    const listings = await withTimeout(
      (async () => {
        const snapshot = await openRepoSnapshot({
          repositoryId: repository.id,
          connector,
          branch: repository.defaultBranch,
          now: ctx.now,
          signal: controller.signal,
        });
        // Folders chosen by hand may hold files the clone has not downloaded: one request, not one each.
        if (isCloneBacked(connector) && chosen.roots) {
          const paths = listingTextFiles(snapshot.files, chosen.roots);
          if (paths.length > 0) await connector.warm(paths, snapshot.ref, controller.signal);
        }
        return readListings(snapshot.files, snapshot.read, {
          ...(chosen.roots ? { roots: chosen.roots } : {}),
          ...(chosen.autoKey === undefined ? {} : { autoTarget: chosen.autoKey }),
          ignoreExpoConfig: chosen.ignoreExpoConfig,
        });
      })(),
      ctx.timeoutMs,
      () => controller.abort(),
    );
    return { ok: true, listings, ...(chosen.custom ? { custom: chosen.custom } : {}) };
  } catch (error) {
    if (error instanceof UnknownTargetError) {
      return failure(
        404,
        'target_not_found',
        'That detected listing target is not in the repository any more. Scan again and choose another.',
      );
    }
    throw error;
  }
}

/** A place the listing can be read from: found by the scan, or saved by a person. */
export type ListingTargetView = {
  /** A saved target's id, or `auto:<key>` for a detected one. Send it back as `target`. */
  id: string;
  origin: 'detected' | 'custom';
  label: string;
  app: string | null;
  roots: { appStore: string | null; googlePlay: string | null };
  createdAt?: number;
  updatedAt?: number;
};

export type SelectedTarget = {
  /** The id of the target that was used, or null when the folders were chosen one by one. */
  id: string | null;
  /** `custom`: a saved target. `detected`: one found by the scan, chosen. `folders`: roots in the request. `default`: nothing chosen. */
  origin: 'custom' | 'detected' | 'folders' | 'default';
  label: string;
};

export type ListingView = {
  listing: Listing;
  found: ListingSnapshot['found'];
  roots: ListingSnapshot['roots'];
  warnings: string[];
  problems: ListingProblem[];
  /** Where each store's listing comes from: its source, file or folder, and the source's warnings. */
  sources: ListingSources;
  /** Every place the listing can be read from: detected (one per app) and saved. */
  targets: ListingTargetView[];
  /** Which of them was read. */
  selected: SelectedTarget;
  /** Every folder that looks like listing files, with the app it belongs to. */
  candidates: ListingCandidate[];
  /** What was searched and what was found instead, per store (for an empty result). */
  diagnostics: ListingDiagnostics;
};

export function listingTargetViews(
  fastlane: ListingSnapshot,
  custom: readonly ListingTarget[],
): ListingTargetView[] {
  return [
    ...fastlane.targets.map(
      (t): ListingTargetView => ({
        id: `auto:${t.key}`,
        origin: 'detected',
        label: t.label,
        app: t.app ?? null,
        roots: t.roots,
      }),
    ),
    ...custom.map(
      (t): ListingTargetView => ({
        id: t.id,
        origin: 'custom',
        label: t.name,
        app: t.appId,
        roots: { appStore: t.appStoreRoot, googlePlay: t.googlePlayRoot },
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }),
    ),
  ];
}

export function selectedTarget(
  views: readonly ListingTargetView[],
  fastlane: ListingSnapshot,
  selection: ListingSelection | undefined,
  custom: ListingTarget | undefined,
): SelectedTarget {
  const rootsGiven = selection?.roots !== undefined && Object.keys(selection.roots).length > 0;
  if (custom && !rootsGiven) return { id: custom.id, origin: 'custom', label: custom.name };
  const auto = selection?.target?.startsWith('auto:') ? views.find((v) => v.id === selection.target) : undefined;
  if (auto && !rootsGiven) return { id: auto.id, origin: 'detected', label: auto.label };
  if (rootsGiven || custom) return { id: null, origin: 'folders', label: 'Chosen folders' };
  const same = views.find(
    (v) =>
      v.origin === 'detected' &&
      (v.roots.appStore ?? '') === fastlane.roots.appStore &&
      (v.roots.googlePlay ?? '') === fastlane.roots.googlePlay,
  );
  return same
    ? { id: same.id, origin: 'default', label: same.label }
    : { id: null, origin: 'default', label: 'Detected folders' };
}

export async function getRepositoryListing(
  ctx: RepoContext,
  input: { workspaceId: string; id: string; selection?: ListingSelection },
  actor: Actor,
): Promise<Outcome<ListingView>> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.id);
  if (!repository) return failure(404, 'not_found');
  const opened = await openFor(ctx, input.workspaceId, repository, actor, 'repository.listing');
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
    const { listings } = read;
    const listing = mergedListing(listings);
    const sources = listingSources(listings);
    const saved = await listListingTargets(ctx.db, input.workspaceId, repository.id);
    const targets = listingTargetViews(listings.fastlane, saved);
    return {
      ok: true,
      listing,
      found: { appStore: sources.appStore.found, googlePlay: sources.googlePlay.found },
      roots: listings.fastlane.roots,
      warnings: listingWarnings(listings),
      problems: validateListing(listing),
      sources,
      targets,
      selected: selectedTarget(targets, listings.fastlane, input.selection, read.custom),
      candidates: listings.fastlane.candidates,
      diagnostics: listings.fastlane.diagnostics,
    };
  } catch (error) {
    return githubFailure(error, opened.secret);
  }
}

export { openFor as openConnectorForRepository };
