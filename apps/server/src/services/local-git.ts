import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
