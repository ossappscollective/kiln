import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  loadConfig,
  MAX_LOCAL_REPO_ROOTS,
  parseByteSize,
  parseGitSigning,
  parseLocalRepoRoots,
} from './config.ts';

const key = randomBytes(32).toString('base64');

// The defaults depend on which folders exist in the working directory (an old `.kiln-data` is kept in use), so tests that
// assert them say what exists.
const nothing = () => false;

test('defaults are usable with only a master key', () => {
  const config = loadConfig({ KILN_MASTER_KEY: key }, nothing);
  assert.equal(config.port, 8787);
  assert.equal(config.databaseUrl, 'file:./.kiln-data/kiln.db');
  assert.equal(config.masterKey.length, 32);
});

test('an existing ./.mrm-data keeps being the default data folder and database; ./.kiln-data wins when it exists', () => {
  const only = (...paths: string[]) => (p: string) => paths.includes(p);
  const old = loadConfig({ KILN_MASTER_KEY: key }, only('./.mrm-data', './.mrm-data/mrm.db'));
  assert.equal(old.dataDir, './.mrm-data');
  assert.equal(old.databaseUrl, 'file:./.mrm-data/mrm.db');
  assert.equal(old.cloneDir, join('./.mrm-data', 'clones'));
  const both = loadConfig({ KILN_MASTER_KEY: key }, only('./.mrm-data', './.kiln-data'));
  assert.equal(both.dataDir, './.kiln-data');
  assert.equal(both.databaseUrl, 'file:./.kiln-data/kiln.db');
  // A configured folder is used as it is, whatever exists.
  const set = loadConfig({ KILN_MASTER_KEY: key, KILN_DATA_DIR: '/data' }, only('./.mrm-data'));
  assert.equal(set.dataDir, '/data');
  assert.equal(set.cloneDir, '/data/clones');
});

test('a database URL naming kiln.db keeps using an existing mrm.db next to it', () => {
  const url = 'file:/data/kiln.db';
  const earlier = loadConfig({ KILN_MASTER_KEY: key, DATABASE_URL: url }, (p) => p === '/data/mrm.db');
  assert.equal(earlier.databaseUrl, 'file:/data/mrm.db');
  const both = loadConfig(
    { KILN_MASTER_KEY: key, DATABASE_URL: url },
    (p) => p === '/data/mrm.db' || p === '/data/kiln.db',
  );
  assert.equal(both.databaseUrl, url);
  assert.equal(loadConfig({ KILN_MASTER_KEY: key, DATABASE_URL: url }, nothing).databaseUrl, url);
  const pg = 'postgres://u:p@db.example.com/kiln';
  assert.equal(loadConfig({ KILN_MASTER_KEY: key, DATABASE_URL: pg }, () => true).databaseUrl, pg);
});

test('a missing master key explains how to make one', () => {
  assert.throws(() => loadConfig({}), /openssl rand -base64 32/);
});

test('a short master key is rejected', () => {
  assert.throws(
    () => loadConfig({ KILN_MASTER_KEY: randomBytes(8).toString('base64') }),
    /32 bytes/,
  );
});

test('port is parsed from text', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key, PORT: '9000' }).port, 9000);
  assert.throws(() => loadConfig({ KILN_MASTER_KEY: key, PORT: 'abc' }), /Invalid configuration/);
});

test('worker defaults to inline and trusted origins are split and trimmed', () => {
  const config = loadConfig({
    KILN_MASTER_KEY: key,
    KILN_TRUSTED_ORIGINS: ' http://a.test, ,http://b.test ',
  });
  assert.equal(config.worker, 'inline');
  assert.deepEqual(config.trustedOrigins, ['http://a.test', 'http://b.test']);
  assert.throws(() => loadConfig({ KILN_MASTER_KEY: key, KILN_WORKER: 'sometimes' }), /KILN_WORKER/);
});

test('KILN_TRUST_PROXY is off by default and only 0 or 1 are accepted', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).trustProxy, false);
  assert.equal(loadConfig({ KILN_MASTER_KEY: key, KILN_TRUST_PROXY: '1' }).trustProxy, true);
  assert.equal(loadConfig({ KILN_MASTER_KEY: key, KILN_TRUST_PROXY: '0' }).trustProxy, false);
  assert.throws(
    () => loadConfig({ KILN_MASTER_KEY: key, KILN_TRUST_PROXY: 'yes' }),
    /KILN_TRUST_PROXY/,
  );
});

test('reads default to auto, with the clone folder under the data folder and a 60 second tip cache', () => {
  const config = loadConfig({ KILN_MASTER_KEY: key }, nothing);
  assert.equal(config.reads, 'auto');
  assert.equal(config.cloneDir, join('./.kiln-data', 'clones'));
  assert.equal(config.cloneTtlMs, 60_000);
  assert.equal(config.gitPath, 'git');
  assert.equal(loadConfig({ KILN_MASTER_KEY: key, KILN_DATA_DIR: '/data' }).cloneDir, '/data/clones');
});

test('KILN_READS accepts api, clone and auto only', () => {
  for (const mode of ['api', 'clone', 'auto'] as const) {
    assert.equal(loadConfig({ KILN_MASTER_KEY: key, KILN_READS: mode }).reads, mode);
  }
  assert.throws(() => loadConfig({ KILN_MASTER_KEY: key, KILN_READS: 'git' }), /KILN_READS/);
  assert.throws(() => loadConfig({ KILN_MASTER_KEY: key, KILN_READS: 'API' }), /KILN_READS/);
});

