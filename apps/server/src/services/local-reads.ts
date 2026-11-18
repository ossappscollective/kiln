import {
  GitCloneError,
  type ProposalResult,
  type RepoConnector,
} from '@mrm/connectors';
import {
  type CloneBackedClient,
  type CloneReader,
  type CloneReads,
  LocalReadError,
  withCloneReads,
} from './clone-reads.ts';
import {
  DUBIOUS_OWNERSHIP_MESSAGE,
  type LocalPathProblemCode,
  validateLocalPath,
} from './local-git.ts';

/**
 * Reading a repository from a folder on this machine (docs/adr/0005-local-clone-reads.md). The
 * service functions that attach and detach are in local-checkouts.ts; this file is what the read
 * path (repositories.ts) needs, and it does not import repositories.ts.
 */

export const ENV_NAME = 'MRM_LOCAL_REPO_ROOTS';
const NO_LOCAL = { roots: [], excluded: [] } as const;

export type LocalUnavailableReason = 'no_roots' | 'reads_api' | 'git_missing';

export type LocalAvailability =
  | { enabled: true; roots: string[] }
  | { enabled: false; reason: LocalUnavailableReason; message: string; envName: typeof ENV_NAME };

/** Whether local clones can be used on this server, and if not why not (in words to show). */
export function localAvailability(reads: CloneReads | undefined): LocalAvailability {
  const roots = reads?.local?.roots ?? [];
  if (roots.length === 0) {
    return {
      enabled: false,
      reason: 'no_roots',
      envName: ENV_NAME,
      message: `Local clones are not enabled. Set ${ENV_NAME}=/path/to/your/projects (a colon-separated list of folders that may hold clones, for example ${ENV_NAME}=/Volumes/dev) and restart the server.`,
    };
  }
  if (reads?.mode === 'api') {
    return {
      enabled: false,
      reason: 'reads_api',
      envName: ENV_NAME,
      message: 'MRM_READS=api means git is never run, so local clones cannot be read. Set MRM_READS=auto or clone to use them.',
    };
  }
  if (!reads?.active) {
    return {
      enabled: false,
      reason: 'git_missing',
      envName: ENV_NAME,
      message: 'git is not available on the server, so local clones cannot be read. Install git or set MRM_GIT_PATH.',
    };
  }
  return { enabled: true, roots: [...roots] };
}

/** The pool and clone-folder id of a repository's local reader, apart from its GitHub clone. */
export const localCloneId = (repositoryId: string): string => `${repositoryId}-local`;

export type LocalStatus =
  | 'ok'
  | 'not_enabled'
  | 'reads_api'
  | 'git_missing'
  | LocalPathProblemCode;

/** Whether the stored folder can be read now. File system checks only: git is not run. */
export async function localStatus(
  reads: CloneReads | undefined,
  path: string,
): Promise<{ status: LocalStatus; message?: string }> {
  const available = localAvailability(reads);
  if (!available.enabled) {
    const status: LocalStatus =
      available.reason === 'no_roots' ? 'not_enabled' : available.reason;
    return { status, message: available.message };
  }
  const check = await validateLocalPath(path, reads?.local ?? NO_LOCAL);
  return check.ok ? { status: 'ok' } : { status: check.code, message: check.message };
}

/** What a local-only repository stands in for the GitHub connector: reads are replaced, the rest refuse. */
export const LOCAL_ONLY_MESSAGE =
  'This repository is only a folder on this machine (it has no GitHub connection), so it cannot be used for pull requests, workflow runs or other GitHub features.';
export const LOCAL_ONLY_APPLY_MESSAGE =
  'This repository has no GitHub connection, so its change sets cannot be applied as a pull request on GitHub. Apply it as a commit on a new branch of the local clone instead (mode local_branch).';

export const WRITE_ENV_NAME = 'MRM_LOCAL_REPO_WRITE';

/**
 * Writing to local clones (a commit on a new branch, docs/adr/0005-local-clone-reads.md) is a
 * separate opt-in from reading them: `MRM_LOCAL_REPO_WRITE=true`.
 */
export type LocalWriteConfig = {
  enabled: boolean;
  /** MRM_GIT_AUTHOR_NAME and MRM_GIT_AUTHOR_EMAIL; the acting person is used when they are not set. */
  authorName?: string;
  authorEmail?: string;
  /** For tests only: where a push goes and how, instead of https://github.com/<owner>/<repo>.git. */
  push?: {
    url?: (owner: string, repo: string) => string;
    protocol?: 'http' | 'file';
    timeoutMs?: number;
  };
};

export type LocalWriteAvailability =
  | { enabled: true }
  | { enabled: false; envName: typeof WRITE_ENV_NAME; message: string };

export function localWriteAvailability(write: LocalWriteConfig | undefined): LocalWriteAvailability {
  if (write?.enabled) return { enabled: true };
  return {
    enabled: false,
    envName: WRITE_ENV_NAME,
    message: `Writing to local clones is not enabled. Set ${WRITE_ENV_NAME}=true and restart the server to allow a commit on a new branch of a local clone.`,
  };
}

