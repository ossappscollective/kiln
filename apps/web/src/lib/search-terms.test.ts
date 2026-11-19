import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  canConfirmTerms,
  checkImportPeriod,
  checkSearchTermsFile,
  conversionText,
  exportSteps,
  flowStep,
  freshnessLine,
  hintText,
  idleFlow,
  importedLine,
  importPeriodText,
  needsPeriod,
  periodLine,
  previewFacts,
  type SearchTermsFlow,
  type SearchTermsPlan,
  type SearchTermsResponse,
  searchTermsErrorText,
  searchTermsQueryText,
  termRows,
  totalsLine,
  trackTarget,
} from './search-terms.ts';

const plan = (over: Partial<SearchTermsPlan> = {}): SearchTermsPlan => ({
  platform: 'android',
  report: { kind: 'play_search_terms', label: 'Google Play search terms' },
  stats: { rowsRead: 6, rowsUsed: 5, rowsUnreadable: 0, rowsFiltered: 1, rowsOther: 1 },
  dateFrom: '2026-10-01',
  dateTo: '2026-10-31',
  hasDates: true,
  period: null,
  days: 31,
  rows: 5,
  terms: 3,
  countries: ['de', 'us'],
  files: 1,
  totals: { visitors: 216, installs: 16 },
  other: { visitors: 90, installs: 3 },
  top: [{ term: 'coffee timer', visitors: 84, installs: 11, conversion: 0.131 }],
  overlapsStored: 0,
  notes: [],
  ...over,
});

const insight = (over: Record<string, unknown> = {}) =>
  ({
    key: 'coffee timer',
    term: 'coffee timer',
    visitors: 84,
    installs: 11,
    conversion: 0.131,
    countries: [],
    rows: 2,
    trackedKeywordId: null,
    trackedCountries: [],
    listing: 'not_in_listing',
    inFields: [],
    hint: null,
    ...over,
  }) as SearchTermsResponse['terms'][number];

test('the query keeps only what is set, and encodes it', () => {
  assert.equal(searchTermsQueryText({}), '');
  assert.equal(
    searchTermsQueryText({ sort: 'visitors', country: 'us', limit: 20 }),
    '?country=us&sort=visitors&limit=20',
  );
  assert.equal(importPeriodText(null), '');
  assert.equal(
    importPeriodText({ from: '2026-10-01', to: '2026-10-31' }),
    'from=2026-10-01&to=2026-10-31',
  );
});

test('a file is checked for size and name before it is sent', () => {
  assert.equal(checkSearchTermsFile({ name: 'terms.csv', size: 10 }), '');
  assert.match(checkSearchTermsFile({ name: 'terms.csv', size: 0 }), /empty/);
  assert.match(checkSearchTermsFile({ name: 'terms.csv', size: 11 * 1024 * 1024 }), /10 MiB/);
  assert.match(checkSearchTermsFile({ name: 'x'.repeat(201), size: 10 }), /200/);
});

test('a period needs two real days in order, not in the future, and not longer than the cap', () => {
  assert.equal(checkImportPeriod('2026-10-01', '2026-10-31', '2026-11-19'), '');
  assert.match(checkImportPeriod('', '2026-10-31', '2026-11-19'), /year-month-day/);
  assert.match(checkImportPeriod('2026-02-30', '2026-10-31', '2026-11-19'), /year-month-day/);
  assert.match(checkImportPeriod('2026-10-31', '2026-10-01', '2026-11-19'), /after/);
  assert.match(checkImportPeriod('2026-10-01', '2026-11-20', '2026-11-19'), /future/);
  assert.match(checkImportPeriod('2025-01-01', '2026-10-31', '2026-11-19'), /at most 400/);
});

