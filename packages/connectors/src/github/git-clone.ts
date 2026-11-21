import { type ChildProcess, spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  readdir,
  readFile as readTextFile,
  realpath,
  rm,
  rmdir,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  BlobEntry,
  BlobHeadItem,
  BlobHeads,
  BlobHeadsOptions,
  BlobListing,
} from '../blobs.ts';
import { GithubError, GithubRateLimitError, redactSecrets } from '../errors.ts';
import type { RepoConnector } from '../types.ts';

/**
 * Reads a repository from a local, managed, bare, shallow, partial clone made with the git CLI.
 * Design and threat model: docs/adr/0005-local-clone-reads.md.
 *
 * - The clone is `git init --bare` plus `git fetch --depth 1 --filter=blob:none`. There is no
 *   working tree and nothing is ever checked out: files are read from the object store with
 *   `git ls-tree -r -z` and `git cat-file`, so repository content cannot run a hook, a filter or
 *   a smudge program, and cannot write anywhere on disk (a symlink is just a blob of text).
 * - Blobs are not downloaded with the fetch. They are fetched on demand, in one batch for all the
 *   blobs a caller is about to read (`git fetch --stdin` with object ids, the same request git
 *   makes for a partial clone). Reads never trigger git's own one-by-one lazy fetch: lazy fetching
 *   is switched off for every read command, so a read is local or it fails.
 * - A token is only ever passed in the environment of the one git process that talks to the
 *   host, as an `http.<url>.extraheader` through `GIT_CONFIG_COUNT/KEY/VALUE`. It is never in the
 *   URL, in argv, in the clone's config file or in an error message. Redirects are not followed.
 * - Nothing here logs. Errors are `GithubError`s (`GitCloneError`) with safe, redacted messages,
 *   so code that maps `GithubError` to a response (`githubFailure`) needs no change.
 */

/** The read half of `RepoConnector`: what detection and listing code calls. */
export type RepoReader = Pick<RepoConnector, 'kind' | 'listFiles' | 'readFile'> & {
  defaultBranch(): Promise<string>;
};

/** A reader pinned to one commit: every call sees the same files. */
export type PinnedReader = {
  /** The full commit sha. Pass it to `listFiles` / `readFile` of the reader to read it later. */
  readonly commit: string;
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string | undefined>;
};

export type CloneSource =
  /** A repository on GitHub (or GitHub Enterprise Server, with `baseUrl`), over https. */
  | { type: 'github'; owner: string; repo: string; baseUrl?: string }
  /**
   * A repository on this machine (the desktop app's "use my checkout"). Only the `file` protocol
   * is enabled, and only for this source. Uncommitted changes are not seen: commits only.
   */
  | { type: 'local'; path: string };

export type GitCloneReaderOptions = {
  /** Directory all clones live under (for example `<KILN_DATA_DIR>/clones`). Created on demand. */
  baseDir: string;
  /** Safe ids (letters, digits, `-`, `_`). The clone is `<baseDir>/<workspaceId>/<repositoryId>`. */
  workspaceId: string;
  repositoryId: string;
  source: CloneSource;
  /**
   * Token for a `github` source: a GitHub App installation token or a personal access token. A
   * function is called before every network operation, so a short-lived installation token can be
   * renewed. Ignored for a `local` source.
   */
  token?: string | (() => string | Promise<string>);
  /** Branch to read when no ref is given. Default: asked from the remote (`ls-remote --symref`). */
  defaultBranch?: string | undefined;
  /**
   * How long a fetched branch or tag tip is reused before the next read fetches again.
   * Default 60000. `Infinity`: never fetch on read when a copy exists, only `refresh()` does.
   */
  ttlMs?: number;
  /**
   * Partial clone filter. Default `blob:none` for a `github` source (the right choice: no file
   * content comes with the fetch) and none for a `local` source (copying from disk is cheap and a
   * checkout rarely allows filtering). `null` downloads everything at depth 1.
   */
  filter?: string | null;
  /** Per local git process (list, read, check). Default 30000. */
  timeoutMs?: number;
  /** Per git process that uses the network. Default 120000. */
  fetchTimeoutMs?: number;
  /** Files larger than this are refused with a `too_large` error. Default 5 MiB. */
  maxFileBytes?: number;
  /** Largest tree listing accepted, in bytes of `ls-tree` output. Default 64 MiB. */
  maxListBytes?: number;
  /**
   * Which of the listed paths to download in the first batch when a commit is first read, so the
   * reads that follow are local. Default: `defaultWarmPaths` (project files and fastlane listing
   * text). `null` turns it off: every read then fetches what it needs when it asks.
   */
  warmPaths?: ((paths: readonly string[]) => string[]) | null;
  /** The git program. Default `git`. Tests pass a wrapper. */
  gitPath?: string;
  /** Verify every object received (`fetch.fsckObjects`). Default true. */
  fsck?: boolean;
  /**
   * Allow a `baseUrl` that starts with `http://`. Off by default and meant for tests: a token
   * would travel unencrypted.
   */
  insecureHttp?: boolean;
  /** Names of extra environment variables to pass to git (all others are dropped). */
  passEnv?: string[];
  /** Epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
};

export type CloneRefreshResult = {
  /** The branch or tag that was fetched (the default branch's name when none was given). */
  ref: string;
  /** The commit the ref points to now. */
  commit: string;
  /** False when the remote had not moved since the last fetch of this ref. */
  changed: boolean;
  /** Epoch milliseconds. */
  fetchedAt: number;
};

export type CloneCallOptions = { signal?: AbortSignal };

export type GitCloneReason =
  | 'timeout'
  | 'aborted'
  | 'git_missing'
  | 'git_failed'
  | 'output_limit'
  | 'ref_missing'
  | 'not_managed'
  | 'locked'
  | 'redirected';

/**
 * A `GithubError` raised by the clone path. `kind` is what response mapping uses; `reason` says
 * more (a timeout is `kind: 'network'`, `reason: 'timeout'`).
 */
export class GitCloneError extends GithubError {
  readonly reason?: GitCloneReason;
  constructor(
    kind: GithubError['kind'],
    message: string,
    reason?: GitCloneReason,
    status?: number,
  ) {
    super(kind, message, status);
    this.name = 'GitCloneError';
    if (reason !== undefined) this.reason = reason;
  }
}

// -----------------------------------------------------------------------------------------------
// Validation

const SHA = /^[0-9a-f]{40}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const OWNER_REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const MARKER = 'kiln-clone.json';
const MARKER_VERSION = 1;
const MIB = 1024 * 1024;
const BATCH_MAX = 500;
const STDERR_CAP = 64 * 1024;
/** The marker's modification time is when the clone was last used; it is rewritten at most this often. */
const TOUCH_EVERY_MS = 30_000;

/**
 * A path inside the repository. The same rules as the GitHub connector's `checkRepoPath` (kept
 * in step by a test): no leading slash, no empty, `.` or `..` segment, no `.git`, no backslash.
 */
function checkRepoPath(path: string): string {
  const bad =
    path === '' ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git');
  if (bad)
    throw new GithubError('invalid_input', `Not a valid repository path: ${JSON.stringify(path)}.`);
  return path;
}

