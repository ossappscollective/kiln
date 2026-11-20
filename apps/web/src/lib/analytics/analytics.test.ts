import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api.ts';
import {
  analyticsErrorText,
  bucketSourceText,
  customRangeProblem,
  DEFAULT_RANGE,
  deltaLine,
  deltaSpoken,
  deltaTone,
  deriveRatioSeries,
  formatCount,
  formatDay,
  formatExact,
  formatMoney,
  formatPercent,
  formatValue,
  freshnessLine,
  hasData,
  isProvisional,
  lagText,
  lastValue,
  levelDelta,
  MAX_RANGE_DAYS,
  missingRuns,
  needsPlayBucket,
  noteText,
  parseRange,
  periodDelta,
  playSourceLine,
  presentRuns,
  previousRange,
  rangeText,
  resolveRange,
  runsWhere,
  setupSentence,
  stateOf,
  stepAction,
  stepAvailable,
  storedErrorText,
  withRange,
} from './analytics.ts';
import { appleOverview, FROM, mkSeries, NOW, sourceOf, statusOf, TO, wave } from './fixtures.ts';

const series = (values: (number | null)[], over: Partial<Parameters<typeof mkSeries>[0]> = {}) =>
  mkSeries({ id: 'x', label: 'X', unit: 'count', source: 'apple_analytics', values, ...over });

// ---- range ----

test('a preset range ends yesterday and the previous period is the same length right before it', () => {
  const r = resolveRange({ kind: 'preset', days: 28 }, NOW);
  assert.deepEqual(r, { from: FROM, to: TO, days: 28 });
  const p = previousRange(r);
  assert.deepEqual(p, { from: '2026-09-24', to: '2026-10-21', days: 28 });
  assert.deepEqual(resolveRange({ kind: 'preset', days: 7 }, NOW), {
    from: '2026-11-12',
    to: '2026-11-18',
    days: 7,
  });
});

test('a custom range is held inside today and keeps its length', () => {
  assert.deepEqual(resolveRange({ kind: 'custom', from: '2026-11-01', to: '2026-11-10' }, NOW), {
    from: '2026-11-01',
    to: '2026-11-10',
    days: 10,
  });
  assert.deepEqual(resolveRange({ kind: 'custom', from: '2026-11-01', to: '2027-01-01' }, NOW), {
    from: '2026-11-01',
    to: '2026-11-19',
    days: 19,
  });
  assert.deepEqual(resolveRange({ kind: 'custom', from: '2027-02-01', to: '2027-03-01' }, NOW), {
    from: '2026-11-19',
    to: '2026-11-19',
    days: 1,
  });
});

test('the range lives in the address: the default is clean and a bad value reads as the default', () => {
  assert.deepEqual(parseRange('#/portfolio/a/analytics'), DEFAULT_RANGE);
  assert.deepEqual(parseRange('#/portfolio/a/analytics?range=90'), { kind: 'preset', days: 90 });
  assert.deepEqual(parseRange('#/portfolio/a/analytics?range=13'), DEFAULT_RANGE);
  assert.deepEqual(parseRange('#/portfolio/a/analytics?from=2026-10-01&to=2026-10-31'), {
    kind: 'custom',
    from: '2026-10-01',
    to: '2026-10-31',
  });
  assert.deepEqual(
    parseRange('#/portfolio/a/analytics?from=2026-10-31&to=2026-10-01'),
    DEFAULT_RANGE,
  );
  assert.deepEqual(
    parseRange('#/portfolio/a/analytics?from=2026-13-01&to=2026-10-01'),
    DEFAULT_RANGE,
  );
  assert.deepEqual(
    parseRange('#/portfolio/a/analytics?from=2024-01-01&to=2026-10-01'),
    DEFAULT_RANGE,
  );
});

