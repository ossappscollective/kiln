import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import {
  type BlobHeadsOptions,
  type BlobReads,
  type CloneSource,
  GitCloneError,
  GitCloneReader,
  GithubError,
  isBlobReads,
  type RepoConnector,
  removeClone,
  removeWorkspaceClones,
} from '@mrm/connectors';

/**
 * Reads from a local git clone (docs/adr/0005-local-clone-reads.md). This file is the server's
 * half of it: the mode switch, the pool of readers, the adapter that puts a `GitCloneReader` in
 * front of the API connector, and the start-up check for git. The clone itself is in
 * packages/connectors/src/github/git-clone.ts.
 */

/** `api`: the GitHub API only. `clone`: a clone, no fall back. `auto`: a clone, the API when it cannot be used. */
export type ReadsMode = 'api' | 'clone' | 'auto';

/** The read half of what `RepoClient` is (repositories.ts), spelled out here to avoid a cycle. */
type ApiClient = RepoConnector & {
  defaultBranch(): Promise<string>;
  resolveCommit?(ref?: string, signal?: AbortSignal): Promise<string>;
};

/** The methods of `GitCloneReader` the adapter uses. A test may pass a stand-in. */
export type CloneReader = Pick<
  GitCloneReader,
  'listFiles' | 'readFile' | 'resolveCommit' | 'defaultBranch' | 'refresh' | 'warm' | 'remove'
> &
  // Binary reads for the asset index (asset-repo.ts). A stand-in without them cannot serve it.
  Partial<Pick<GitCloneReader, 'listBlobEntries' | 'readBlobHeads'>>;

/** One read that went to the API because the clone could not be used. Never carries a message. */
export type ReadFallback = {
  /** `resolveCommit`, `listFiles`, `readFile`, `defaultBranch` or `refresh`. */
  operation: string;
  /** The `GithubError` kind, or `error` for anything else. */
  kind: string;
  /** The `GitCloneError` reason (`git_missing`, `not_managed`, ...), when there is one. */
  reason: string | null;
  /** The error's message, redacted. For the server log only: not for an audit row or a response. */
  message: string;
};

export type ReadReport = {
  fallbacks: ReadFallback[];
  /** `local`: the repository's attached local folder (docs/adr/0005). Absent: a managed clone of GitHub. */
  origin?: 'local';
};

/**
 * A local clone could not be read, with a code and a message written to be shown (no path outside
 * the allowed folders, no secret). `githubFailure` turns it into a response with this status and code.
 */
export class LocalReadError extends Error {
  readonly code: string;
  readonly status: 404 | 409 | 422;
  constructor(code: string, message: string, status: 404 | 409 | 422 = 422) {
    super(message);
    this.name = 'LocalReadError';
    this.code = code;
    this.status = status;
  }
}

/** What `withCloneReads` returns: the API connector with the clone's reads, and a few extras. */
export type CloneBackedClient = ApiClient & {
  /** Fetches the newest tip of a branch now, ignoring the freshness window. A no-op on the API path. */
  refresh(ref?: string, signal?: AbortSignal): Promise<void>;
  /** Downloads these files in one request so the reads that follow are local. Best effort. */
  warm(paths: readonly string[], ref?: string, signal?: AbortSignal): Promise<void>;
  /** The abort signal of the request this client serves: aborting it kills a running git. */
  useSignal(signal: AbortSignal): void;
  readonly reads: ReadReport;
};

export const isCloneBacked = (client: unknown): client is CloneBackedClient =>
  typeof client === 'object' && client !== null && 'reads' in client && 'useSignal' in client;

/** `git_missing` and `not_managed` are about this server, `unexpected` is something we did not foresee. */
export function canFallBack(error: unknown): boolean {
  if (error instanceof GitCloneError) {
    return (
      error.reason === 'git_missing' ||
      error.reason === 'not_managed' ||
      error.kind === 'unexpected'
    );
  }
  // Auth, not found, rate limits, timeouts, too large, not text: the API would say the same.
  return !(error instanceof GithubError);
}

export type WithCloneReadsOptions = {
  /** `auto`: use the API for the rest of the request when the clone fails in a way that allows it. */
  fallback?: boolean;
  /** Awaited before the API is used. Must not throw. */
  onFallback?: (fallback: ReadFallback) => void | Promise<void>;
  signal?: AbortSignal;
  /** Marks the reads as coming from an attached local folder, for the audit detail. */
  origin?: 'local';
};

