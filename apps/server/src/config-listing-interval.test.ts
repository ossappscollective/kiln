import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from './config.ts';

const key = randomBytes(32).toString('base64');

test('MRM_LISTING_INTERVAL_MINUTES is off by default, blank means off, and the range is checked', () => {
  assert.equal(loadConfig({ MRM_MASTER_KEY: key }).listingIntervalMinutes, 0);
  assert.equal(
    loadConfig({ MRM_MASTER_KEY: key, MRM_LISTING_INTERVAL_MINUTES: '' }).listingIntervalMinutes,
    0,
  );
  assert.equal(
    loadConfig({ MRM_MASTER_KEY: key, MRM_LISTING_INTERVAL_MINUTES: '0' }).listingIntervalMinutes,
    0,
  );
  assert.equal(
    loadConfig({ MRM_MASTER_KEY: key, MRM_LISTING_INTERVAL_MINUTES: '30' }).listingIntervalMinutes,
    30,
  );
  assert.equal(
    loadConfig({ MRM_MASTER_KEY: key, MRM_LISTING_INTERVAL_MINUTES: '1440' })
      .listingIntervalMinutes,
    1440,
  );
  assert.equal(
    loadConfig({ MRM_MASTER_KEY: key, MRM_LISTING_INTERVAL_MINUTES: '10080' })
      .listingIntervalMinutes,
    10_080,
  );
  for (const bad of ['1', '29', '10081', '-30', '45.5', 'often']) {
    assert.throws(
      () => loadConfig({ MRM_MASTER_KEY: key, MRM_LISTING_INTERVAL_MINUTES: bad }),
      /MRM_LISTING_INTERVAL_MINUTES/,
      bad,
    );
  }
});

test('the listing interval and the sync interval are independent settings', () => {
  const config = loadConfig({ MRM_MASTER_KEY: key, MRM_SYNC_INTERVAL_MINUTES: '60' });
  assert.equal(config.syncIntervalMinutes, 60);
  assert.equal(config.listingIntervalMinutes, 0);
});