test('the steps of the import: pick, preview, confirm, done; a late answer cannot jump a step', () => {
  let s: SearchTermsFlow = idleFlow;
  s = flowStep(s, { type: 'previewed', preview: { plan: plan(), confirmHash: 'h' } });
  assert.equal(s.phase, 'idle', 'a preview with no pick is ignored');
  s = flowStep(s, { type: 'pick', fileName: 'terms.csv' });
  assert.equal(s.phase, 'checking');
  assert.equal(
    flowStep(s, { type: 'pick', fileName: 'other.csv' }),
    s,
    'busy: the second pick is ignored',
  );
  assert.equal(flowStep(s, { type: 'confirm' }), s);
  s = flowStep(s, { type: 'previewed', preview: { plan: plan(), confirmHash: 'h' } });
  assert.equal(s.phase, 'preview');
  assert.equal(canConfirmTerms(s), true);
  s = flowStep(s, { type: 'confirm' });
  assert.equal(s.phase, 'importing');
  assert.equal(flowStep(s, { type: 'reset' }), s, 'cannot reset while importing');
  s = flowStep(s, {
    type: 'imported',
    result: { rows: 5, written: 5, unchanged: 0, dateFrom: '2026-10-01', dateTo: '2026-10-31' },
  });
  assert.equal(s.phase, 'done');
  assert.equal(
    flowStep(s, { type: 'failed', during: 'import', code: 'x', message: 'y' }),
    s,
    'a failure after done is ignored',
  );
});

test('nothing to store cannot be confirmed; a failed preview asks for the period only for period_required', () => {
  let s = flowStep(flowStep(idleFlow, { type: 'pick', fileName: 'a.csv' }), {
    type: 'previewed',
    preview: { plan: plan({ rows: 0 }), confirmHash: 'h' },
  });
  assert.equal(canConfirmTerms(s), false);
  assert.equal(flowStep(s, { type: 'confirm' }), s);
  s = flowStep(flowStep(idleFlow, { type: 'pick', fileName: 'a.csv' }), {
    type: 'failed',
    during: 'preview',
    code: 'period_required',
    message: 'm',
  });
  assert.equal(needsPeriod(s), true);
  assert.equal(s.phase === 'error' && s.fileName, 'a.csv');
  const other = flowStep(flowStep(idleFlow, { type: 'pick', fileName: 'a.csv' }), {
    type: 'failed',
    during: 'preview',
    code: 'missing_columns',
    message: 'm',
  });
  assert.equal(needsPeriod(other), false);
  assert.equal(
    flowStep(s, { type: 'reset' }).phase,
    'idle',
    'an error is left by a reset, so the same file can be checked again',
  );
});

test('the preview says the period, the rows, the countries and warns about overlap', () => {
  const f = previewFacts(plan({ overlapsStored: 2 }));
  assert.match(f.period, /Oct 1, 2026 to Oct 31, 2026/);
  assert.match(f.period, /31 days, from the file/);
  assert.deepEqual(f.rows, [
    '6 rows read, 5 used',
    '1 grouped by Google as "Other"',
    '1 left out because they are not Google Play search',
  ]);
  assert.equal(f.countries, 'DE, US');
  assert.equal(f.terms, '3 terms');
  assert.match(
    f.totals ?? '',
    /216 visitors, 16 installs, of which 90 visitors, 3 installs are grouped by Google as "Other"/,
  );
  assert.equal(f.top[0]?.conversion, '13%');
  assert.equal(f.warnings.length, 1);
  assert.equal(f.willStore, '5 rows can be stored.');
  const typed = previewFacts(
    plan({
      hasDates: false,
      dateFrom: null,
      dateTo: null,
      period: { from: '2026-09-01', to: '2026-09-30' },
      countries: [],
    }),
  );
  assert.match(typed.period, /typed by you/);
  assert.equal(typed.countries, 'No country in the file');
  assert.equal(previewFacts(plan({ rows: 0 })).willStore, 'Nothing in this file can be stored.');
});

test('the line after an import says when nothing new was stored', () => {
  assert.match(
    importedLine({ rows: 5, written: 0, unchanged: 5, dateFrom: null, dateTo: null }),
    /Nothing new/,
  );
  assert.equal(
    importedLine({
      rows: 5,
      written: 4,
      unchanged: 1,
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
    }),
    'Stored 4 rows, 1 were already there for Oct 1, 2026 to Oct 31, 2026.',
  );
});

