import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allScopeLabel,
  appAddress,
  appReviewsHref,
  appSectionDefs,
  appWorkflowsHref,
  parseAppAddress,
  parseViewPath,
  resolveScope,
  visibleSections,
  withScope,
} from './app-scope.ts';
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
  assert.deepEqual(parseAppAddress('#/portfolio/a1'), {
    id: 'a1',
    section: 'dashboard',
    release: null,
    platform: null,
  });
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
  assert.deepEqual(parseAppAddress('#/portfolio/a1/nope?platform=windows'), {
    id: 'a1',
    section: 'dashboard',
    release: null,
    platform: null,
  });
});

test('appAddress and parseAppAddress round trip', () => {
  assert.equal(appAddress('a b'), '#/portfolio/a%20b');
  assert.equal(appAddress('a1', 'listing', 'ios'), '#/portfolio/a1/listing?platform=ios');
  assert.equal(appAddress('a1', 'dashboard', 'both'), '#/portfolio/a1?platform=both');
  assert.equal(appAddress('a1', 'releases', null, '1.0 beta'), '#/portfolio/a1/release/1.0%20beta');
  assert.equal(appReviewsHref('a1'), '#/portfolio/a1/reviews');
  for (const hash of [
    appAddress('x/y', 'assets', 'android'),
    appAddress('x', 'releases', 'ios', '2.0'),
  ]) {
    const parsed = parseAppAddress(hash);
    assert.ok(parsed);
    assert.equal(appAddress(parsed.id, parsed.section, parsed.platform, parsed.release), hash);
  }
});

test('withScope sets, replaces and removes the platform and keeps other parts', () => {
  assert.equal(withScope('#/portfolio/a1/listing', 'ios'), '#/portfolio/a1/listing?platform=ios');
  assert.equal(
    withScope('#/portfolio/a1/listing?platform=ios', 'android'),
    '#/portfolio/a1/listing?platform=android',
  );
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
  assert.deepEqual(
    visibleSections(() => true).map((s) => s.id),
    [
      'dashboard',
      'pending',
      'listing',
      'releases',
      'workflows',
      'assets',
      'reviews',
      'insights',
      'aso',
      'analytics',
      'builds',
      'test-builds',
      'settings',
    ],
  );
  assert.deepEqual(
    visibleSections((a) => a === 'apps.read').map((s) => s.id),
    ['dashboard', 'releases', 'workflows', 'builds', 'settings'],
  );
  assert.ok(appSectionDefs.every((s) => isIconName(s.icon)));
});

test('resolveScope with a macOS record: three platforms show All, and only the platforms the app has are shown', () => {
  const all = resolveScope(null, ['android', 'macos', 'ios']);
  assert.equal(all.scope, 'both');
  assert.deepEqual(all.platforms, ['ios', 'macos', 'android']);
  assert.deepEqual(
    all.options.map((o) => [o.id, o.label, o.disabled]),
    [
      ['ios', 'iOS', false],
      ['macos', 'macOS', false],
      ['android', 'Android', false],
      ['both', 'All', false],
    ],
  );
  assert.equal(resolveScope('macos', ['ios', 'macos', 'android']).scope, 'macos');
  assert.deepEqual(resolveScope('macos', ['ios', 'macos', 'android']).platforms, ['macos']);

  // iOS and macOS only: two platforms, so "Both", and no Android option at all.
  const apple = resolveScope(null, ['ios', 'macos']);
  assert.deepEqual(
    apple.options.map((o) => [o.id, o.label]),
    [
      ['ios', 'iOS'],
      ['macos', 'macOS'],
      ['both', 'Both'],
    ],
  );
  assert.deepEqual(apple.platforms, ['ios', 'macos']);

  // macOS alone: one option, no "Both".
  const mac = resolveScope('both', ['macos']);
  assert.equal(mac.scope, 'macos');
  assert.deepEqual(
    mac.options.map((o) => o.id),
    ['macos'],
  );

  // An app without macOS never shows the macOS option, and a macOS request falls back.
  const classic = resolveScope('macos', ['ios', 'android']);
  assert.equal(classic.scope, 'both');
  assert.deepEqual(
    classic.options.map((o) => o.id),
    ['ios', 'android', 'both'],
  );
  assert.equal(allScopeLabel(2), 'Both');
  assert.equal(allScopeLabel(3), 'All');
});

test('an address with ?platform=macos is a scope', () => {
  assert.equal(parseAppAddress('#/portfolio/a1/listing?platform=macos')?.platform, 'macos');
  assert.equal(parseAppAddress('#/portfolio/a1?platform=windows')?.platform, null);
  assert.equal(appAddress('a1', 'assets', 'macos'), '#/portfolio/a1/assets?platform=macos');
});

test('the workflows section has its own address and keeps the scope', () => {
  assert.equal(appWorkflowsHref('a1'), '#/portfolio/a1/workflows');
  assert.equal(appWorkflowsHref('a1', 'ios'), '#/portfolio/a1/workflows?platform=ios');
  assert.equal(parseAppAddress('#/portfolio/a1/workflows?platform=android')?.section, 'workflows');
});

test('the pending changes section is an app section with its own address, also as ?section=pending', () => {
  assert.equal(appAddress('a1', 'pending'), '#/portfolio/a1/pending');
  assert.equal(appAddress('a1', 'pending', 'ios'), '#/portfolio/a1/pending?platform=ios');
  assert.deepEqual(parseAppAddress('#/portfolio/a1/pending?platform=android'), {
    id: 'a1',
    section: 'pending',
    release: null,
    platform: 'android',
  });
  assert.equal(parseAppAddress('#/portfolio/a1?section=pending')?.section, 'pending');
  // The path wins, and an unknown section falls back to the dashboard.
  assert.equal(parseAppAddress('#/portfolio/a1/listing?section=pending')?.section, 'listing');
  assert.equal(parseAppAddress('#/portfolio/a1?section=nope')?.section, 'dashboard');
  // Everybody who can read the listing sees it (every role).
  assert.ok(visibleSections((a) => a === 'listing.read').some((s) => s.id === 'pending'));
  assert.ok(!visibleSections((a) => a === 'apps.read').some((s) => s.id === 'pending'));
});
