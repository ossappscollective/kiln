import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from './config.ts';

const key = randomBytes(32).toString('base64');

test('MRM_SYNC_INTERVAL_MINUTES is off by default, blank means off, and the range is checked', () => {
  assert.equal(loadConfig({ MRM_MASTER_KEY: key }).syncIntervalMinutes, 0);
  assert.equal(
    loadConfig({ MRM_MASTER_KEY: key, MRM_SYNC_INTERVAL_MINUTES: '' }).syncIntervalMinutes,
    0,
  );
  assert.equal(
    loadConfig({ MRM_MASTER_KEY: key, MRM_SYNC_INTERVAL_MINUTES: '0' }).syncIntervalMinutes,
    0,
  );
  assert.equal(
    loadConfig({ MRM_MASTER_KEY: key, MRM_SYNC_INTERVAL_MINUTES: '60' }).syncIntervalMinutes,
    60,
  );
  assert.equal(
    loadConfig({ MRM_MASTER_KEY: key, MRM_SYNC_INTERVAL_MINUTES: '5' }).syncIntervalMinutes,
    5,
  );
  assert.equal(
    loadConfig({ MRM_MASTER_KEY: key, MRM_SYNC_INTERVAL_MINUTES: '10080' }).syncIntervalMinutes,
    10_080,
  );
  for (const bad of ['1', '4', '10081', '-5', '1.5', 'often']) {
    assert.throws(
      () => loadConfig({ MRM_MASTER_KEY: key, MRM_SYNC_INTERVAL_MINUTES: bad }),
      /MRM_SYNC_INTERVAL_MINUTES/,
      bad,
    );
  }
});
