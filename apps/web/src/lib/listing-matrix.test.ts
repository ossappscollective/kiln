import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMatrix,
  cellMatchesMode,
  cellStatus,
  cellsSummary,
  cellText,
  columnKey,
  columnScopeNote,
  defaultMatrixFilter,
  filterRows,
  isOverLimit,
  limitText,
  matrixSummary,
  modeCounts,
} from './listing-matrix.ts';
import type { DriftField, DriftLocale, DriftSide, DriftStatus, ListingDrift } from './types.ts';

const side = (value: string | null): DriftSide => ({
  value,
  observedAt: value === null ? null : 1,
  sourceRef: null,
  source: null,
});

function field(status: DriftStatus, partial: Partial<DriftField> = {}): DriftField {
  return {
    locale: 'en-US',
    field: 'name',
    label: 'Name',
    limit: 30,
    unit: 'characters',
    status,
    repo: side('Acme'),
    db: side('Acme'),
    live: side('Acme'),
    problems: { repo: [], live: [] },
    ...partial,
  };
}

function drift(platform: 'ios' | 'android', locales: DriftLocale[]): ListingDrift {
  return {
    appId: platform,
    platform,
    channel: 'live',
    store: { readAt: 1, error: null },
    repo: { readAt: 1, ref: null, error: null },
    summary: { identical: 0, 'repo-ahead': 0, 'store-ahead': 0, diverged: 0, 'missing-in-one': 0 },
    locales,
  };
}

test('cellStatus maps the drift status to the five dots and diverged', () => {
  assert.equal(cellStatus(field('identical')), 'sync');
  assert.equal(cellStatus(field('store-ahead')), 'repo-differs');
  assert.equal(cellStatus(field('repo-ahead')), 'store-differs');
  assert.equal(cellStatus(field('diverged')), 'diverged');
  assert.equal(
    cellStatus(field('missing-in-one', { missingIn: 'repo', repo: side(null) })),
    'missing',
  );
});

test('a value over the limit wins over the drift status, by count or by problem', () => {
  assert.equal(cellStatus(field('identical', { limit: 3 })), 'over');
  assert.equal(isOverLimit(field('identical', { limit: null })), false);
  const withProblem = field('identical', {
    limit: 100,
    problems: { repo: [], live: [{ code: 'too_long', severity: 'error', message: 'too long' }] },
  });
  assert.equal(cellStatus(withProblem), 'over');
  const warning = field('identical', {
    limit: 100,
    problems: { repo: [{ code: 'too_long', severity: 'warning', message: 'long' }], live: [] },
  });
  assert.equal(cellStatus(warning), 'sync');
});

test('columnKey merges the Play names with the App Store names', () => {
  assert.equal(columnKey('title'), 'name');
  assert.equal(columnKey('full_description'), 'description');
  assert.equal(columnKey('keywords'), 'keywords');
});

const ios = drift('ios', [
  {
    locale: 'en-US',
    fields: [
      field('identical', { field: 'name', label: 'Name' }),
      field('store-ahead', { field: 'subtitle', label: 'Subtitle', limit: 30 }),
      field('identical', { field: 'description', label: 'Description', limit: 4000 }),
    ],
  },
  {
    locale: 'de-DE',
    fields: [
      field('missing-in-one', {
        field: 'name',
        label: 'Name',
        locale: 'de-DE',
        live: side(null),
        missingIn: 'store',
      }),
    ],
  },
]);
const android = drift('android', [
  {
    locale: 'en-US',
    fields: [
      field('repo-ahead', { field: 'title', label: 'Title' }),
      field('identical', { field: 'short_description', label: 'Short description', limit: 80 }),
      field('identical', { field: 'full_description', label: 'Full description', limit: 4000 }),
    ],
  },
  {
    locale: 'fr-FR',
    fields: [field('identical', { field: 'title', label: 'Title', locale: 'fr-FR' })],
  },
]);

test('buildMatrix for one platform has that platform columns and one cell per field', () => {
  const m = buildMatrix([{ platform: 'ios', drift: ios }]);
  assert.deepEqual(m.platforms, ['ios']);
  assert.deepEqual(
    m.columns.map((c) => c.key),
    ['name', 'subtitle', 'description'],
  );
  assert.deepEqual(
    m.rows.map((r) => r.locale),
    ['en-US', 'de-DE'],
  );
  const en = m.rows[0];
  assert.equal(en?.cells.name?.[0]?.status, 'sync');
  assert.equal(en?.cells.subtitle?.[0]?.status, 'repo-differs');
  // de-DE has a name row but no subtitle or description row: those are missing, not absent.
  const de = m.rows[1];
  assert.equal(de?.cells.name?.[0]?.status, 'missing');
  assert.equal(de?.cells.subtitle?.[0]?.status, 'missing');
  assert.equal(de?.counts.missing, 3);
});

