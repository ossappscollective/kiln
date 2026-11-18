import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_LOCAL_REPO_ROOTS, loadConfig, parseLocalRepoRoots } from './config.ts';

const key = randomBytes(32).toString('base64');

test('defaults are usable with only a master key', () => {
  const config = loadConfig({ MRM_MASTER_KEY: key });
  assert.equal(config.port, 8787);
  assert.equal(config.databaseUrl, 'file:./.mrm-data/mrm.db');
  assert.equal(config.masterKey.length, 32);
});

test('a missing master key explains how to make one', () => {
  assert.throws(() => loadConfig({}), /openssl rand -base64 32/);
});

test('a short master key is rejected', () => {
  assert.throws(
    () => loadConfig({ MRM_MASTER_KEY: randomBytes(8).toString('base64') }),
    /32 bytes/,
  );
});

test('port is parsed from text', () => {
  assert.equal(loadConfig({ MRM_MASTER_KEY: key, PORT: '9000' }).port, 9000);
  assert.throws(() => loadConfig({ MRM_MASTER_KEY: key, PORT: 'abc' }), /Invalid configuration/);
});

test('worker defaults to inline and trusted origins are split and trimmed', () => {
  const config = loadConfig({ MRM_MASTER_KEY: key, MRM_TRUSTED_ORIGINS: ' http://a.test, ,http://b.test ' });
  assert.equal(config.worker, 'inline');
  assert.deepEqual(config.trustedOrigins, ['http://a.test', 'http://b.test']);
  assert.throws(() => loadConfig({ MRM_MASTER_KEY: key, MRM_WORKER: 'sometimes' }), /MRM_WORKER/);
});

test('MRM_TRUST_PROXY is off by default and only 0 or 1 are accepted', () => {
  assert.equal(loadConfig({ MRM_MASTER_KEY: key }).trustProxy, false);
  assert.equal(loadConfig({ MRM_MASTER_KEY: key, MRM_TRUST_PROXY: '1' }).trustProxy, true);
  assert.equal(loadConfig({ MRM_MASTER_KEY: key, MRM_TRUST_PROXY: '0' }).trustProxy, false);
  assert.throws(() => loadConfig({ MRM_MASTER_KEY: key, MRM_TRUST_PROXY: 'yes' }), /MRM_TRUST_PROXY/);
});

test('reads default to auto, with the clone folder under the data folder and a 60 second tip cache', () => {
  const config = loadConfig({ MRM_MASTER_KEY: key });
  assert.equal(config.reads, 'auto');
  assert.equal(config.cloneDir, join('./.mrm-data', 'clones'));
  assert.equal(config.cloneTtlMs, 60_000);
  assert.equal(config.gitPath, 'git');
  assert.equal(loadConfig({ MRM_MASTER_KEY: key, MRM_DATA_DIR: '/data' }).cloneDir, '/data/clones');
});

test('MRM_READS accepts api, clone and auto only', () => {
  for (const mode of ['api', 'clone', 'auto'] as const) {
    assert.equal(loadConfig({ MRM_MASTER_KEY: key, MRM_READS: mode }).reads, mode);
  }
  assert.throws(() => loadConfig({ MRM_MASTER_KEY: key, MRM_READS: 'git' }), /MRM_READS/);
  assert.throws(() => loadConfig({ MRM_MASTER_KEY: key, MRM_READS: 'API' }), /MRM_READS/);
});

test('clone folder, tip cache and git path are read from the environment', () => {
  const config = loadConfig({
    MRM_MASTER_KEY: key,
    MRM_CLONE_DIR: '/var/clones',
    MRM_CLONE_TTL_SECONDS: '5',
    MRM_GIT_PATH: '/usr/local/bin/git',
  });
  assert.equal(config.cloneDir, '/var/clones');
  assert.equal(config.cloneTtlMs, 5000);
  assert.equal(config.gitPath, '/usr/local/bin/git');
  assert.equal(loadConfig({ MRM_MASTER_KEY: key, MRM_CLONE_TTL_SECONDS: '0' }).cloneTtlMs, 0);
});

