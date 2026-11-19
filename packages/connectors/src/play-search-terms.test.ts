import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyticsError } from './analytics-types.ts';
import { parseCountCell, parseRatioCell, parseSearchDay, readSearchTermsFile } from './play-search-terms.ts';
import { csv, enc, gz, periodCsv, renamedCsv, trafficSourceCsv, utf16, zip } from './play-search-terms.fixtures.ts';
import { isZip, readZipEntries } from './zip.ts';

const fails = async (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof AnalyticsError && e.code === code, `expected ${code}`);

test('the documented traffic_source file: search rows only, Other kept apart, dated per day', async () => {
  const r = await readSearchTermsFile(enc(trafficSourceCsv()));
  assert.deepEqual(r.stats, { rowsRead: 7, rowsUsed: 5, rowsUnreadable: 0, rowsFiltered: 2, rowsOther: 1 });
  assert.equal(r.hasDates, true);
  assert.equal(r.hasCountry, false);
  assert.equal(r.terms, 3);
  assert.deepEqual([r.dateFrom, r.dateTo], ['2026-11-02', '2026-11-03']);
  const coffee = r.points.filter((p) => p.key === 'coffee timer');
  assert.deepEqual(coffee.map((p) => [p.from, p.to, p.visitors, p.installs, p.conversion]), [['2026-11-02', '2026-11-02', 40, 5, 0.125], ['2026-11-03', '2026-11-03', 44, 6, 0.136]]);
  const other = r.points.find((p) => p.term === '');
  assert.equal(other?.key, '');
  assert.equal(other?.visitors, 90);
  assert.equal(r.points.find((p) => p.key === 'brew timer')?.term, 'Brew Timer');
  assert.ok(r.notes.some((n) => /not Google Play search/.test(n)));
  assert.ok(r.notes.some((n) => /"Other" line/.test(n)));
  assert.ok(!r.notes.some((n) => /coffee|brew|espresso/i.test(n)), 'a note never repeats a term');
});

test('a file with no date column needs the period, then stores one row per term and country', async () => {
  await fails(readSearchTermsFile(enc(periodCsv())), 'period_required');
  await fails(readSearchTermsFile(enc(periodCsv()), { from: '2026-11-10', to: '2026-11-01' }), 'period_required');
  await fails(readSearchTermsFile(enc(periodCsv()), { from: '2024-01-01', to: '2026-11-01' }), 'period_required');
  const r = await readSearchTermsFile(enc(periodCsv()), { from: '2026-10-01', to: '2026-10-28' });
  assert.equal(r.hasDates, false);
  assert.equal(r.hasCountry, true);
  assert.deepEqual(r.countries, ['de', 'us']);
  assert.equal(r.stats.rowsUsed, 5);
  const us = r.points.find((p) => p.key === 'coffee timer' && p.country === 'us');
  assert.deepEqual([us?.from, us?.to, us?.visitors, us?.installs, us?.conversion], ['2026-10-01', '2026-10-28', 1200, 150, 0.125]);
  assert.equal(r.points.find((p) => p.key === 'coffee timer' && p.country === 'de')?.conversion, 0.067);
  assert.equal(r.points.find((p) => p.key === '')?.visitors, 5000, '5.000 is five thousand');
  assert.equal(r.points.find((p) => p.key === 'kaffee wecker')?.country, '', 'a country name is not a code');
  assert.ok(r.notes.some((n) => /not a two letter code/.test(n)));
  assert.ok(r.notes.some((n) => /no date column/.test(n)));
});

test('columns are matched by name, in any order, with another delimiter, a dotted date and unreadable rows counted', async () => {
  const r = await readSearchTermsFile(enc(renamedCsv()));
  assert.equal(r.stats.rowsRead, 3);
  assert.equal(r.stats.rowsUsed, 1);
  assert.equal(r.stats.rowsUnreadable, 2);
  assert.deepEqual(r.points.map((p) => [p.key, p.from, p.visitors, p.installs]), [['coffee timer', '2026-11-03', 70, 7]]);
});

test('UTF-16, gzip and zip (several files, one without a term table) are read the same', async () => {
  const plain = await readSearchTermsFile(enc(trafficSourceCsv()));
  assert.deepEqual((await readSearchTermsFile(utf16(trafficSourceCsv()))).points, plain.points);
  assert.deepEqual((await readSearchTermsFile(gz(trafficSourceCsv()))).points, plain.points);
  const country = csv([['Date', 'Package name', 'Country/region', 'Store listing acquisitions', 'Store listing visitors'], ['2026-11-02', 'p', 'US', '3', '30']]);
  const archive = zip([
    { name: 'store_performance_com.acme.coffee_202611_traffic_source.csv', data: enc(trafficSourceCsv()) },
    { name: 'store_performance_com.acme.coffee_202611_country.csv', data: enc(country), method: 0 },
    { name: '__MACOSX/._x.csv', data: enc('junk') },
    { name: 'readme.pdf', data: enc('%PDF') },
  ]);
  assert.ok(isZip(archive));
  const z = await readSearchTermsFile(archive);
  assert.deepEqual(z.points, plain.points);
  assert.equal(z.files, 1);
  assert.ok(z.notes.some((n) => /no search term table/.test(n)));
});