test('clone folder, tip cache and git path are read from the environment', () => {
  const config = loadConfig({
    KILN_MASTER_KEY: key,
    KILN_CLONE_DIR: '/var/clones',
    KILN_CLONE_TTL_SECONDS: '5',
    KILN_GIT_PATH: '/usr/local/bin/git',
  });
  assert.equal(config.cloneDir, '/var/clones');
  assert.equal(config.cloneTtlMs, 5000);
  assert.equal(config.gitPath, '/usr/local/bin/git');
  assert.equal(loadConfig({ KILN_MASTER_KEY: key, KILN_CLONE_TTL_SECONDS: '0' }).cloneTtlMs, 0);
});

test('bad clone settings are rejected, and blank ones mean the default', () => {
  for (const bad of ['-1', '1.5', 'abc', '86401']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_CLONE_TTL_SECONDS: bad }),
      /KILN_CLONE_TTL_SECONDS/,
      bad,
    );
  }
  const blank = loadConfig(
    {
      KILN_MASTER_KEY: key,
      KILN_CLONE_DIR: '',
      KILN_CLONE_TTL_SECONDS: ' ',
      KILN_GIT_PATH: '',
      KILN_READS: '',
    },
    nothing,
  );
  assert.equal(blank.cloneDir, join('./.kiln-data', 'clones'));
  assert.equal(blank.cloneTtlMs, 60_000);
  assert.equal(blank.gitPath, 'git');
});

test('webhooks may not reach private addresses unless KILN_WEBHOOKS_ALLOW_PRIVATE=1', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).webhooksAllowPrivate, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_WEBHOOKS_ALLOW_PRIVATE: '0' }).webhooksAllowPrivate,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_WEBHOOKS_ALLOW_PRIVATE: '1' }).webhooksAllowPrivate,
    true,
  );
  // Only the exact opt-in counts: a loose "yes" must not open the door by accident.
  assert.throws(
    () => loadConfig({ KILN_MASTER_KEY: key, KILN_WEBHOOKS_ALLOW_PRIVATE: 'true' }),
    /Invalid configuration/,
  );
});

test('the LibreTranslate address may not be private unless KILN_TRANSLATE_ALLOW_PRIVATE_URLS=true', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).translateAllowPrivateUrls, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_TRANSLATE_ALLOW_PRIVATE_URLS: '' })
      .translateAllowPrivateUrls,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_TRANSLATE_ALLOW_PRIVATE_URLS: 'false' })
      .translateAllowPrivateUrls,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_TRANSLATE_ALLOW_PRIVATE_URLS: 'true' })
      .translateAllowPrivateUrls,
    true,
  );
  // Only the exact opt-in counts.
  for (const loose of ['1', 'yes', 'TRUE']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_TRANSLATE_ALLOW_PRIVATE_URLS: loose }),
      /Invalid configuration/,
      loose,
    );
  }
});

// ----- KILN_LOCAL_REPO_ROOTS ------------------------------------------------------------------

test('KILN_LOCAL_REPO_ROOTS is blank by default: local clones are off', () => {
  assert.deepEqual(loadConfig({ KILN_MASTER_KEY: key }).localRepoRoots, []);
  assert.deepEqual(
    loadConfig({ KILN_MASTER_KEY: key, KILN_LOCAL_REPO_ROOTS: '' }).localRepoRoots,
    [],
  );
  assert.deepEqual(
    loadConfig({ KILN_MASTER_KEY: key, KILN_LOCAL_REPO_ROOTS: '  ' }).localRepoRoots,
    [],
  );
  assert.deepEqual(parseLocalRepoRoots(undefined, ':'), []);
  assert.deepEqual(parseLocalRepoRoots(' : ::', ':'), []);
});

test('KILN_LOCAL_REPO_ROOTS is a list of absolute folders: normalised, trimmed, listed once', () => {
  assert.deepEqual(parseLocalRepoRoots('/Volumes/dev', ':'), ['/Volumes/dev']);
  assert.deepEqual(
    parseLocalRepoRoots(' /Volumes/dev/ : /home/ada/code//work :/Volumes/dev', ':'),
    ['/Volumes/dev', '/home/ada/code/work'],
  );
  assert.deepEqual(parseLocalRepoRoots('/a;/b', ';'), ['/a', '/b']);
});

test('KILN_LOCAL_REPO_ROOTS refuses what could widen the exposure, naming the variable only', () => {
  const bad = [
    'relative/path',
    '~/code',
    './code',
    '/Volumes/dev/../etc',
    '/',
    '/ok:/tmp/../../x',
    '/with\u0000nul',
    '/with\nnewline',
    `/${'a'.repeat(5000)}`,
  ];
  for (const value of bad) {
    assert.throws(
      () => parseLocalRepoRoots(value, ':'),
      /KILN_LOCAL_REPO_ROOTS/,
      JSON.stringify(value.slice(0, 40)),
    );
  }
  const many = Array.from({ length: MAX_LOCAL_REPO_ROOTS + 1 }, (_, i) => `/r${i}`).join(':');
  assert.throws(() => parseLocalRepoRoots(many, ':'), /more than/);
  // loadConfig reports it as a configuration error, with the platform's separator.
  assert.throws(
    () => loadConfig({ KILN_MASTER_KEY: key, KILN_LOCAL_REPO_ROOTS: 'not-absolute' }),
    /Invalid configuration[\s\S]*KILN_LOCAL_REPO_ROOTS/,
  );
  assert.deepEqual(
    loadConfig({ KILN_MASTER_KEY: key, KILN_LOCAL_REPO_ROOTS: '/Volumes/dev' }).localRepoRoots,
    ['/Volumes/dev'],
  );
});