test('withRange writes only what differs from the default and keeps other parts of the address', () => {
  const base = '#/portfolio/a/analytics?platform=ios';
  assert.equal(withRange(base, { kind: 'preset', days: 28 }), base);
  assert.equal(
    withRange(base, { kind: 'preset', days: 7 }),
    '#/portfolio/a/analytics?platform=ios&range=7',
  );
  assert.equal(withRange('#/portfolio/a/analytics?range=7&platform=ios', DEFAULT_RANGE), base);
  assert.equal(
    withRange('#/portfolio/a/analytics?range=7', DEFAULT_RANGE),
    '#/portfolio/a/analytics',
  );
  assert.equal(
    withRange('#/portfolio/a/analytics?range=7', {
      kind: 'custom',
      from: '2026-10-01',
      to: '2026-10-31',
    }),
    '#/portfolio/a/analytics?from=2026-10-01&to=2026-10-31',
  );
});

test('custom range problems are said in a sentence and an acceptable range gives an empty string', () => {
  assert.equal(customRangeProblem('2026-10-01', '2026-10-31', NOW), '');
  assert.match(customRangeProblem('', '2026-10-31', NOW), /both dates/);
  assert.match(customRangeProblem('2026-10-31', '2026-10-01', NOW), /not be after/);
  assert.match(customRangeProblem('2026-10-01', '2026-11-20', NOW), /future/);
  assert.match(
    customRangeProblem('2025-01-01', '2026-11-01', NOW),
    new RegExp(String(MAX_RANGE_DAYS)),
  );
});

test('rangeText names a preset or the dates', () => {
  const choice = { kind: 'custom', from: '2026-10-01', to: '2026-10-31' } as const;
  assert.equal(
    rangeText({ kind: 'preset', days: 90 }, resolveRange({ kind: 'preset', days: 90 }, NOW)),
    'Last 90 days',
  );
  assert.equal(rangeText(choice, resolveRange(choice, NOW)), 'Oct 1, 2026 to Oct 31, 2026');
});

// ---- formatting ----

test('counts: whole numbers in full under ten thousand and compact above, exact in tooltips', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(1284), '1,284');
  assert.equal(formatCount(9999), '9,999');
  assert.equal(formatCount(12_900), '12.9K');
  assert.equal(formatCount(4_200_000), '4.2M');
  assert.equal(formatCount(-12_900), '-12.9K');
  assert.equal(formatCount(Number.NaN), '');
  assert.equal(formatExact('count', 12_345), '12,345');
  assert.equal(formatExact('count', 1234567), '1,234,567');
});

test('percentages carry the digits their size needs and no more precision than the data has', () => {
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(0.0123), '1.2%');
  assert.equal(formatPercent(0.0049), '0.49%');
  assert.equal(formatPercent(0.2), '20%');
  assert.equal(formatPercent(0.0123, true), '1.23%');
  assert.equal(formatValue('ratio', 0.034), '3.4%');
  assert.equal(formatExact('ratio', 0.034), '3.40%');
});

test('money stays in its own currency and an unknown code is text, never a conversion', () => {
  assert.equal(formatMoney(12.5, 'USD'), '$12.50');
  assert.equal(formatMoney(12345.678, 'USD'), '$12,346');
  assert.equal(formatMoney(12345.678, 'USD', true), '$12,345.68');
  assert.match(formatMoney(12.5, 'EUR'), /12\.50/);
  assert.equal(formatMoney(12.5, 'zz'), 'zz 12.50');
  assert.equal(formatMoney(12.5, null), '12.50');
  assert.equal(formatValue('rating', 4.3), '4.30');
});

test('days are written from the text of the date', () => {
  assert.equal(formatDay('2026-11-03'), 'Nov 3');
  assert.equal(formatDay('2026-01-31', true), 'Jan 31, 2026');
  assert.equal(formatDay('nonsense'), 'nonsense');
});

// ---- series gaps ----

test('runs: gaps are separated and never bridged', () => {
  assert.deepEqual(runsWhere([true, true, false, true]), [
    { start: 0, end: 1 },
    { start: 3, end: 3 },
  ]);
  assert.deepEqual(presentRuns([1, 2, null, null, 5, null]), [
    { start: 0, end: 1 },
    { start: 4, end: 4 },
  ]);
  assert.deepEqual(missingRuns([1, 2, null, null, 5, null]), [
    { start: 2, end: 3 },
    { start: 5, end: 5 },
  ]);
  assert.deepEqual(presentRuns([]), []);
  assert.deepEqual(presentRuns([null, null]), []);
});

