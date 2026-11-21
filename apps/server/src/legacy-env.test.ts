import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { applyLegacyEnv, resetLegacyEnvReport } from './legacy-env.ts';

beforeEach(() => resetLegacyEnvReport());

test('an old MRM_ name is copied to the KILN_ name when that is absent', () => {
  const env: Record<string, string | undefined> = { MRM_DATA_DIR: '/data', MRM_BIND: '0.0.0.0' };
  const lines: string[] = [];
  const taken = applyLegacyEnv(env, (l) => lines.push(l));
  assert.deepEqual(taken, ['MRM_BIND', 'MRM_DATA_DIR']);
  assert.equal(env.KILN_DATA_DIR, '/data');
  assert.equal(env.KILN_BIND, '0.0.0.0');
  assert.equal(env.MRM_DATA_DIR, '/data', 'the old variable is left as it was');
  assert.equal(lines.length, 1);
});

test('a KILN_ value is never overwritten, even by a different or empty old value', () => {
  const env: Record<string, string | undefined> = {
    KILN_PORT_X: 'new',
    MRM_PORT_X: 'old',
    KILN_BLANK: '',
    MRM_BLANK: 'old',
  };
  const lines: string[] = [];
  assert.deepEqual(applyLegacyEnv(env, (l) => lines.push(l)), []);
  assert.equal(env.KILN_PORT_X, 'new');
  assert.equal(env.KILN_BLANK, '');
  assert.deepEqual(lines, []);
});

test('the warning is logged once, lists names only and never a value', () => {
  const secret = 'c2VjcmV0LXZhbHVlLWRvLW5vdC1sb2c=';
  const env: Record<string, string | undefined> = {
    MRM_MASTER_KEY: secret,
    MRM_SMTP_PASSWORD: 'hunter2',
    KILN_MODE: 'single_user',
    MRM_MODE: 'multi',
  };
  const lines: string[] = [];
  applyLegacyEnv(env, (l) => lines.push(l));
  applyLegacyEnv(env, (l) => lines.push(l));
  assert.equal(lines.length, 1, 'a second call in the same process stays quiet');
  const line = lines[0] as string;
  assert.match(line, /MRM_MASTER_KEY/);
  assert.match(line, /MRM_SMTP_PASSWORD/);
  assert.doesNotMatch(line, /MRM_MODE/, 'MRM_MODE lost to KILN_MODE and is not reported');
  assert.ok(!line.includes(secret) && !line.includes('hunter2'));
  assert.ok(!line.includes('\n'));
});

test('unset values, the bare prefix and other variables are ignored', () => {
  const env: Record<string, string | undefined> = {
    MRM_GONE: undefined,
    MRM_: 'x',
    OTHER_MRM_X: 'x',
    PATH: '/bin',
  };
  const lines: string[] = [];
  assert.deepEqual(applyLegacyEnv(env, (l) => lines.push(l)), []);
  assert.equal(env.KILN_GONE, undefined);
  assert.equal(env.KILN_, undefined);
  assert.deepEqual(lines, []);
});

test('an empty old value is carried over as an empty value', () => {
  const env: Record<string, string | undefined> = { MRM_PUBLIC_ORIGIN: '' };
  applyLegacyEnv(env, () => {});
  assert.equal(env.KILN_PUBLIC_ORIGIN, '');
});
