import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isIconName } from '../components/ui/icons.ts';
import {
  canonicalAppHash,
  canonicalSection,
  navEntryOf,
  pageTitle,
  primaryNav,
  resolveView,
  sectionViews,
  showsScope,
  viewOf,
  viewsFor,
  visibleNav,
  withInsightsAsoView,
  withView,
  workspaceRail,
} from './app-nav.ts';
import { appSectionDefs, parseAppAddress } from './app-scope.ts';

const all = () => true;

test('the left panel has exactly six entries, in order, and no pending changes', () => {
  assert.deepEqual(primaryNav.map((e) => e.label), ['Overview', 'Releases', 'Store listing', 'Reviews', 'Insights', 'Builds']);
  assert.deepEqual(visibleNav(all).map((e) => e.id), ['dashboard', 'releases', 'listing', 'reviews', 'insights', 'builds']);
  assert.ok(primaryNav.every((e) => isIconName(e.icon)));
  // Every entry is a page an address can name, with the same right.
  for (const e of primaryNav) assert.ok(appSectionDefs.some((s) => s.id === e.id && s.requires === e.requires), e.id);
});

test('entries follow the actions a role has', () => {
  assert.deepEqual(visibleNav((a) => a === 'apps.read').map((e) => e.id), ['dashboard', 'releases', 'builds']);
  assert.deepEqual(visibleNav((a) => a === 'listing.read' || a === 'reviews.read').map((e) => e.id), ['listing', 'reviews']);
});

test('an old page highlights the entry that holds it now; pending and settings highlight none', () => {
  assert.equal(navEntryOf('aso'), 'insights');
  assert.equal(navEntryOf('analytics'), 'insights');
  assert.equal(navEntryOf('assets'), 'listing');
  assert.equal(navEntryOf('workflows'), 'builds');
  assert.equal(navEntryOf('test-builds'), 'builds');
  assert.equal(navEntryOf('pending'), null);
  assert.equal(navEntryOf('settings'), null);
  assert.equal(navEntryOf('reviews'), 'reviews');
});