test('hasData and lastValue treat missing as missing and zero as a value', () => {
  assert.equal(hasData(series([null, null])), false);
  assert.equal(hasData(series([null, 0])), true);
  assert.equal(hasData(null), false);
  assert.equal(lastValue(series([1, 2, null])), 2);
  assert.equal(lastValue(series([null, null])), null);
  assert.equal(lastValue(series([3, 0])), 0);
});

test('a derived ratio is missing wherever either side is missing or the denominator is zero', () => {
  const num = series([1, null, 3, 4], { id: 'n', notes: ['apple_privacy_thresholds'] });
  const den = series([10, 10, 0, 8], { id: 'd', delayDays: 5 });
  const ratio = deriveRatioSeries({ id: 'r', label: 'R', numerator: num, denominator: den });
  assert.deepEqual(
    ratio.points.map((p) => p.value),
    [0.1, null, null, 0.5],
  );
  assert.equal(ratio.derived, true);
  assert.equal(ratio.unit, 'ratio');
  assert.equal(ratio.delayDays, 5);
  assert.equal(ratio.coverage.days, 2);
  assert.equal(ratio.coverage.gapDays, 2);
  assert.equal(ratio.coverage.state, 'partial');
  const codes = ratio.coverage.notes.map((n) => n.code);
  assert.ok(codes.includes('derived'));
  assert.ok(codes.includes('gaps'));
  assert.ok(codes.includes('apple_privacy_thresholds'));
});

test('a day is provisional while it is within the delay of today', () => {
  assert.equal(isProvisional('2026-11-18', '2026-11-19', 3), true);
  assert.equal(isProvisional('2026-11-16', '2026-11-19', 3), true);
  assert.equal(isProvisional('2026-11-15', '2026-11-19', 3), false);
});

// ---- deltas ----

test('period delta compares totals and says how much, as a sign and a percentage', () => {
  const cur = series(Array.from({ length: 28 }, () => 110));
  const prev = series(Array.from({ length: 28 }, () => 100));
  const d = periodDelta(cur, prev, 28);
  assert.deepEqual(d, { kind: 'change', direction: 'up', text: '+10%' });
  assert.equal(deltaLine(d, 28), '+10% vs previous 28 days');
  assert.equal(deltaSpoken(d, 28), 'Up 10% compared with the previous 28 days');
  assert.equal(deltaTone(d, true), 'ok');
  assert.equal(deltaTone(d, false), 'bad');
});

test('period delta: small differences are flat, a zero previous total gives no percentage', () => {
  const same = periodDelta(
    series(Array.from({ length: 28 }, () => 100.5)),
    series(Array.from({ length: 28 }, () => 100)),
    28,
  );
  assert.deepEqual(same, { kind: 'flat' });
  assert.equal(deltaLine(same, 28), 'About the same as the previous 28 days');
  assert.equal(deltaTone(same, true), 'neutral');
  const zero = periodDelta(
    series(Array.from({ length: 28 }, () => 5)),
    series(Array.from({ length: 28 }, () => 0)),
    28,
  );
  assert.deepEqual(zero, { kind: 'none', reason: 'no_previous' });
  assert.equal(deltaLine(zero, 28), '');
});

test('period delta refuses a half-empty period or two unequal stretches: it says there is not enough data', () => {
  const full = series(Array.from({ length: 28 }, () => 100));
  const half = series([
    ...Array.from({ length: 12 }, () => 100),
    ...Array.from({ length: 16 }, () => null),
  ]);
  const d = periodDelta(half, full, 28);
  assert.deepEqual(d, { kind: 'none', reason: 'not_enough_data' });
  assert.equal(deltaLine(d, 28), 'Not enough data to compare');
  assert.deepEqual(periodDelta(full, half, 28), { kind: 'none', reason: 'not_enough_data' });
  // 18 against 28 days present: both over the minimum, but the stretches differ by more than 15 percent of the days
  const eighteen = series([
    ...Array.from({ length: 18 }, () => 100),
    ...Array.from({ length: 10 }, () => null),
  ]);
  assert.deepEqual(periodDelta(eighteen, full, 28), { kind: 'none', reason: 'not_enough_data' });
  assert.deepEqual(periodDelta(null, full, 28), { kind: 'none', reason: 'no_current' });
  assert.deepEqual(periodDelta(full, null, 28), { kind: 'none', reason: 'no_previous' });
  assert.deepEqual(periodDelta(series([null, null]), full, 28), {
    kind: 'none',
    reason: 'no_current',
  });
});