/** The rules of the GitHub connector's branch name check, minus the `refs/` ban. */
function checkRefName(name: string): string {
  const bad =
    name === '' ||
    name.length > 200 ||
    name === '@' ||
    /^[-/.]|[/.]$|\.lock$|\.\.|\/\/|@\{|\/\.|\.lock\//.test(name) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: git forbids control characters
    /[\x00-\x20\x7f~^:?*[\\]/.test(name);
  if (bad)
    throw new GithubError(
      'invalid_input',
      `Not a valid branch or tag name: ${JSON.stringify(name)}.`,
    );
  return name;
}

type RefSpec =
  | { kind: 'commit'; name: string; sha: string }
  | { kind: 'heads' | 'tags'; name: string }
  | { kind: 'any'; name: string };

/** `main`, `heads/main`, `refs/heads/main`, `tags/v1`, or a full commit sha. */
function parseRef(ref: string): RefSpec {
  if (SHA.test(ref)) return { kind: 'commit', name: ref.toLowerCase(), sha: ref.toLowerCase() };
  const name = ref.replace(/^refs\//, '');
  const prefixed = /^(heads|tags)\/(.+)$/.exec(name);
  if (prefixed) {
    return { kind: prefixed[1] as 'heads' | 'tags', name: checkRefName(prefixed[2] as string) };
  }
  return { kind: 'any', name: checkRefName(name) };
}

const localRef = (kind: 'heads' | 'tags' | 'commits', name: string) => `refs/kiln/${kind}/${name}`;

function checkId(label: string, value: string): string {
  if (!SAFE_ID.test(value)) {
    throw new GithubError(
      'invalid_input',
      `${label} must be 1 to 100 letters, digits, "-" or "_", starting with a letter or digit.`,
    );
  }
  return value;
}

// -----------------------------------------------------------------------------------------------
// Warm paths

const WARM_ROOT_FILES =
  /^(?:Gemfile|package\.json|app\.json|eas\.json|[^/]*store[^/]*\.json|app\.config\.[cm]?[jt]s)$/;
const WARM_FASTLANE = /^(?:[^/]+\/){0,2}fastlane\/(?:Fastfile|Appfile|metadata\/.+\.txt)$/;

/**
 * The files project detection and listing reading ask for: a few files at the root, the Fastfile
 * and Appfile, and the metadata text of fastlane. Capped at 2000 paths.
 */
export function defaultWarmPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (WARM_ROOT_FILES.test(path) || WARM_FASTLANE.test(path)) {
      out.push(path);
      if (out.length >= 2000) break;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------------------------
// Locks and processes

class Mutex {
  #tail: Promise<void> = Promise.resolve();
  #waiting = 0;
  get idle() {
    return this.#waiting === 0;
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.#waiting++;
    const result = this.#tail.then(fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.#waiting--;
    });
  }
}

/** One lock per clone directory in this process, shared by every reader and `removeClone`. */
const mutexes = new Map<string, Mutex>();

function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  let mutex = mutexes.get(dir);
  if (!mutex) {
    mutex = new Mutex();
    mutexes.set(dir, mutex);
  }
  const held = mutex;
  return held.run(fn).finally(() => {
    if (held.idle && mutexes.get(dir) === held) mutexes.delete(dir);
  });
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-pid, 'SIGKILL'); // the whole process group: git starts helpers
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

type RunOptions = {
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  input?: string;
  timeoutMs: number;
  maxStdout: number;
  /** Keep the first `maxStdout` bytes and stop the process, instead of failing (`readBlobHeads`). */
  truncate?: boolean;
  signal?: AbortSignal;
  gitPath: string;
  children: Set<ChildProcess>;
  what: string;
};

type RunResult = { stdout: Buffer; stderr: string; code: number };

function runGit(o: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    if (o.signal?.aborted) {
      reject(new GitCloneError('network', 'The request was cancelled.', 'aborted'));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(o.gitPath, o.args, {
        cwd: o.cwd,
        env: o.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      reject(new GitCloneError('unexpected', 'git could not be started.', 'git_missing'));
      return;
    }
    o.children.add(child);
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = '';
    let failure: GitCloneError | undefined;
    const stop = (error: GitCloneError) => {
      failure ??= error;
      killTree(child);
    };
    const timer = setTimeout(
      () =>
        stop(
          new GitCloneError(
            'network',
            `git ${o.what} timed out after ${Math.round(o.timeoutMs / 1000)} seconds.`,
            'timeout',
          ),
        ),
      o.timeoutMs,
    );
    const onAbort = () =>
      stop(new GitCloneError('network', 'The request was cancelled.', 'aborted'));
    o.signal?.addEventListener('abort', onAbort, { once: true });

    let headOnly = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (headOnly) return;
      outBytes += chunk.length;
      if (outBytes > o.maxStdout && o.truncate) {
        const keep = o.maxStdout - (outBytes - chunk.length);
        if (keep > 0) out.push(chunk.subarray(0, keep));
        headOnly = true;
        killTree(child);
        return;
      }
      if (outBytes > o.maxStdout) {
        stop(
          new GitCloneError(
            'too_large',
            `git ${o.what} produced more than ${o.maxStdout} bytes of output.`,
            'output_limit',
          ),
        );
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8').slice(0, STDERR_CAP);
    });
    child.stdin?.on('error', () => {
      // git exited before reading its input; the exit code says why.
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failure ??=
        error.code === 'ENOENT'
          ? new GitCloneError(
              'unexpected',
              'The git program was not found. Install git to read repositories from a local clone.',
              'git_missing',
            )
          : new GitCloneError('unexpected', 'git could not be started.', 'git_missing');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      o.children.delete(child);
      if (failure) reject(failure);
      else
        resolvePromise({ stdout: Buffer.concat(out), stderr, code: headOnly ? 0 : (code ?? -1) });
    });
    if (o.input !== undefined) child.stdin?.end(o.input);
    else child.stdin?.end();
  });
}

const PASS_ENV = [
  'PATH',
  'SYSTEMROOT',
  'SystemRoot',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
];

// -----------------------------------------------------------------------------------------------
// Failure mapping

type Where = { label: string; ref?: string };
type GitCall = {
  network?: boolean;
  input?: string;
  signal?: AbortSignal | undefined;
  maxStdout?: number;
  truncate?: boolean;
  init?: boolean;
  what: string;
};

/**
 * Turns what git printed into a `GithubError`. `stderr` is already redacted. The text of git's
 * messages is stable enough for this (it is `LC_ALL=C`), and anything not recognised is
 * `unexpected` with the first line, so a new message is visible rather than hidden.
 */
