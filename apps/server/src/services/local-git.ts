import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactSecrets, secretStrings } from '@mrm/connectors';

/**
 * Local clones: checking a folder a person wants to attach, and asking its repository a few
 * read-only questions (docs/adr/0005-local-clone-reads.md). Nothing here is reached from a
 * request without the feature being on (MRM_LOCAL_REPO_ROOTS) and the role `repositories.write`.
 *
 * The rules, in the order they are applied to a path:
 * 1. text only: no NUL or control character, absolute, no `..` segment, bounded length;
 * 2. `realpath`: symbolic links are resolved, the result must be a directory;
 * 3. the real path is inside the real path of an allowed root (so a link that leaves a root is refused);
 * 4. it is not inside the server's own data or clone folders;
 * 5. it has a `.git` folder, or a `.git` file (a worktree) whose target is inside a root too.
 * The checks are repeated on every read, because a folder can be swapped for a link later.
 */

export const MAX_LOCAL_PATH_LENGTH = 4096;
export const MAX_LOCAL_BRANCHES = 300;

export type LocalPathProblemCode =
  | 'invalid_path'
  | 'not_found'
  | 'not_accessible'
  | 'not_directory'
  | 'outside_roots'
  | 'data_folder'
  | 'bare_repository'
  | 'not_a_repository';

export type PathCheck =
  | { ok: true; realPath: string; root: string; worktree: boolean }
  | { ok: false; code: LocalPathProblemCode; message: string };

export type LocalRoots = { roots: readonly string[]; excluded: readonly string[] };

/** True when `child` is `parent` or inside it. Both must be absolute and normalised. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const bad = (code: LocalPathProblemCode, message: string): PathCheck => ({ ok: false, code, message });

/** Real paths of the roots that exist, in order. A root that does not exist is skipped. */
async function realRoots(roots: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const root of roots) {
    try {
      found.push(await realpath(root));
    } catch {
      // A drive that is not mounted: nothing can be inside it.
    }
  }
  return found;
}

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

/** The text rules of step 1. Returns the trimmed path, or a problem. No file system access. */
export function checkPathText(input: unknown): { ok: true; path: string } | { ok: false; message: string } {
  if (typeof input !== 'string') return { ok: false, message: 'The path must be text.' };
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    return { ok: false, message: 'The path must not contain control characters or NUL bytes.' };
  }
  const path = input.trim();
  if (path === '') return { ok: false, message: 'Enter the path of a folder.' };
  if (path.length > MAX_LOCAL_PATH_LENGTH) {
    return { ok: false, message: `The path is longer than ${MAX_LOCAL_PATH_LENGTH} characters.` };
  }
  if (!isAbsolute(path)) {
    return { ok: false, message: 'Use an absolute path (starting with / on macOS and Linux). "~" is not expanded.' };
  }
  if (path.split(/[\\/]+/).includes('..')) {
    return { ok: false, message: 'The path must not contain ".." segments.' };
  }
  return { ok: true, path };
}

/**
 * Validates a folder a person wants to read as a local clone. Never runs git. `cfg.roots` empty
 * means the feature is off and is the caller's to report (this returns `outside_roots`).
 */
export async function validateLocalPath(input: unknown, cfg: LocalRoots): Promise<PathCheck> {
  const text = checkPathText(input);
  if (!text.ok) return bad('invalid_path', text.message);

  let real: string;
  try {
    real = await realpath(resolve(text.path));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return bad('not_found', 'That folder does not exist on the server.');
    if (code === 'EACCES' || code === 'EPERM') {
      return bad('not_accessible', 'The server is not allowed to open that folder.');
    }
    return bad('invalid_path', 'That path cannot be resolved.');
  }
  try {
    if (!(await stat(real)).isDirectory()) return bad('not_directory', 'That path is not a folder.');
  } catch {
    return bad('not_accessible', 'The server is not allowed to open that folder.');
  }

  const roots = await realRoots(cfg.roots);
  const root = roots.find((r) => isInside(real, r));
  if (!root) {
    return bad(
      'outside_roots',
      `That folder is not inside an allowed folder. Allowed: ${cfg.roots.join(', ') || 'none'}. Symbolic links are followed before this check.`,
    );
  }

  for (const folder of cfg.excluded) {
    const excluded = await realpath(folder).catch(() => resolve(folder));
    if (isInside(real, excluded)) {
      return bad('data_folder', 'That folder is part of the server’s own data and cannot be used.');
    }
  }
  if (await lstat(join(real, 'mrm-clone.json')).then(() => true, () => false)) {
    return bad('data_folder', 'That folder is a clone managed by this server and cannot be used.');
  }

  const dotGit = await lstat(join(real, '.git')).catch(() => undefined);
  if (!dotGit) {
    const bare =
      (await stat(join(real, 'HEAD')).then((s) => s.isFile(), () => false)) &&
      (await stat(join(real, 'objects')).then((s) => s.isDirectory(), () => false));
    return bad(
      bare ? 'bare_repository' : 'not_a_repository',
      bare
        ? 'That is a bare repository (a server-side repository with no working folder). Use a normal clone.'
        : 'There is no git repository in that folder (no .git). Pick the top folder of a clone.',
    );
  }
  if (dotGit.isSymbolicLink()) {
    return bad('not_a_repository', 'The .git entry in that folder is a symbolic link, which is not accepted.');
  }
  if (dotGit.isDirectory()) {
    if (!(await stat(join(real, '.git', 'HEAD')).then((s) => s.isFile(), () => false))) {
      return bad('not_a_repository', 'The .git folder in that folder is not a git repository.');
    }
    return { ok: true, realPath: real, root, worktree: false };
  }
  if (!dotGit.isFile() || dotGit.size > 4096) {
    return bad('not_a_repository', 'The .git entry in that folder is not a git repository.');
  }
  // A worktree or a submodule: `.git` is a file naming the real git folder. That must be inside a
  // root as well, or a file in an allowed folder could point git at any repository on the machine.
  const pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(await readFile(join(real, '.git'), 'utf8').catch(() => ''));
  if (!pointer?.[1]) return bad('not_a_repository', 'The .git file in that folder is not a git pointer.');
  const target = await realpath(resolve(real, pointer[1])).catch(() => undefined);
  if (!target) return bad('not_a_repository', 'The .git file in that folder points to a folder that does not exist.');
  const targets = [target];
  const common = await readFile(join(target, 'commondir'), 'utf8').catch(() => undefined);
  if (common !== undefined) {
    const commonDir = await realpath(resolve(target, common.trim())).catch(() => undefined);
    if (!commonDir) return bad('not_a_repository', 'The worktree’s main repository is missing.');
    targets.push(commonDir);
  }
  if (!targets.every((t) => roots.some((r) => isInside(t, r)))) {
    return bad(
      'outside_roots',
      'The .git file in that folder points to a repository outside the allowed folders. Attach the main clone instead.',
    );
  }
  return { ok: true, realPath: real, root, worktree: true };
}

