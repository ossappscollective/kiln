import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breadcrumbItems } from './breadcrumb.ts';

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
