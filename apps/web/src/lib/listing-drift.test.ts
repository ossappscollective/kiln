import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actorText,
  comparison,
  DIFF_TOKEN_CAP,
  describeSource,
  diffWords,
  driftSummaryText,
  filterLocales,
  historySteps,
  localeName,
  localeSummary,
  shortRef,
  statusDetail,
  statusExplanation,
  statusLabel,
  statusTone,
  usage,
  usageText,
} from './listing-drift.ts';
import type {
  DriftField,
  DriftLocale,
  DriftSide,
  DriftStatus,
  ListingDrift,
  ListingHistoryEntry,
} from './types.ts';

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

const rejoin = (parts: ReturnType<typeof diffWords>, kinds: string[]) =>
  parts
    .filter((p) => kinds.includes(p.kind))
    .map((p) => p.text)
    .join('');

test('every status has words, a tone and an explanation', () => {
  const all: DriftStatus[] = [
    'identical',
    'repo-ahead',
    'store-ahead',
    'diverged',
    'missing-in-one',
  ];
  for (const status of all) {
    assert.ok(statusLabel(status).length > 3);
    assert.ok(statusExplanation(status).endsWith('.'));
  }
  assert.equal(statusTone('identical'), 'ok');
  assert.equal(statusTone('diverged'), 'bad');
  assert.equal(new Set(all.map(statusLabel)).size, all.length);
});

test('a missing field says which side lacks the value', () => {
  assert.equal(
    statusDetail(field('missing-in-one', { missingIn: 'repo' })),
    'Missing in the repository',
  );
  assert.equal(
    statusDetail(field('missing-in-one', { missingIn: 'store' })),
    'Missing in the store',
  );
  assert.equal(statusDetail(field('missing-in-one')), 'Missing on one side');
  assert.equal(statusDetail(field('diverged')), 'Diverged');
});

test('usage counts characters by code point and bytes as UTF-8', () => {
  assert.deepEqual(usage('Acme', 30, 'characters'), {
    count: 4,
    limit: 30,
    unit: 'characters',
    over: false,
  });
  assert.equal(usage('😀😀', 30, 'characters').count, 2);
  assert.equal(usage('é', 100, 'bytes').count, 2);
  assert.equal(usage('x'.repeat(31), 30, 'characters').over, true);
  assert.equal(usage('x'.repeat(30), 30, 'characters').over, false);
  assert.equal(usage(null, 30, 'characters').count, 0);
  assert.equal(usage('x'.repeat(5000), null, 'characters').over, false);
  assert.equal(usageText(usage('Acme', 30, 'characters')), '4 / 30 characters');
  assert.equal(usageText(usage('abc', 100, 'bytes')), '3 / 100 bytes');
  assert.equal(usageText(usage('abc', null, 'characters')), '3 characters');
});

test('diffWords marks only the words that differ and reproduces both sides', () => {
  const from = 'Plan your trips with ease.';
  const to = 'Plan your journeys with ease and speed.';
  const parts = diffWords(from, to);
  assert.equal(rejoin(parts, ['same', 'del']), from);
  assert.equal(rejoin(parts, ['same', 'ins']), to);
  assert.deepEqual(
    parts.filter((p) => p.kind === 'del').map((p) => p.text),
    ['trips'],
  );
  assert.ok(parts.some((p) => p.kind === 'ins' && p.text.includes('journeys')));
  assert.ok(parts.some((p) => p.kind === 'same' && p.text.includes('Plan your')));
});

test('diffWords handles identical, empty and one-sided text', () => {
  assert.deepEqual(diffWords('same', 'same'), [{ kind: 'same', text: 'same' }]);
  assert.deepEqual(diffWords('', ''), []);
  assert.deepEqual(diffWords('', 'new text'), [{ kind: 'ins', text: 'new text' }]);
  assert.deepEqual(diffWords('old text', ''), [{ kind: 'del', text: 'old text' }]);
});

test('diffWords keeps whitespace and line breaks', () => {
  const from = 'One\n\nTwo  words';
  const to = 'One\n\nTwo words\nThree';
  const parts = diffWords(from, to);
  assert.equal(rejoin(parts, ['same', 'del']), from);
  assert.equal(rejoin(parts, ['same', 'ins']), to);
});

test('diffWords falls back to one replaced block past the token cap', () => {
  const from = Array.from({ length: DIFF_TOKEN_CAP + 10 }, (_, i) => `a${i}`).join(' ');
  const to = Array.from({ length: DIFF_TOKEN_CAP + 10 }, (_, i) => `b${i}`).join(' ');
  const parts = diffWords(from, to);
  assert.deepEqual(
    parts.map((p) => p.kind),
    ['del', 'ins'],
  );
  assert.equal(rejoin(parts, ['del']), from);
  assert.equal(rejoin(parts, ['ins']), to);
});