function classifyFailure(stderr: string, where: Where): GithubError {
  const text = stderr.trim();
  const has = (re: RegExp) => re.test(text);
  const first = (text.split('\n').find((l) => l.trim() !== '') ?? '').slice(0, 240);
  const detail = first ? ` (${first})` : '';
  if (has(/returned error: 429|rate limit/i)) return new GithubRateLimitError(429, 'secondary', 60);
  if (has(/couldn't find remote ref|no such remote ref|not our ref|unadvertised object/i)) {
    return new GitCloneError(
      'not_found',
      `There is no branch, tag or commit named ${where.ref ?? 'that'} in ${where.label}.`,
      'ref_missing',
      404,
    );
  }
  if (has(/returned error: 30\d|unable to update url base from redirection|redirect/i)) {
    return new GitCloneError(
      'not_found',
      `GitHub redirected the request for ${where.label} (the repository may have been renamed or ` +
        'moved). Check its owner and name.',
      'redirected',
      404,
    );
  }
  if (
    has(
      /returned error: 401|Authentication failed|could not read (Username|Password)|terminal prompts disabled|Invalid username or password|bad credentials/i,
    )
  ) {
    return new GitCloneError(
      'auth',
      `The host rejected the credentials for ${where.label}. Check the token.`,
      undefined,
      401,
    );
  }
  if (has(/returned error: 403|Permission to .* denied|access denied|Repository access blocked/i)) {
    return new GitCloneError(
      'forbidden',
      `The host refused access to ${where.label}. Check that the token may read its contents.`,
      undefined,
      403,
    );
  }
  if (has(/detected dubious ownership/i)) {
    return new GitCloneError(
      'forbidden',
      `git refuses to read ${where.label} because another user owns it.`,
    );
  }
  if (
    has(
      /returned error: 404|Repository not found|repository .* not found|does not appear to be a git repository|does not exist/i,
    )
  ) {
    return new GitCloneError('not_found', `${where.label} was not found.`, undefined, 404);
  }
  const status = /returned error: (5\d\d)/.exec(text);
  if (status) {
    return new GitCloneError(
      'server',
      `The host failed while serving ${where.label} (${status[1]}).`,
      undefined,
      Number(status[1]),
    );
  }
  if (has(/Unable to create '.*\.lock'|\.lock': File exists/i)) {
    return new GitCloneError(
      'conflict',
      'Another process is updating this clone. Try again in a moment.',
      'locked',
    );
  }
  if (
    has(
      /Could not resolve host|Failed to connect|Connection (refused|timed out|reset)|Couldn't connect|SSL|TLS|unable to access|RPC failed|early EOF|transfer closed|hung up unexpectedly|Operation timed out|Proxy/i,
    )
  ) {
    return new GitCloneError('network', `Could not reach the host of ${where.label}${detail}.`);
  }
  if (has(/Not a valid object name|not a tree object/i)) {
    return new GitCloneError(
      'not_found',
      `That commit is not in the clone of ${where.label}.`,
      'ref_missing',
      404,
    );
  }
  if (has(/fsck|bad object|hash mismatch|corrupt|invalid (tree|commit|blob)/i)) {
    return new GitCloneError(
      'unexpected',
      `The data received for ${where.label} failed verification${detail}.`,
      'git_failed',
    );
  }
  return new GitCloneError('unexpected', `git failed for ${where.label}${detail}.`, 'git_failed');
}

// -----------------------------------------------------------------------------------------------
// The reader

type Entry = { mode: string; oid: string };
type Tree = { entries: Map<string, Entry>; paths: string[] };
type BlobResult =
  | { kind: 'ok'; data: Buffer }
  | { kind: 'too_large'; size: number }
  | { kind: 'missing' };
type Waiter = { resolve: (result: BlobResult) => void; reject: (error: unknown) => void };
type SharedRefresh = {
  promise: Promise<CloneRefreshResult>;
  controller: AbortController;
  waiters: number;
};

const cancelled = () => new GitCloneError('network', 'The request was cancelled.', 'aborted');

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined); // its outcome no longer matters
    return Promise.reject(cancelled());
  }
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

type Marker = { version: number; url: string; createdAt: number };

async function readMarker(path: string): Promise<Marker | undefined> {
  try {
    const parsed = JSON.parse(await readTextFile(path, 'utf8')) as Partial<Marker>;
    if (parsed.version === MARKER_VERSION && typeof parsed.url === 'string') {
      return { version: parsed.version, url: parsed.url, createdAt: Number(parsed.createdAt ?? 0) };
    }
  } catch {
    // missing or unreadable: not a clone of ours
  }
  return undefined;
}

export class GitCloneReader implements RepoReader {
  readonly kind = 'local' as const;
  /** The clone's directory (a bare repository). */
  readonly dir: string;

  readonly #baseDir: string;
  readonly #workspaceId: string;
  readonly #repositoryId: string;
  readonly #source: CloneSource;
  readonly #token?: string | (() => string | Promise<string>);
  readonly #configuredBranch?: string;
  readonly #ttl: number;
  readonly #filter: string | null;
  readonly #timeoutMs: number;
  readonly #fetchTimeoutMs: number;
  readonly #maxFileBytes: number;
  readonly #maxListBytes: number;
  readonly #warm: ((paths: readonly string[]) => string[]) | null;
  readonly #gitPath: string;
  readonly #passEnv: string[];
  readonly #now: () => number;
  readonly #label: string;
  readonly #hardening: string[];
  /** `https://github.com/` style prefix a token's header is scoped to. Empty for a local source. */
  readonly #urlPrefix: string;
  readonly #protocols: string;
  #githubUrl?: string;
  readonly #secrets = new Set<string>();
  readonly #children = new Set<ChildProcess>();
  #abort = new AbortController();
  #verified = false;
  #discovered: { name: string; at: number } | undefined;
  readonly #tips = new Map<string, { commit: string; fetchedAt: number }>();
  readonly #refreshing = new Map<string, Promise<CloneRefreshResult>>();
  readonly #trees = new Map<string, Promise<Tree>>();
  readonly #warmed = new Map<string, Promise<void>>();
  readonly #sharedRefresh = new Map<string, SharedRefresh>();
  #lastTouch = 0;
  #queue = new Map<string, Waiter[]>();
  #flushTimer: ReturnType<typeof setImmediate> | undefined;

  constructor(options: GitCloneReaderOptions) {
    if (!options.baseDir.trim()) {
      throw new GithubError('invalid_input', 'A base directory for clones is required.');
    }
    this.#baseDir = resolve(options.baseDir);
    this.#workspaceId = checkId('workspaceId', options.workspaceId);
    this.#repositoryId = checkId('repositoryId', options.repositoryId);
    this.dir = GitCloneReader.cloneDir(this.#baseDir, this.#workspaceId, this.#repositoryId);
    this.#source = options.source;
    if (options.token !== undefined) this.#token = options.token;
    if (options.defaultBranch !== undefined) {
      this.#configuredBranch = checkRefName(options.defaultBranch);
    }
    this.#ttl = options.ttlMs ?? 60_000;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetchTimeoutMs = options.fetchTimeoutMs ?? 120_000;
    this.#maxFileBytes = options.maxFileBytes ?? 5 * MIB;
    this.#maxListBytes = options.maxListBytes ?? 64 * MIB;
    this.#warm = options.warmPaths === undefined ? defaultWarmPaths : options.warmPaths;
    this.#gitPath = options.gitPath ?? 'git';
    this.#passEnv = options.passEnv ?? [];
    this.#now = options.now ?? Date.now;

    const source = options.source;
    if (source.type === 'github') {
      for (const [label, value] of [
        ['owner', source.owner],
        ['repo', source.repo],
      ] as const) {
        if (!OWNER_REPO.test(value) || value === '.' || value === '..') {
          throw new GithubError('invalid_input', `Not a valid repository ${label}.`);
        }
      }
      let base: URL;
      try {
        base = new URL(source.baseUrl ?? 'https://github.com');
      } catch {
        throw new GithubError('invalid_input', 'The base URL is not a valid URL.');
      }
      const https = base.protocol === 'https:';
      if (!https && !(options.insecureHttp && base.protocol === 'http:')) {
        throw new GithubError('invalid_input', 'The base URL must use https.');
      }
      if (base.username || base.password || base.search || base.hash) {
        throw new GithubError(
          'invalid_input',
          'The base URL must not carry credentials, a query or a fragment.',
        );
      }
      this.#urlPrefix = `${base.origin}${base.pathname.replace(/\/+$/, '')}/`;
      this.#githubUrl = `${this.#urlPrefix}${source.owner}/${source.repo}.git`;
      this.#protocols = https ? 'https' : 'http';
      this.#label = `${source.owner}/${source.repo}`;
      this.#filter = options.filter === undefined ? 'blob:none' : options.filter;
    } else {
      if (!source.path.trim()) {
        throw new GithubError('invalid_input', 'A path to the local repository is required.');
      }
      this.#urlPrefix = '';
      this.#protocols = 'file';
      this.#label = 'the local repository';
      this.#filter = options.filter === undefined ? null : options.filter;
    }
    if (this.#filter !== null && !/^[A-Za-z0-9:=._,+-]{1,100}$/.test(this.#filter)) {
      throw new GithubError('invalid_input', 'The partial clone filter is not valid.');
    }
    const fsck = String(options.fsck ?? true);
    // Every git process gets these on its command line. They are also what makes a repository's
    // own content (attributes, config in objects is not read at all) unable to run anything.
    this.#hardening = [
      ['core.hooksPath', devNull],
      ['core.fsmonitor', 'false'],
      ['credential.helper', ''],
      ['protocol.version', '2'],
      ['fetch.fsckObjects', fsck],
      ['transfer.fsckObjects', fsck],
      ['fetch.recurseSubmodules', 'false'],
      ['submodule.recurse', 'false'],
      ['gc.auto', '0'],
      ['gc.autoDetach', 'false'],
      ['maintenance.auto', 'false'],
      ['http.followRedirects', 'false'],
      ['filter.lfs.smudge', ''],
      ['filter.lfs.clean', ''],
      ['filter.lfs.process', ''],
      ['filter.lfs.required', 'false'],
      ['advice.detachedHead', 'false'],
    ].flatMap(([key, value]) => ['-c', `${key}=${value}`]);
  }