test('rates compare in percentage points and a mean needs only a few days', () => {
  const cur = series([0.05, 0.05, 0.05], { unit: 'ratio', aggregation: 'mean' });
  const prev = series([0.04, 0.04, 0.04], { unit: 'ratio', aggregation: 'mean' });
  const d = periodDelta(cur, prev, 28);
  assert.deepEqual(d, { kind: 'change', direction: 'up', text: '+1.0 pts' });
  assert.equal(deltaTone(d, false), 'bad');
});

test('a rating is a level: the newest value against the newest value before', () => {
  const cur = series([4.2, 4.4], { unit: 'rating', aggregation: 'mean' });
  const prev = series([4.1, 4.3], { unit: 'rating', aggregation: 'mean' });
  assert.deepEqual(levelDelta(cur, prev), { kind: 'change', direction: 'up', text: '+0.10' });
  assert.deepEqual(levelDelta(cur, null), { kind: 'none', reason: 'no_previous' });
  assert.deepEqual(levelDelta(null, prev), { kind: 'none', reason: 'no_current' });
});

// ---- honesty lines ----

test('every series says where it comes from and how late it can be', () => {
  assert.match(lagText('apple_analytics', 3), /up to 3 days/);
  assert.match(lagText('play_vitals', 1), /up to 1 day$/);
  assert.match(lagText('apple_sales', 1), /next day/);
  assert.match(lagText('somewhere', 2), /store can lag up to 2 days/);
  const s = series([1, 2, 3]);
  assert.match(freshnessLine(s), /^Data up to Oct 24\. Apple reports can lag up to 3 days\.$/);
  assert.match(freshnessLine(series([null, null])), /^No data yet\./);
});

test('coverage notes come from the fixed vocabulary and an unknown code gets a generic sentence', () => {
  assert.notEqual(
    noteText({ code: 'derived', message: 'anything the server says' }),
    'anything the server says',
  );
  assert.equal(
    noteText({ code: 'not_a_code', message: 'store text <b>' }),
    'A limit of the store data applies here.',
  );
});

test('errors are sentences from fixed lists and never the server message', () => {
  const err = (code: string, status = 400, retryAfter?: number) =>
    new ApiError(status, code, 'SERVER TEXT', retryAfter);
  assert.equal(
    analyticsErrorText(err('analytics_disabled')),
    'Analytics is off for this workspace. Turn it on first.',
  );
  assert.match(analyticsErrorText(err('plan_changed', 409)), /changed since the preview/);
  assert.equal(analyticsErrorText(new Error('boom')), 'Something went wrong. Try again.');
  assert.equal(analyticsErrorText(err('weird', 500)), 'The server had a problem. Try again.');
  assert.equal(analyticsErrorText(err('weird', 400)), 'The analytics request failed. Try again.');
  for (const code of ['analytics_disabled', 'plan_changed', 'weird', 'rate_limited']) {
    assert.ok(!analyticsErrorText(err(code)).includes('SERVER TEXT'));
  }
  assert.match(analyticsErrorText(err('rate_limited', 429, 1)), /1 second\./);
  assert.match(analyticsErrorText(err('rate_limited', 429)), /in a minute/);
  assert.match(storedErrorText('not_a_code'), /\S/);
});

// ---- status to next step ----

