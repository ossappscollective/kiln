import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breadcrumbItems, charsFor, fitCrumbs } from './breadcrumb.ts';

const section = { label: 'All apps', href: '#/portfolio' };

test('an open app: workspace, a link to the list, the app as the current page', () => {
  const items = breadcrumbItems({ workspace: 'Akylas', section, appName: 'OSS Weather', appOpen: true });
  assert.deepEqual(
    items.map((i) => [i.label, i.href, i.current]),
    [
      ['Akylas', null, false],
      ['All apps', '#/portfolio', false],
      ['OSS Weather', null, true],
    ],
  );
});

test('a workspace page: the section is the current page and not a link', () => {
  const items = breadcrumbItems({ workspace: 'Akylas', section, appOpen: false });
  assert.equal(items.length, 2);
  assert.equal(items[1]?.current, true);
  assert.equal(items[1]?.href, null);
});

test('an app without a name yet shows App, and empty parts are dropped', () => {
  assert.equal(breadcrumbItems({ workspace: ' ', section, appName: '', appOpen: true })[1]?.label, 'App');
  assert.equal(breadcrumbItems({ workspace: '', section: null, appOpen: false }).length, 0);
});

test('an open app page follows the app, and the app links to its overview', () => {
  const items = breadcrumbItems({ workspace: 'Akylas', section, appName: 'OSS Weather', appOpen: true, page: 'Insights', appHref: '#/portfolio/a1' });
  assert.deepEqual(
    items.map((i) => [i.label, i.href, i.current]),
    [
      ['Akylas', null, false],
      ['All apps', '#/portfolio', false],
      ['OSS Weather', '#/portfolio/a1', false],
      ['Insights', null, true],
    ],
  );
  assert.equal(items[3]?.kind, 'page');
});

const deep = () =>
  breadcrumbItems({ workspace: 'Demo Studio', section, appName: 'Demo Notes', appOpen: true, page: 'Pending changes', appHref: '#/portfolio/a1' });
const text = (items: ReturnType<typeof fitCrumbs>) => items.map((i) => (i.kind === 'more' ? '…' : i.label));

test('fitCrumbs: everything when there is room', () => {
  assert.deepEqual(text(fitCrumbs(deep(), 80)), ['Demo Studio', 'All apps', 'Demo Notes', 'Pending changes']);
});

test('fitCrumbs: tight, the section goes first and the others stay whole', () => {
  assert.deepEqual(text(fitCrumbs(deep(), 45)), ['Demo Studio', 'Demo Notes', 'Pending changes']);
});

test('fitCrumbs: tighter, the middle crumbs become an ellipsis menu of links; the last crumb stays whole', () => {
  const shown = fitCrumbs(deep(), 34);
  assert.deepEqual(text(shown), ['Demo Studio', '…', 'Pending changes']);
  const menu = shown[1];
  assert.ok(menu && menu.kind === 'more');
  assert.deepEqual(menu.menu.map((c) => [c.label, c.href]), [['Demo Notes', '#/portfolio/a1']]);
});

test('fitCrumbs: tightest, the workspace goes into the menu too, and the page is never cut', () => {
  const shown = fitCrumbs(deep(), 10);
  assert.deepEqual(text(shown), ['…', 'Pending changes']);
  const menu = shown[0];
  assert.ok(menu && menu.kind === 'more');
  assert.deepEqual(menu.menu.map((c) => c.label), ['Demo Notes']);
});

test('fitCrumbs: nothing to hide for one crumb, and no menu when nothing in it is a link', () => {
  const lone = breadcrumbItems({ workspace: '', section, appOpen: false });
  assert.deepEqual(text(fitCrumbs(lone, 4)), ['All apps']);
  const page = breadcrumbItems({ workspace: 'Demo Studio', section, appOpen: false });
  assert.deepEqual(text(fitCrumbs(page, 5)), ['All apps']);
});

test('charsFor never goes below a handful of characters', () => {
  assert.equal(charsFor(10), 8);
  assert.ok(charsFor(400) > 40);
});