test('bad clone settings are rejected, and blank ones mean the default', () => {
  for (const bad of ['-1', '1.5', 'abc', '86401']) {
    assert.throws(
      () => loadConfig({ MRM_MASTER_KEY: key, MRM_CLONE_TTL_SECONDS: bad }),
      /MRM_CLONE_TTL_SECONDS/,
      bad,
    );
  }
  const blank = loadConfig({
    MRM_MASTER_KEY: key,
    MRM_CLONE_DIR: '',
    MRM_CLONE_TTL_SECONDS: ' ',
    MRM_GIT_PATH: '',
    MRM_READS: '',
  });
  assert.equal(blank.cloneDir, join('./.mrm-data', 'clones'));
  assert.equal(blank.cloneTtlMs, 60_000);
  assert.equal(blank.gitPath, 'git');
});

test('webhooks may not reach private addresses unless MRM_WEBHOOKS_ALLOW_PRIVATE=1', () => {
  assert.equal(loadConfig({ MRM_MASTER_KEY: key }).webhooksAllowPrivate, false);
  assert.equal(loadConfig({ MRM_MASTER_KEY: key, MRM_WEBHOOKS_ALLOW_PRIVATE: '0' }).webhooksAllowPrivate, false);
  assert.equal(loadConfig({ MRM_MASTER_KEY: key, MRM_WEBHOOKS_ALLOW_PRIVATE: '1' }).webhooksAllowPrivate, true);
  // Only the exact opt-in counts: a loose "yes" must not open the door by accident.
  assert.throws(() => loadConfig({ MRM_MASTER_KEY: key, MRM_WEBHOOKS_ALLOW_PRIVATE: 'true' }), /Invalid configuration/);
});

// ----- MRM_LOCAL_REPO_ROOTS ------------------------------------------------------------------

test('MRM_LOCAL_REPO_ROOTS is blank by default: local clones are off', () => {
  assert.deepEqual(loadConfig({ MRM_MASTER_KEY: key }).localRepoRoots, []);
  assert.deepEqual(loadConfig({ MRM_MASTER_KEY: key, MRM_LOCAL_REPO_ROOTS: '' }).localRepoRoots, []);
  assert.deepEqual(loadConfig({ MRM_MASTER_KEY: key, MRM_LOCAL_REPO_ROOTS: '  ' }).localRepoRoots, []);
  assert.deepEqual(parseLocalRepoRoots(undefined, ':'), []);
  assert.deepEqual(parseLocalRepoRoots(' : ::', ':'), []);
});

test('MRM_LOCAL_REPO_ROOTS is a list of absolute folders: normalised, trimmed, listed once', () => {
  assert.deepEqual(parseLocalRepoRoots('/Volumes/dev', ':'), ['/Volumes/dev']);
  assert.deepEqual(parseLocalRepoRoots(' /Volumes/dev/ : /home/ada/code//work :/Volumes/dev', ':'), [
    '/Volumes/dev',
    '/home/ada/code/work',
  ]);
  assert.deepEqual(parseLocalRepoRoots('/a;/b', ';'), ['/a', '/b']);
});

test('MRM_LOCAL_REPO_ROOTS refuses what could widen the exposure, naming the variable only', () => {
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
    assert.throws(() => parseLocalRepoRoots(value, ':'), /MRM_LOCAL_REPO_ROOTS/, JSON.stringify(value.slice(0, 40)));
  }
  const many = Array.from({ length: MAX_LOCAL_REPO_ROOTS + 1 }, (_, i) => `/r${i}`).join(':');
  assert.throws(() => parseLocalRepoRoots(many, ':'), /more than/);
  // loadConfig reports it as a configuration error, with the platform's separator.
  assert.throws(
    () => loadConfig({ MRM_MASTER_KEY: key, MRM_LOCAL_REPO_ROOTS: 'not-absolute' }),
    /Invalid configuration[\s\S]*MRM_LOCAL_REPO_ROOTS/,
  );
  assert.deepEqual(
    loadConfig({ MRM_MASTER_KEY: key, MRM_LOCAL_REPO_ROOTS: '/Volumes/dev' }).localRepoRoots,
    ['/Volumes/dev'],
  );
});

test('MRM_LOCAL_REPO_ROOTS applies the same way in single-user mode', () => {
  const secret = randomBytes(32).toString('hex');
  const config = loadConfig({
    MRM_MASTER_KEY: key,
    MRM_MODE: 'single_user',
    MRM_LAUNCH_SECRET: secret,
    MRM_LOCAL_REPO_ROOTS: '/Volumes/dev',
  });
  assert.deepEqual(config.localRepoRoots, ['/Volumes/dev']);
  const blank = loadConfig({ MRM_MASTER_KEY: key, MRM_MODE: 'single_user', MRM_LAUNCH_SECRET: secret });
  assert.deepEqual(blank.localRepoRoots, []);
});
