import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heightToHold, routePath, shouldResetScroll } from './scroll-keep.ts';

test('the route path ignores the query and the fragment', () => {
  assert.equal(routePath('#/portfolio/7/listing?view=graphics'), '/portfolio/7/listing');
  assert.equal(routePath('#/portfolio/7/'), '/portfolio/7');
  assert.equal(routePath(''), '/');
  assert.equal(routePath('#/reviews?rating=1#x'), '/reviews');
});

test('a query-only change never resets the scroll', () => {
  const base = '#/portfolio/7/builds';
  for (const next of ['#/portfolio/7/builds?view=workflows', '#/portfolio/7/builds?view=tests&platform=ios', '#/portfolio/7/builds?version=1.2', '#/portfolio/7/builds?locale=de-DE']) {
    assert.equal(shouldResetScroll(base, next), false, next);
  }
  assert.equal(shouldResetScroll('#/portfolio/7/insights?view=keywords', '#/portfolio/7/insights?view=rank'), false);
  assert.equal(shouldResetScroll('#/reviews?rating=1', '#/reviews?rating=2&q=a'), false);
  assert.equal(shouldResetScroll('#/portfolio/7/reviews', '#/portfolio/7/reviews'), false);
});

test('another page, app or release resets the scroll', () => {
  assert.equal(shouldResetScroll('#/portfolio/7/builds', '#/portfolio/7/reviews'), true);
  assert.equal(shouldResetScroll('#/portfolio/7/builds', '#/portfolio/8/builds'), true);
  assert.equal(shouldResetScroll('#/portfolio/7/releases', '#/portfolio/7/release/1.2.0'), true);
  assert.equal(shouldResetScroll('#/portfolio', '#/portfolio/7'), true);
  assert.equal(shouldResetScroll('#/reviews', '#/audit'), true);
});

test('the page holds its height only when it keeps its place', () => {
  assert.equal(heightToHold(false, 1200.4), 1201);
  assert.equal(heightToHold(true, 1200), 0);
  assert.equal(heightToHold(false, 0), 0);
  assert.equal(heightToHold(false, Number.NaN), 0);
});
