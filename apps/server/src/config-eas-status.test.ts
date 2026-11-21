import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from './config.ts';

const key = randomBytes(32).toString('base64');
const load = (env: Record<string, string>) => loadConfig({ KILN_MASTER_KEY: key, ...env });

test('the EAS status interval defaults to 30 minutes, and a blank value is the default', () => {
  assert.equal(load({}).easStatusIntervalMinutes, 30);
  assert.equal(load({ KILN_EAS_STATUS_INTERVAL_MINUTES: '' }).easStatusIntervalMinutes, 30);
});

test('KILN_EAS_STATUS_INTERVAL_MINUTES is 0 (off) or 5 to 10080', () => {
  assert.equal(load({ KILN_EAS_STATUS_INTERVAL_MINUTES: '0' }).easStatusIntervalMinutes, 0);
  assert.equal(load({ KILN_EAS_STATUS_INTERVAL_MINUTES: '5' }).easStatusIntervalMinutes, 5);
  assert.equal(load({ KILN_EAS_STATUS_INTERVAL_MINUTES: '10080' }).easStatusIntervalMinutes, 10_080);
  for (const bad of ['1', '4', '10081', '2.5', 'soon']) {
    assert.throws(() => load({ KILN_EAS_STATUS_INTERVAL_MINUTES: bad }), /KILN_EAS_STATUS_INTERVAL_MINUTES/, bad);
  }
});
