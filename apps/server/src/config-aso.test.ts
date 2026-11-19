import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from './config.ts';

const key = randomBytes(32).toString('base64');
const load = (env: Record<string, string>) => loadConfig({ MRM_MASTER_KEY: key, ...env });

test('ASO is off by default, Google Play is off, and the limits are conservative', () => {
  const c = load({});
  assert.equal(c.asoIntervalMinutes, 0);
  assert.equal(c.asoPlayUnofficialEnabled, false);
  assert.equal(c.asoRetentionDays, 365);
  assert.equal(c.asoMaxKeywordsPerApp, 50);
  assert.equal(c.asoMaxCompetitorsPerApp, 10);
  assert.equal(c.asoMaxChecksPerRun, 25);
  assert.equal(c.asoRankDepth, 50);
  assert.equal(c.asoCacheMs, 60 * 60_000);
  assert.equal(c.asoAppleCallsPerMinute, 10, 'below the 20 Apple documents');
  assert.equal(c.asoPlayCallsPerMinute, 4);
  assert.equal(c.asoHeartbeatMs, 7 * 24 * 60 * 60_000);
});

test('blank values mean the default', () => {
  const c = load({
    MRM_ASO_INTERVAL_MINUTES: '',
    MRM_ASO_PLAY_UNOFFICIAL_ENABLED: '',
    MRM_ASO_RETENTION_DAYS: '',
    MRM_ASO_CACHE_MINUTES: '',
  });
  assert.equal(c.asoIntervalMinutes, 0);
  assert.equal(c.asoPlayUnofficialEnabled, false);
  assert.equal(c.asoRetentionDays, 365);
  assert.equal(c.asoCacheMs, 60 * 60_000);
});

test('MRM_ASO_INTERVAL_MINUTES is 0 or 60 to 10080', () => {
  assert.equal(load({ MRM_ASO_INTERVAL_MINUTES: '0' }).asoIntervalMinutes, 0);
  assert.equal(load({ MRM_ASO_INTERVAL_MINUTES: '60' }).asoIntervalMinutes, 60);
  assert.equal(load({ MRM_ASO_INTERVAL_MINUTES: '10080' }).asoIntervalMinutes, 10_080);
  for (const bad of ['1', '59', '10081', '-5', '1.5', 'often']) {
    assert.throws(() => load({ MRM_ASO_INTERVAL_MINUTES: bad }), /MRM_ASO_INTERVAL_MINUTES/, bad);
  }
});

test('Google Play is only on for exactly true', () => {
  assert.equal(load({ MRM_ASO_PLAY_UNOFFICIAL_ENABLED: 'true' }).asoPlayUnofficialEnabled, true);
  assert.equal(load({ MRM_ASO_PLAY_UNOFFICIAL_ENABLED: 'false' }).asoPlayUnofficialEnabled, false);
  for (const bad of ['1', 'yes', 'TRUE', 'on']) {
    assert.throws(
      () => load({ MRM_ASO_PLAY_UNOFFICIAL_ENABLED: bad }),
      /MRM_ASO_PLAY_UNOFFICIAL_ENABLED/,
      bad,
    );
  }
});

test('the other ASO values are checked against their ranges', () => {
  assert.equal(load({ MRM_ASO_RETENTION_DAYS: '0' }).asoRetentionDays, 0);
  assert.equal(load({ MRM_ASO_RETENTION_DAYS: '90' }).asoRetentionDays, 90);
  assert.equal(load({ MRM_ASO_APPLE_CALLS_PER_MINUTE: '20' }).asoAppleCallsPerMinute, 20);
  assert.equal(load({ MRM_ASO_CACHE_MINUTES: '0' }).asoCacheMs, 0);
  const bad: [string, string][] = [
    ['MRM_ASO_RETENTION_DAYS', '3651'],
    ['MRM_ASO_RETENTION_DAYS', '-1'],
    ['MRM_ASO_MAX_KEYWORDS_PER_APP', '0'],
    ['MRM_ASO_MAX_KEYWORDS_PER_APP', '501'],
    ['MRM_ASO_MAX_COMPETITORS_PER_APP', '51'],
    ['MRM_ASO_MAX_CHECKS_PER_RUN', '201'],
    ['MRM_ASO_RANK_DEPTH', '9'],
    ['MRM_ASO_RANK_DEPTH', '201'],
    ['MRM_ASO_CACHE_MINUTES', '1441'],
    ['MRM_ASO_APPLE_CALLS_PER_MINUTE', '21'],
    ['MRM_ASO_PLAY_CALLS_PER_MINUTE', '0'],
    ['MRM_ASO_HEARTBEAT_DAYS', '91'],
  ];
  for (const [name, value] of bad)
    assert.throws(() => load({ [name]: value }), new RegExp(name), `${name}=${value}`);
});