test('buildMatrix merges both platforms, names shared columns once and marks single-store columns', () => {
  const m = buildMatrix([
    { platform: 'android', drift: android },
    { platform: 'ios', drift: ios },
  ]);
  assert.deepEqual(m.platforms, ['ios', 'android']);
  assert.deepEqual(
    m.columns.map((c) => c.key),
    ['name', 'subtitle', 'short_description', 'description'],
  );
  const name = m.columns[0];
  assert.equal(name?.label, 'Name / Title');
  assert.deepEqual(name?.platforms, ['ios', 'android']);
  assert.equal(columnScopeNote(m.columns[1] as never, m.platforms), 'iOS only');
  assert.equal(columnScopeNote(m.columns[2] as never, m.platforms), 'Android only');
  assert.equal(columnScopeNote(name as never, m.platforms), null);
  assert.equal(columnScopeNote(m.columns[1] as never, ['ios']), null);

  assert.deepEqual(
    m.rows.map((r) => r.locale),
    ['en-US', 'de-DE', 'fr-FR'],
  );
  const en = m.rows[0];
  assert.deepEqual(
    en?.cells.name?.map((c) => [c.platform, c.status]),
    [
      ['ios', 'sync'],
      ['android', 'store-differs'],
    ],
  );
  // A field only one store has is n/a on the other, not missing.
  assert.equal(en?.cells.subtitle?.[1]?.status, 'na');
  assert.equal(en?.cells.short_description?.[0]?.status, 'na');
  // A locale one store lacks is n/a on that store.
  const fr = m.rows[2];
  assert.deepEqual(fr?.platforms, ['android']);
  assert.equal(fr?.cells.name?.[0]?.status, 'na');
  assert.equal(fr?.cells.name?.[1]?.status, 'sync');
});

test('buildMatrix leaves out a platform whose view is not loaded', () => {
  const m = buildMatrix([
    { platform: 'ios', drift: ios },
    { platform: 'android', drift: null },
  ]);
  assert.deepEqual(m.platforms, ['ios']);
  assert.equal(buildMatrix([]).rows.length, 0);
});

test('limitText shows one limit, or one per store when they differ', () => {
  const m = buildMatrix([
    { platform: 'ios', drift: ios },
    { platform: 'android', drift: android },
  ]);
  assert.equal(limitText(m.columns[0] as never), 'max 30');
  const notes = buildMatrix([
    {
      platform: 'ios',
      drift: drift('ios', [
        {
          locale: 'en-US',
          fields: [
            field('identical', { field: 'release_notes', label: 'Release notes', limit: 4000 }),
          ],
        },
      ]),
    },
  ]);
  assert.equal(limitText(notes.columns[0] as never), 'max 4000');
  const differing = { platforms: ['ios', 'android'] as const, limits: { ios: 4000, android: 500 } };
  assert.equal(
    limitText({ ...differing, platforms: ['ios', 'android'] }),
    'iOS 4000 / Android 500',
  );
  assert.equal(limitText({ platforms: ['ios'], limits: { ios: null } }), '');
});

test('filters: needs attention, missing only, over limit and the search', () => {
  const m = buildMatrix([
    { platform: 'ios', drift: ios },
    { platform: 'android', drift: android },
  ]);
  const all = filterRows(m.rows, defaultMatrixFilter());
  assert.equal(all.length, 3);
  const differing = filterRows(m.rows, { mode: 'differing', query: '' });
  // fr-FR has a title but no short or full description row, so it is missing fields too.
  assert.deepEqual(
    differing.map((r) => r.locale),
    ['en-US', 'de-DE', 'fr-FR'],
  );
  assert.deepEqual(
    filterRows(m.rows, { mode: 'missing', query: '' }).map((r) => r.locale),
    ['de-DE', 'fr-FR'],
  );
  assert.deepEqual(filterRows(m.rows, { mode: 'over', query: '' }), []);
  assert.deepEqual(
    filterRows(m.rows, { mode: 'all', query: 'FR' }).map((r) => r.locale),
    ['fr-FR'],
  );
  assert.deepEqual(
    filterRows(m.rows, { mode: 'all', query: '  de-de ' }).map((r) => r.locale),
    ['de-DE'],
  );
  assert.deepEqual(modeCounts(m.rows), { all: 3, differing: 3, missing: 2, over: 0 });
});

test('cellMatchesMode ignores n/a cells', () => {
  assert.equal(cellMatchesMode('na', 'all'), false);
  assert.equal(cellMatchesMode('sync', 'all'), true);
  assert.equal(cellMatchesMode('sync', 'differing'), false);
  assert.equal(cellMatchesMode('diverged', 'differing'), true);
  assert.equal(cellMatchesMode('missing', 'missing'), true);
  assert.equal(cellMatchesMode('over', 'missing'), false);
});

test('matrixSummary and cellText say it in words', () => {
  const m = buildMatrix([{ platform: 'ios', drift: ios }]);
  assert.equal(matrixSummary(m.rows), '2 locales, 2 need attention, 1 with missing fields');
  assert.equal(matrixSummary([]), 'No locales yet');
  assert.equal(matrixSummary(m.rows.slice(0, 0)), 'No locales yet');
  const cell = m.rows[0]?.cells.subtitle?.[0];
  assert.equal(
    cellText(m.columns[1] as never, cell as never, true),
    'iOS, Subtitle: Differs from repo: the store is ahead',
  );
  assert.equal(
    cellText(m.columns[1] as never, cell as never, false),
    'Subtitle: Differs from repo: the store is ahead',
  );
});

test('cellsSummary joins the stores that have the field', () => {
  assert.equal(
    cellsSummary(
      [
        { platform: 'ios', status: 'sync' },
        { platform: 'android', status: 'store-differs' },
      ],
      true,
    ),
    'iOS: In sync; Android: Differs from store: the repository is ahead',
  );
  assert.equal(
    cellsSummary(
      [
        { platform: 'ios', status: 'na' },
        { platform: 'android', status: 'missing' },
      ],
      false,
    ),
    'Missing: one side has no value',
  );
  assert.equal(cellsSummary([{ platform: 'ios', status: 'na' }], true), 'Not on this platform');
});