test('KILN_LOCAL_REPO_ROOTS applies the same way in single-user mode', () => {
  const secret = randomBytes(32).toString('hex');
  const config = loadConfig({
    KILN_MASTER_KEY: key,
    KILN_MODE: 'single_user',
    KILN_LAUNCH_SECRET: secret,
    KILN_LOCAL_REPO_ROOTS: '/Volumes/dev',
  });
  assert.deepEqual(config.localRepoRoots, ['/Volumes/dev']);
  const blank = loadConfig({
    KILN_MASTER_KEY: key,
    KILN_MODE: 'single_user',
    KILN_LAUNCH_SECRET: secret,
  });
  assert.deepEqual(blank.localRepoRoots, []);
});

test('KILN_LOCAL_REPO_WRITE is off by default; only true and false are accepted; blank means off', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).localRepoWrite, false);
  assert.equal(loadConfig({ KILN_MASTER_KEY: key, KILN_LOCAL_REPO_WRITE: '' }).localRepoWrite, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_LOCAL_REPO_WRITE: 'false' }).localRepoWrite,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_LOCAL_REPO_WRITE: 'true' }).localRepoWrite,
    true,
  );
  for (const bad of ['1', 'yes', 'TRUE', 'on']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_LOCAL_REPO_WRITE: bad }),
      /KILN_LOCAL_REPO_WRITE/,
      bad,
    );
  }
});

test('KILN_GIT_AUTHOR_NAME and KILN_GIT_AUTHOR_EMAIL are optional, trimmed and validated', () => {
  const none = loadConfig({ KILN_MASTER_KEY: key });
  assert.equal(none.gitAuthorName, undefined);
  assert.equal(none.gitAuthorEmail, undefined);
  const blank = loadConfig({
    KILN_MASTER_KEY: key,
    KILN_GIT_AUTHOR_NAME: '  ',
    KILN_GIT_AUTHOR_EMAIL: '',
  });
  assert.equal(blank.gitAuthorName, undefined);
  assert.equal(blank.gitAuthorEmail, undefined);
  const set = loadConfig({
    KILN_MASTER_KEY: key,
    KILN_GIT_AUTHOR_NAME: ' Release Bot ',
    KILN_GIT_AUTHOR_EMAIL: ' bot@example.com ',
  });
  assert.equal(set.gitAuthorName, 'Release Bot');
  assert.equal(set.gitAuthorEmail, 'bot@example.com');
  for (const name of ['Bot <x@y.z>', 'two\nlines', 'a'.repeat(101)]) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_GIT_AUTHOR_NAME: name }),
      /KILN_GIT_AUTHOR_NAME/,
    );
  }
  for (const email of ['nobody', 'a@b@c', 'a b@c.d', '<a@b.c>']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_GIT_AUTHOR_EMAIL: email }),
      /KILN_GIT_AUTHOR_EMAIL/,
    );
  }
});

// ----- KILN_GIT_SIGN ----------------------------------------------------------------------------

const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** Files for the signing checks: fake keys and programs (config.ts only looks at the shape, mode and path). */
function signingFiles() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kiln-cfg-')));
  folders.push(dir);
  const file = (name: string, content: string, mode: number) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
  };
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const program = (name: string, mode = 0o755) => {
    const path = join(bin, name);
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, mode);
    return path;
  };
  const home = join(dir, 'gnupg');
  mkdirSync(home, { mode: 0o700 });
  return {
    dir,
    bin,
    home,
    file,
    program,
    privateKey: file(
      'id_ed25519',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
      0o600,
    ),
    publicKey: file('id_ed25519.pub', 'ssh-ed25519 AAAAC3Nza signer@example.com\n', 0o644),
    sshKeygen: program('ssh-keygen'),
    gpg: program('gpg'),
  };
}

const signingEnv = (extra: Record<string, string>) => ({ KILN_MASTER_KEY: key, ...extra });
const raises = (env: Record<string, string>, pattern: RegExp, message?: string) =>
  assert.throws(
    () => loadConfig(signingEnv(env)),
    (error: Error) => {
      assert.match(error.message, /^Invalid configuration:/, message);
      assert.match(error.message, pattern, message);
      return true;
    },
  );

test('KILN_GIT_SIGN is off by default, and then nothing else about signing is read', () => {
  const f = signingFiles();
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).gitSigning, undefined);
  for (const value of ['', ' ', 'off']) {
    assert.equal(
      loadConfig(signingEnv({ KILN_GIT_SIGN: value })).gitSigning,
      undefined,
      JSON.stringify(value),
    );
  }
  // Leftover settings of a signing setup that is switched off must not stop the server.
  const off = loadConfig(
    signingEnv({
      KILN_GIT_SIGN: 'off',
      KILN_GIT_SIGNING_KEY: 'relative/key',
      KILN_GIT_SIGNING_PROGRAM: 'nope',
      KILN_GIT_GNUPGHOME: 'nope',
    }),
  );
  assert.equal(off.gitSigning, undefined);
  assert.equal(Object.hasOwn(off, 'gitSigning'), false);
  assert.equal(parseGitSigning({}), undefined);
  assert.ok(f.dir);
});