function localOnlyStub(): RepoConnector & { defaultBranch(): Promise<string> } {
  const refuse = (): never => {
    throw new LocalReadError('local_only', LOCAL_ONLY_MESSAGE, 409);
  };
  return {
    kind: 'local',
    listFiles: async () => refuse(),
    readFile: async () => refuse(),
    propose: async (): Promise<ProposalResult> => refuse(),
    dispatchWorkflow: async () => refuse(),
    listWorkflowRuns: async () => refuse(),
    defaultBranch: async () => refuse(),
  };
}

/** A git failure on the local source, as an error with a code a person can act on. */
export function translateLocalError(error: unknown, branch: string): unknown {
  if (error instanceof LocalReadError) return error;
  if (error instanceof GitCloneError) {
    if (error.reason === 'git_missing') {
      return new LocalReadError('local_git_missing', 'The git program was not found on the server (MRM_GIT_PATH).', 409);
    }
    if (error.kind === 'forbidden') return new LocalReadError('dubious_ownership', DUBIOUS_OWNERSHIP_MESSAGE);
    if (error.kind === 'not_found' && error.reason === 'ref_missing') {
      return new LocalReadError(
        'local_branch_missing',
        `The local repository has no branch named ${branch} any more. Change the branch of the local clone.`,
      );
    }
    if (error.kind === 'not_found') {
      return new LocalReadError('local_missing', 'The local repository folder could not be found any more.');
    }
  }
  return error;
}

export type LocalOpenInput = {
  reads: CloneReads;
  workspaceId: string;
  repositoryId: string;
  /** The checkout as stored. Its path is validated again here. */
  path: string;
  branch: string;
  /** The repository's default branch: a read at that name is a read of `branch` (see below). */
  defaultBranch: string;
  /** The GitHub connector for an attached clone; undefined for a local-only repository. */
  api?: RepoConnector & { defaultBranch(): Promise<string>; resolveCommit?(ref?: string, signal?: AbortSignal): Promise<string> };
  /** Called with the commit a read resolved. Must not throw. */
  onCommit?: (sha: string) => void | Promise<void>;
};

export type LocalOpened =
  | { ok: true; connector: CloneBackedClient }
  | { ok: false; status: 409 | 422; code: string; message: string };

/**
 * A connector whose reads (`listFiles`, `readFile`, `resolveCommit`, `refresh`, `warm`) come from
 * the local folder and whose other methods are the GitHub connector's (or refuse, with no
 * GitHub). The folder is validated again here (its real path must still be inside an allowed
 * root: a folder may have been swapped for a link since it was attached), and only the validated
 * real path is handed to the reader. The reader fetches the committed branch into a managed bare
 * clone under the clones folder (`<id>-local`); the folder itself is never checked out into or
 * written to. A read of the repository's default branch name means the checkout's branch, so the
 * callers that always ask for `repository.defaultBranch` need no change; a commit sha is read as is.
 */
export async function openLocalConnector(input: LocalOpenInput): Promise<LocalOpened> {
  const { reads } = input;
  const available = localAvailability(reads);
  if (!available.enabled) {
    return {
      ok: false,
      status: 409,
      code: available.reason === 'no_roots' ? 'local_not_enabled' : available.reason === 'reads_api' ? 'local_reads_disabled' : 'local_git_missing',
      message: available.message,
    };
  }
  const check = await validateLocalPath(input.path, reads.local ?? NO_LOCAL);
  if (!check.ok) {
    return { ok: false, status: 422, code: `local_${check.code}`, message: check.message };
  }
  const inner = reads.reader(
    {
      workspaceId: input.workspaceId,
      repositoryId: localCloneId(input.repositoryId),
      owner: 'local',
      repo: 'local',
      defaultBranch: input.branch,
      source: { type: 'local', path: check.realPath },
      // The tip of a local branch is read on every request: it is a local fetch, and the point
      // is to see the commit a person just made.
      ttlMs: 0,
    },
    '',
  );
  const { branch, defaultBranch } = input;
  const map = (ref?: string) => (ref === undefined || ref === defaultBranch ? branch : ref);
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw translateLocalError(error, branch);
    }
  };
  const reader: CloneReader = {
    listFiles: (ref, options) => guard(() => inner.listFiles(map(ref), options)),
    readFile: (path, ref, options) => guard(() => inner.readFile(path, map(ref), options)),
    resolveCommit: (ref, signal) =>
      guard(async () => {
        const sha = await inner.resolveCommit(map(ref), signal);
        await input.onCommit?.(sha);
        return sha;
      }),
    defaultBranch: () => Promise.resolve(branch),
    refresh: (ref, options) =>
      guard(async () => {
        const done = await inner.refresh(map(ref), options);
        await input.onCommit?.(done.commit);
        return done;
      }),
    warm: (paths, ref, options) => guard(() => inner.warm(paths, map(ref), options)),
    remove: () => inner.remove(),
  };
  const connector = withCloneReads(input.api ?? localOnlyStub(), reader, { fallback: false, origin: 'local' });
  return { ok: true, connector };
}