/**
 * The adapter of ADR 0005: `listFiles`, `readFile`, `resolveCommit` and `defaultBranch` are the
 * clone's; everything else (`propose`, `dispatchWorkflow`, `listWorkflowRuns`, whatever else the
 * API connector has) is the API connector's, so applying a change set and the pull request still
 * go through GitHub's API, with its conflict check. Make one per request.
 *
 * With `fallback`, a clone failure that `canFallBack` is answered by the API connector, and so is
 * every later read of the same request (one source per request, never a mix). The API reads the
 * commit the clone resolved, so the by-commit cache in repo-snapshot.ts holds either way. If the
 * API connector cannot name commits (`resolveCommit` missing) there is nothing to fall back to and
 * the clone's error is thrown.
 */
export function withCloneReads(
  api: ApiClient,
  reader: CloneReader,
  options: WithCloneReadsOptions = {},
): CloneBackedClient {
  let signal = options.signal;
  let fellBack = false;
  const reads: ReadReport = {
    fallbacks: [],
    ...(options.origin ? { origin: options.origin } : {}),
  };
  const call = () => (signal ? { signal } : {});

  async function run<T>(
    operation: string,
    viaClone: () => Promise<T>,
    viaApi: (() => Promise<T>) | undefined,
  ): Promise<T> {
    if (fellBack) {
      if (!viaApi) throw new Error(`${operation} is not available on the API connector.`);
      return viaApi();
    }
    try {
      return await viaClone();
    } catch (error) {
      if (!options.fallback || !viaApi || signal?.aborted || !canFallBack(error)) throw error;
      const entry: ReadFallback = {
        operation,
        kind: error instanceof GithubError ? error.kind : 'error',
        reason: error instanceof GitCloneError ? (error.reason ?? null) : null,
        message: describe(error),
      };
      fellBack = true;
      reads.fallbacks.push(entry);
      await options.onFallback?.(entry);
      return viaApi();
    }
  }

  const own: Record<string, unknown> = {
    reads,
    useSignal: (next: AbortSignal) => {
      signal = next;
    },
    listFiles: (ref?: string) =>
      run(
        'listFiles',
        () => reader.listFiles(ref, call()),
        () => api.listFiles(ref),
      ),
    readFile: (path: string, ref?: string) =>
      run(
        'readFile',
        () => reader.readFile(path, ref, call()),
        () => api.readFile(path, ref),
      ),
    resolveCommit: (ref?: string, next?: AbortSignal) => {
      if (next) signal = next;
      return run(
        'resolveCommit',
        () => reader.resolveCommit(ref, signal),
        api.resolveCommit
          ? () => Promise.resolve(api.resolveCommit?.(ref, signal) as Promise<string>)
          : undefined,
      );
    },
    // The reader is made with the stored default branch, so this does not touch the network.
    defaultBranch: () =>
      run(
        'defaultBranch',
        () => reader.defaultBranch(call()),
        () => api.defaultBranch(),
      ),
    refresh: async (ref?: string, next?: AbortSignal) => {
      if (next) signal = next;
      await run(
        'refresh',
        async () => {
          await reader.refresh(ref, call());
        },
        async () => undefined,
      );
    },
    warm: async (paths: readonly string[], ref?: string, next?: AbortSignal) => {
      if (next) signal = next;
      if (fellBack) return;
      // The reads that follow report the real problem; a failed warm-up only costs time.
      await reader.warm(paths, ref, call()).catch(() => undefined);
    },
    // Binary reads for the asset index (blobs.ts): the clone's, with the API's as the fall back.
    listBlobEntries: (ref?: string, options: { signal?: AbortSignal } = {}) =>
      run(
        'listBlobEntries',
        () =>
          cloneBlobs().listBlobEntries(ref, options.signal ? options : { ...options, ...call() }),
        isBlobReads(api) ? () => (api as BlobReads).listBlobEntries(ref, options) : undefined,
      ),
    readBlobHeads: (paths: readonly string[], options: BlobHeadsOptions) =>
      run(
        'readBlobHeads',
        () =>
          cloneBlobs().readBlobHeads(paths, options.signal ? options : { ...options, ...call() }),
        isBlobReads(api) ? () => (api as BlobReads).readBlobHeads(paths, options) : undefined,
      ),
  };
  const cloneBlobs = (): BlobReads => {
    if (isBlobReads(reader)) return reader;
    throw new GitCloneError('unexpected', 'This reader cannot read binary files.', 'not_managed');
  };

  return new Proxy(api, {
    get(_target, prop) {
      if (typeof prop === 'string' && Object.hasOwn(own, prop)) return own[prop];
      const value = Reflect.get(api, prop);
      // Bound: the connector has private fields, which `this` must be the connector itself for.
      return typeof value === 'function' ? value.bind(api) : value;
    },
    has(_target, prop) {
      return (typeof prop === 'string' && Object.hasOwn(own, prop)) || Reflect.has(api, prop);
    },
  }) as CloneBackedClient;
}

