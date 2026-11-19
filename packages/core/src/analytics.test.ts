import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MICRO,
  addDays,
  analyticsErrorCodes,
  analyticsErrorMessages,
  analyticsMetrics,
  analyticsNextSteps,
  analyticsSetupCodes,
  analyticsSources,
  bucketStart,
  bucketStarts,
  coverageNoteCodes,
  coverageNoteMessages,
  dateToDay,
  daysBetween,
  fromMicro,
  isIsoDate,
  metricInfo,
  metricsOfSource,
  normalizeBucketId,
  normalizeVendorNumber,
  safeRatio,
  sourcesForPlatform,
  toMicro,
} from './analytics.ts';

test('every metric belongs to one source and has a label, a unit and a delay', () => {
  for (const metric of analyticsMetrics) {
    const info = metricInfo[metric];
    assert.ok(analyticsSources.includes(info.source), metric);
    assert.ok(info.label.length > 0 && info.delayDays >= 0, metric);
    assert.ok(metricsOfSource(info.source).includes(metric), metric);
  }
  assert.deepEqual(sourcesForPlatform('ios'), ['apple_analytics', 'apple_sales']);
  assert.deepEqual(sourcesForPlatform('macos'), ['apple_analytics', 'apple_sales']);
  assert.deepEqual(sourcesForPlatform('android'), ['play_vitals', 'play_reports']);
});

test('counts and money add up; rates and ratings are averaged', () => {
  for (const metric of analyticsMetrics) {
    const { unit, aggregation } = metricInfo[metric];
    if (unit === 'ratio' || unit === 'rating') assert.equal(aggregation, 'mean', metric);
    if (unit === 'money') assert.equal(aggregation, 'sum', metric);
  }
  assert.equal(metricInfo.active_installs_device.aggregation, 'mean', 'a stock, not a flow');
});

test('every error, setup, next-step and coverage code has a plain sentence or a place in its vocabulary', () => {
  for (const code of analyticsErrorCodes) assert.ok(analyticsErrorMessages[code].length > 10, code);
  for (const code of coverageNoteCodes) assert.ok(coverageNoteMessages[code].length > 10, code);
  assert.equal(new Set(analyticsSetupCodes).size, analyticsSetupCodes.length);
  assert.equal(new Set(analyticsNextSteps).size, analyticsNextSteps.length);
  // No message carries a URL, a token or a secret: they are fixed sentences.
  for (const text of [...Object.values(analyticsErrorMessages), ...Object.values(coverageNoteMessages)]) {
    assert.ok(!/https?:\/\/|Bearer|BEGIN|X-Amz/i.test(text), text);
  }
});

test('values are stored as micro integers: six decimals survive, a sum is exact', () => {
  assert.equal(MICRO, 1_000_000);
  assert.equal(toMicro(0.0123), 12_300);
  assert.equal(fromMicro(toMicro(4.31)), 4.31);
  assert.equal(toMicro(0.1) + toMicro(0.2), toMicro(0.3), 'no floating point drift');
  assert.ok(Number.isSafeInteger(toMicro(9_000_000_000)));
});

test('dates: real calendar days only; arithmetic in UTC', () => {
  assert.equal(isIsoDate('2026-11-19'), true);
  for (const bad of ['2026-02-30', '2026-13-01', '26-11-19', '2026-11-19T00:00:00Z', '', 5, undefined]) assert.equal(isIsoDate(bad), false, String(bad));
  assert.equal(addDays('2026-11-19', -19), '2026-10-31');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(daysBetween('2026-11-01', '2026-11-19'), 18);
  assert.equal(dateToDay(Date.UTC(2026, 10, 19, 23, 59, 59)), '2026-11-19');
});

test('buckets: a week starts on Monday, a month on the first; every day lands in exactly one bucket', () => {
  assert.equal(bucketStart('2026-11-19', 'day'), '2026-11-19');
  assert.equal(bucketStart('2026-11-19', 'week'), '2026-11-16', 'a Thursday');
  assert.equal(bucketStart('2026-11-22', 'week'), '2026-11-16', 'a Sunday belongs to the week before');
  assert.equal(bucketStart('2026-11-23', 'week'), '2026-11-23');
  assert.equal(bucketStart('2026-11-19', 'month'), '2026-11-01');
  assert.deepEqual(bucketStarts('2026-11-19', '2026-12-02', 'week'), ['2026-11-16', '2026-11-23', '2026-11-30']);
  assert.deepEqual(bucketStarts('2026-11-30', '2027-01-02', 'month'), ['2026-11-01', '2026-12-01', '2027-01-01']);
  assert.equal(bucketStarts('2026-11-01', '2026-11-30', 'day').length, 30);
});

test('a ratio is null, never NaN or infinity, when it cannot be computed', () => {
  assert.equal(safeRatio(1, 4), 0.25);
  assert.equal(safeRatio(0, 4), 0);
  for (const [n, d] of [[1, 0], [null, 4], [4, null], [1, -2]] as const) assert.equal(safeRatio(n, d), null);
});

test('a vendor number is digits; a bucket id is pubsite_prod_rev_ and digits, with or without gs://', () => {
  assert.equal(normalizeVendorNumber(' 85123456 '), '85123456');
  for (const bad of ['', 'abc', '1234', '1234567890123', '85 12 34', '85123456; DROP']) assert.equal(normalizeVendorNumber(bad), undefined, bad);
  assert.equal(normalizeBucketId('gs://pubsite_prod_rev_01234567890123456789/'), 'pubsite_prod_rev_01234567890123456789');
  assert.equal(normalizeBucketId('pubsite_prod_rev_01234567890123456789'), 'pubsite_prod_rev_01234567890123456789');
  for (const bad of ['', 'my-bucket', 'pubsite_prod_rev_', 'pubsite_prod_rev_12/../x', 'https://storage.googleapis.com/pubsite_prod_rev_123456']) {
    assert.equal(normalizeBucketId(bad), undefined, bad);
  }
});