test('KILN_GIT_SIGN accepts off, ssh and gpg only', () => {
  for (const bad of ['SSH', 'yes', 'true', '1', 'x509', 'openpgp'])
    raises({ KILN_GIT_SIGN: bad }, /KILN_GIT_SIGN/, bad);
});

test('ssh with a private key file: the key and the program are pinned as absolute paths', () => {
  const f = signingFiles();
  const explicit = loadConfig(
    signingEnv({
      KILN_GIT_SIGN: 'ssh',
      KILN_GIT_SIGNING_KEY: f.privateKey,
      KILN_GIT_SIGNING_PROGRAM: f.sshKeygen,
    }),
  ).gitSigning;
  assert.deepEqual(explicit, { format: 'ssh', key: f.privateKey, program: f.sshKeygen });
  // Without KILN_GIT_SIGNING_PROGRAM, ssh-keygen is looked up in PATH once, and the absolute path is kept.
  const found = loadConfig(
    signingEnv({
      KILN_GIT_SIGN: 'ssh',
      KILN_GIT_SIGNING_KEY: f.privateKey,
      PATH: `relative/bin:${f.bin}`,
    }),
  ).gitSigning;
  assert.deepEqual(found, { format: 'ssh', key: f.privateKey, program: f.sshKeygen });
  // The agent socket of the server's environment is for a .pub key only.
  const withSocket = loadConfig(
    signingEnv({
      KILN_GIT_SIGN: 'ssh',
      KILN_GIT_SIGNING_KEY: f.privateKey,
      KILN_GIT_SIGNING_PROGRAM: f.sshKeygen,
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    }),
  );
  assert.equal(withSocket.gitSigning?.sshAuthSock, undefined);
});

test('ssh with a .pub key: the agent socket of the server environment is passed on when there is one', () => {
  const f = signingFiles();
  const base = {
    KILN_GIT_SIGN: 'ssh',
    KILN_GIT_SIGNING_KEY: f.publicKey,
    KILN_GIT_SIGNING_PROGRAM: f.sshKeygen,
  };
  assert.deepEqual(
    loadConfig(signingEnv({ ...base, SSH_AUTH_SOCK: '/tmp/ssh-abc/agent.1' })).gitSigning,
    {
      format: 'ssh',
      key: f.publicKey,
      program: f.sshKeygen,
      sshAuthSock: '/tmp/ssh-abc/agent.1',
    },
  );
  assert.equal(loadConfig(signingEnv(base)).gitSigning?.sshAuthSock, undefined);
  raises({ ...base, SSH_AUTH_SOCK: 'agent.sock' }, /SSH_AUTH_SOCK must be an absolute path/);
});

