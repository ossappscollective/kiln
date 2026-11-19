import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultFilters, defaultInboxFilters } from './reviews.ts';
import {
  filtersButtonText,
  inboxPopoverFilterCount,
  popoverFilterCount,
  statsLine,
  statusChips,
  statusesAfterChip,
  trendWord,
} from './reviews-toolbar.ts';

const week = (i: number, average: number | null, count = 3) => ({ weekStart: i * 604_800_000, count, average });

test('status chips: short labels, counts when known, one pressed', () => {
  const chips = statusChips({ new: 4, triaged: 0, replied_in_console: 2 }, ['triaged']);
  assert.deepEqual(chips.map((c) => c.label), ['New', 'Triaged', 'Replied', 'Ignored']);
  assert.deepEqual(chips.map((c) => c.count), [4, 0, 2, null]);
  assert.deepEqual(chips.map((c) => c.pressed), [false, true, false, false]);
  assert.equal(chips[2]?.title, 'Replied in store console');
});

test('several statuses at once press no chip, and a chip then picks only its own', () => {
  const chips = statusChips({}, ['new', 'triaged']);
  assert.equal(chips.some((c) => c.pressed), false);
  assert.deepEqual(statusesAfterChip(['new', 'triaged'], 'new'), ['new']);
  assert.deepEqual(statusesAfterChip(['new'], 'new'), []);
  assert.deepEqual(statusesAfterChip([], 'ignored'), ['ignored']);
});

test('the Filters button counts what the popover holds, not the chips or the search', () => {
  const f = defaultFilters();
  assert.equal(popoverFilterCount(f), 0);
  assert.equal(popoverFilterCount({ ...f, statuses: ['new'], q: 'crash' }), 0);
  assert.equal(popoverFilterCount({ ...f, ratings: [1, 2], language: 'de', sort: 'rating' }), 3);
  assert.equal(popoverFilterCount({ ...f, response: 'no', statuses: ['new', 'triaged', 'replied_in_console'] }, '30'), 3);
  assert.equal(filtersButtonText(0), 'Filters');
  assert.equal(filtersButtonText(3), 'Filters (3)');
});

test('the inbox also counts store, assignee, apps and the written window', () => {
  const f = defaultInboxFilters();
  assert.equal(inboxPopoverFilterCount(f), 0);
  assert.equal(inboxPopoverFilterCount({ ...f, platform: 'ios', assignee: 'me', appIds: ['a'], within: '7', ratings: [1] }), 5);
});

test('trend word: needs three rated weeks, ignores small moves', () => {
  assert.equal(trendWord([week(1, 4), week(2, 4)]), null);
  assert.equal(trendWord([week(1, 4), week(2, 4.1), week(3, 4)]), 'steady');
  assert.equal(trendWord([week(1, 3), week(2, 3), week(3, 4.5), week(4, 4.5)]), 'rising');
  assert.equal(trendWord([week(1, 4.5), week(2, 4.5), week(3, 3), week(4, 3)]), 'falling');
  assert.equal(trendWord([week(1, null, 0), week(2, 4), week(3, 4)]), null);
});

test('the stats line', () => {
  assert.equal(statsLine({ count: 0, average: null, weeks: [] }), 'No stored reviews yet');
  assert.equal(statsLine({ count: 1, average: 4, weeks: [] }), '4.0 average, 1 stored review');
  assert.equal(statsLine({ count: 12, average: 3.25, weeks: [week(1, 3), week(2, 3), week(3, 4.5)] }), '3.3 average, 12 stored reviews, rating rising');
});