// ---------------------------------------------------------------------------------------------
// Branch names and remotes

/** A branch name safe to pass to git as one argument and to put in a ref: no leading dash, no `..`. */
export function isSafeBranchName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    !name.includes('/.') &&
    !name.includes('@{')
  );
}

export type RemoteInfo = { host: string; owner: string; repo: string; github: boolean };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * `host`, `owner` and `repo` of a remote URL: `https://`, `ssh://`, `git://` and the scp form
 * (`git@github.com:acme/app.git`). Credentials in the URL are dropped, never returned. Null for
 * anything else (a local path, `file://`, a URL with more path levels).
 */
export function parseRemoteUrl(url: string): RemoteInfo | null {
  const value = url.trim();
  const named =
    /^(?:https?|git|ssh|git\+ssh|ssh\+git):\/\/(?:[^@/\s]+@)?([^/:@\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(value) ??
    /^(?:[^@/\s:]+@)?([^/:@\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(value);
  if (!named) return null;
  const [, host, owner, repo] = named;
  if (!host || !owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  const lower = host.toLowerCase();
  return { host: lower, owner, repo, github: lower === 'github.com' || lower === 'www.github.com' };
}

// ---------------------------------------------------------------------------------------------
// Read-only git in the user's folder

/**
 * Settings on every git command run in a folder we do not control. They switch off what a
 * repository's own config could make git run: a filesystem monitor, hooks, a pager, an alternate
 * refs command, a credential helper, ssh and askpass programs, an external diff. `status` can
 * also run a clean filter named in the config, so `countUncommitted` empties those for it.
 */
const HARDENING = [
  '--no-pager',
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${devNull}`,
  '-c', 'core.alternateRefsCommand=',
  '-c', 'core.sshCommand=',
  '-c', 'core.askPass=',
  '-c', 'credential.helper=',
  '-c', 'diff.external=',
  '-c', 'core.untrackedCache=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
];

const PASS_ENV = ['PATH', 'SYSTEMROOT', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP'];

/** The environment of every git process in a folder we do not control: an allowlist, then fixed settings. */
function localGitEnv(cwd: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASS_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    HOME: tmpdir(),
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: 'mrm-offline',
    GIT_CEILING_DIRECTORIES: dirname(cwd),
  });
  return env;
}

export type GitResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The program could not run or was stopped: `missing`, `timeout`, `output` (too much), `error`. */
  failed?: 'missing' | 'timeout' | 'output' | 'error';
};

/**
 * Runs git in `cwd` (a validated real path) with an allowlisted environment: no global or system
 * config, no prompts, no network protocols, no locks taken, and discovery limited to `cwd`'s
 * folder. Never throws.
 */
export function runLocalGit(
  gitPath: string,
  cwd: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBytes?: number; extraConfig?: readonly string[] } = {},
): Promise<GitResult> {
  const env = localGitEnv(cwd);
  const extra = (options.extraConfig ?? []).flatMap((entry) => ['-c', entry]);
  return new Promise((done) => {
    execFile(
      gitPath,
      [...HARDENING, ...extra, ...args],
      {
        cwd,
        env,
        timeout: options.timeoutMs ?? 10_000,
        maxBuffer: options.maxBytes ?? 1024 * 1024,
        killSignal: 'SIGKILL',
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (!error) return done({ code: 0, stdout, stderr });
        const exit = (error as { code?: unknown }).code;
        if (typeof exit === 'number') return done({ code: exit, stdout, stderr });
        const failed =
          exit === 'ENOENT'
            ? 'missing'
            : (error as { killed?: boolean }).killed
              ? 'timeout'
              : exit === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                ? 'output'
                : 'error';
        done({ code: null, stdout, stderr, failed });
      },
    );
  });
}

export type GitProblemCode =
  | 'git_missing'
  | 'git_timeout'
  | 'dubious_ownership'
  | 'not_a_repository'
  | 'git_failed'
  | 'no_commits'
  | 'detached_head'
  | 'branch_not_found'
  | 'invalid_branch';

export const DUBIOUS_OWNERSHIP_MESSAGE =
  'git refuses to read this folder because it is owned by a different user than the one running the server (git’s "dubious ownership" protection). Make the server’s user the owner of the folder (chown), or run the server as the folder’s owner. MRM does not add safe.directory exceptions, because that would trust configuration written by another user.';

/** A safe, short message for a failed git call: never git's own text beyond a classification. */
export function gitProblem(result: GitResult): { code: GitProblemCode; message: string } {
  if (result.failed === 'missing') {
    return { code: 'git_missing', message: 'The git program was not found on the server (MRM_GIT_PATH).' };
  }
  if (result.failed === 'timeout') return { code: 'git_timeout', message: 'git took too long to answer for that folder.' };
  if (/dubious ownership/i.test(result.stderr)) {
    return { code: 'dubious_ownership', message: DUBIOUS_OWNERSHIP_MESSAGE };
  }
  if (/not a git repository/i.test(result.stderr)) {
    return { code: 'not_a_repository', message: 'git does not see a repository in that folder.' };
  }
  return { code: 'git_failed', message: 'git could not read that repository.' };
}

export type LocalInspection = {
  realPath: string;
  /** The folder's name, a default name for a local-only repository. */
  folderName: string;
  worktree: boolean;
  /** The branch HEAD is on, or null when HEAD is detached. */
  checkedOutBranch: string | null;
  /** The branch that will be read: the one asked for, else the checked out one. Null when neither exists. */
  branch: string | null;
  /** Local branches, at most MAX_LOCAL_BRANCHES, sorted. */
  branches: string[];
  /** Commit HEAD points to. */
  headSha: string;
  /** Commit the selected branch points to, when there is one. */
  branchSha: string | null;
  remote: RemoteInfo | null;
  /** Files with uncommitted changes (modified, staged or untracked), or null when it could not be counted safely. */
  dirtyCount: number | null;
};

export type InspectOutcome =
  | { ok: true; inspection: LocalInspection }
  | { ok: false; code: GitProblemCode; message: string };

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Asks the repository in `realPath` (already validated by `validateLocalPath`) what branch it is
 * on, its tip, branches, `origin` and how many files have uncommitted changes. Read only:
 * `symbolic-ref`, `rev-parse`, `for-each-ref`, `config --get` and `status --porcelain`, with the
 * settings above.
 */
export async function inspectLocalRepo(input: {
  gitPath: string;
  realPath: string;
  worktree?: boolean;
  branch?: string | undefined;
  /** Skip `status` (a caller that only needs the branches). */
  skipStatus?: boolean;
}): Promise<InspectOutcome> {
  const { gitPath, realPath } = input;
  const run = (args: string[]) => runLocalGit(gitPath, realPath, args);
  const fail = (result: GitResult): InspectOutcome => ({ ok: false, ...gitProblem(result) });

  if (input.branch !== undefined && !isSafeBranchName(input.branch)) {
    return { ok: false, code: 'invalid_branch', message: 'That is not a usable branch name.' };
  }

  const head = await run(['symbolic-ref', '-q', '--short', 'HEAD']);
  let checkedOut: string | null = null;
  if (head.code === 0) {
    const name = head.stdout.trim();
    checkedOut = isSafeBranchName(name) ? name : null;
  } else if (head.code !== 1) {
    return fail(head);
  }

  const headSha = await run(['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  const headValue = headSha.stdout.trim();
  if (headSha.code === 1 || (headSha.code === 0 && !SHA.test(headValue))) {
    return {
      ok: false,
      code: 'no_commits',
      message: 'The repository has no commits yet. Make a first commit, then try again.',
    };
  }
  if (headSha.code !== 0) return fail(headSha);

  const refs = await run([
    'for-each-ref',
    `--count=${MAX_LOCAL_BRANCHES}`,
    '--sort=refname',
    '--format=%(refname:lstrip=2)',
    'refs/heads',
  ]);
  if (refs.code !== 0) return fail(refs);
  const branches = refs.stdout.split('\n').filter((b) => isSafeBranchName(b));

  const wanted = input.branch ?? checkedOut;
  let branchSha: string | null = null;
  if (wanted !== null) {
    const tip = await run(['rev-parse', '--verify', '-q', `refs/heads/${wanted}^{commit}`]);
    const value = tip.stdout.trim();
    if (tip.code === 0 && SHA.test(value)) branchSha = value;
    else if (tip.code !== 1 && tip.code !== 0) return fail(tip);
  }
  if (input.branch !== undefined && branchSha === null) {
    return { ok: false, code: 'branch_not_found', message: `The local repository has no branch named ${input.branch}.` };
  }

  const origin = await run(['config', '--local', '--get', 'remote.origin.url']);
  const remote = origin.code === 0 ? parseRemoteUrl(origin.stdout.split('\n')[0] ?? '') : null;

  const dirtyCount = input.skipStatus ? null : await countUncommitted(gitPath, realPath);

  return {
    ok: true,
    inspection: {
      realPath,
      folderName: basename(realPath),
      worktree: input.worktree ?? false,
      checkedOutBranch: checkedOut,
      branch: branchSha === null ? null : wanted,
      branches,
      headSha: headValue,
      branchSha,
      remote,
      dirtyCount,
    },
  };
}

/**
 * Files with uncommitted changes, counted with `git status --porcelain=v1 -z`. `status` may run
 * the clean filter of a file whose stat data changed, and a filter's command comes from the
 * repository's config, so every configured filter is emptied for this call first. A filter name
 * with a character that cannot be passed safely as a `-c` key means the count is skipped (null).
 * Submodules are not entered. Null when it could not be counted.
 */
export async function countUncommitted(gitPath: string, realPath: string): Promise<number | null> {
  const names = await runLocalGit(gitPath, realPath, ['config', '--local', '--name-only', '--get-regexp', '^filter\\.']);
  const extraConfig: string[] = [];
  if (names.code === 0) {
    for (const line of names.stdout.split('\n')) {
      const text = line.trim();
      if (text === '') continue;
      // filter.<name>.<variable>; the name may contain dots.
      const match = /^filter\.([A-Za-z0-9_.-]+)\.(clean|smudge|process|required)$/i.exec(text);
      if (!match?.[1] || !match[2]) return null;
      const variable = match[2].toLowerCase();
      extraConfig.push(`filter.${match[1]}.${variable}=${variable === 'required' ? 'false' : ''}`);
    }
  } else if (names.code !== 1) {
    return null;
  }
  const status = await runLocalGit(
    gitPath,
    realPath,
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all', '--no-renames'],
    { timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024, extraConfig },
  );
  if (status.code !== 0) return null;
  return status.stdout.split('\0').filter((entry) => entry !== '').length;
}

// ---------------------------------------------------------------------------------------------
// Writing: a commit on a new branch, without touching the working tree
//
// docs/adr/0005-local-clone-reads.md ("Writing to a local clone"). Everything here is plumbing
// that creates objects and exactly one ref under refs/heads/. The person's working tree, index,
// HEAD, current branch, hooks and configuration are never changed.

/** Settings added to every git command that writes: nothing may sign, split the index or sparse-expand. */
const WRITE_CONFIG = [
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'core.splitIndex=false',
  'index.sparse=false',
  'core.sparseCheckout=false',
  'i18n.commitEncoding=UTF-8',
];

export type RawGitResult = {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  failed?: 'missing' | 'timeout' | 'output' | 'error';
};

type RawOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  extraConfig?: readonly string[];
  input?: string | Buffer;
  /** Set after the allowlisted environment, so it can only be a variable we chose to set. */
  env?: Record<string, string>;
  /** Pass the proxy and certificate variables of the server (network commands). */
  network?: boolean;
  /** Run against this git directory instead of discovering one from `cwd`. */
  gitDir?: string;
};

const NETWORK_ENV = [
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

const STDERR_CAP = 16 * 1024;

/**
 * `runLocalGit` with input on stdin, a binary stdout, extra environment, and a timeout that kills
 * the whole process group (a push runs a helper). Same hardening and environment. Never throws.
 */
export function runGitRaw(
  gitPath: string,
  cwd: string,
  args: readonly string[],
  options: RawOptions = {},
): Promise<RawGitResult> {
  const env = localGitEnv(cwd);
  if (options.network) {
    for (const key of NETWORK_ENV) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  Object.assign(env, options.env ?? {});
  const extra = (options.extraConfig ?? []).flatMap((entry) => ['-c', entry]);
  const gitDir = options.gitDir === undefined ? [] : [`--git-dir=${options.gitDir}`];
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(gitPath, [...gitDir, ...HARDENING, ...extra, ...args], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      return done({ code: null, stdout: Buffer.alloc(0), stderr: '', failed: 'missing' });
    }
    const out: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let failed: RawGitResult['failed'];
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      failed ??= 'timeout';
      kill();
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failed ??= 'output';
        kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8').slice(0, STDERR_CAP);
    });
    child.stdin?.on('error', () => {
      // git stopped reading; the exit code says why.
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failed ??= error.code === 'ENOENT' ? 'missing' : 'error';
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      if (failed) return done({ code: null, stdout, stderr, failed });
      done({ code: code ?? null, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

const asText = (result: RawGitResult): GitResult => ({
  code: result.code,
  stdout: result.stdout.toString('utf8'),
  stderr: result.stderr,
  ...(result.failed ? { failed: result.failed } : {}),
});

/** A path inside the repository, by the rules of the GitHub connector: no leading slash, no `.`, `..` or `.git` segment. */
export function isSafeRepoPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path !== '' &&
    path.length <= 1024 &&
    !/[\u0000-\u001f\u007f\\]/.test(path) &&
    !path.startsWith('/') &&
    !path.split('/').some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git')
  );
}

export const MAX_BRANCH_LENGTH = 200;

/**
 * The name of a branch to create. Stricter than git: ASCII letters, digits and `._-/`, a letter,
 * digit or `_` first (so it can never be an option), no `..`, `//`, `@{`, `/.`, trailing `/`, `.`
 * or `.lock`, no `.lock` segment, not `HEAD`, not starting with `refs/`, at most 200 characters.
 * It is always used as `refs/heads/<name>`.
 */
export function checkNewBranchName(name: unknown): { ok: true; name: string } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (typeof name !== 'string') return bad('The branch name must be text.');
  if (/[\u0000-\u001f\u007f]/.test(name)) return bad('The branch name must not contain control characters.');
  if (name === '') return bad('Enter a branch name.');
  if (name.length > MAX_BRANCH_LENGTH) return bad(`The branch name is longer than ${MAX_BRANCH_LENGTH} characters.`);
  if (name.startsWith('-')) return bad('The branch name must not start with "-".');
  if (name === 'HEAD' || name === '@' || name.startsWith('refs/')) {
    return bad('That branch name is reserved. Pick a name such as mrm/update-listing.');
  }
  if (name.includes('..')) return bad('The branch name must not contain "..".');
  if (name.includes('@{')) return bad('The branch name must not contain "@{".');
  if (name.split('/').some((segment) => segment.endsWith('.lock'))) {
    return bad('A part of the branch name must not end in ".lock".');
  }
  if (!isSafeBranchName(name)) {
    return bad('Use letters, digits and . _ - / only, starting with a letter or digit, without "//", "/." or a trailing "/" or ".".');
  }
  return { ok: true, name };
}

export type CommitIdentity = { name: string; email: string };

const IDENTITY_FALLBACK: CommitIdentity = { name: 'Mobile Release Manager', email: 'noreply@localhost' };

/** A name and email that are safe in a commit header: one line, no `<`, `>` or control characters. */
export function cleanIdentity(identity: Partial<CommitIdentity> | undefined): CommitIdentity {
  const name = (identity?.name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  const email = (identity?.email ?? '').trim();
  const emailOk = email.length <= 200 && /^[^\s<>@\u0000-\u001f\u007f]+@[^\s<>@\u0000-\u001f\u007f]+$/.test(email);
  return {
    name: name === '' ? IDENTITY_FALLBACK.name : name,
    email: emailOk ? email : IDENTITY_FALLBACK.email,
  };
}

/** One file of a change set, as stored: absent `before` means the file is new, absent `after` that it is deleted. */
export type FileEdit = { path: string; before?: string; after?: string };

export type BranchCommitInput = {
  gitPath: string;
  /** The folder as stored. It is validated again here, immediately before anything is written. */
  path: string;
  roots: LocalRoots;
  /** The local branch the change set is applied on top of. Its tip is the commit's parent. */
  baseBranch: string;
  /** The branch to create under refs/heads/. */
  branch: string;
  files: readonly FileEdit[];
  message: string;
  author: CommitIdentity;
  /** Epoch milliseconds for the author and committer dates. */
  now: number;
  /** Epoch milliseconds after which nothing more is started (checked before the ref is written). */
  deadline?: number;
};

export type BranchCommitProblemCode =
  | LocalPathProblemCode
  | GitProblemCode
  | 'branch_exists'
  | 'base_changed'
  | 'invalid_file_path'
  | 'unsupported_entry'
  | 'path_conflict'
  | 'no_changes'
  | 'too_large'
  | 'timeout';

export type BranchCommitOutcome =
  | { ok: true; commit: string; tree: string; base: string; changed: number; skipped: number }
  | { ok: false; code: BranchCommitProblemCode; message: string; paths?: string[] };

const MIB = 1024 * 1024;

type TreeEntry = { mode: string; type: string; oid: string };

/** `git ls-tree -r -z`: path to mode, type and object id. */
function parseLsTree(buffer: Buffer): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const record of buffer.toString('utf8').split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    if (mode && type && oid) entries.set(record.slice(tab + 1), { mode, type, oid });
  }
  return entries;
}

/** `git cat-file --batch`: object id to its bytes (absent when git said missing). */
function parseCatBatch(buffer: Buffer): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  let at = 0;
  while (at < buffer.length) {
    const eol = buffer.indexOf(0x0a, at);
    if (eol < 0) break;
    const [oid, type, size] = buffer.toString('utf8', at, eol).split(' ');
    at = eol + 1;
    if (!oid || type === 'missing') continue;
    const length = Number(size);
    if (!Number.isInteger(length) || length < 0) break;
    found.set(oid, buffer.subarray(at, at + length));
    at += length + 1;
  }
  return found;
}

/**
 * Commits `files` on top of the tip of `baseBranch` as a new branch `branch`, in the repository
 * at `path`, and returns the commit. What happens, in order:
 *
 * 1. the folder is validated again (real path inside an allowed root, `.git` rules);
 * 2. the base is the tip of `refs/heads/<baseBranch>`; the new branch must not exist;
 * 3. every changed file is compared with the base: the blob there must be the `before` text (or
 *    absent for a new file); anything else is `base_changed` and nothing is written;
 * 4. the blobs are written (`hash-object -w --no-filters`: no filter, no line-ending conversion),
 *    the tree is built in a private temporary index (`GIT_INDEX_FILE` in a new folder under the
 *    system temp folder: `read-tree`, `update-index --index-info`, `write-tree`), the commit with
 *    `commit-tree` (parent: the base, never signed), and the branch with
 *    `update-ref refs/heads/<branch> <commit> <zero id>`, which can only create it.
 *
 * Never run here: checkout, switch, reset, add, commit, merge, stash, clean, push or anything else
 * that reads or writes the working tree, the person's index, HEAD or hooks. A failure before
 * `update-ref` leaves only unreachable objects, which `git gc` removes.
 */
export async function createBranchCommit(input: BranchCommitInput): Promise<BranchCommitOutcome> {
  const fail = (code: BranchCommitProblemCode, message: string, paths?: string[]): BranchCommitOutcome => ({
    ok: false,
    code,
    message,
    ...(paths ? { paths } : {}),
  });
  const named = checkNewBranchName(input.branch);
  if (!named.ok) return fail('invalid_branch', named.message);
  if (!isSafeBranchName(input.baseBranch)) return fail('invalid_branch', 'The local branch has a name that cannot be used.');
  for (const file of input.files) {
    if (!isSafeRepoPath(file.path)) return fail('invalid_file_path', `Not a valid repository path: ${JSON.stringify(file.path)}.`);
  }
  if (new Set(input.files.map((f) => f.path)).size !== input.files.length) {
    return fail('invalid_file_path', 'A path appears twice in the change set.');
  }
  const author = cleanIdentity(input.author);
  const expired = () => input.deadline !== undefined && Date.now() > input.deadline;
  const tooSlow = () => fail('timeout', 'Writing the commit took too long and was stopped before anything was changed.');

  // 1. The folder, now.
  const check = await validateLocalPath(input.path, input.roots);
  if (!check.ok) return fail(check.code, check.message);
  const cwd = check.realPath;
  const run = (args: string[], options: RawOptions = {}) =>
    runGitRaw(input.gitPath, cwd, args, { extraConfig: WRITE_CONFIG, ...options });
  const problem = (result: RawGitResult) => {
    const p = gitProblem(asText(result));
    return fail(p.code, p.message);
  };

  // 2. The base, and a branch that does not exist. The length of the base's id says SHA-1 or SHA-256.
  const base = await run(['rev-parse', '--verify', '-q', `refs/heads/${input.baseBranch}^{commit}`]);
  const baseSha = base.stdout.toString('utf8').trim();
  if (base.code === 1) return fail('branch_not_found', `The local repository has no branch named ${input.baseBranch} any more.`);
  if (base.code !== 0) return problem(base);
  if (!SHA.test(baseSha)) return fail('git_failed', 'git could not read that repository.');
  const zero = '0'.repeat(baseSha.length);
  const ref = `refs/heads/${named.name}`;
  const taken = await run(['rev-parse', '--verify', '-q', ref]);
  if (taken.code === 0) return fail('branch_exists', `A branch named ${named.name} already exists in the local clone. Pick another name.`);
  if (taken.code !== 1) return problem(taken);
  if (expired()) return tooSlow();

  // 3. What the base holds at the changed paths.
  const listing = await run(['ls-tree', '-r', '-z', '--full-tree', baseSha], { maxBytes: 64 * MIB, timeoutMs: 60_000 });
  if (listing.failed === 'output') return fail('too_large', 'The repository has too many files to list.');
  if (listing.code !== 0) return problem(listing);
  const tree = parseLsTree(listing.stdout);
  const directories = new Set<string>();
  for (const path of tree.keys()) {
    for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) {
      directories.add(path.slice(0, slash));
    }
  }
  const wanted = new Map<string, TreeEntry>();
  for (const file of input.files) {
    const entry = tree.get(file.path);
    if (entry) wanted.set(file.path, entry);
  }
  const unsupported = [...wanted]
    .filter(([, e]) => e.type !== 'blob' || e.mode === '120000' || e.mode === '160000')
    .map(([p]) => p);
  if (unsupported.length > 0) {
    return fail('unsupported_entry', 'Some of these files are a symbolic link or a submodule in the local clone, which cannot be edited here.', unsupported.slice(0, 50));
  }
  const conflicts: string[] = [];
  for (const file of input.files) {
    if (file.after === undefined) continue;
    const parts = file.path.split('/');
    let underFile = false;
    for (let i = 1; i < parts.length; i += 1) if (tree.has(parts.slice(0, i).join('/'))) underFile = true;
    if (underFile || directories.has(file.path)) conflicts.push(file.path);
  }
  if (conflicts.length > 0) {
    return fail('path_conflict', 'A file of the change set would replace a folder, or sit under a file, in the local clone.', conflicts.slice(0, 50));
  }

  const blobIds = [...new Set([...wanted.values()].map((e) => e.oid))];
  let contents = new Map<string, Buffer>();
  if (blobIds.length > 0) {
    const cat = await run(['cat-file', '--batch'], { input: `${blobIds.join('\n')}\n`, maxBytes: 128 * MIB, timeoutMs: 60_000 });
    if (cat.failed === 'output') return fail('too_large', 'The files to change are too large.');
    if (cat.code !== 0) return problem(cat);
    contents = parseCatBatch(cat.stdout);
  }
  const same = (entry: TreeEntry | undefined, text: string | undefined): boolean => {
    if (!entry || text === undefined) return false;
    const blob = contents.get(entry.oid);
    return blob !== undefined && blob.equals(Buffer.from(text, 'utf8'));
  };

  const plan: { path: string; mode: string; content?: string }[] = [];
  const differing: string[] = [];
  let skipped = 0;
  for (const file of input.files) {
    const entry = wanted.get(file.path);
    if (file.after === undefined) {
      if (!entry) skipped += 1; // already gone
      else if (file.before !== undefined && !same(entry, file.before)) differing.push(file.path);
      else plan.push({ path: file.path, mode: entry.mode });
      continue;
    }
    if (same(entry, file.after)) skipped += 1; // already has this text
    else if (file.before === undefined ? entry !== undefined : !same(entry, file.before)) differing.push(file.path);
    else plan.push({ path: file.path, mode: entry?.mode ?? '100644', content: file.after });
  }
  if (differing.length > 0) {
    return fail(
      'base_changed',
      `These files are not what the change set was made from on branch ${input.baseBranch} of the local clone: they changed after it was created. Nothing was written. Discard this change set and create a new one.`,
      differing.sort().slice(0, 50),
    );
  }
  if (plan.length === 0) return fail('no_changes', 'Nothing to commit: the local branch already has these changes.');
  if (expired()) return tooSlow();

  // 4. Blobs, the tree in a private index, the commit, the branch.
  const blobs = new Map<string, string>();
  const queue = plan.filter((p) => p.content !== undefined);
  let failure: BranchCommitOutcome | undefined;
  const worker = async () => {
    for (let item = queue.shift(); item && !failure; item = queue.shift()) {
      const made = await run(['hash-object', '-w', '--no-filters', '-t', 'blob', '--stdin'], {
        input: Buffer.from(item.content ?? '', 'utf8'),
      });
      const oid = made.stdout.toString('utf8').trim();
      if (made.code !== 0 || oid.length !== baseSha.length || !SHA.test(oid)) failure ??= problem(made);
      else blobs.set(item.path, oid);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, queue.length)) }, worker));
  if (failure) return failure;

  const scratch = await mkdtemp(join(tmpdir(), 'mrm-index-'));
  try {
    const indexEnv = { GIT_INDEX_FILE: join(scratch, 'index') };
    const read = await run(['read-tree', baseSha], { env: indexEnv });
    if (read.code !== 0) return problem(read);
    const info = plan
      .map((p) => {
        const oid = blobs.get(p.path);
        return oid === undefined ? `0 ${zero}\t${p.path}\0` : `${p.mode} ${oid}\t${p.path}\0`;
      })
      .join('');
    const updated = await run(['update-index', '--add', '-z', '--index-info'], { env: indexEnv, input: info });
    if (updated.code !== 0) return problem(updated);
    const written = await run(['write-tree'], { env: indexEnv });
    const treeSha = written.stdout.toString('utf8').trim();
    if (written.code !== 0 || !SHA.test(treeSha)) return problem(written);

    const when = `${Math.floor(input.now / 1000)} +0000`;
    const committed = await run(['commit-tree', treeSha, '-p', baseSha, '-F', '-'], {
      input: `${input.message.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n`,
      env: {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
        GIT_COMMITTER_DATE: when,
      },
    });
    const commitSha = committed.stdout.toString('utf8').trim();
    if (committed.code !== 0 || !SHA.test(commitSha)) return problem(committed);
    if (expired()) return tooSlow();

    // The only write to a ref: creating the branch. The old value must be the zero id, so an
    // existing branch (or one made a moment ago by someone else) is never moved.
    const moved = await run(['update-ref', '-m', 'mrm: commit change set', ref, commitSha, zero]);
    if (moved.code !== 0) {
      const now = await run(['rev-parse', '--verify', '-q', ref]);
      if (now.code === 0 || /cannot lock ref|already exists|exists; cannot create/i.test(moved.stderr)) {
        return fail('branch_exists', `A branch named ${named.name} already exists in the local clone, or conflicts with one. Pick another name.`);
      }
      return problem(moved);
    }
    return { ok: true, commit: commitSha, tree: treeSha, base: baseSha, changed: plan.length, skipped };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Pushing the commit

export type PushProblemCode =
  | LocalPathProblemCode
  | GitProblemCode
  | 'push_auth'
  | 'push_rejected'
  | 'push_declined'
  | 'push_not_found'
  | 'push_network'
  | 'push_timeout'
  | 'push_failed'
  | 'commit_missing'
  | 'invalid_url'
  | 'invalid_token';

export type PushInput = {
  gitPath: string;
  /** The folder as stored. It is validated again here. */
  path: string;
  roots: LocalRoots;
  /** The commit to push (a full object id that exists in the repository). */
  commit: string;
  /** The branch to create on the remote: refs/heads/<branch>. */
  branch: string;
  /** The remote, always given in full (never the repository's configured remote). */
  url: string;
  /** Sent as HTTP Basic `x-access-token:<token>` for this URL only. */
  token?: string;
  /** `https` unless a test uses a local stub (`http`) or a bare repository (`file`). */
  protocol?: 'https' | 'http' | 'file';
  timeoutMs?: number;
};

export type PushOutcome =
  | { ok: true; upToDate: boolean }
  | { ok: false; code: PushProblemCode; message: string };

const PUSH_MESSAGES: Record<string, string> = {
  push_auth: 'GitHub refused the credential for this push. Check that the token or app can write to the repository (contents: write).',
  push_rejected: 'GitHub rejected the push because the branch already exists there with other history. Choose another branch name, or delete that branch on GitHub.',
  push_declined: 'GitHub declined the push (for example a branch protection or push rule).',
  push_not_found: 'GitHub could not find the repository, or the credential cannot see it.',
  push_network: 'Could not reach GitHub to push. Try again in a moment.',
  push_timeout: 'The push took too long and was stopped. The commit is still in the local clone; try again.',
  push_failed: 'The push did not work.',
  commit_missing: 'The commit is not in the local clone any more (it may have been pruned).',
};

/** Classifies what `git push` printed. The text is not returned: only a fixed message per class. */
export function classifyPush(result: RawGitResult): { code: PushProblemCode; message: string } {
  if (result.failed === 'missing') {
    return { code: 'git_missing', message: 'The git program was not found on the server (MRM_GIT_PATH).' };
  }
  const pick = (code: PushProblemCode) => ({ code, message: PUSH_MESSAGES[code] ?? 'The push did not work.' });
  if (result.failed === 'timeout') return pick('push_timeout');
  const text = `${result.stderr}\n${result.stdout.toString('utf8')}`;
  if (/Authentication failed|could not read (Username|Password)|returned error: 40[13]|Permission to .* denied|invalid credentials|Bad credentials/i.test(text)) {
    return pick('push_auth');
  }
  if (/protected branch|GH00\d|declined|pre-receive hook/i.test(text)) return pick('push_declined');
  if (/non-fast-forward|fetch first|\[rejected\]|\(stale info\)|already exists/i.test(text)) return pick('push_rejected');
  if (/returned error: 404|Repository not found|not found/i.test(text)) return pick('push_not_found');
  if (/Could not resolve host|unable to access|Failed to connect|timed out|Connection (refused|reset)|SSL|TLS|Couldn't connect/i.test(text)) {
    return pick('push_network');
  }
  return pick('push_failed');
}

/** Removes the token (and its encodings), Authorization lines, URL credentials and the folders we named. */
export function scrubPushText(text: string, secrets: readonly string[], paths: readonly string[]): string {
  let out = redactSecrets(text, secrets.flatMap((s) => secretStrings(s)));
  out = out.replace(/(Authorization:)[^\r\n]*/gi, '$1 [redacted]');
  out = out.replace(/:\/\/[^/@\s]+@/g, '://[redacted]@');
  for (const path of paths) if (path.length > 1) out = out.split(path).join('<folder>');
  return out;
}

/**
 * Pushes one commit as a new branch to `url`, from the repository at `path`, without running
 * anything that belongs to that repository. `git push` run inside a person's clone would read its
 * config (remotes, `url.<x>.insteadOf`, credential helpers, `core.sshCommand`) and run its hooks.
 * So the push runs in a private, empty bare repository made for the purpose, whose
 * `objects/info/alternates` names the clone's object folder (read only): git finds the commit and
 * its history there and reads no other file of the clone.
 *
 * - The remote is `url`, never a configured one. Only `https` is allowed (`GIT_ALLOW_PROTOCOL`); a
 *   test may name `http` for a local stub or `file` for a bare repository.
 * - The token goes in the environment of the one process, as `http.<url>.extraheader`, scoped to
 *   that URL, with redirects off. It is not in argv or in a file, and what git printed is
 *   redacted before it is looked at; the result carries a fixed message per class, not git's text.
 * - The refspec is `<commit>:refs/heads/<branch>`: no `+`, no delete, no tags, no `--all` or
 *   `--mirror`. A branch that exists with other history is rejected by the remote, never forced.
 *   No hook runs (`--no-verify`, an empty template, `core.hooksPath` off).
 */
export async function pushBranchCommit(input: PushInput): Promise<PushOutcome> {
  const fail = (code: PushProblemCode, message: string): PushOutcome => ({ ok: false, code, message });
  const named = checkNewBranchName(input.branch);
  if (!named.ok) return fail('git_failed', named.message);
  if (!SHA.test(input.commit)) return fail('commit_missing', PUSH_MESSAGES.commit_missing ?? '');
  const protocol = input.protocol ?? 'https';
  let url: URL | undefined;
  try {
    url = protocol === 'file' && isAbsolute(input.url) ? new URL(`file://${input.url}`) : new URL(input.url);
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== `${protocol}:` || url.username || url.password || url.search || url.hash) {
    return fail('invalid_url', 'The push address is not valid.');
  }
  if (input.token !== undefined && !/^[\x21-\x7e]+$/.test(input.token)) {
    return fail('invalid_token', 'The token contains characters a token cannot have.');
  }

  const check = await validateLocalPath(input.path, input.roots);
  if (!check.ok) return fail(check.code, check.message);
  const cwd = check.realPath;
  const secrets: string[] = [];
  const env: Record<string, string> = { GIT_ALLOW_PROTOCOL: protocol, GIT_TERMINAL_PROMPT: '0' };
  if (input.token !== undefined && input.token !== '' && protocol !== 'file') {
    const encoded = Buffer.from(`x-access-token:${input.token}`).toString('base64');
    const header = `Authorization: Basic ${encoded}`;
    secrets.push(input.token, encoded, header);
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${url.origin}/.extraheader`,
      GIT_CONFIG_VALUE_0: header,
    });
  }

  // The commit must exist in the clone, and its object folder must be inside the allowed root.
  const exists = await runLocalGit(input.gitPath, cwd, ['rev-parse', '--verify', '-q', `${input.commit}^{commit}`]);
  if (exists.code === 1) return fail('commit_missing', PUSH_MESSAGES.commit_missing ?? '');
  if (exists.code !== 0) {
    const p = gitProblem(exists);
    return fail(p.code, p.message);
  }
  const where = await runLocalGit(input.gitPath, cwd, ['rev-parse', '--git-path', 'objects']);
  if (where.code !== 0) {
    const p = gitProblem(where);
    return fail(p.code, p.message);
  }
  const objects = await realpath(resolve(cwd, where.stdout.trim())).catch(() => undefined);
  if (!objects || !isInside(objects, check.root)) {
    return fail('outside_roots', 'The object folder of that repository is outside the allowed folders.');
  }

  const scratch = await mkdtemp(join(tmpdir(), 'mrm-push-'));
  try {
    const bare = join(scratch, 'repo.git');
    const init = await runGitRaw(input.gitPath, scratch, ['init', '--bare', '-q', '--template=', bare]);
    if (init.code !== 0) {
      const p = gitProblem(asText(init));
      return fail(p.code, p.message);
    }
    await writeFile(join(bare, 'objects', 'info', 'alternates'), `${objects}\n`, { mode: 0o600 });
    const pushed = await runGitRaw(
      input.gitPath,
      scratch,
      ['push', '--porcelain', '--no-verify', '--no-recurse-submodules', '--', url.toString(), `${input.commit}:refs/heads/${named.name}`],
      {
        gitDir: bare,
        network: true,
        env,
        timeoutMs: input.timeoutMs ?? 60_000,
        extraConfig: ['http.followRedirects=false', 'push.recurseSubmodules=no', 'push.gpgSign=false'],
      },
    );
    if (pushed.code === 0 && !pushed.failed) {
      return { ok: true, upToDate: /^=\t/m.test(pushed.stdout.toString('utf8')) };
    }
    const clean = (value: string) => scrubPushText(value, secrets, [scratch, cwd, objects]);
    return {
      ok: false,
      ...classifyPush({ ...pushed, stderr: clean(pushed.stderr), stdout: Buffer.from(clean(pushed.stdout.toString('utf8'))) }),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