test('ssh: every bad setting is refused at start with a message that names the variable and never the key path', () => {
  const f = signingFiles();
  const loose = f.file('loose_key', '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n', 0o644);
  const groupReadable = f.file('group_key', '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n', 0o640);
  const notAKey = f.file('notes.txt', 'hello\n', 0o600);
  const pubWithoutExtension = f.file('id_pub', 'ssh-ed25519 AAAAC3Nza x\n', 0o644);
  const badPub = f.file('bad.pub', 'hello\n', 0o644);
  const plain = f.program('plain', 0o644);
  const base = {
    KILN_GIT_SIGN: 'ssh',
    KILN_GIT_SIGNING_KEY: f.privateKey,
    KILN_GIT_SIGNING_PROGRAM: f.sshKeygen,
  };
  const table: {
    name: string;
    env: Record<string, string>;
    pattern: RegExp;
    skipOnWindows?: boolean;
  }[] = [
    {
      name: 'no key',
      env: { ...base, KILN_GIT_SIGNING_KEY: '' },
      pattern: /KILN_GIT_SIGNING_KEY is required/,
    },
    {
      name: 'a relative path',
      env: { ...base, KILN_GIT_SIGNING_KEY: 'keys/id' },
      pattern: /KILN_GIT_SIGNING_KEY must be an absolute path/,
    },
    {
      name: 'a tilde path',
      env: { ...base, KILN_GIT_SIGNING_KEY: '~/.ssh/id_ed25519' },
      pattern: /absolute path/,
    },
    {
      name: 'a .. segment',
      env: { ...base, KILN_GIT_SIGNING_KEY: `${f.dir}/../x` },
      pattern: /must not contain "\.\."/,
    },
    {
      name: 'a control character',
      env: { ...base, KILN_GIT_SIGNING_KEY: `${f.dir}/a\nb` },
      pattern: /control characters/,
    },
    {
      name: 'a missing file',
      env: { ...base, KILN_GIT_SIGNING_KEY: join(f.dir, 'nope') },
      pattern: /not a file that exists/,
    },
    {
      name: 'a folder',
      env: { ...base, KILN_GIT_SIGNING_KEY: f.dir },
      pattern: /not a file that exists/,
    },
    {
      name: 'a key readable by others',
      env: { ...base, KILN_GIT_SIGNING_KEY: loose },
      pattern: /readable by other users[\s\S]*chmod 600/,
      skipOnWindows: true,
    },
    {
      name: 'a key readable by the group',
      env: { ...base, KILN_GIT_SIGNING_KEY: groupReadable },
      pattern: /readable by other users/,
      skipOnWindows: true,
    },
    {
      name: 'a file that is not a key',
      env: { ...base, KILN_GIT_SIGNING_KEY: notAKey },
      pattern: /not an ssh private key file/,
    },
    {
      name: 'a public key without .pub',
      env: { ...base, KILN_GIT_SIGNING_KEY: pubWithoutExtension },
      pattern: /does not end in \.pub/,
    },
    {
      name: 'a .pub that is not a public key',
      env: { ...base, KILN_GIT_SIGNING_KEY: badPub },
      pattern: /not an ssh public key/,
    },
    {
      name: 'a relative program',
      env: { ...base, KILN_GIT_SIGNING_PROGRAM: 'ssh-keygen' },
      pattern: /KILN_GIT_SIGNING_PROGRAM must be an absolute path/,
    },
    {
      name: 'a program that does not exist',
      env: { ...base, KILN_GIT_SIGNING_PROGRAM: join(f.dir, 'nope') },
      pattern: /not an executable file/,
    },
    {
      name: 'a program that is not executable',
      env: { ...base, KILN_GIT_SIGNING_PROGRAM: plain },
      pattern: /not an executable file/,
      skipOnWindows: true,
    },
    {
      name: 'a folder as the program',
      env: { ...base, KILN_GIT_SIGNING_PROGRAM: f.bin },
      pattern: /not an executable file/,
    },
    {
      name: 'a program path with a quote',
      env: { ...base, KILN_GIT_SIGNING_PROGRAM: `${f.dir}/it's` },
      pattern: /must not contain quotes/,
    },
    {
      name: 'no ssh-keygen anywhere',
      env: { KILN_GIT_SIGN: 'ssh', KILN_GIT_SIGNING_KEY: f.privateKey, PATH: join(f.dir, 'empty') },
      pattern: /needs ssh-keygen[\s\S]*KILN_GIT_SIGNING_PROGRAM/,
    },
    {
      name: 'a keyring folder with ssh',
      env: { ...base, KILN_GIT_GNUPGHOME: f.home },
      pattern: /KILN_GIT_GNUPGHOME only applies with KILN_GIT_SIGN=gpg/,
    },
  ];
  for (const row of table) {
    if (row.skipOnWindows && process.platform === 'win32') continue;
    assert.throws(
      () => loadConfig(signingEnv(row.env)),
      (error: Error) => {
        assert.match(error.message, /^Invalid configuration:/, row.name);
        assert.match(error.message, row.pattern, row.name);
        for (const secret of [f.privateKey, f.dir, 'AAAA'])
          assert.equal(
            error.message.includes(secret),
            false,
            `${row.name}: no path or key content in the message`,
          );
        return true;
      },
    );
  }
});

test('ssh: a key file the server cannot read is refused', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, () => {
  const f = signingFiles();
  const locked = f.file('locked_key', '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n', 0o000);
  raises(
    { KILN_GIT_SIGN: 'ssh', KILN_GIT_SIGNING_KEY: locked, KILN_GIT_SIGNING_PROGRAM: f.sshKeygen },
    /not readable/,
  );
});

test('gpg: a key id or fingerprint, the keyring folder and the program are pinned', () => {
  const f = signingFiles();
  const fingerprint = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  const base = {
    KILN_GIT_SIGN: 'gpg',
    KILN_GIT_SIGNING_KEY: fingerprint,
    KILN_GIT_GNUPGHOME: f.home,
    KILN_GIT_SIGNING_PROGRAM: f.gpg,
  };
  assert.deepEqual(loadConfig(signingEnv(base)).gitSigning, {
    format: 'gpg',
    key: fingerprint,
    program: f.gpg,
    gnupgHome: f.home,
  });
  for (const id of ['0xDEADBEEF', 'deadbeef', 'DEADBEEFDEADBEEF', 'DEADBEEFDEADBEEF!']) {
    assert.equal(
      loadConfig(signingEnv({ ...base, KILN_GIT_SIGNING_KEY: id })).gitSigning?.key,
      id.replace(/^0x/, ''),
      id,
    );
  }
  // gpg is looked up in PATH once when no program is given (gpg2 is the fallback name).
  const viaPath = loadConfig(
    signingEnv({ ...base, KILN_GIT_SIGNING_PROGRAM: '', PATH: f.bin }),
  ).gitSigning;
  assert.equal(viaPath?.program, f.gpg);
  // The ssh agent socket is not passed on for gpg.
  assert.equal(
    loadConfig(signingEnv({ ...base, SSH_AUTH_SOCK: '/tmp/a.sock' })).gitSigning?.sshAuthSock,
    undefined,
  );
});

