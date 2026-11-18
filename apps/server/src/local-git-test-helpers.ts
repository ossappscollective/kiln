import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

// ---------------------------------------------------------------------------------------------
// Signing (ADR 0005, "Signing"): throw-away keys made in temp folders, and fake programs.

const which = (name: string): string | undefined => {
  try {
    return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
};
export const SSH_KEYGEN = which('ssh-keygen');
export const SSH_AGENT = which('ssh-agent');
export const SSH_ADD = which('ssh-add');
export const GPG = which('gpg') ?? which('gpg2');
export const GPGCONF = which('gpgconf');

export type SshKey = {
  /** The private key file (0600). */
  key: string;
  /** Its .pub file. */
  pub: string;
  /** An allowed-signers file naming only this key, for `git verify-commit` in the test. */
  signers: string;
  passphrase: string;
};

/** A new ed25519 key in its own temp folder; with a passphrase, locked. Requires ssh-keygen. */
export function sshKey(passphrase = ''): SshKey {
  assert.ok(SSH_KEYGEN, 'ssh-keygen is needed');
  const dir = scratch();
  const key = join(dir, 'id_ed25519');
  execFileSync(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', passphrase, '-C', 'mrm-test-key', '-f', key]);
  const pub = `${key}.pub`;
  const signers = join(dir, 'allowed_signers');
  writeFileSync(signers, `signer@example.com ${readFileSync(pub, 'utf8').trim().split(' ').slice(0, 2).join(' ')}\n`);
  return { key, pub, signers, passphrase };
}

/** `git verify-commit` against one allowed-signers file. Returns whether the signature is good. */
export function sshVerifies(dir: string, commit: string, signers: string): boolean {
  try {
    // The format and program are given here: a repository config under test may say otherwise.
    execFileSync(REAL_GIT, ['-c', 'gpg.format=ssh', '-c', `gpg.ssh.program=${SSH_KEYGEN}`, '-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-commit', commit], {
      cwd: dir,
      env: gitEnv,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

const gpgHomes: string[] = [];
after(() => {
  for (const home of gpgHomes) {
    if (GPGCONF) {
      try {
        execFileSync(GPGCONF, ['--kill', 'gpg-agent'], { env: { PATH: process.env.PATH ?? '', GNUPGHOME: home }, stdio: 'ignore' });
      } catch {
        // No agent was started.
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
});

export type GpgKey = { home: string; fingerprint: string };

/**
 * A keyring in a temp folder with one batch-generated ed25519 key (no passphrase, or `passphrase`),
 * or undefined with a reason when this machine cannot do it. The agent is stopped after
 * generating, so a passphrase is not cached.
 */
export function gpgKey(passphrase?: string): GpgKey | { skip: string } {
  if (!GPG) return { skip: 'gpg is not installed' };
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mrm-gh-')));
  chmodSync(home, 0o700);
  gpgHomes.push(home);
  const env = { PATH: process.env.PATH ?? '', GNUPGHOME: home, LC_ALL: 'C' };
  const params = [
    'Key-Type: EDDSA',
    'Key-Curve: ed25519',
    'Name-Real: MRM Test Signer',
    'Name-Email: signer@example.com',
    'Expire-Date: 0',
    passphrase === undefined ? '%no-protection' : `Passphrase: ${passphrase}`,
    '%commit',
    '',
  ].join('\n');
  try {
    execFileSync(GPG, ['--batch', '--quiet', '--pinentry-mode', 'loopback', '--gen-key'], { env, input: params, stdio: ['pipe', 'pipe', 'pipe'], timeout: 90_000 });
    const listing = execFileSync(GPG, ['--list-secret-keys', '--with-colons'], { env, encoding: 'utf8' });
    const fingerprint = /^fpr:+([0-9A-F]{40}):/m.exec(listing)?.[1];
    if (!fingerprint) return { skip: 'gpg made no key' };
    if (GPGCONF) {
      try {
        execFileSync(GPGCONF, ['--kill', 'gpg-agent'], { env, stdio: 'ignore' });
      } catch {
        // Nothing to stop.
      }
    }
    return { home, fingerprint };
  } catch (error) {
    return { skip: `gpg could not generate a key here (${(error as Error).message.split('\n')[0]})` };
  }
}

/** The fingerprint of the key that signed a gpg-signed commit (VALIDSIG), or undefined when it does not verify. */
export function gpgSigner(dir: string, commit: string, home: string): string | undefined {
  const run = spawnSync(
    REAL_GIT,
    ['-c', 'gpg.format=openpgp', '-c', `gpg.program=${GPG}`, '-c', `gpg.openpgp.program=${GPG}`, 'verify-commit', '--raw', commit],
    { cwd: dir, env: { ...gitEnv, GNUPGHOME: home }, encoding: 'utf8' },
  );
  return /VALIDSIG ([0-9A-F]{40})/.exec(`${run.stdout}${run.stderr}`)?.[1];
}

export type FakeProgram = { path: string; log: string; lines: () => string[] };

/**
 * A program that appends its arguments and a few environment variables to a log, then runs
 * `real` with the same arguments (or `body`, a shell snippet, instead). Not signing itself: it is
 * a stand-in for ssh-keygen or gpg that proves which program ran and with what.
 */
export function fakeProgram(name: string, real: string | undefined, body = ''): FakeProgram {
  const dir = scratch();
  const path = join(dir, name);
  const log = join(dir, 'ran.log');
  writeFileSync(
    path,
    `#!/bin/sh\necho "args:$*" >> '${log}'\necho "home:$HOME" >> '${log}'\necho "sock:\${SSH_AUTH_SOCK-unset}" >> '${log}'\necho "gnupg:\${GNUPGHOME-unset}" >> '${log}'\necho "secret:\${MRM_MASTER_KEY-unset}" >> '${log}'\n${body}${real ? `exec '${real}' "$@"\n` : ''}`,
  );
  chmodSync(path, 0o755);
  return { path, log, lines: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}