// ---------------------------------------------------------------------------------------------
// Reader pool

/** The repository a reader is for. */
export type CloneTarget = {
  workspaceId: string;
  repositoryId: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  /** Read from this source instead of GitHub: a local folder that has been validated by the caller. */
  source?: CloneSource;
  /** Overrides the pool's freshness window for this reader. 0 fetches the branch tip on every read. */
  ttlMs?: number;
};

/** Where local clones may be (docs/adr/0005-local-clone-reads.md). Empty `roots`: the feature is off. */
export type LocalReposConfig = {
  /** Allowed parent folders, absolute (MRM_LOCAL_REPO_ROOTS). Their real paths are used when a path is checked. */
  roots: readonly string[];
  /** Folders a local clone must never be in (the server's data and clone folders). */
  excluded: readonly string[];
};

export type CloneReadsOptions = {
  mode: ReadsMode;
  /** Folder all clones live in. */
  cloneDir: string;
  /** How long a fetched branch tip is reused. Default 60 s. */
  ttlMs?: number;
  /** The git program. Default `git`. */
  gitPath?: string;
  /** False when `git --version` failed at start. `auto` then reads through the API. Default true. */
  gitAvailable?: boolean;
  /**
   * Where to clone a repository from, when not from GitHub: a local path (tests; the desktop
   * app's "use my checkout"). Return undefined for GitHub.
   */
  source?: (target: CloneTarget) => CloneSource | undefined;
  /** One line to the server log. Default `console.warn`. Never receives a secret. */
  log?: (line: string) => void;
  /** Longest a pooled reader is kept. Default 64 repositories. */
  maxReaders?: number;
  /** Local clones a person may attach. Default: none (off). */
  local?: LocalReposConfig;
};

export type CloneReads = {
  readonly mode: ReadsMode;
  readonly cloneDir: string;
  /** The git program. Optional so a stand-in pool in a test need not have it. Default `git`. */
  readonly gitPath?: string;
  /** Where local clones may be. Absent or empty `roots`: the feature is off. */
  readonly local?: LocalReposConfig;
  /** Reads go through a clone: `clone`, or `auto` with git present. False in `api` mode. */
  readonly active: boolean;
  /** `auto`: the API takes over for a request when the clone cannot be used. */
  readonly fallback: boolean;
  readonly log: (line: string) => void;
  /** A reader for the repository. Readers are kept, so the freshness window works across requests. */
  reader(target: CloneTarget, token: string | (() => string | Promise<string>)): CloneReader;
  /** Deletes the clone. Errors are logged, not thrown: the folder is only a cache. */
  remove(workspaceId: string, repositoryId: string): Promise<void>;
  /** Deletes every clone of a workspace. Same error handling. */
  removeWorkspace(workspaceId: string): Promise<void>;
};

