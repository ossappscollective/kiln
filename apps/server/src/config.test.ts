import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from './config.ts';

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