test('gpg: every bad setting is refused at start', () => {
  const f = signingFiles();
  const fingerprint = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  const base = {
    KILN_GIT_SIGN: 'gpg',
    KILN_GIT_SIGNING_KEY: fingerprint,
    KILN_GIT_GNUPGHOME: f.home,
    KILN_GIT_SIGNING_PROGRAM: f.gpg,
  };
  const notAFolder = f.file('keyring-file', 'x', 0o600);
  const table: { name: string; env: Record<string, string>; pattern: RegExp }[] = [
    {
      name: 'no key',
      env: { ...base, KILN_GIT_SIGNING_KEY: '' },
      pattern: /KILN_GIT_SIGNING_KEY is required when KILN_GIT_SIGN=gpg/,
    },
    {
      name: 'an e-mail address',
      env: { ...base, KILN_GIT_SIGNING_KEY: 'ada@example.com' },
      pattern: /key id or fingerprint/,
    },
    {
      name: 'a user name',
      env: { ...base, KILN_GIT_SIGNING_KEY: 'Ada Lovelace' },
      pattern: /key id or fingerprint/,
    },
    {
      name: 'too short',
      env: { ...base, KILN_GIT_SIGNING_KEY: 'DEADBE' },
      pattern: /key id or fingerprint/,
    },
    {
      name: 'too long',
      env: { ...base, KILN_GIT_SIGNING_KEY: 'A'.repeat(65) },
      pattern: /key id or fingerprint/,
    },
    {
      name: 'not hex',
      env: { ...base, KILN_GIT_SIGNING_KEY: 'GHIJKLMNOP' },
      pattern: /key id or fingerprint/,
    },
    {
      name: 'an option',
      env: { ...base, KILN_GIT_SIGNING_KEY: '--list-keys' },
      pattern: /key id or fingerprint/,
    },
    {
      name: 'a shell fragment',
      env: { ...base, KILN_GIT_SIGNING_KEY: 'DEADBEEF;touch x' },
      pattern: /key id or fingerprint/,
    },
    {
      name: 'a path',
      env: { ...base, KILN_GIT_SIGNING_KEY: f.privateKey },
      pattern: /key id or fingerprint/,
    },
    {
      name: 'no keyring folder',
      env: { ...base, KILN_GIT_GNUPGHOME: '' },
      pattern: /KILN_GIT_GNUPGHOME is required when KILN_GIT_SIGN=gpg/,
    },
    {
      name: 'a relative keyring folder',
      env: { ...base, KILN_GIT_GNUPGHOME: '.gnupg' },
      pattern: /KILN_GIT_GNUPGHOME must be an absolute path/,
    },
    {
      name: 'a keyring folder that does not exist',
      env: { ...base, KILN_GIT_GNUPGHOME: join(f.dir, 'nope') },
      pattern: /not a folder that exists/,
    },
    {
      name: 'a file as the keyring folder',
      env: { ...base, KILN_GIT_GNUPGHOME: notAFolder },
      pattern: /not a folder that exists/,
    },
    {
      name: 'no gpg anywhere',
      env: { ...base, KILN_GIT_SIGNING_PROGRAM: '', PATH: join(f.dir, 'empty') },
      pattern: /needs gpg[\s\S]*KILN_GIT_SIGNING_PROGRAM/,
    },
    {
      name: 'a relative program',
      env: { ...base, KILN_GIT_SIGNING_PROGRAM: 'gpg' },
      pattern: /KILN_GIT_SIGNING_PROGRAM must be an absolute path/,
    },
  ];
  for (const row of table) raises(row.env, row.pattern, row.name);
  // gpg needs a shell script to forbid prompts: not on Windows.
  assert.throws(() => parseGitSigning({ ...base }, 'win32'), /not supported on Windows/);
});

test('clone upkeep: defaults are 2 GiB, 30 days and a sweep every 6 hours', () => {
  const config = loadConfig({ KILN_MASTER_KEY: key });
  assert.equal(config.cloneMaxBytes, 2 * 1024 ** 3);
  assert.equal(config.cloneIdleDays, 30);
  assert.equal(config.cloneSweepIntervalMinutes, 360);
  const blank = loadConfig({
    KILN_MASTER_KEY: key,
    KILN_CLONE_MAX_BYTES: ' ',
    KILN_CLONE_IDLE_DAYS: '',
    KILN_CLONE_SWEEP_INTERVAL_MINUTES: '',
  });
  assert.equal(blank.cloneMaxBytes, 2 * 1024 ** 3);
  assert.equal(blank.cloneIdleDays, 30);
  assert.equal(blank.cloneSweepIntervalMinutes, 360);
});

test('clone upkeep: sizes in bytes or with a unit, and 0 turns each limit off', () => {
  const read = (extra: Record<string, string>) => loadConfig({ KILN_MASTER_KEY: key, ...extra });
  assert.equal(read({ KILN_CLONE_MAX_BYTES: '1048576' }).cloneMaxBytes, 1048576);
  assert.equal(read({ KILN_CLONE_MAX_BYTES: '500m' }).cloneMaxBytes, 500 * 1024 ** 2);
  assert.equal(read({ KILN_CLONE_MAX_BYTES: '2G' }).cloneMaxBytes, 2 * 1024 ** 3);
  assert.equal(read({ KILN_CLONE_MAX_BYTES: '10 GiB' }).cloneMaxBytes, 10 * 1024 ** 3);
  assert.equal(read({ KILN_CLONE_MAX_BYTES: '0' }).cloneMaxBytes, 0);
  assert.equal(read({ KILN_CLONE_IDLE_DAYS: '0' }).cloneIdleDays, 0);
  assert.equal(read({ KILN_CLONE_SWEEP_INTERVAL_MINUTES: '0' }).cloneSweepIntervalMinutes, 0);
  assert.equal(read({ KILN_CLONE_SWEEP_INTERVAL_MINUTES: '5' }).cloneSweepIntervalMinutes, 5);
  assert.equal(parseByteSize('1k'), 1024);
  assert.equal(parseByteSize('1.5g'), undefined);
});