test('rows say tracked, in the listing and the hint; a term already tracked has no track button', () => {
  const rows = termRows([
    insight({ trackedKeywordId: 'k1', trackedCountries: ['us', 'de'], listing: 'in_listing' }),
    insight({
      key: 'brew guide',
      term: 'brew guide',
      installs: 1,
      conversion: null,
      listing: 'partly',
      hint: 'add_to_listing',
    }),
    insight({
      key: 'x',
      term: 'x',
      installs: null,
      visitors: null,
      conversion: null,
      listing: 'unknown',
    }),
  ]);
  assert.deepEqual(
    [rows[0]?.tracked, rows[0]?.trackedIn, rows[0]?.canTrack, rows[0]?.listing.text, rows[0]?.hint],
    [true, 'US, DE', false, 'In listing', null],
  );
  assert.deepEqual(
    [rows[1]?.canTrack, rows[1]?.conversion, rows[1]?.listing.tone],
    [true, '–', 'warn'],
  );
  assert.match(
    rows[1]?.hint ?? '',
    /Brought 1 install and is not fully in your listing text\. Add it to the description\?/,
  );
  assert.deepEqual([rows[2]?.installs, rows[2]?.listing.text], ['–', 'Listing unknown']);
  assert.equal(hintText({ hint: null, installs: 5 }), null);
  assert.equal(conversionText(0.0667), '6.7%');
});

test('the freshness line names the day of the import and the period it covers', () => {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const at = Date.parse('2026-11-12T10:00:00Z');
  assert.equal(freshnessLine({ imported: null, stored: null }, day), null);
  assert.equal(
    freshnessLine(
      {
        imported: { at, periodFrom: '2026-10-01', periodTo: '2026-10-31', imports: 1 },
        stored: null,
      },
      day,
    ),
    'Imported from a file on Nov 12, 2026, covering Oct 1, 2026 to Oct 31, 2026.',
  );
  assert.match(
    freshnessLine(
      {
        imported: { at, periodFrom: null, periodTo: null, imports: 1 },
        stored: { from: '2026-10-05', to: '2026-10-06', countries: [], rows: 3 },
      },
      day,
    ) ?? '',
    /covering Oct 5, 2026 to Oct 6, 2026/,
  );
  assert.match(
    freshnessLine(
      {
        imported: { at, periodFrom: '2026-10-02', periodTo: '2026-10-02', imports: 1 },
        stored: null,
      },
      day,
    ) ?? '',
    /covering Oct 2, 2026\.$/,
  );
});

test('the period line and the totals', () => {
  assert.equal(
    periodLine({
      from: '2026-10-01',
      to: '2026-10-31',
      termCount: 3,
      terms: [insight(), insight(), insight()],
      country: null,
    }),
    '3 terms, Oct 1, 2026 to Oct 31, 2026.',
  );
  assert.equal(
    periodLine({
      from: '2026-10-01',
      to: '2026-10-31',
      termCount: 120,
      terms: [insight()],
      country: 'us',
    }),
    'the top 1 of 120 terms in US, Oct 1, 2026 to Oct 31, 2026.',
  );
  assert.equal(totalsLine({ totals: { visitors: null, installs: null }, other: null }), null);
  assert.equal(
    totalsLine({ totals: { visitors: 1, installs: 1 }, other: null }),
    'In the period: 1 visitor, 1 install.',
  );
});

test('a one-click track uses the chosen country, else the market with most tracked keywords, else nothing', () => {
  assert.deepEqual(trackTarget({ country: 'de', locale: 'de-DE' }, []), {
    country: 'de',
    locale: 'de-DE',
  });
  const ks = [
    { country: 'us', locale: 'en-US' },
    { country: 'gb', locale: 'en-GB' },
    { country: 'gb', locale: 'en-GB' },
  ];
  assert.deepEqual(trackTarget({ country: null, locale: 'en-US' }, ks), {
    country: 'gb',
    locale: 'en-GB',
  });
  assert.equal(trackTarget({ country: null, locale: 'en-US' }, []), null);
});

test('errors use the fixed sentences, never the server text', () => {
  const e = (code: string, status = 422) =>
    new ApiError(status, code, 'SECRET TEXT FROM THE SERVER', undefined);
  assert.match(searchTermsErrorText(e('not_google_play_app')), /only for Google Play/);
  assert.match(searchTermsErrorText(e('period_required')), /no date column/);
  assert.match(searchTermsErrorText(e('bad_zip')), /zip/);
  assert.match(searchTermsErrorText(e('confirm_mismatch', 409)), /not the file/);
  assert.ok(!searchTermsErrorText(e('whatever')).includes('SECRET'));
  assert.match(searchTermsErrorText(new Error('x')), /Something went wrong/);
});

test('the export steps say where to look and to use English', () => {
  assert.ok(exportSteps.some((s) => /Export report/.test(s)));
  assert.ok(exportSteps.some((s) => /English/.test(s)));
});
