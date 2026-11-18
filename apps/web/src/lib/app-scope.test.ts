import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appAddress, appReviewsHref, appSectionDefs, parseAppAddress, parseViewPath, resolveScope, visibleSections, withScope } from './app-scope.ts';
import { isIconName } from './icons.ts';

test('parseViewPath splits segments and ignores the query for the section', () => {
  const p = parseViewPath('#/reviews?rating=1,2&apps=x');
  assert.deepEqual(p.segments, ['reviews']);
  assert.equal(p.query.get('rating'), '1,2');
  assert.deepEqual(parseViewPath('').segments, []);
  assert.deepEqual(parseViewPath('#/portfolio/a%20b/').segments, ['portfolio', 'a b']);
  assert.deepEqual(parseViewPath('#/portfolio/%E0%A4%A').segments, ['portfolio', '%E0%A4%A']);
  assert.deepEqual(parseViewPath('#/settings#frag').segments, ['settings']);
});

test('parseAppAddress reads id, section, release and platform', () => {
  assert.equal(parseAppAddress('#/portfolio'), null);
  assert.equal(parseAppAddress('#/reviews/a1'), null);
  assert.deepEqual(parseAppAddress('#/portfolio/a1'), { id: 'a1', section: 'dashboard', release: null, platform: null });
  assert.deepEqual(parseAppAddress('#/portfolio/a1/reviews?platform=android'), {
    id: 'a1',
    section: 'reviews',
    release: null,
    platform: 'android',
  });
  assert.deepEqual(parseAppAddress('#/portfolio/a1/release/2.1.0?platform=both'), {
    id: 'a1',
    section: 'releases',
    release: '2.1.0',
    platform: 'both',
  });
  // Unknown sections and platforms fall back; they are never trusted.
  assert.deepEqual(parseAppAddress('#/portfolio/a1/nope?platform=windows'), { id: 'a1', section: 'dashboard', release: null, platform: null });
});

test('appAddress and parseAppAddress round trip', () => {
  assert.equal(appAddress('a b'), '#/portfolio/a%20b');
  assert.equal(appAddress('a1', 'listing', 'ios'), '#/portfolio/a1/listing?platform=ios');
  assert.equal(appAddress('a1', 'dashboard', 'both'), '#/portfolio/a1?platform=both');
  assert.equal(appAddress('a1', 'releases', null, '1.0 beta'), '#/portfolio/a1/release/1.0%20beta');
  assert.equal(appReviewsHref('a1'), '#/portfolio/a1/reviews');
  for (const hash of [appAddress('x/y', 'assets', 'android'), appAddress('x', 'releases', 'ios', '2.0')]) {
    const parsed = parseAppAddress(hash);
    assert.ok(parsed);
    assert.equal(appAddress(parsed.id, parsed.section, parsed.platform, parsed.release), hash);
  }
});

test('withScope sets, replaces and removes the platform and keeps other parts', () => {
  assert.equal(withScope('#/portfolio/a1/listing', 'ios'), '#/portfolio/a1/listing?platform=ios');
  assert.equal(withScope('#/portfolio/a1/listing?platform=ios', 'android'), '#/portfolio/a1/listing?platform=android');
  assert.equal(withScope('#/portfolio/a1?x=1&platform=ios', null), '#/portfolio/a1?x=1');
  assert.equal(withScope('#/portfolio/a1?platform=ios', null), '#/portfolio/a1');
});

test('resolveScope defaults to Both for two stores and follows the address', () => {
  const both = resolveScope(null, ['android', 'ios']);
  assert.equal(both.scope, 'both');
  assert.deepEqual(both.platforms, ['ios', 'android']);
  assert.ok(both.options.every((o) => !o.disabled));
  assert.equal(resolveScope('android', ['ios', 'android']).scope, 'android');
  assert.deepEqual(resolveScope('android', ['ios', 'android']).platforms, ['android']);
});

test('resolveScope disables the missing store and Both for a one-store app', () => {
  const ios = resolveScope('android', ['ios']);
  assert.equal(ios.scope, 'ios');
  assert.deepEqual(ios.platforms, ['ios']);
  const byId = Object.fromEntries(ios.options.map((o) => [o.id, o]));
  assert.equal(byId.ios?.disabled, false);
  assert.equal(byId.android?.disabled, true);
  assert.equal(byId.android?.reason, 'This app is not on that store');
  assert.equal(byId.both?.disabled, true);
  assert.equal(resolveScope('both', ['android']).scope, 'android');
  assert.deepEqual(resolveScope(null, []).platforms, []);
});

test('visibleSections follows the actions a role has', () => {
  assert.deepEqual(visibleSections(() => true).map((s) => s.id), ['dashboard', 'listing', 'releases', 'assets', 'reviews', 'builds', 'settings']);
  assert.deepEqual(visibleSections((a) => a === 'apps.read').map((s) => s.id), ['dashboard', 'releases', 'builds', 'settings']);
  assert.ok(appSectionDefs.every((s) => isIconName(s.icon)));
});