  /** `<baseDir>/<workspaceId>/<repositoryId>`, after checking both ids. */
  static cloneDir(baseDir: string, workspaceId: string, repositoryId: string): string {
    return join(
      resolve(baseDir),
      checkId('workspaceId', workspaceId),
      checkId('repositoryId', repositoryId),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Running git

  #clean(text: string): string {
    let out = redactSecrets(text, this.#secrets);
    out = out.replace(/(Authorization:)[^\r\n]*/gi, '$1 [redacted]');
    out = out.replace(/:\/\/[^/@\s]+@/g, '://[redacted]@');
    return out.split(this.#baseDir).join('<clones>');
  }

  #env(network: boolean): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of [...PASS_ENV, ...this.#passEnv]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, {
      HOME: this.#baseDir,
      LC_ALL: 'C',
      LANG: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_ATTR_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      // Reads never go to the network: an object that is not here is reported as missing, and
      // the caller decides to fetch it in a batch. The unknown protocol name blocks every
      // transport for git versions that do not know GIT_NO_LAZY_FETCH.
      GIT_NO_LAZY_FETCH: '1',
      GIT_ALLOW_PROTOCOL: 'kiln-offline',
    });
    if (network) {
      delete env.GIT_NO_LAZY_FETCH;
      env.GIT_ALLOW_PROTOCOL = this.#protocols;
    }
    return env;
  }

  /** The token as `http.<url>.extraheader`, in the environment only. Empty without a token. */
  async #authEnv(): Promise<Record<string, string>> {
    if (this.#source.type !== 'github' || this.#token === undefined) return {};
    const token = typeof this.#token === 'function' ? await this.#token() : this.#token;
    if (!token) return {};
    if (!/^[\x21-\x7e]+$/.test(token)) {
      throw new GithubError('invalid_input', 'The token contains characters a token cannot have.');
    }
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
    const header = `Authorization: Basic ${encoded}`;
    for (const secret of [token, encoded, header]) this.#secrets.add(secret);
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${this.#urlPrefix}.extraheader`,
      GIT_CONFIG_VALUE_0: header,
    };
  }

  async #git(args: string[], o: GitCall): Promise<RunResult> {
    const env = this.#env(o.network === true);
    if (o.network) Object.assign(env, await this.#authEnv());
    const signals = [this.#abort.signal];
    if (o.signal) signals.push(o.signal);
    return runGit({
      args: [...this.#hardening, ...(o.init ? [] : [`--git-dir=${this.dir}`]), ...args],
      env,
      cwd: this.#baseDir,
      ...(o.input !== undefined ? { input: o.input } : {}),
      timeoutMs: o.network ? this.#fetchTimeoutMs : this.#timeoutMs,
      maxStdout: o.maxStdout ?? 1024 * 1024,
      ...(o.truncate ? { truncate: true } : {}),
      signal: AbortSignal.any(signals),
      gitPath: this.#gitPath,
      children: this.#children,
      what: o.what,
    });
  }

  /** Like `#git`, but a non-zero exit is an error with a safe message. */
  async #gitOk(
    args: string[],
    o: GitCall,
    where: Where = { label: this.#label },
  ): Promise<RunResult> {
    const result = await this.#git(args, o);
    if (result.code !== 0) throw classifyFailure(this.#clean(result.stderr), where);
    return result;
  }

  /**
   * Notes that the clone is in use: the marker's modification time is the "last used" time that
   * idle pruning goes by (`listClones`). At most once per 30 seconds, never waits, never throws.
   */
  #touch(): void {
    const at = Date.now();
    if (at - this.#lastTouch < TOUCH_EVERY_MS) return;
    this.#lastTouch = at;
    const when = new Date(at);
    utimes(join(this.dir, MARKER), when, when).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------------
  // The clone directory (callers hold the lock)

  async #remoteUrl(): Promise<string> {
    if (this.#githubUrl) return this.#githubUrl;
    if (this.#source.type !== 'local') throw new GithubError('invalid_input', 'No source.');
    let real: string;
    try {
      real = await realpath(this.#source.path);
      if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new GitCloneError(
        'not_found',
        'The local repository folder does not exist.',
        undefined,
        404,
      );
    }
    return pathToFileURL(real).href;
  }

  async #healthy(): Promise<boolean> {
    try {
      const r = await this.#git(['rev-parse', '--is-bare-repository'], { what: 'rev-parse' });
      return r.code === 0 && r.stdout.toString('utf8').trim() === 'true';
    } catch {
      return false;
    }
  }

  async #wipe(): Promise<void> {
    const info = await lstat(this.dir).catch(() => undefined);
    if (!info) return;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new GitCloneError('unexpected', 'The clone location is not a folder.', 'not_managed');
    }
    await rm(this.dir, { recursive: true, force: true, maxRetries: 3 });
  }

  async #ensure(): Promise<void> {
    await mkdir(this.#baseDir, { recursive: true, mode: 0o700 });
    const url = await this.#remoteUrl();
    const existing = await readMarker(join(this.dir, MARKER));
    if (existing && existing.url === url && this.#verified) {
      this.#touch();
      return;
    }
    if (existing && existing.url === url && (await this.#healthy())) {
      this.#verified = true;
      this.#touch();
      return;
    }
    if (existing) {
      // One of ours, but for another source or damaged: start again.
      await this.#wipe();
      this.#trees.clear();
      this.#warmed.clear();
      this.#tips.clear();
    } else {
      const entries = await readdir(this.dir).catch(() => undefined);
      if (entries && entries.length > 0) {
        throw new GitCloneError(
          'unexpected',
          'The clone location is not empty and is not a managed clone. Nothing was changed.',
          'not_managed',
        );
      }
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // The marker first: a crash during init leaves a folder we know is ours.
    await writeFile(
      join(this.dir, MARKER),
      JSON.stringify({ version: MARKER_VERSION, url, createdAt: this.#now() }),
      { mode: 0o600 },
    );
    await this.#gitOk(['init', '--bare', '--quiet', '--template=', this.dir], {
      init: true,
      what: 'init',
    });
    // Also in the clone's own config, for a person who runs git inside it by hand. No secret.
    for (const [key, value] of [
      ['remote.origin.url', url],
      ['core.hooksPath', devNull],
      ['gc.auto', '0'],
      ['fetch.fsckObjects', 'true'],
      ['transfer.fsckObjects', 'true'],
    ] as const) {
      await this.#gitOk(['config', key, value], { what: 'config' });
    }
    this.#verified = true;
  }

  // ---------------------------------------------------------------------------------------------
  // Fetching

  async #revParse(ref: string): Promise<string | undefined> {
    const r = await this.#git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      what: 'rev-parse',
    });
    const sha = r.stdout.toString('utf8').trim();
    return r.code === 0 && SHA.test(sha) ? sha : undefined;
  }

  async #hasCommit(sha: string): Promise<boolean> {
    const r = await this.#git(['cat-file', '-e', `${sha}^{commit}`], { what: 'cat-file' });
    return r.code === 0;
  }

  async #fetchSpec(spec: string, where: Where, signal?: AbortSignal): Promise<void> {
    await this.#gitOk(
      [
        'fetch',
        '--quiet',
        '--depth=1',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-show-forced-updates',
        '--recurse-submodules=no',
        ...(this.#filter ? [`--filter=${this.#filter}`] : []),
        'origin',
        spec,
      ],
      { network: true, signal, what: 'fetch' },
      where,
    );
  }

