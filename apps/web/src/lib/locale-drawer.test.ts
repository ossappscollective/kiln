import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blockingLines,
  fieldLimitNote,
  fieldWord,
  leadAction,
  localeLead,
  orderFields,
  splitFields,
} from './locale-drawer.ts';
import type { DriftField, DriftSide, DriftStatus } from './types.ts';

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

const named = (status: DriftStatus, label: string, partial: Partial<DriftField> = {}) =>
  field(status, { label, field: label.toLowerCase(), ...partial });

test('fieldWord: one short word per status', () => {
  assert.equal(fieldWord('sync'), 'In sync');
  assert.equal(fieldWord('repo-differs'), 'Store ahead');
  assert.equal(fieldWord('store-differs'), 'Repo ahead');
  assert.equal(fieldWord('over'), 'Over limit');
});

test('orderFields: over the limit first, then diverged, missing, store ahead, repository ahead, in sync; stable', () => {
  const long = 'x'.repeat(40);
  const list = [
    named('identical', 'A'),
    named('repo-ahead', 'B'),
    named('store-ahead', 'C'),
    named('missing-in-one', 'D', { repo: side(null), missingIn: 'repo' }),
    named('diverged', 'E'),
    named('identical', 'F', { repo: side(long), live: side(long) }),
    named('repo-ahead', 'G'),
  ];
  assert.deepEqual(
    orderFields(list).map((f) => f.label),
    ['F', 'E', 'D', 'C', 'B', 'G', 'A'],
  );
});

test('splitFields: an identical field over its limit needs attention', () => {
  const long = 'x'.repeat(40);
  const r = splitFields([
    named('identical', 'A'),
    named('identical', 'B', { repo: side(long), live: side(long) }),
  ]);
  assert.deepEqual(
    r.attention.map((f) => f.label),
    ['B'],
  );
  assert.deepEqual(
    r.inSync.map((f) => f.label),
    ['A'],
  );
});

test('fieldLimitNote: quiet counter; one sentence when a side is over', () => {
  assert.equal(fieldLimitNote(field('identical', { limit: null })), null);
  assert.equal(fieldLimitNote(field('identical', { repo: side(null), live: side(null) })), null);
  const ok = fieldLimitNote(field('repo-ahead', { repo: side('abcdefghij'), live: side('abc') }));
  assert.deepEqual(ok, { text: '10 / 30 characters', over: false, message: null });
  const over = fieldLimitNote(
    field('repo-ahead', { repo: side('x'.repeat(34)), live: side('abc') }),
  );
  assert.equal(over?.over, true);
  assert.equal(over?.message, 'The repository is 4 characters over the limit of 30.');
  const both = fieldLimitNote(
    field('identical', { repo: side('x'.repeat(31)), live: side('x'.repeat(31)) }),
  );
  assert.equal(both?.message, 'The repository and the store are over the limit of 30 characters.');
  const bytes = fieldLimitNote(
    field('identical', { unit: 'bytes', limit: 100, repo: side('x'.repeat(101)), live: side('x') }),
  );
  assert.equal(bytes?.message, 'The repository is 1 byte over the limit of 100.');
});

test('blockingLines: server messages with their side; the generated sentence only when none says too long', () => {
  const long = 'x'.repeat(40);
  assert.deepEqual(blockingLines(field('identical')), []);
  assert.deepEqual(blockingLines(field('repo-ahead', { repo: side(long) })), [
    'The repository is 10 characters over the limit of 30.',
  ]);
  const withProblem = field('repo-ahead', {
    repo: side(long),
    problems: {
      repo: [{ code: 'too_long', severity: 'error', message: 'Too long: 40 of 30.' } as never],
      live: [],
    },
  });
  assert.deepEqual(blockingLines(withProblem), ['Repository: Too long: 40 of 30.']);
});

test('localeLead: in sync, differing, over the limit, empty', () => {
  assert.equal(localeLead([{ fields: [] }]).headline, 'This locale has no fields');
  const sync = localeLead([{ fields: [field('identical')] }]);
  assert.equal(sync.headline, 'Everything is in sync');
  assert.equal(sync.tone, 'ok');
  const some = localeLead([
    { fields: [named('repo-ahead', 'A'), named('repo-ahead', 'B')] },
    { fields: [named('store-ahead', 'C'), named('identical', 'D')] },
  ]);
  assert.equal(some.headline, '3 fields differ from the store');
  assert.equal(some.hint, '2 changed in the repository, 1 changed in the store.');
  assert.equal(some.tone, 'warn');
  const one = localeLead([{ fields: [named('diverged', 'A')] }]);
  assert.equal(one.headline, '1 field differs from the store');
  const long = 'x'.repeat(40);
  const over = localeLead([
    {
      fields: [
        named('identical', 'A', { repo: side(long), live: side(long) }),
        named('repo-ahead', 'B'),
      ],
    },
  ]);
  assert.equal(over.headline, "1 field is over the store's limit");
  assert.equal(over.tone, 'bad');
  assert.match(over.hint, /1 more differs from the store/);
});

const input = (
  partial: Partial<Parameters<typeof leadAction>[0][number]> & { fields: DriftField[] },
) => ({
  platform: 'ios' as const,
  pullable: [],
  canPull: true,
  canEdit: () => true,
  canStage: () => false,
  ...partial,
});

test('leadAction: shorten what is over the limit, else pull, else stage, else nothing', () => {
  const long = 'x'.repeat(40);
  const over = named('repo-ahead', 'Title', { repo: side(long) });
  const stale = named('store-ahead', 'Subtitle');
  const mine = named('repo-ahead', 'Promo');
  const a = leadAction([input({ fields: [stale, over], pullable: [stale], canStage: () => true })]);
  assert.equal(a?.kind, 'edit');
  assert.equal(a?.label, 'Shorten title');
  const b = leadAction([input({ fields: [stale, mine], pullable: [stale], canStage: () => true })]);
  assert.equal(b?.kind, 'pull');
  assert.equal(b?.label, 'Pull 1 iOS change into the repository');
  const c = leadAction([input({ fields: [mine], canStage: () => true })]);
  assert.equal(c?.kind, 'stage');
  assert.equal(c?.label, 'Stage promo from the repository');
  assert.equal(leadAction([input({ fields: [mine], pullable: [stale], canPull: false })]), null);
  assert.equal(leadAction([input({ fields: [over], canEdit: () => false })]), null);
});

test('leadAction: names the platform when several are in the locale', () => {
  const mine = named('repo-ahead', 'Promo');
  const a = leadAction([
    input({ fields: [] }),
    input({ platform: 'android', fields: [mine], canStage: () => true }),
  ]);
  assert.equal(a?.label, 'Stage Android promo from the repository');
});
