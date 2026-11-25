import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api.ts';
import { reasonKey } from '../aso/estimates.ts';
import { t } from '../i18n/t.ts';
import {
  ADS_SECTIONS,
  adsApps,
  adsCredentials,
  adsErrorText,
  adsSectionKeys,
  ariaSort,
  changeOf,
  DEFAULT_SORT,
  dailyBars,
  deltaText,
  formatMicros,
  formatRatio,
  nextSort,
  termsQueryOf,
  trackBody,
  validAdamId,
  warningText,
  withAdsSection,
} from './ads.ts';

test('only App Store records have Apple Ads, and only its own credential kind is offered', () => {
  assert.deepEqual(
    adsApps([{ platform: 'ios' }, { platform: 'android' }, { platform: 'macos' }]).map(
      (a) => a.platform,
    ),
    ['ios', 'macos'],
  );
  assert.deepEqual(
    adsCredentials([
      { kind: 'apple_ads', id: 'a' },
      { kind: 'github_token', id: 'b' },
    ] as never).map((c) => c.id),
    ['a'],
  );
  assert.deepEqual(adsCredentials(null), []);
  assert.ok(validAdamId('1234567890') && validAdamId(' 12345 '));
  assert.ok(!validAdamId('1234') && !validAdamId('abc12345') && !validAdamId('1'.repeat(16)));
});

test('micro-units are shown in the currency of the account, and no value is a dash, never zero', () => {
  assert.equal(formatMicros(10_250_000, 'EUR').replace(/\s/g, ''), '€10.25');
  assert.equal(formatMicros(null, 'EUR'), t('ads:none'));
  assert.equal(formatMicros(726_190, 'USD').replace(/\s/g, ''), '$0.73');
  assert.equal(formatMicros(0, 'USD').replace(/\s/g, ''), '$0.00', 'a real zero is a zero');
  assert.equal(formatRatio(null), t('ads:none'));
  assert.equal(formatRatio(0.05), '5%');
});

test('a change against the period before is null when there is nothing to compare with, never a division by zero', () => {
  assert.equal(changeOf(10, 0), null);
  assert.equal(changeOf(null, 5), null);
  assert.equal(changeOf(15, 10), 0.5);
  assert.equal(deltaText(null), null);
  assert.deepEqual(deltaText(0.5), { text: '+50%', tone: 'up' });
  assert.deepEqual(deltaText(-0.125), { text: '-12.5%', tone: 'down' });
  assert.equal(deltaText(0.0001)?.tone, 'flat');
});

test('daily bars scale to the largest day, and an all-zero series has no bars', () => {
  const day = (n: number) => ({
    day: `2026-11-0${n}`,
    impressions: n * 10,
    taps: 0,
    installs: 0,
    spendMicros: 0,
  });
  assert.deepEqual(dailyBars([day(1), day(2), day(4)], 'impressions'), [0.25, 0.5, 1]);
  assert.deepEqual(dailyBars([day(1), day(2)], 'taps'), [0, 0]);
  assert.deepEqual(dailyBars([], 'taps'), []);
});

test('sorting: the same heading flips, another starts largest first, the term starts A to Z; aria-sort follows', () => {
  assert.deepEqual(nextSort(DEFAULT_SORT, 'impressions'), { sort: 'impressions', dir: 'asc' });
  assert.deepEqual(nextSort(DEFAULT_SORT, 'spend'), { sort: 'spend', dir: 'desc' });
  assert.deepEqual(nextSort(DEFAULT_SORT, 'term'), { sort: 'term', dir: 'asc' });
  assert.equal(ariaSort(DEFAULT_SORT, 'impressions'), 'descending');
  assert.equal(ariaSort(DEFAULT_SORT, 'taps'), 'none');
});

test('the terms query carries the range, the sort, the page and a trimmed filter; Track keyword never invents a storefront', () => {
  const q = new URLSearchParams(
    termsQueryOf({
      kind: 'term',
      window: { from: '2026-11-01', to: '2026-11-30' },
      sort: DEFAULT_SORT,
      q: '  photo ',
      offset: 50,
    }),
  );
  assert.deepEqual(Object.fromEntries(q), {
    kind: 'term',
    from: '2026-11-01',
    to: '2026-11-30',
    sort: 'impressions',
    dir: 'desc',
    limit: '50',
    offset: '50',
    q: 'photo',
  });
  assert.equal(
    new URLSearchParams(
      termsQueryOf({
        kind: 'keyword',
        window: { from: 'a', to: 'b' },
        sort: DEFAULT_SORT,
        q: ' ',
        offset: 0,
      }),
    ).has('q'),
    false,
  );
  assert.deepEqual(trackBody({ term: 'Photo', country: 'gb' }), { term: 'Photo', country: 'gb' });
  assert.deepEqual(trackBody({ term: 'Photo', country: '' }), { term: 'Photo', country: 'us' });
});

test('the sections of the rail keep the view in the address; Overview is the default and is not written', () => {
  assert.equal(
    withAdsSection('#/portfolio/a/insights', 'terms'),
    '#/portfolio/a/insights?view=ads&section=terms',
  );
  assert.equal(
    withAdsSection('#/portfolio/a/insights?view=ads&section=terms&range=7', 'overview'),
    '#/portfolio/a/insights?view=ads&range=7',
  );
  for (const id of ADS_SECTIONS) assert.ok(t(adsSectionKeys[id]) !== '', id);
});

test('every warning code and the ads reason of the estimate has its own text; an unknown one falls back', () => {
  for (const code of [
    'cap_campaigns',
    'read_cut',
    'currency_mismatch',
    'popularity_failed',
    'popularity_partial',
    'no_campaign',
  ])
    assert.notEqual(warningText(code), t('ads:warn.unknown'), code);
  assert.equal(warningText('whatever'), t('ads:warn.unknown'));
  assert.notEqual(reasonKey('ads_impressions'), reasonKey('nope'));
});

test('an API error is shown with a fixed sentence of ours, or the server text when it has one', () => {
  assert.equal(adsErrorText(new ApiError(422, 'ads_not_linked', 'x')), t('ads:err.notLinked'));
  assert.equal(adsErrorText(new ApiError(403, 'forbidden', 'x')), t('ads:err.forbidden'));
  assert.equal(
    adsErrorText(
      new ApiError(502, 'ads_unavailable', 'x', undefined, { message: 'Apple Ads had a problem.' }),
    ),
    'Apple Ads had a problem.',
  );
  assert.equal(adsErrorText(new Error('boom')), t('common:error.genericRetry'));
});