  /** The branch to read when no ref is given. */
  async defaultBranch(options: CloneCallOptions = {}): Promise<string> {
    if (this.#configuredBranch) return this.#configuredBranch;
    const cached = this.#discovered;
    if (cached && this.#now() - cached.at < Math.max(this.#ttl, 0)) return cached.name;
    const name = await raceAbort(
      withLock(this.dir, async () => {
        await this.#ensure();
        const r = await this.#gitOk(['ls-remote', '--symref', 'origin', 'HEAD'], {
          network: true,
          what: 'ls-remote',
        });
        const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout.toString('utf8'));
        if (!match?.[1]) {
          throw new GitCloneError(
            'unexpected',
            `${this.#label} does not say which branch is the default (is it empty?).`,
          );
        }
        return checkRefName(match[1]);
      }),
      options.signal,
    );
    this.#discovered = { name, at: this.#now() };
    return name;
  }

  /**
   * Fetches the tip of a branch or tag (default: the default branch) at depth 1, or one commit
   * by its full sha when the remote allows it. Returns the commit to pass to the read methods.
   * Always fetches; reads fetch only when the last fetch is older than `ttlMs`.
   */
  async refresh(ref?: string, options: CloneCallOptions = {}): Promise<CloneRefreshResult> {
    if (options.signal?.aborted) throw cancelled();
    const name = ref ?? (await this.defaultBranch(options));
    const spec = parseRef(name);
    // One fetch for everyone who asks for the same ref while it runs (two scans or listings of one
    // repository at once). It does not carry one caller's signal: git is stopped when every caller
    // has given up, and a caller that gives up is released at once.
    let shared = this.#sharedRefresh.get(spec.name);
    if (!shared || shared.controller.signal.aborted) {
      const controller = new AbortController();
      const entry: SharedRefresh = {
        controller,
        waiters: 0,
        promise: withLock(this.dir, async () => {
          await this.#ensure();
          return this.#fetchRef(spec, controller.signal);
        }).finally(() => {
          if (this.#sharedRefresh.get(spec.name) === entry) this.#sharedRefresh.delete(spec.name);
        }),
      };
      entry.promise.catch(() => undefined);
      this.#sharedRefresh.set(spec.name, entry);
      shared = entry;
    }
    const entry = shared;
    entry.waiters++;
    const signal = options.signal;
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      entry.waiters--;
      if (entry.waiters === 0) entry.controller.abort();
    };
    signal?.addEventListener('abort', leave, { once: true });
    try {
      return await raceAbort(entry.promise, signal);
    } finally {
      signal?.removeEventListener('abort', leave);
      if (!left) {
        left = true;
        entry.waiters--;
      }
    }
  }

  async #fetchRef(spec: RefSpec, signal?: AbortSignal): Promise<CloneRefreshResult> {
    const where: Where = { label: this.#label, ref: spec.name };
    if (spec.kind === 'commit') {
      if (!(await this.#hasCommit(spec.sha))) {
        await this.#fetchSpec(`${spec.sha}:${localRef('commits', spec.sha)}`, where, signal);
      }
      if (!(await this.#hasCommit(spec.sha))) {
        throw new GitCloneError(
          'not_found',
          `The commit ${spec.sha} could not be fetched from ${this.#label}.`,
          'ref_missing',
          404,
        );
      }
      return { ref: spec.name, commit: spec.sha, changed: false, fetchedAt: this.#now() };
    }
    const kinds = spec.kind === 'any' ? (['heads', 'tags'] as const) : ([spec.kind] as const);
    for (const [index, kind] of kinds.entries()) {
      const local = localRef(kind, spec.name);
      const before = await this.#revParse(local);
      try {
        await this.#fetchSpec(`+refs/${kind}/${spec.name}:${local}`, where, signal);
      } catch (error) {
        const more = index < kinds.length - 1;
        if (error instanceof GitCloneError && error.reason === 'ref_missing') {
          if (more) continue;
          throw new GitCloneError(
            'not_found',
            `There is no branch or tag named ${spec.name} in ${this.#label}.`,
            'ref_missing',
            404,
          );
        }
        throw error;
      }
      const commit = await this.#revParse(local);
      if (!commit) {
        throw new GitCloneError('unexpected', `The fetch of ${spec.name} left no commit behind.`);
      }
      const fetchedAt = this.#now();
      this.#tips.set(`${kind}/${spec.name}`, { commit, fetchedAt });
      if (spec.kind === 'any') this.#tips.set(`any/${spec.name}`, { commit, fetchedAt });
      return { ref: spec.name, commit, changed: before !== commit, fetchedAt };
    }
    throw new GitCloneError(
      'not_found',
      `There is no branch or tag named ${spec.name}.`,
      'ref_missing',
      404,
    );
  }

  /**
   * The commit a ref points to, fetching when there is no copy yet or the copy is older than
   * `ttlMs`. A full sha is returned as is when the clone has it, else fetched.
   */
  async resolve(ref?: string, options: CloneCallOptions = {}): Promise<string> {
    this.#touch();
    const name = ref ?? (await this.defaultBranch(options));
    const spec = parseRef(name);
    if (spec.kind === 'commit') {
      if (await this.#hasCommit(spec.sha)) return spec.sha;
      return (await this.refresh(spec.sha, options)).commit;
    }
    const key = `${spec.kind}/${spec.name}`;
    const tip = this.#tips.get(key);
    if (tip && this.#now() - tip.fetchedAt < this.#ttl) return tip.commit;
    if (this.#ttl === Number.POSITIVE_INFINITY) {
      const kinds = spec.kind === 'any' ? (['heads', 'tags'] as const) : ([spec.kind] as const);
      for (const kind of kinds) {
        const commit = await this.#revParse(localRef(kind, spec.name));
        if (commit) {
          this.#tips.set(key, { commit, fetchedAt: this.#now() });
          return commit;
        }
      }
    }
    let shared = this.#refreshing.get(key);
    if (!shared) {
      // One fetch for everyone who asks at the same time. It does not carry one caller's signal.
      shared = this.refresh(name).finally(() => this.#refreshing.delete(key));
      this.#refreshing.set(key, shared);
    }
    return (await raceAbort(shared, options.signal)).commit;
  }

  /**
   * Same as `resolve`, with the signature of `GithubRepoConnector.resolveCommit`, so a reader can
   * be used where the server asks a connector to name the commit it is about to read.
   */
  resolveCommit(ref?: string, signal?: AbortSignal): Promise<string> {
    return this.resolve(ref, signal ? { signal } : {});
  }

  /** A reader fixed to the commit `ref` points to now. Every call on it sees the same files. */
  async pin(ref?: string, options: CloneCallOptions = {}): Promise<PinnedReader> {
    const commit = await this.resolve(ref, options);
    return {
      commit,
      listFiles: () => this.listFiles(commit),
      readFile: (path) => this.readFile(path, commit),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // RepoConnector (read half)

  async #tree(commit: string, signal?: AbortSignal): Promise<Tree> {
    let pending = this.#trees.get(commit);
    if (pending) {
      this.#trees.delete(commit); // move to the end: the cache keeps the 8 most recently used
    } else {
      pending = this.#readTree(commit).catch((error) => {
        this.#trees.delete(commit);
        throw error;
      });
    }
    this.#trees.set(commit, pending);
    while (this.#trees.size > 8) {
      const oldest = this.#trees.keys().next().value;
      if (oldest === undefined) break;
      this.#trees.delete(oldest);
    }
    return raceAbort(pending, signal);
  }

  async #readTree(commit: string): Promise<Tree> {
    const r = await this.#gitOk(
      ['ls-tree', '-r', '-z', commit],
      { maxStdout: this.#maxListBytes, what: 'ls-tree' },
      { label: this.#label, ref: commit },
    );
    const entries = new Map<string, Entry>();
    for (const record of r.stdout.toString('utf8').split('\0')) {
      if (record === '') continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, oid] = record.slice(0, tab).split(' ');
      // `commit` entries are submodules: not files, and not listed (as the GitHub connector).
      if (type !== 'blob' || !mode || !oid) continue;
      entries.set(record.slice(tab + 1), { mode, oid });
    }
    return { entries, paths: [...entries.keys()].sort() };
  }

  /** Paths of all files at `ref` (default: the default branch). Folders are not listed. */
  async listFiles(ref?: string, options: CloneCallOptions = {}): Promise<string[]> {
    const commit = await this.resolve(ref, options);
    const tree = await this.#tree(commit, options.signal);
    return tree.paths.slice();
  }

  /**
   * The text of a file, or undefined when there is no such file (or it is a symlink: a symlink
   * is never followed). Errors as the GitHub connector: `too_large`, `not_text`, `invalid_input`.
   */
  async readFile(
    path: string,
    ref?: string,
    options: CloneCallOptions = {},
  ): Promise<string | undefined> {
    checkRepoPath(path);
    const commit = await this.resolve(ref, options);
    const tree = await this.#tree(commit, options.signal);
    await this.#warmOnce(commit, tree, options.signal);
    const entry = tree.entries.get(path);
    if (!entry || entry.mode === '120000') return undefined;
    const result = await raceAbort(this.#request(entry.oid), options.signal);
    if (result.kind === 'missing') {
      throw new GitCloneError(
        'unexpected',
        `${path} could not be read from the clone of ${this.#label}.`,
      );
    }
    if (result.kind === 'too_large') {
      throw new GitCloneError(
        'too_large',
        `${path} is ${result.size} bytes, over the ${this.#maxFileBytes} byte limit.`,
        'output_limit',
      );
    }
    try {
      // ignoreBOM keeps a leading BOM, so the text hashes to the same blob it came from.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.data);
    } catch {
      throw new GithubError('not_text', `${path} is not UTF-8 text.`);
    }
  }

  /**
   * Downloads the files at `paths` in one request, so the `readFile` calls that follow are
   * local. Paths that do not exist are skipped. A caller that knows what it will read (a scan
   * reads a handful of files, a listing the metadata folder) should call this first.
   */
  async warm(
    paths: readonly string[],
    ref?: string,
    options: CloneCallOptions = {},
  ): Promise<void> {
    for (const path of paths) checkRepoPath(path);
    const commit = await this.resolve(ref, options);
    const tree = await this.#tree(commit, options.signal);
    const oids = new Set<string>();
    for (const path of paths) {
      const entry = tree.entries.get(path);
      if (entry && entry.mode !== '120000') oids.add(entry.oid);
    }
    await raceAbort(this.#ensurePresent([...oids]), options.signal);
  }

  // ---------------------------------------------------------------------------------------------
  // Binary files, bounded (see blobs.ts). Additive: the text reads above are unchanged.

  /** Every file of a commit with its object id. A symlink is not listed. Sizes are not known without reading. */
  async listBlobEntries(ref?: string, options: CloneCallOptions = {}): Promise<BlobListing> {
    const commit = await this.resolve(ref, options);
    const tree = await this.#tree(commit, options.signal);
    const entries: BlobEntry[] = [];
    for (const path of tree.paths) {
      const entry = tree.entries.get(path);
      if (entry && entry.mode !== '120000')
        entries.push({ path, oid: entry.oid, mode: entry.mode, size: null });
    }
    return { commit, entries };
  }

  /**
   * The first `headBytes` bytes of each file, for reading image headers. Sizes of the blobs that
   * are in the clone are free (`cat-file --batch-check`; a local source copies them all); the ones
   * that are not are fetched a few at a time while the transfer budget lasts. A file over
   * `maxFileBytes` is never read, but a missing one has to be fetched to learn its size, so one
   * chunk of eight can overshoot the budget.
   */
  async readBlobHeads(paths: readonly string[], options: BlobHeadsOptions): Promise<BlobHeads> {
    const signal = options.signal;
    const commit = await this.resolve(options.ref, signal ? { signal } : {});
    const tree = await this.#tree(commit, signal);
    const items = new Map<string, BlobHeadItem>();
    const wanted = new Map<string, string>();
    for (const path of paths) {
      if (items.has(path) || wanted.has(path)) continue;
      const entry = tree.entries.get(path);
      if (!entry || entry.mode === '120000' || !/^[0-9a-f]{40,64}$/.test(entry.oid)) {
        items.set(path, { ok: false, oid: null, reason: 'missing', size: null });
      } else wanted.set(path, entry.oid);
    }
    const oids = [...new Set(wanted.values())];
    const sizes = new Map<string, number | undefined>();
    for (let i = 0; i < oids.length; i += BATCH_MAX) {
      for (const [oid, size] of await raceAbort(this.#check(oids.slice(i, i + BATCH_MAX)), signal))
        sizes.set(oid, size);
    }
    const budget = options.maxTransferBytes;
    const sizesOnly = options.headBytes <= 0;
    let transferred = 0;
    const refused = new Set<string>();
    const absent = oids.filter((oid) => sizes.get(oid) === undefined);
    for (let i = 0; i < absent.length && !sizesOnly; i += 8) {
      const chunk = absent.slice(i, i + 8);
      if (transferred >= budget) {
        for (const oid of chunk) refused.add(oid);
        continue;
      }
      await raceAbort(this.#fetchBlobs(chunk), signal);
      for (const [oid, size] of await raceAbort(this.#check(chunk), signal)) {
        sizes.set(oid, size);
        if (size !== undefined) transferred += size;
      }
    }
    const readable = sizesOnly
      ? []
      : oids.filter((oid) => {
          const size = sizes.get(oid);
          return size !== undefined && size <= options.maxFileBytes && !refused.has(oid);
        });
    const heads = new Map<string, Uint8Array>();
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < readable.length; i = next++) {
        const oid = readable[i] as string;
        const r = await this.#gitOk(['cat-file', 'blob', oid], {
          maxStdout: options.headBytes,
          truncate: true,
          what: 'cat-file',
          ...(signal ? { signal } : {}),
        });
        heads.set(oid, new Uint8Array(r.stdout));
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, readable.length) }, worker));
    for (const [path, oid] of wanted) {
      const size = sizes.get(oid);
      const head = heads.get(oid);
      if (refused.has(oid)) items.set(path, { ok: false, oid, reason: 'budget', size: null });
      else if (size === undefined) {
        items.set(path, { ok: false, oid, reason: sizesOnly ? 'unsized' : 'missing', size: null });
      } else if (size > options.maxFileBytes)
        items.set(path, { ok: false, oid, reason: 'too_large', size });
      else if (sizesOnly) items.set(path, { ok: true, oid, size, head: new Uint8Array(0) });
      else if (head) items.set(path, { ok: true, oid, size, head });
      else items.set(path, { ok: false, oid, reason: 'missing', size });
    }
    return { items, transferredBytes: transferred };
  }

  #warmOnce(commit: string, tree: Tree, signal?: AbortSignal): Promise<void> {
    const select = this.#warm;
    if (!select) return Promise.resolve();
    let pending = this.#warmed.get(commit);
    if (!pending) {
      pending = (async () => {
        const oids = new Set<string>();
        for (const path of select(tree.paths)) {
          const entry = tree.entries.get(path);
          if (entry && entry.mode !== '120000') oids.add(entry.oid);
        }
        await this.#ensurePresent([...oids]);
      })().catch(() => {
        // The read that follows reports the real problem (auth, network); a later one retries.
        this.#warmed.delete(commit);
      });
      this.#warmed.set(commit, pending);
      while (this.#warmed.size > 8) {
        const oldest = this.#warmed.keys().next().value;
        if (oldest === undefined) break;
        this.#warmed.delete(oldest);
      }
    }
    return raceAbort(pending, signal);
  }

  // ---------------------------------------------------------------------------------------------
  // Blobs

  async #check(oids: string[]): Promise<Map<string, number | undefined>> {
    const sizes = new Map<string, number | undefined>();
    if (oids.length === 0) return sizes;
    const r = await this.#gitOk(['cat-file', '--batch-check'], {
      input: `${oids.join('\n')}\n`,
      maxStdout: oids.length * 200 + 1024,
      what: 'cat-file',
    });
    const lines = r.stdout.toString('utf8').split('\n');
    oids.forEach((oid, index) => {
      const parts = (lines[index] ?? '').split(' ');
      const size = Number(parts[2]);
      sizes.set(oid, parts[1] === 'blob' && Number.isFinite(size) ? size : undefined);
    });
    return sizes;
  }

  /** Fetches the blobs a clone lacks, all in one request. */
  async #fetchBlobs(oids: string[]): Promise<void> {
    await withLock(this.dir, async () => {
      await this.#ensure();
      await this.#gitOk(
        [
          '-c',
          'fetch.negotiationAlgorithm=noop',
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-write-fetch-head',
          '--recurse-submodules=no',
          ...(this.#filter ? [`--filter=${this.#filter}`] : []),
          '--stdin',
          'origin',
        ],
        { network: true, input: `${oids.join('\n')}\n`, what: 'fetch' },
      );
    });
  }

  async #ensurePresent(oids: string[]): Promise<Map<string, number | undefined>> {
    const sizes = new Map<string, number | undefined>();
    for (let i = 0; i < oids.length; i += BATCH_MAX) {
      const chunk = oids.slice(i, i + BATCH_MAX);
      const found = await this.#check(chunk);
      const missing = chunk.filter((oid) => found.get(oid) === undefined);
      if (missing.length > 0) {
        await this.#fetchBlobs(missing);
        const again = await this.#check(missing);
        for (const oid of missing) found.set(oid, again.get(oid));
      }
      for (const [oid, size] of found) sizes.set(oid, size);
    }
    return sizes;
  }

  async #loadBlobs(oids: string[]): Promise<Map<string, BlobResult>> {
    const sizes = await this.#ensurePresent(oids);
    const results = new Map<string, BlobResult>();
    const readable: string[] = [];
    let total = 0;
    for (const oid of oids) {
      const size = sizes.get(oid);
      if (size === undefined) results.set(oid, { kind: 'missing' });
      else if (size > this.#maxFileBytes) results.set(oid, { kind: 'too_large', size });
      else {
        readable.push(oid);
        total += size;
      }
    }
    if (readable.length === 0) return results;
    const r = await this.#gitOk(['cat-file', '--batch'], {
      input: `${readable.join('\n')}\n`,
      maxStdout: total + readable.length * 128 + 1024,
      what: 'cat-file',
    });
    const buffer = r.stdout;
    let pos = 0;
    for (const oid of readable) {
      const newline = buffer.indexOf(10, pos);
      if (newline < 0) {
        results.set(oid, { kind: 'missing' });
        continue;
      }
      const header = buffer.toString('latin1', pos, newline).split(' ');
      const size = Number(header[2]);
      if (header[1] !== 'blob' || !Number.isFinite(size)) {
        results.set(oid, { kind: 'missing' });
        pos = newline + 1;
        continue;
      }
      results.set(oid, { kind: 'ok', data: buffer.subarray(newline + 1, newline + 1 + size) });
      pos = newline + 1 + size + 1;
    }
    return results;
  }

  /** Reads asked for in the same turn of the event loop share one fetch and one `cat-file`. */
  #request(oid: string): Promise<BlobResult> {
    return new Promise((resolvePromise, reject) => {
      const waiters = this.#queue.get(oid) ?? [];
      waiters.push({ resolve: resolvePromise, reject });
      this.#queue.set(oid, waiters);
      this.#flushTimer ??= setImmediate(() => {
        void this.#flush();
      });
    });
  }

  async #flush(): Promise<void> {
    const batch = this.#queue;
    this.#queue = new Map();
    this.#flushTimer = undefined;
    const all = [...batch.keys()];
    for (let i = 0; i < all.length; i += BATCH_MAX) {
      const chunk = all.slice(i, i + BATCH_MAX);
      try {
        const results = await this.#loadBlobs(chunk);
        for (const oid of chunk) {
          const result = results.get(oid) ?? { kind: 'missing' as const };
          for (const waiter of batch.get(oid) ?? []) waiter.resolve(result);
        }
      } catch (error) {
        for (const oid of chunk) for (const waiter of batch.get(oid) ?? []) waiter.reject(error);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Housekeeping

  /**
   * Drops pinned-commit refs and unreachable objects (`git gc --prune=now`). Blobs fetched for
   * a commit that is no longer a branch tip go too; they are fetched again if read again.
   */
  async compact(options: CloneCallOptions = {}): Promise<void> {
    await raceAbort(
      withLock(this.dir, async () => {
        await this.#ensure();
        const root = 'refs/kiln/commits';
        const refs = await this.#gitOk(['for-each-ref', '--format=%(refname)', root], {
          what: 'for-each-ref',
        });
        for (const name of refs.stdout.toString('utf8').split('\n')) {
          if (name.startsWith(`${root}/`))
            await this.#gitOk(['update-ref', '-d', name], { what: 'update-ref' });
        }
        await this.#gitOk(['gc', '--prune=now', '--quiet'], {
          network: false,
          what: 'gc',
          signal: options.signal,
        });
      }),
      options.signal,
    );
    this.#trees.clear();
    this.#warmed.clear();
  }

  /** Bytes on disk, for the clone's folder. 0 when there is none. The walk is capped (`cloneSize`). */
  async diskUsage(): Promise<number> {
    return (await cloneSize(this.dir)).bytes;
  }

  /**
   * Deletes the clone. Cancels git processes of this reader that are running, waits for the
   * others, and deletes only a folder inside the base directory that carries our marker.
   * Returns false when there was nothing to delete. The reader can be used again afterwards.
   */
  async remove(): Promise<boolean> {
    this.#abort.abort();
    this.#abort = new AbortController();
    for (const child of this.#children) killTree(child);
    const removed = await removeClone(this.#baseDir, this.#workspaceId, this.#repositoryId);
    this.#trees.clear();
    this.#warmed.clear();
    this.#tips.clear();
    this.#refreshing.clear();
    this.#sharedRefresh.clear();
    this.#discovered = undefined;
    this.#verified = false;
    return removed;
  }
}

// -----------------------------------------------------------------------------------------------
// Removing clones without a reader

/**
 * Deletes one clone. Refuses anything that is not a real folder with our marker directly under
 * `<baseDir>/<workspaceId>/`, resolved through symlinks, so a bad id, a symlink or a folder that
 * is not ours is never deleted. Returns false when there is no such clone.
 */
export async function removeClone(
  baseDir: string,
  workspaceId: string,
  repositoryId: string,
): Promise<boolean> {
  const dir = GitCloneReader.cloneDir(baseDir, workspaceId, repositoryId);
  return withLock(dir, async () => {
    let realBase: string;
    try {
      realBase = await realpath(resolve(baseDir));
    } catch {
      return false;
    }
    const info = await lstat(dir).catch(() => undefined);
    if (!info) return false;
    const refuse = () =>
      new GitCloneError(
        'unexpected',
        'Refusing to delete a folder that is not a managed clone.',
        'not_managed',
      );
    if (info.isSymbolicLink() || !info.isDirectory()) throw refuse();
    const real = await realpath(dir);
    if (!real.startsWith(realBase + sep) || real === realBase) throw refuse();
    if (!(await stat(join(real, MARKER)).catch(() => undefined))) throw refuse();
    await rm(real, { recursive: true, force: true, maxRetries: 3 });
    await rmdir(dirname(real)).catch(() => undefined); // the workspace folder, when now empty
    return true;
  });
}

/** Deletes every clone of a workspace (when the workspace is deleted). Returns how many. */
export async function removeWorkspaceClones(baseDir: string, workspaceId: string): Promise<number> {
  checkId('workspaceId', workspaceId);
  const folder = join(resolve(baseDir), workspaceId);
  const names = await readdir(folder).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (!SAFE_ID.test(name)) continue;
    if (await removeClone(baseDir, workspaceId, name)) removed++;
  }
  return removed;
}

