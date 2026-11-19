import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from './config.ts';

const key = randomBytes(32).toString('base64');
const load = (env: Record<string, string>) => loadConfig({ MRM_MASTER_KEY: key, ...env });

test('the analytics interval defaults to six hours, and a blank value is the default', () => {
  assert.equal(load({}).analyticsIntervalMinutes, 360);
  assert.equal(load({ MRM_ANALYTICS_INTERVAL_MINUTES: '' }).analyticsIntervalMinutes, 360);
});

test('MRM_ANALYTICS_INTERVAL_MINUTES is 0 (off) or 15 to 10080', () => {
  assert.equal(load({ MRM_ANALYTICS_INTERVAL_MINUTES: '0' }).analyticsIntervalMinutes, 0);
  assert.equal(load({ MRM_ANALYTICS_INTERVAL_MINUTES: '15' }).analyticsIntervalMinutes, 15);
  assert.equal(load({ MRM_ANALYTICS_INTERVAL_MINUTES: '10080' }).analyticsIntervalMinutes, 10_080);
  for (const bad of ['1', '14', '10081', '-5', '1.5', 'often']) {
    assert.throws(
      () => load({ MRM_ANALYTICS_INTERVAL_MINUTES: bad }),
      /MRM_ANALYTICS_INTERVAL_MINUTES/,
      bad,
    );
  }
});
