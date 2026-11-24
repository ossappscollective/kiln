import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allApps,
  appOptions,
  chosenTotal,
  filterSummaryText,
  matchApps,
  otherFilterCount,
  pruneAppIds,
  removeApp,
  selectedOptions,
  toggleApp,
} from './app-filter.ts';
import {
  defaultInboxFilters,
  hasActiveInboxFilters,
  inboxFiltersFromSearch,
  inboxFiltersToQuery,
  inboxFiltersToSearch,
  type SummaryApp,
} from './reviews.ts';

const apps = [
  {
    id: 'b1',
    name: 'Beta',
    identifier: 'com.acme.beta',
    platform: 'ios' as const,
    iconUrl: '/api/workspaces/w/apps/b1/icon',
  },
  { id: 'a1', name: 'Alpha', identifier: 'com.acme.alpha', platform: 'ios' as const },
  { id: 'a2', name: 'Álpha Pro', identifier: 'com.acme.alpha.pro', platform: 'android' as const },
];
const summaryApps = (rows: [string, number, number][]): SummaryApp[] =>
  rows.map(([id, total, n]) => ({
    app: { id, name: id, platform: 'ios', store: 'appstoreconnect' },
    total,
    new: n,
    unanswered: 0,
    lowRating: 0,
    average: null,
    oldestAt: null,
    newestAt: null,
  }));

test('options are sorted by name and carry the counts of the summary', () => {
  const o = appOptions(
    apps,
    summaryApps([
      ['a1', 12, 3],
      ['b1', 4, 0],
    ]),
  );
  assert.deepEqual(
    o.map((x) => x.id),
    ['a1', 'a2', 'b1'],
  );
  assert.deepEqual([o[0]?.total, o[0]?.newCount], [12, 3]);
  assert.equal(o[1]?.total, null, 'no summary row: unknown, not zero');
  assert.equal(appOptions(apps, null)[0]?.total, null);
  assert.equal(o[2]?.iconUrl, '/api/workspaces/w/apps/b1/icon');
});

test('search matches the name or the bundle id, ignoring case and accents, every word', () => {
  const o = appOptions(apps, null);
  assert.deepEqual(
    matchApps(o, '').map((x) => x.id),
    ['a1', 'a2', 'b1'],
  );
  assert.deepEqual(
    matchApps(o, 'ALPHA').map((x) => x.id),
    ['a1', 'a2'],
  );
  assert.deepEqual(
    matchApps(o, 'alpha pro').map((x) => x.id),
    ['a2'],
  );
  assert.deepEqual(
    matchApps(o, 'com.acme.beta').map((x) => x.id),
    ['b1'],
    'by bundle id',
  );
  assert.deepEqual(
    matchApps(o, 'acme beta').map((x) => x.id),
    ['b1'],
  );
  assert.deepEqual(matchApps(o, 'zzz'), []);
});

test('toggle, remove and reset', () => {
  assert.deepEqual(toggleApp(['a1'], 'b1'), ['a1', 'b1']);
  assert.deepEqual(toggleApp(['a1', 'b1'], 'a1'), ['b1']);
  assert.deepEqual(removeApp(['a1', 'b1'], 'b1'), ['a1']);
  assert.deepEqual(allApps(), []);
});

test('chips: chosen apps in the order chosen; ids that are not visible apps are not chips and are pruned once the apps are known', () => {
  const o = appOptions(apps, null);
  assert.deepEqual(
    selectedOptions(o, ['b1', 'ghost', 'a1']).map((x) => x.id),
    ['b1', 'a1'],
  );
  assert.deepEqual(pruneAppIds(['b1', 'ghost'], o, true), ['b1']);
  assert.deepEqual(
    pruneAppIds(['b1', 'ghost'], o, false),
    ['b1', 'ghost'],
    'before the apps are read nothing is dropped',
  );
});

test('the address round-trips the app filter together with the other filters', () => {
  const f = {
    ...defaultInboxFilters(),
    appIds: ['a1', 'b1'],
    ratings: [1, 2],
    platform: 'ios' as const,
    statuses: ['new' as const],
    response: 'no' as const,
    q: 'crash',
    within: '30' as const,
  };
  const search = inboxFiltersToSearch(f);
  const params = new URLSearchParams(search);
  assert.equal(params.get('apps'), 'a1,b1');
  assert.equal(params.get('rating'), '1,2');
  const back = inboxFiltersFromSearch(`?${search}`);
  assert.deepEqual(back.appIds, ['a1', 'b1']);
  assert.deepEqual(back.ratings, [1, 2]);
  assert.equal(back.platform, 'ios');
  assert.equal(back.q, 'crash');
  assert.equal(inboxFiltersToSearch(back), search, 'a stable round trip');
  assert.equal(inboxFiltersToSearch(defaultInboxFilters()), '', 'no filter, no query');
  // The same state goes to the server as `appIds`, with the other filters.
  const q = new URLSearchParams(inboxFiltersToQuery(f, 0, { limit: 25 }));
  assert.equal(q.get('appIds'), 'a1,b1');
  assert.equal(q.get('rating'), '1,2');
  assert.equal(q.get('platform'), 'ios');
  assert.equal(q.get('limit'), '25');
});

test('a hostile or broken ?apps= is dropped, never trusted', () => {
  assert.deepEqual(inboxFiltersFromSearch('?apps=a1,<script>').appIds, []);
  assert.deepEqual(inboxFiltersFromSearch('?apps=').appIds, []);
  assert.deepEqual(
    inboxFiltersFromSearch(`?apps=${Array.from({ length: 51 }, (_, i) => `a${i}`).join(',')}`)
      .appIds,
    [],
  );
  assert.deepEqual(inboxFiltersFromSearch('?apps=a1,a1,b1').appIds, ['a1', 'b1']);
  assert.deepEqual(inboxFiltersFromSearch('?apps=a%20b').appIds, []);
});

test('chosen total adds the counts, null while any is unknown or nothing is chosen', () => {
  const o = appOptions(
    apps,
    summaryApps([
      ['a1', 12, 3],
      ['b1', 4, 0],
    ]),
  );
  assert.equal(chosenTotal(o, ['a1', 'b1']), 16);
  assert.equal(chosenTotal(o, ['a1', 'a2']), null);
  assert.equal(chosenTotal(o, []), null);
});

test('the active filter summary names the apps and counts the other filters', () => {
  const o = appOptions(apps, null);
  const none = defaultInboxFilters();
  assert.equal(filterSummaryText(none, o), null);
  assert.equal(hasActiveInboxFilters(none), false);
  assert.match(filterSummaryText({ ...none, appIds: ['a1'] }, o) ?? '', /Alpha/);
  assert.match(filterSummaryText({ ...none, appIds: ['a1', 'b1'] }, o) ?? '', /Alpha.*Beta/);
  const many = filterSummaryText({ ...none, appIds: ['a1', 'a2', 'b1'] }, o) ?? '';
  assert.match(many, /Alpha/);
  assert.match(many, /2/);
  assert.match(filterSummaryText({ ...none, appIds: ['a1'], ratings: [1], q: 'x' }, o) ?? '', /2/);
  assert.match(filterSummaryText({ ...none, ratings: [1] }, o) ?? '', /1/);
  assert.equal(otherFilterCount({ ...none, appIds: ['a1'] }), 0, 'apps are not "other"');
  assert.equal(otherFilterCount({ ...none, ratings: [1], platform: 'ios', within: '7' }), 3);
});