// -----------------------------------------------------------------------------------------------
// Upkeep: what is on disk, how big, when it was last used

/** Most files and folders one size walk visits. A bare shallow clone has a few thousand. */
export const SIZE_WALK_MAX_ENTRIES = 200_000;

export type CloneSize = { bytes: number; entries: number; truncated: boolean };

/**
 * Bytes of the files under `dir`, like `du` (apparent size, symbolic links counted as links and
 * never followed), visiting at most `maxEntries` entries: a bigger folder reports what it found so
 * far with `truncated: true`. Takes no lock: a clone being fetched into is measured as it is.
 */
export async function cloneSize(
  dir: string,
  maxEntries = SIZE_WALK_MAX_ENTRIES,
): Promise<CloneSize> {
  let bytes = 0;
  let entries = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const folder = pending.pop() as string;
    const items = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (++entries > maxEntries) return { bytes, entries: maxEntries, truncated: true };
      const path = join(folder, item.name);
      if (item.isDirectory() && !item.isSymbolicLink()) {
        pending.push(path);
        continue;
      }
      const info = await lstat(path).catch(() => undefined);
      bytes += info?.size ?? 0;
    }
  }
  return { bytes, entries, truncated: false };
}

export type ClonedRepository = {
  workspaceId: string;
  /** The folder name: the repository's id, with `-local` added for the copy of an attached local folder. */
  cloneId: string;
  /** The real path of the clone. */
  dir: string;
  bytes: number;
  /** The size walk stopped at its cap: `bytes` is a lower bound. */
  truncated: boolean;
  /** Epoch milliseconds: when the clone was made. 0 when unknown. */
  createdAt: number;
  /** Epoch milliseconds: the last time a reader used it (the marker's modification time). */
  lastUsedAt: number;
};