test('the workspace rail: All apps, Inbox, Settings, and the rest in a collapsed group', () => {
  const views = [
    { id: 'portfolio', label: 'All apps', icon: 'smartphone' },
    { id: 'reviews', label: 'Reviews inbox', icon: 'message' },
    { id: 'aso', label: 'ASO', icon: 'trending-up' },
    { id: 'repositories', label: 'Repositories', icon: 'git-branch' },
    { id: 'credentials', label: 'Credentials', icon: 'key' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
    { id: 'audit', label: 'Audit log', icon: 'history' },
  ];
  const rail = workspaceRail(views);
  assert.deepEqual(rail.main.map((v) => [v.id, v.label]), [['portfolio', 'All apps'], ['reviews', 'Inbox'], ['settings', 'Settings']]);
  assert.deepEqual(rail.more.map((v) => v.id), ['aso', 'repositories', 'credentials', 'audit']);
  // A role that may open less sees less; nothing is invented.
  const few = workspaceRail([{ id: 'portfolio', label: 'All apps' }, { id: 'members', label: 'Members' }]);
  assert.deepEqual(few.main.map((v) => v.id), ['portfolio']);
  assert.deepEqual(few.more.map((v) => v.id), ['members']);
  assert.deepEqual(workspaceRail([]), { main: [], more: [] });
});

test('old addresses redirect to the new place and keep platform, version, locale and the rest', () => {
  assert.equal(canonicalAppHash('#/portfolio/a1/workflows'), '#/portfolio/a1/builds?view=workflows');
  assert.equal(canonicalAppHash('#/portfolio/a1/workflows?platform=ios'), '#/portfolio/a1/builds?platform=ios&view=workflows');
  assert.equal(canonicalAppHash('#/portfolio/a1/test-builds?platform=android&build=240'), '#/portfolio/a1/builds?platform=android&build=240&view=tests');
  assert.equal(canonicalAppHash('#/portfolio/a1/assets?platform=macos&version=2.4.0&locale=en-US'), '#/portfolio/a1/listing?platform=macos&version=2.4.0&locale=en-US&view=graphics');
  assert.equal(canonicalAppHash('#/portfolio/a1/analytics?range=28d'), '#/portfolio/a1/insights?range=28d');
  assert.equal(canonicalAppHash('#/portfolio/a1/analytics'), '#/portfolio/a1/insights');
  assert.equal(canonicalAppHash('#/portfolio/a1/aso'), '#/portfolio/a1/insights?view=aso');
  assert.equal(canonicalAppHash('#/portfolio/a1/aso?view=fit&platform=ios'), '#/portfolio/a1/insights?view=fit&platform=ios');
  assert.equal(canonicalAppHash('#/portfolio/a1/aso?view=keywords'), '#/portfolio/a1/insights?view=keywords');
  assert.equal(canonicalAppHash('#/portfolio/a1/aso?view=nonsense'), '#/portfolio/a1/insights?view=aso');
  // The old ?section= form is replaced by the path.
  assert.equal(canonicalAppHash('#/portfolio/a1?section=workflows'), '#/portfolio/a1/builds?view=workflows');
  assert.equal(canonicalAppHash('#/portfolio/my%20app/assets'), '#/portfolio/my%20app/listing?view=graphics');
});

test('the new pages, pending, settings, a release and non-app addresses are not redirected', () => {
  for (const hash of [
    '#/portfolio/a1',
    '#/portfolio/a1/releases',
    '#/portfolio/a1/listing?view=graphics',
    '#/portfolio/a1/insights?view=aso',
    '#/portfolio/a1/builds',
    '#/portfolio/a1/pending',
    '#/portfolio/a1/settings',
    '#/portfolio/a1/release/2.4.0',
    '#/portfolio',
    '#/aso',
    '#/workflows',
    '#/reviews?rating=1',
    '',
  ]) {
    assert.equal(canonicalAppHash(hash), null, hash);
  }
});

test('every redirect lands on a page of the left panel and needs no further redirect', () => {
  for (const old of ['workflows', 'assets', 'aso', 'analytics', 'test-builds']) {
    const next = canonicalAppHash(`#/portfolio/a1/${old}`) as string;
    assert.equal(canonicalAppHash(next), null, next);
    const open = parseAppAddress(next);
    assert.ok(primaryNav.some((e) => e.id === open?.section), next);
  }
});

test('canonicalSection reads an old page as its new page', () => {
  assert.equal(canonicalSection('workflows'), 'builds');
  assert.equal(canonicalSection('test-builds'), 'builds');
  assert.equal(canonicalSection('assets'), 'listing');
  assert.equal(canonicalSection('aso'), 'insights');
  assert.equal(canonicalSection('analytics'), 'insights');
  assert.equal(canonicalSection('pending'), 'pending');
  assert.equal(canonicalSection('releases'), 'releases');
});

test('views: the first is the default; unknown values fall back to it', () => {
  assert.equal(viewOf('listing', '#/portfolio/a1/listing'), 'text');
  assert.equal(viewOf('listing', '#/portfolio/a1/listing?view=graphics'), 'graphics');
  assert.equal(viewOf('listing', '#/portfolio/a1/listing?view=zzz'), 'text');
  assert.equal(viewOf('builds', '#/portfolio/a1/builds?view=tests'), 'tests');
  assert.equal(viewOf('builds', '#/portfolio/a1/builds?view=workflows'), 'workflows');
  assert.equal(viewOf('builds', '#/portfolio/a1/builds'), 'builds');
  assert.equal(viewOf('reviews', '#/portfolio/a1/reviews?view=text'), '');
});

test('Insights: any ASO sub-view of the address is the ASO view', () => {
  assert.equal(viewOf('insights', '#/portfolio/a1/insights'), 'analytics');
  assert.equal(viewOf('insights', '#/portfolio/a1/insights?view=analytics'), 'analytics');
  assert.equal(viewOf('insights', '#/portfolio/a1/insights?view=aso'), 'aso');
  for (const v of ['keywords', 'listing', 'competitors', 'ideas', 'fit', 'gaps', 'markets', 'terms', 'rank']) {
    assert.equal(viewOf('insights', `#/portfolio/a1/insights?view=${v}`), 'aso', v);
  }
  assert.equal(viewOf('insights', '#/portfolio/a1/insights?view=zzz'), 'analytics');
});

test('withView writes the view, drops the default and keeps the rest of the address', () => {
  assert.equal(withView('#/portfolio/a1/listing', 'listing', 'graphics'), '#/portfolio/a1/listing?view=graphics');
  assert.equal(withView('#/portfolio/a1/listing?platform=ios&view=graphics&locale=de', 'listing', 'text'), '#/portfolio/a1/listing?platform=ios&locale=de');
  assert.equal(withView('#/portfolio/a1/builds?platform=android', 'builds', 'tests'), '#/portfolio/a1/builds?platform=android&view=tests');
  assert.equal(withView('#/portfolio/a1/insights', 'insights', 'aso'), '#/portfolio/a1/insights?view=aso');
  assert.equal(withView('#/portfolio/a1/insights?view=aso', 'insights', 'analytics'), '#/portfolio/a1/insights');
  // A view the page does not have changes nothing.
  assert.equal(withView('#/portfolio/a1/listing', 'listing', 'nope'), '#/portfolio/a1/listing');
  assert.equal(withView('#/portfolio/a1/reviews', 'reviews', 'text'), '#/portfolio/a1/reviews');
  // And the view round-trips.
  for (const section of ['listing', 'insights', 'builds'] as const) {
    for (const v of sectionViews[section] ?? []) assert.equal(viewOf(section, withView(`#/portfolio/a1/${section}`, section, v.id)), v.id);
  }
});

test('the ASO tabs inside Insights keep the address on ASO, also for Keywords', () => {
  assert.equal(withInsightsAsoView('#/portfolio/a1/insights?view=aso', 'fit'), '#/portfolio/a1/insights?view=fit');
  assert.equal(withInsightsAsoView('#/portfolio/a1/insights?view=fit&platform=ios', 'keywords'), '#/portfolio/a1/insights?view=aso&platform=ios');
  assert.equal(viewOf('insights', withInsightsAsoView('#/portfolio/a1/insights', 'keywords')), 'aso');
});

test('a page offers a switch only for the views the role may open, and only when there is a choice', () => {
  assert.deepEqual(viewsFor('builds', all).map((v) => v.id), ['builds', 'workflows', 'tests']);
  assert.deepEqual(viewsFor('builds', (a) => a === 'apps.read').map((v) => v.id), ['builds', 'workflows']);
  assert.deepEqual(viewsFor('insights', all).map((v) => v.id), ['analytics', 'aso']);
  assert.deepEqual(viewsFor('insights', (a) => a === 'analytics.read'), []);
  assert.deepEqual(viewsFor('listing', all).map((v) => v.id), ['text', 'graphics']);
  assert.deepEqual(viewsFor('reviews', all), []);
});

test('resolveView falls back to a view the role may open', () => {
  assert.equal(resolveView('insights', '#/portfolio/a1/insights?view=aso', all), 'aso');
  assert.equal(resolveView('insights', '#/portfolio/a1/insights?view=aso', (a) => a === 'analytics.read'), 'analytics');
  assert.equal(resolveView('builds', '#/portfolio/a1/builds?view=tests', (a) => a === 'apps.read'), 'builds');
  assert.equal(resolveView('builds', '#/portfolio/a1/builds', all), 'builds');
  assert.equal(resolveView('dashboard', '#/portfolio/a1', all), '');
});

test('page titles, and the platform control only where it means something', () => {
  assert.equal(pageTitle('dashboard'), 'Overview');
  assert.equal(pageTitle('listing'), 'Store listing');
  assert.equal(pageTitle('pending'), 'Pending changes');
  assert.equal(pageTitle('aso'), 'Insights');
  assert.equal(pageTitle('test-builds'), 'Builds');
  assert.equal(showsScope('releases', 2), true);
  assert.equal(showsScope('releases', 3), true);
  assert.equal(showsScope('releases', 1), false);
  assert.equal(showsScope('settings', 2), false);
});
