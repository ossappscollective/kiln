import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from './config.ts';

const key = randomBytes(32).toString('base64');

test('KILN_SYNC_INTERVAL_MINUTES is 30 by default (blank too), 0 turns it off, and the range is checked', () => {
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).syncIntervalMinutes, 30);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_SYNC_INTERVAL_MINUTES: '' }).syncIntervalMinutes,
    30,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_SYNC_INTERVAL_MINUTES: '0' }).syncIntervalMinutes,
    0,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_SYNC_INTERVAL_MINUTES: '60' }).syncIntervalMinutes,
    60,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_SYNC_INTERVAL_MINUTES: '5' }).syncIntervalMinutes,
    5,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_SYNC_INTERVAL_MINUTES: '10080' }).syncIntervalMinutes,
    10_080,
  );
  for (const bad of ['1', '4', '10081', '-5', '1.5', 'often']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_SYNC_INTERVAL_MINUTES: bad }),
      /KILN_SYNC_INTERVAL_MINUTES/,
      bad,
    );
  }
});