export function createCloneReads(options: CloneReadsOptions): CloneReads {
  const log = options.log ?? ((line: string) => console.warn(line));
  const maxReaders = options.maxReaders ?? 64;
  const active =
    options.mode === 'clone' || (options.mode === 'auto' && options.gitAvailable !== false);
  const pool = new Map<
    string,
    {
      reader: GitCloneReader;
      shape: string;
      token: { current: string | (() => string | Promise<string>) };
    }
  >();
  const keyOf = (workspaceId: string, repositoryId: string) => `${workspaceId}/${repositoryId}`;

  return {
    mode: options.mode,
    cloneDir: options.cloneDir,
    gitPath: options.gitPath ?? 'git',
    local: options.local ?? { roots: [], excluded: [] },
    active,
    fallback: options.mode === 'auto',
    log,
    reader(target, token) {
      const source: CloneSource = target.source ??
        options.source?.(target) ?? {
          type: 'github',
          owner: target.owner,
          repo: target.repo,
        };
      const key = keyOf(target.workspaceId, target.repositoryId);
      const shape = JSON.stringify([source, target.defaultBranch, target.ttlMs ?? null]);
      let entry = pool.get(key);
      if (entry && entry.shape !== shape) {
        pool.delete(key);
        entry = undefined;
      }
      if (!entry) {
        const holder = { current: token };
        const reader = new GitCloneReader({
          baseDir: options.cloneDir,
          workspaceId: target.workspaceId,
          repositoryId: target.repositoryId,
          source,
          token: () => (typeof holder.current === 'function' ? holder.current() : holder.current),
          defaultBranch: target.defaultBranch,
          ttlMs: target.ttlMs ?? options.ttlMs ?? 60_000,
          ...(options.gitPath ? { gitPath: options.gitPath } : {}),
        });
        entry = { reader, shape, token: holder };
      } else {
        pool.delete(key); // re-inserted below: the newest is last
      }
      entry.token.current = token;
      pool.set(key, entry);
      while (pool.size > maxReaders) {
        const oldest = pool.keys().next().value;
        if (oldest === undefined) break;
        pool.delete(oldest);
      }
      return entry.reader;
    },
    async remove(workspaceId, repositoryId) {
      const key = keyOf(workspaceId, repositoryId);
      const entry = pool.get(key);
      pool.delete(key);
      try {
        if (entry) await entry.reader.remove();
        else await removeClone(options.cloneDir, workspaceId, repositoryId);
      } catch (error) {
        log(`Could not remove the clone of repository ${repositoryId}: ${describe(error)}`);
      }
    },
    async removeWorkspace(workspaceId) {
      for (const key of [...pool.keys()]) {
        if (key.startsWith(`${workspaceId}/`)) pool.delete(key);
      }
      try {
        await removeWorkspaceClones(options.cloneDir, workspaceId);
      } catch (error) {
        log(`Could not remove the clones of workspace ${workspaceId}: ${describe(error)}`);
      }
    },
  };
}

/** A short, safe description of an error for a log line: the kind and reason, or the message of ours. */
export function describe(error: unknown): string {
  if (error instanceof GitCloneError) {
    return `${error.kind}${error.reason ? `/${error.reason}` : ''}: ${error.message}`;
  }
  if (error instanceof GithubError) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.name : 'unknown error';
}

// ---------------------------------------------------------------------------------------------
// Start-up

export type GitCheck = { ok: true; version: string } | { ok: false; message: string };

/** Runs `git --version`. Never throws. */
export function checkGit(gitPath: string): Promise<GitCheck> {
  return new Promise((resolve) => {
    execFile(
      gitPath,
      ['--version'],
      { timeout: 5000, env: { PATH: process.env.PATH ?? '' }, windowsHide: true },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          resolve({
            ok: false,
            message:
              code === 'ENOENT' ? `"${gitPath}" was not found` : `"${gitPath} --version" failed`,
          });
          return;
        }
        resolve({ ok: true, version: stdout.trim().replace(/^git version\s+/, '') });
      },
    );
  });
}

/**
 * Called once at start. Not in `api` mode: creates the clone folder (mode 0700) and checks git,
 * logging one line. In `auto` a missing git means the API is used, in `clone` the reads will fail
 * with an error that says why. Always returns the pool (in `api` mode it is inactive), so a
 * clone left from an earlier mode is still removed when its repository is disconnected.
 */
export async function setUpReads(
  options: Omit<CloneReadsOptions, 'gitAvailable'>,
): Promise<CloneReads> {
  const info = options.log ?? ((line: string) => console.log(line));
  if (options.mode === 'api') return createCloneReads(options);
  const auto = options.mode === 'auto';
  let gitAvailable = true;
  const git = await checkGit(options.gitPath ?? 'git');
  if (!git.ok) {
    gitAvailable = false;
    info(
      auto
        ? `Reads: git is not installed (${git.message}). Reading repositories through the GitHub API. Install git or set MRM_GIT_PATH to use local clones.`
        : `Reads: MRM_READS=clone but git is not installed (${git.message}). Repository reads will fail until it is. Install git, set MRM_GIT_PATH, or use MRM_READS=api.`,
    );
  }
  let folderOk = true;
  try {
    await mkdir(options.cloneDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    folderOk = false;
    gitAvailable = false;
    info(
      `Reads: cannot create the clone folder ${options.cloneDir} (${(error as NodeJS.ErrnoException).code ?? 'error'}).${
        auto ? ' Reading repositories through the GitHub API.' : ' Repository reads will fail.'
      }`,
    );
  }
  if (git.ok && folderOk) {
    info(`Reads: ${options.mode}, git ${git.version}, clones in ${options.cloneDir}`);
  }
  // In `clone` mode `active` does not depend on the check: the reads then fail with the reason.
  return createCloneReads({ ...options, gitAvailable });
}