test('a next step is a button only for those who may manage; words and links are for everyone', () => {
  const turnOn = stepAction('turn_on_analytics');
  assert.equal(turnOn.kind, 'turn_on');
  assert.equal(stepAvailable(turnOn, false), false);
  assert.equal(stepAvailable(turnOn, true), true);
  assert.equal(stepAction('enable_apple_analytics').kind, 'enable_apple');
  assert.equal(stepAction('import_apple_report').kind, 'import');
  assert.equal(stepAction('sync_now').kind, 'sync');
  const bucket = stepAction('set_bucket_id');
  assert.deepEqual(bucket, { kind: 'bucket', label: 'Set the reports bucket', needs: 'manage' });
  assert.equal(stepAvailable(bucket, false), false, 'only an owner or an admin sets it');
  assert.equal(stepAvailable(bucket, true), true);
  const cred = stepAction('fix_credential');
  assert.equal(cred.kind === 'link' && cred.target, 'credentials');
  assert.equal(stepAction('wait').kind, 'text');
  assert.equal(stepAction('ask_apple_admin').kind, 'text');
  assert.equal(stepAction('anything else').label, 'Next step');
});

test('setup codes read as plain sentences, unknown ones as a generic sentence; unknown states need setup', () => {
  assert.match(setupSentence('role_required'), /Import a report file/);
  assert.match(setupSentence('bucket_id_missing'), /reports/);
  assert.match(setupSentence('nope'), /needs attention/);
  assert.equal(stateOf('ready'), 'ready');
  assert.equal(stateOf('what'), 'needs_setup');
});

// ---- fixture sanity (so later tests lean on sound data) ----

test('the fixture overview has the shapes the API documents', () => {
  const o = appleOverview();
  assert.equal(o.series.length > 8, true);
  assert.equal(wave(3, 10, 0).length, 3);
  const gap = appleOverview({ gap: true }).series.find((s) => s.id === 'impressions');
  assert.equal(gap?.coverage.gapDays, 2);
});

// ---- the Google Play reports bucket ----

test('an Android app without a reports bucket says so; an iOS app and an app with a bucket do not', () => {
  assert.equal(needsPlayBucket(null), false);
  assert.equal(needsPlayBucket(statusOf()), false, 'iOS has no bucket');
  assert.equal(
    needsPlayBucket(statusOf({ google: { bucketIdSet: false, bucketSource: null } })),
    true,
  );
  assert.equal(
    needsPlayBucket(statusOf({ google: { bucketIdSet: true, bucketSource: 'app' } })),
    false,
  );
});

test('the status line names each Android source: Vitals connected, Installs not set up until a bucket is', () => {
  const vitals = sourceOf({ source: 'play_vitals', label: 'Android vitals', state: 'ready' });
  const reports = sourceOf({
    source: 'play_reports',
    label: 'Play Console reports',
    state: 'needs_setup',
  });
  const without = statusOf({
    platform: 'android',
    apple: null,
    google: { bucketIdSet: false, bucketSource: null },
    sources: [vitals, reports],
  });
  assert.equal(playSourceLine(without), 'Vitals: connected · Installs: not set up');
  const withBucket = statusOf({
    platform: 'android',
    apple: null,
    google: { bucketIdSet: true, bucketSource: 'workspace' },
    sources: [vitals, { ...reports, state: 'ready' }],
  });
  assert.equal(playSourceLine(withBucket), 'Vitals: connected · Installs: connected');
  const failing = statusOf({
    platform: 'android',
    apple: null,
    google: { bucketIdSet: true, bucketSource: 'app' },
    sources: [vitals, { ...reports, state: 'error' }],
  });
  assert.equal(playSourceLine(failing), 'Vitals: connected · Installs: last read failed');
});

test('where the bucket comes from, in words', () => {
  assert.equal(bucketSourceText({ source: 'app', sharedWith: 3 }), 'Set for this app only.');
  assert.equal(
    bucketSourceText({ source: 'workspace', sharedWith: 3 }),
    'Set in the workspace settings.',
  );
  assert.equal(
    bucketSourceText({ source: 'account', sharedWith: 3 }),
    'Shared by the 3 Android apps of this Play account.',
  );
  assert.equal(bucketSourceText({ source: null, sharedWith: 1 }), 'Not set.');
});