test('clone upkeep: bad values are rejected with the variable named', () => {
  for (const [name, bad] of [
    ['KILN_CLONE_MAX_BYTES', '-1'],
    ['KILN_CLONE_MAX_BYTES', 'lots'],
    ['KILN_CLONE_MAX_BYTES', '2gigabytes'],
    ['KILN_CLONE_MAX_BYTES', '99999999999999999999'],
    ['KILN_CLONE_IDLE_DAYS', '-1'],
    ['KILN_CLONE_IDLE_DAYS', '1.5'],
    ['KILN_CLONE_IDLE_DAYS', '4000'],
    ['KILN_CLONE_SWEEP_INTERVAL_MINUTES', '1'],
    ['KILN_CLONE_SWEEP_INTERVAL_MINUTES', '10081'],
    ['KILN_CLONE_SWEEP_INTERVAL_MINUTES', 'x'],
  ] as const) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, [name]: bad }),
      new RegExp(name),
      `${name}=${bad}`,
    );
  }
});

test('KILN_REVIEW_REPLY_ENABLED is off by default; only true and false are accepted; blank means off', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).reviewReplyEnabled, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_REVIEW_REPLY_ENABLED: '' }).reviewReplyEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_REVIEW_REPLY_ENABLED: 'false' }).reviewReplyEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_REVIEW_REPLY_ENABLED: 'true' }).reviewReplyEnabled,
    true,
  );
  for (const bad of ['1', 'yes', 'TRUE', 'on']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_REVIEW_REPLY_ENABLED: bad }),
      /KILN_REVIEW_REPLY_ENABLED/,
      bad,
    );
  }
});

test('KILN_STORE_ROLLOUT_ENABLED is off by default; only true and false are accepted; blank means off', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).storeRolloutEnabled, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_ROLLOUT_ENABLED: '' }).storeRolloutEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_ROLLOUT_ENABLED: 'false' }).storeRolloutEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_ROLLOUT_ENABLED: 'true' }).storeRolloutEnabled,
    true,
  );
  for (const bad of ['1', 'yes', 'TRUE', 'on']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_ROLLOUT_ENABLED: bad }),
      /KILN_STORE_ROLLOUT_ENABLED/,
      bad,
    );
  }
});

test('KILN_STORE_PRODUCT_WRITE_ENABLED is off by default; only true and false are accepted; blank means off; independent of the other store switches', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).storeProductWriteEnabled, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_PRODUCT_WRITE_ENABLED: '' })
      .storeProductWriteEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_PRODUCT_WRITE_ENABLED: 'false' })
      .storeProductWriteEnabled,
    false,
  );
  const on = loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_PRODUCT_WRITE_ENABLED: 'true' });
  assert.equal(on.storeProductWriteEnabled, true);
  assert.equal(on.storeRolloutEnabled, false);
  assert.equal(on.storeDraftWriteEnabled, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_ROLLOUT_ENABLED: 'true' }).storeProductWriteEnabled,
    false,
    'the rollout switch does not turn product writes on',
  );
  for (const bad of ['1', 'yes', 'TRUE', 'on']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_PRODUCT_WRITE_ENABLED: bad }),
      /KILN_STORE_PRODUCT_WRITE_ENABLED/,
      bad,
    );
  }
});

test('KILN_EAS_UPDATE_ROLLOUT_ENABLED is off by default; only true and false are accepted; blank means off; independent of the store switches', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).easUpdateRolloutEnabled, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_EAS_UPDATE_ROLLOUT_ENABLED: '' }).easUpdateRolloutEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_EAS_UPDATE_ROLLOUT_ENABLED: 'false' })
      .easUpdateRolloutEnabled,
    false,
  );
  const on = loadConfig({ KILN_MASTER_KEY: key, KILN_EAS_UPDATE_ROLLOUT_ENABLED: 'true' });
  assert.equal(on.easUpdateRolloutEnabled, true);
  assert.equal(on.storeRolloutEnabled, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_ROLLOUT_ENABLED: 'true' }).easUpdateRolloutEnabled,
    false,
    'the store rollout switch does not turn the Expo rollout on',
  );
  for (const bad of ['1', 'yes', 'TRUE', 'on']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_EAS_UPDATE_ROLLOUT_ENABLED: bad }),
      /KILN_EAS_UPDATE_ROLLOUT_ENABLED/,
      bad,
    );
  }
});

test('KILN_STORE_DRAFT_WRITE_ENABLED is off by default; only true and false are accepted; blank means off', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).storeDraftWriteEnabled, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_DRAFT_WRITE_ENABLED: '' }).storeDraftWriteEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_DRAFT_WRITE_ENABLED: 'false' })
      .storeDraftWriteEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_DRAFT_WRITE_ENABLED: 'true' })
      .storeDraftWriteEnabled,
    true,
  );
  for (const bad of ['1', 'yes', 'TRUE', 'on']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_DRAFT_WRITE_ENABLED: bad }),
      /KILN_STORE_DRAFT_WRITE_ENABLED/,
      bad,
    );
  }
  // Independent of the rollout switch.
  const both = loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_ROLLOUT_ENABLED: 'true' });
  assert.equal(both.storeRolloutEnabled, true);
  assert.equal(both.storeDraftWriteEnabled, false);
});