test('a file that is not a search terms table, or is empty of usable rows, is refused with a code', async () => {
  await fails(readSearchTermsFile(enc(csv([['Date', 'Counts'], ['2026-11-01', '3']]))), 'missing_columns');
  await fails(readSearchTermsFile(enc(csv([['Search term'], ['x term']]))), 'missing_columns');
  await fails(readSearchTermsFile(enc(csv([['Date', 'Search term', 'Store listing visitors'], ['2026-11-01', 'x term', 'many']]))), 'no_rows');
  await fails(readSearchTermsFile(enc(csv([['Date', 'Search term', 'Store listing visitors']]))), 'no_rows');
  await fails(readSearchTermsFile(enc('')), 'bad_format');
  await fails(readSearchTermsFile(enc('"unterminated')), 'bad_format');
  await fails(readSearchTermsFile(new Uint8Array([0x1f, 0x8b, 1, 2, 3])), 'bad_gzip');
});

test('size caps: the file, an archive entry, an archive with too many entries, and a damaged archive', async () => {
  await fails(readSearchTermsFile(new Uint8Array(10 * 1024 * 1024 + 1)), 'file_too_large');
  const archive = zip([{ name: 'a.csv', data: enc(trafficSourceCsv()) }]);
  await assert.rejects(readZipEntries(archive, () => true, { maxEntryBytes: 10, maxTotalBytes: 1000 }), (e: unknown) => e instanceof AnalyticsError && e.code === 'file_too_large');
  await assert.rejects(readZipEntries(archive, () => true, { maxEntryBytes: 1000, maxTotalBytes: 1000, maxEntries: 0 }), (e: unknown) => e instanceof AnalyticsError && e.code === 'bad_zip');
  await fails(readSearchTermsFile(archive.subarray(0, archive.length - 5)), 'bad_zip');
  const encrypted = zip([{ name: 'a.csv', data: enc('x'), flags: 1 }]);
  await fails(readSearchTermsFile(encrypted), 'bad_zip');
  const empty = zip([{ name: 'a.pdf', data: enc('x') }]);
  await fails(readSearchTermsFile(empty), 'bad_zip');
  const climbing = zip([{ name: '../evil.csv', data: enc(trafficSourceCsv()) }]);
  await fails(readSearchTermsFile(climbing), 'bad_zip');
});

test('a bomb is stopped while it inflates, not after', async () => {
  const bomb = zip([{ name: 'a.csv', data: new Uint8Array(3 * 1024 * 1024).fill(0x61) }]);
  assert.ok(bomb.length < 10_000);
  await assert.rejects(readZipEntries(bomb, () => true, { maxEntryBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 }), (e: unknown) => e instanceof AnalyticsError && e.code === 'file_too_large');
});

test('cells: days, counts and ratios in the formats people meet', () => {
  assert.equal(parseSearchDay('2026-11-03'), '2026-11-03');
  assert.equal(parseSearchDay('2026/11/03'), '2026-11-03');
  assert.equal(parseSearchDay('03.11.2026'), '2026-11-03');
  assert.equal(parseSearchDay('25/12/2026'), '2026-12-25');
  assert.equal(parseSearchDay('12/25/2026'), '2026-12-25');
  assert.equal(parseSearchDay('03/04/2026'), undefined, 'March or April: not guessed');
  assert.equal(parseSearchDay('2026-02-30'), undefined);
  assert.equal(parseSearchDay('soon'), undefined);
  assert.equal(parseCountCell('1,234'), 1234);
  assert.equal(parseCountCell('1.234.567'), 1234567);
  assert.equal(parseCountCell('1 234'), 1234);
  assert.equal(parseCountCell('1 234'), 1234);
  assert.equal(parseCountCell('12'), 12);
  assert.equal(parseCountCell(''), null);
  assert.equal(parseCountCell('-'), null);
  assert.equal(parseCountCell('12abc'), undefined);
  assert.equal(parseRatioCell('12.5%'), 0.125);
  assert.equal(parseRatioCell('12,5 %'), 0.125);
  assert.equal(parseRatioCell('0.125'), 0.125);
  assert.equal(parseRatioCell('12.5'), 0.125);
  assert.equal(parseRatioCell('150%'), undefined);
  assert.equal(parseRatioCell('abc'), undefined);
});

test('identical term, day and storefront twice add up; the conversion is then not carried', async () => {
  const text = csv([['Date', 'Search term', 'Store listing visitors', 'Store listing acquisitions', 'Store listing conversion rate'], ['2026-11-01', 'x term', '10', '1', '0.1'], ['2026-11-01', 'X  Term', '20', '3', '0.15']]);
  const r = await readSearchTermsFile(enc(text));
  assert.equal(r.points.length, 1);
  assert.deepEqual([r.points[0]?.visitors, r.points[0]?.installs, r.points[0]?.conversion], [30, 4, null]);
});
