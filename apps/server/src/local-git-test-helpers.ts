import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import type { FileEdit } from './services/local-git.ts';
/**
 * Helpers for the tests of writing to a local clone (ADR 0005): real git repositories made with
 * the git CLI in temp folders, a logging git wrapper and a snapshot of everything a commit on a
 * new branch must not change. Not a test file itself.
 */

const dirs: string[] = [];
export const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mrm-lw-')));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const gitEnv = {
  PATH: process.env.PATH ?? '',
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: 'Dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'Dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
export const git = (cwd: string, ...args: string[]) =>
  execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: gitEnv }).trim();

type Files = Record<string, string>;

function writeAll(dir: string, files: Files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

export function buildRepo(parent: string, name: string, files: Files): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeAll(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

export const FASTLANE: Files = {
  'fastlane/Fastfile': 'lane :release do\nend\n',
  'fastlane/metadata/en-US/name.txt': 'Acme App\n',
  'fastlane/metadata/en-US/subtitle.txt': 'Old subtitle\n',
  'fastlane/metadata/de-DE/subtitle.txt': 'Alter Untertitel\n',
  'README.md': 'hello\n',
};

/** A `gitPath` that logs the folder, the index file and the arguments of every call, then runs the real git. */
export function gitWrapper(): { path: string; calls: () => { cwd: string; args: string; index: string }[] } {
  const dir = scratch();
  const log = join(dir, 'calls.log');
  const path = join(dir, 'git');
  writeFileSync(path, `#!/bin/sh\necho "$PWD|$GIT_INDEX_FILE|$*" >> '${log}'\nexec '${REAL_GIT}' "$@"\n`);
  chmodSync(path, 0o755);
  return {
    path,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [cwd = '', index = '', ...rest] = line.split('|');
              return { cwd, index, args: rest.join('|') };
            })
        : [],
  };
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Everything about a repository that a commit on a new branch must not change. */
export function snapshot(dir: string) {
  const tree: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else tree[`${prefix}${entry.name}`] = `${statSync(full).mtimeMs}:${sha256(readFileSync(full))}`;
    }
  };
  walk(dir, '');
  return {
    status: git(dir, 'status', '--porcelain'),
    head: git(dir, 'rev-parse', 'HEAD'),
    headRef: git(dir, 'symbolic-ref', 'HEAD'),
    index: sha256(readFileSync(join(dir, '.git', 'index'))),
    config: sha256(readFileSync(join(dir, '.git', 'config'))),
    hooks: readdirSync(join(dir, '.git', 'hooks')).sort().join(','),
    workingTree: tree,
    refs: git(dir, 'for-each-ref', '--format=%(refname) %(objectname)'),
  };
}

export function setup(files: Files = FASTLANE) {
  const base = scratch();
  const root = join(base, 'dev');
  mkdirSync(root);
  const dir = buildRepo(root, 'app', files);
  const wrapper = gitWrapper();
  const roots = { roots: [root], excluded: [] as string[] };
  return { base, root, dir, wrapper, roots };
}

export type { FileEdit };

export const SUBTITLE: FileEdit = {
  path: 'fastlane/metadata/en-US/subtitle.txt',
  before: 'Old subtitle\n',
  after: 'New subtitle\n',
};

export const BRANCH = 'mrm/update-subtitle-1234abcd';


/**
 * Runs `fn` with a private system temp folder (`TMPDIR`), so a test can ask "did it leave anything
 * behind" without seeing the temporary folders of other test files that run at the same time.
 */
export async function withPrivateTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mrm-tmp-')));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}