/**
 * The managed clones under `baseDir`: real folders that carry our marker, directly under a
 * workspace folder, whose real path is inside the base directory. A symbolic link at either level,
 * a marker that is not a regular file and anything that resolves outside are not listed and are
 * counted in `refused`: nothing here ever follows a link out of the base directory.
 */
export async function listClones(
  baseDir: string,
  options: {
    workspaceId?: string;
    maxEntries?: number;
    /** Measures a clone's folder. Default `cloneSize`; a caller may cache. */
    size?: (dir: string) => Promise<CloneSize>;
  } = {},
): Promise<{ clones: ClonedRepository[]; refused: number }> {
  const clones: ClonedRepository[] = [];
  let refused = 0;
  let realBase: string;
  try {
    realBase = await realpath(resolve(baseDir));
  } catch {
    return { clones, refused };
  }
  const base = resolve(baseDir);
  const workspaces =
    options.workspaceId !== undefined
      ? [checkId('workspaceId', options.workspaceId)]
      : (await readdir(base).catch(() => [] as string[])).filter((name) => SAFE_ID.test(name));
  for (const workspaceId of workspaces) {
    const folder = join(base, workspaceId);
    const info = await lstat(folder).catch(() => undefined);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      refused++;
      continue;
    }
    if (!info.isDirectory()) continue;
    const names = (await readdir(folder).catch(() => [] as string[])).filter((name) =>
      SAFE_ID.test(name),
    );
    for (const cloneId of names) {
      const dir = join(folder, cloneId);
      const own = await lstat(dir).catch(() => undefined);
      if (!own) continue;
      if (own.isSymbolicLink()) {
        refused++;
        continue;
      }
      if (!own.isDirectory()) continue;
      const markerPath = join(dir, MARKER);
      const marker = await lstat(markerPath).catch(() => undefined);
      if (!marker?.isFile()) {
        refused++;
        continue;
      }
      const real = await realpath(dir).catch(() => undefined);
      if (!real?.startsWith(realBase + sep) || real === realBase) {
        refused++;
        continue;
      }
      const parsed = await readMarker(markerPath);
      if (!parsed) {
        refused++;
        continue;
      }
      const size = await (options.size ? options.size(real) : cloneSize(real, options.maxEntries));
      clones.push({
        workspaceId,
        cloneId,
        dir: real,
        bytes: size.bytes,
        truncated: size.truncated,
        createdAt: parsed.createdAt,
        lastUsedAt: Math.max(marker.mtimeMs, 0),
      });
    }
  }
  return { clones, refused };
}

/**
 * Whether something in this process holds or waits for the clone's lock (a fetch, a read of the
 * object store, `compact`, `removeClone`). A clone that is busy must not be pruned. This sees only
 * this process; the grace period of recent use covers the time between two git calls of one request.
 */
export function isCloneBusy(baseDir: string, workspaceId: string, repositoryId: string): boolean {
  return mutexes.has(GitCloneReader.cloneDir(baseDir, workspaceId, repositoryId));
}
