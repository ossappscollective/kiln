import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countOf,
  parseSectionState,
  readSectionOpen,
  type SectionScope,
  type StorageLike,
  sectionPageOf,
  sectionStorageKey,
  showsToggleAll,
  summaryLine,
  toggleAllLabel,
  writeSectionOpen,
  writeSectionsOpen,
} from './section-state.ts';

const fake = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const scope: SectionScope = { workspaceId: 'w1', userId: 'u1', page: 'listing.text' };

test('the choice is kept per workspace, person, page and section', () => {
  const s = fake();
  assert.equal(readSectionOpen(s, scope, 'locales', true), true);
  writeSectionOpen(s, scope, 'locales', false);
  assert.equal(readSectionOpen(s, scope, 'locales', true), false);
  assert.equal(readSectionOpen(s, scope, 'other', true), true);
  assert.equal(readSectionOpen(s, { ...scope, userId: 'u2' }, 'locales', true), true);
  assert.equal(readSectionOpen(s, { ...scope, workspaceId: 'w2' }, 'locales', true), true);
  assert.equal(readSectionOpen(s, { ...scope, page: 'listing.graphics' }, 'locales', true), true);
  assert.ok(s.data.has(sectionStorageKey(scope)));
});

test('a default that is closed stays closed until opened, and an opened one is remembered', () => {
  const s = fake();
  assert.equal(readSectionOpen(s, scope, 'details', false), false);
  writeSectionOpen(s, scope, 'details', true);
  assert.equal(readSectionOpen(s, scope, 'details', false), true);
});

test('Collapse all and Expand all write every key at once and keep the others', () => {
  const s = fake();
  writeSectionOpen(s, scope, 'c', true);
  assert.equal(writeSectionsOpen(s, scope, { a: false, b: false }), true);
  assert.equal(readSectionOpen(s, scope, 'a', true), false);
  assert.equal(readSectionOpen(s, scope, 'b', true), false);
  assert.equal(readSectionOpen(s, scope, 'c', false), true);
});

test('a missing, broken or refusing storage falls back to the default', () => {
  assert.equal(readSectionOpen(null, scope, 'a', true), true);
  assert.equal(writeSectionOpen(null, scope, 'a', false), false);
  const broken: StorageLike = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('full');
    },
  };
  assert.equal(readSectionOpen(broken, scope, 'a', false), false);
  assert.equal(writeSectionOpen(broken, scope, 'a', true), false);
  const garbage = fake();
  garbage.data.set(sectionStorageKey(scope), '{nope');
  assert.equal(readSectionOpen(garbage, scope, 'a', true), true);
  assert.deepEqual(parseSectionState('[1,2]'), {});
  assert.deepEqual(parseSectionState('{"a":true,"b":"x","c":false}'), { a: true, c: false });
  assert.deepEqual(parseSectionState(null), {});
});

test('the toggle for all sections appears from three sections', () => {
  assert.equal(showsToggleAll(2), false);
  assert.equal(showsToggleAll(3), true);
  assert.equal(toggleAllLabel(true), 'Collapse all');
  assert.equal(toggleAllLabel(false), 'Expand all');
});

test('summary lines join only the parts that say something', () => {
  assert.equal(
    summaryLine([countOf(12, 'locale'), '3 need attention']),
    '12 locales · 3 need attention',
  );
  assert.equal(
    summaryLine([countOf(1, 'locale'), 0 === 1 && 'x', null, undefined, '']),
    '1 locale',
  );
  assert.equal(summaryLine([]), '');
  assert.equal(countOf(2, 'child', 'children'), '2 children');
});

test('the page of an address is the page of the app, not the app', () => {
  assert.equal(sectionPageOf('#/portfolio/7/listing'), 'listing.text');
  assert.equal(sectionPageOf('#/portfolio/8/listing?view=graphics&locale=de'), 'listing.graphics');
  assert.equal(sectionPageOf('#/portfolio/7/assets'), 'listing.graphics');
  assert.equal(sectionPageOf('#/portfolio/7/insights?view=rank'), 'insights.keywords');
  assert.equal(sectionPageOf('#/portfolio/7'), 'dashboard');
  assert.equal(sectionPageOf('#/portfolio/7/releases'), 'releases');
  assert.equal(sectionPageOf('#/portfolio/7/release/1.0'), 'release');
  assert.equal(sectionPageOf('#/reviews?rating=1'), 'reviews');
  assert.equal(sectionPageOf('#/portfolio'), 'portfolio');
});