test('the comparison needs two different values', () => {
  assert.equal(comparison(field('identical')), null);
  assert.equal(comparison(field('missing-in-one', { repo: side(null), live: side('Acme') })), null);
  const c = comparison(field('repo-ahead', { repo: side('New'), live: side('Old') }));
  assert.deepEqual(c, { from: 'live', to: 'repo', fromValue: 'Old', toValue: 'New' });
});

const locales: DriftLocale[] = [
  {
    locale: 'en-US',
    fields: [
      field('identical'),
      field('diverged', {
        field: 'subtitle',
        label: 'Subtitle',
        repo: side('Fast trips'),
        live: side('Quick rides'),
      }),
    ],
  },
  { locale: 'de-DE', fields: [field('identical', { locale: 'de-DE' })] },
];

test('filters by status and text, dropping empty locales', () => {
  const all = filterLocales(locales, { status: 'all', query: '' });
  assert.equal(all.length, 2);
  const differing = filterLocales(locales, { status: 'differing', query: '' });
  assert.deepEqual(
    differing.map((l) => [l.locale, l.fields.map((f) => f.field)]),
    [['en-US', ['subtitle']]],
  );
  assert.equal(filterLocales(locales, { status: 'identical', query: 'de-de' }).length, 1);
  assert.equal(filterLocales(locales, { status: 'all', query: 'quick' })[0]?.fields.length, 1);
  assert.equal(filterLocales(locales, { status: 'all', query: 'nothing like this' }).length, 0);
  assert.equal(filterLocales(locales, { status: 'all', query: 'de-DE' })[0]?.fields.length, 1);
});

test('locale and drift summaries', () => {
  assert.equal(localeSummary(locales[0] as DriftLocale), '1 field differs');
  assert.equal(localeSummary(locales[1] as DriftLocale), 'All identical');
  const drift: ListingDrift = {
    appId: 'a',
    platform: 'ios',
    channel: 'live',
    store: { readAt: 1, error: null },
    repo: { readAt: 1, ref: null, error: null },
    summary: { identical: 2, 'repo-ahead': 0, 'store-ahead': 1, diverged: 1, 'missing-in-one': 0 },
    locales,
  };
  assert.equal(driftSummaryText(drift), '1 diverged, 1 store ahead, 2 identical');
  assert.equal(
    driftSummaryText({
      ...drift,
      summary: {
        identical: 0,
        'repo-ahead': 0,
        'store-ahead': 0,
        diverged: 0,
        'missing-in-one': 0,
      },
    }),
    'No listing values yet',
  );
});

test('sources read as words with a short reference', () => {
  const sha = '3fa9c1b2d4e5f60718293a4b5c6d7e8f90a1b2c3';
  assert.equal(shortRef('repo', sha), '3fa9c1b');
  assert.equal(shortRef('store', '2.1.0'), '2.1.0');
  assert.equal(shortRef('store', null), null);
  assert.equal(
    describeSource({ source: 'repo', sourceRef: sha, channel: 'default' }),
    'Repository · 3fa9c1b',
  );
  assert.equal(
    describeSource({ source: 'store', sourceRef: '2.0.0', channel: 'live' }),
    'Store · live version · 2.0.0',
  );
  assert.equal(
    describeSource({ source: 'store', sourceRef: null, channel: 'editable' }),
    'Store · editable version',
  );
  assert.equal(
    describeSource({
      source: 'change_set',
      sourceRef: '1b2c3d4e-aaaa-bbbb-cccc-1234567890ab',
      channel: 'default',
    }),
    'Change set · 1b2c3d4e…',
  );
});

const entry = (
  id: string,
  source: ListingHistoryEntry['source'],
  value: string | null,
  observedAt: number,
  channel = 'live',
): ListingHistoryEntry => ({
  id,
  locale: 'en-US',
  field: 'name',
  channel,
  value,
  source,
  sourceRef: null,
  observedAt,
  actor: null,
});

test('each history step knows what it replaced in its own stream', () => {
  const steps = historySteps([
    entry('5', 'store', null, 50),
    entry('4', 'repo', 'Repo two', 40, 'default'),
    entry('3', 'store', 'Store two', 30),
    entry('2', 'repo', 'Repo one', 20, 'default'),
    entry('1', 'store', 'Store one', 10),
  ]);
  assert.deepEqual(
    steps.map((s) => [s.entry.id, s.previous, s.removed]),
    [
      ['5', 'Store two', true],
      ['4', 'Repo one', false],
      ['3', 'Store one', false],
      ['2', undefined, false],
      ['1', undefined, false],
    ],
  );
  assert.deepEqual(historySteps([]), []);
});

test('actors read as words', () => {
  assert.equal(actorText(null), '');
  assert.equal(actorText({ type: 'user', id: 'u1' }), 'by a workspace member');
  assert.equal(actorText({ type: 'system', id: '' }), 'by the system');
  assert.equal(actorText({ type: 'assistant', id: 'x' }), 'by assistant');
});

test('locale names fall back to the code', () => {
  assert.match(localeName('default'), /^Default/);
  assert.equal(localeName('not a locale!'), 'not a locale!');
  assert.ok(localeName('de-DE').length > 0);
});