test('KILN_STORE_SUBMIT_ENABLED is off by default; only true and false are accepted; blank means off', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).storeSubmitEnabled, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_SUBMIT_ENABLED: '' }).storeSubmitEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_SUBMIT_ENABLED: 'false' }).storeSubmitEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_SUBMIT_ENABLED: 'true' }).storeSubmitEnabled,
    true,
  );
  for (const bad of ['1', 'yes', 'TRUE', 'on']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_SUBMIT_ENABLED: bad }),
      /KILN_STORE_SUBMIT_ENABLED/,
      bad,
    );
  }
  // Independent of the draft switch: turning drafts on does not turn submitting on.
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_DRAFT_WRITE_ENABLED: 'true' }).storeSubmitEnabled,
    false,
  );
});

test('KILN_STORE_RELEASE_ENABLED is off by default; only true and false are accepted; blank means off', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).storeReleaseEnabled, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_RELEASE_ENABLED: '' }).storeReleaseEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_RELEASE_ENABLED: 'false' }).storeReleaseEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_RELEASE_ENABLED: 'true' }).storeReleaseEnabled,
    true,
  );
  for (const bad of ['1', 'yes', 'TRUE', 'on']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_RELEASE_ENABLED: bad }),
      /KILN_STORE_RELEASE_ENABLED/,
      bad,
    );
  }
  // Independent of the draft and submit switches: turning them on does not turn releasing on.
  const others = loadConfig({
    KILN_MASTER_KEY: key,
    KILN_STORE_DRAFT_WRITE_ENABLED: 'true',
    KILN_STORE_SUBMIT_ENABLED: 'true',
  });
  assert.equal(others.storeReleaseEnabled, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_RELEASE_ENABLED: 'true' }).storeSubmitEnabled,
    false,
  );
});

test('KILN_STORE_PUBLISH_BATCH_ENABLED is off by default; only true and false are accepted; blank means off; it turns no step on', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).storePublishBatchEnabled, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_PUBLISH_BATCH_ENABLED: '' })
      .storePublishBatchEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_PUBLISH_BATCH_ENABLED: 'false' })
      .storePublishBatchEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_PUBLISH_BATCH_ENABLED: 'true' })
      .storePublishBatchEnabled,
    true,
  );
  for (const bad of ['1', 'yes', 'TRUE', 'on']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_PUBLISH_BATCH_ENABLED: bad }),
      /KILN_STORE_PUBLISH_BATCH_ENABLED/,
      bad,
    );
  }
  const on = loadConfig({ KILN_MASTER_KEY: key, KILN_STORE_PUBLISH_BATCH_ENABLED: 'true' });
  assert.deepEqual(
    [
      on.storeDraftWriteEnabled,
      on.storeSubmitEnabled,
      on.storeReleaseEnabled,
      on.storeRolloutEnabled,
    ],
    [false, false, false, false],
  );
});

test('KILN_PLAY_INTERNAL_SHARING_ENABLED is off by default, blank is unset, and it turns nothing else on', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).playInternalSharingEnabled, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_PLAY_INTERNAL_SHARING_ENABLED: '' })
      .playInternalSharingEnabled,
    false,
  );
  const on = loadConfig({ KILN_MASTER_KEY: key, KILN_PLAY_INTERNAL_SHARING_ENABLED: 'true' });
  assert.equal(on.playInternalSharingEnabled, true);
  assert.deepEqual(
    [on.buildsDownloadEnabled, on.storeReleaseEnabled, on.storeSubmitEnabled],
    [false, false, false],
  );
  assert.throws(
    () => loadConfig({ KILN_MASTER_KEY: key, KILN_PLAY_INTERNAL_SHARING_ENABLED: 'yes' }),
    /KILN_PLAY_INTERNAL_SHARING_ENABLED/,
  );
});

test('KILN_BUILDS_DOWNLOAD_ENABLED is off by default and independent of the store switches; the size limit is bounded', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).buildsDownloadEnabled, false);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_BUILDS_DOWNLOAD_ENABLED: '' }).buildsDownloadEnabled,
    false,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_BUILDS_DOWNLOAD_ENABLED: 'true' }).buildsDownloadEnabled,
    true,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_BUILDS_DOWNLOAD_ENABLED: 'true' }).storeReleaseEnabled,
    false,
  );
  assert.throws(
    () => loadConfig({ KILN_MASTER_KEY: key, KILN_BUILDS_DOWNLOAD_ENABLED: 'yes' }),
    /KILN_BUILDS_DOWNLOAD_ENABLED/,
  );
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).buildsDownloadMaxBytes, 500 * 1024 * 1024);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_BUILDS_DOWNLOAD_MAX_MB: '2' }).buildsDownloadMaxBytes,
    2 * 1024 * 1024,
  );
  for (const bad of ['0', '5000', 'big'])
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_BUILDS_DOWNLOAD_MAX_MB: bad }),
      /KILN_BUILDS_DOWNLOAD_MAX_MB/,
      bad,
    );
});
