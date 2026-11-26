import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DriftField, DriftLocale, ListingDrift } from '../types.ts';
import { emptyChip, emptyLine, fillPlan, pickSource, stillEmpty } from './empty-locale.ts';
import { buildMatrix } from './matrix.ts';

const side = (value: string | null) => ({ value, observedAt: null, sourceRef: null, source: null });
const field = (locale: string, id: string, value: string | null): DriftField =>
  ({
    locale,
    field: id,
    label: id,
    limit: null,
    unit: 'characters',
    status: 'missing-in-one',
    repo: side(null),
    db: side(value),
    live: side(value),
    problems: { repo: [], live: [] },
  }) as unknown as DriftField;

const drift = (locales: DriftLocale[]): ListingDrift =>
  ({
    appId: 'a',
    platform: 'ios',
    channel: 'live',
    store: { readAt: 1, error: null },
    repo: { readAt: null, ref: null, error: null },
    summary: {},
    locales,
  }) as unknown as ListingDrift;

const LOCALES: DriftLocale[] = [
  {
    locale: 'en-US',
    fields: [
      field('en-US', 'description', 'Hello'),
      field('en-US', 'keywords', 'a,b'),
      field('en-US', 'support_url', 'https://x.y'),
    ],
    stores: ['live', 'editable'],
    valuesFrom: 'live',
  },
  {
    locale: 'fr-CA',
    fields: [field('fr-CA', 'description', 'Bonjour')],
    stores: ['editable'],
    valuesFrom: 'editable',
    emptyRequired: ['keywords', 'support_url'],
  },
  {
    locale: 'fr-FR',
    fields: [],
    stores: ['editable'],
    valuesFrom: 'editable',
    emptyRequired: ['description', 'keywords', 'support_url'],
  },
];

test('a locale with no fields is a row of the grid, with what is empty and that it is on the draft only', () => {
  const matrix = buildMatrix([{ platform: 'ios', drift: drift(LOCALES) }]);
  assert.deepEqual(
    matrix.rows.map((r) => r.locale),
    ['en-US', 'fr-CA', 'fr-FR'],
    'fr-FR and fr-CA are two languages',
  );
  const fr = matrix.rows.find((r) => r.locale === 'fr-FR');
  assert.deepEqual(fr?.empty, { ios: ['description', 'keywords', 'support_url'] });
  assert.equal(fr?.draftOnly, true);
  assert.equal(matrix.rows[0]?.draftOnly, false);
  assert.deepEqual(matrix.rows[0]?.empty, {});
  // Every cell of an empty locale reads as missing, so the locale is counted among those with missing fields.
  assert.ok((fr?.counts.missing ?? 0) > 0);
});

test('the source of the texts is en-US when it has them, else the fullest other locale', () => {
  const matrix = buildMatrix([{ platform: 'ios', drift: drift(LOCALES) }]);
  const wanted = ['description', 'keywords', 'support_url'];
  const source = pickSource(matrix.rows, 'ios', 'fr-FR', wanted);
  assert.equal(source?.locale, 'en-US');
  assert.deepEqual(source?.values, {
    description: 'Hello',
    keywords: 'a,b',
    support_url: 'https://x.y',
  });
  // fr-CA is itself empty in two of the wanted fields: en-US still wins, and the target is never its own source.
  assert.equal(pickSource(matrix.rows, 'ios', 'en-US', wanted)?.locale, 'fr-CA');
  // No locale has anything: no source.
  assert.equal(pickSource(matrix.rows, 'ios', 'fr-FR', ['marketing_url']), null);
});

test('the plan copies what the source has, translates only texts, and names what stays empty', () => {
  const plan = fillPlan(
    { locale: 'en-US', values: { description: 'Hello', support_url: 'https://x.y' } },
    ['description', 'keywords', 'support_url'],
  );
  assert.deepEqual(plan.items, [
    { field: 'description', value: 'Hello', translate: true },
    { field: 'support_url', value: 'https://x.y', translate: false },
  ]);
  assert.deepEqual(plan.without, ['keywords']);
});

test('a staged text is not empty any more', () => {
  assert.deepEqual(
    stillEmpty(['description', 'keywords'], { description: 'Bonjour', keywords: '  ' }),
    ['keywords'],
  );
});

test('the sentences name the locale and the fields', () => {
  assert.match(emptyLine('fr-FR', ['description', 'keywords', 'support_url']), /fr-FR/);
  assert.match(emptyChip(['description']), /description/i);
});
