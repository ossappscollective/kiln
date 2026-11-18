import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_ICON_PX, APP_ICON_TINTS, appIconPixels, iconAlt, iconSrc, initialsOf, tintIndex } from './app-icon.ts';

test('iconSrc accepts only the icon route of this server', () => {
  assert.equal(iconSrc('/api/workspaces/w1/apps/a1/icon?v=abc'), '/api/workspaces/w1/apps/a1/icon?v=abc');
  assert.equal(iconSrc('/api/workspaces/w1/apps/a1/icon'), '/api/workspaces/w1/apps/a1/icon');
});

test('iconSrc drops everything that is not a plain same-origin path', () => {
  for (const bad of [
    null,
    undefined,
    '',
    'https://example.com/icon.png',
    '//evil.example/api/workspaces/x',
    'http://localhost/api/workspaces/w/apps/a/icon',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '/other/path.png',
    '/api/workspaces/../secret',
    '/api/workspaces/w/apps/a/../../x',
    '/api/workspaces/w\\apps',
    '/api/workspaces/w/apps/a/icon\n',
    '/api/workspaces//w',
    `/api/workspaces/${'a'.repeat(700)}`,
  ]) {
    assert.equal(iconSrc(bad as string | null | undefined), null, String(bad));
  }
});

test('initials: two words give two letters, one word gives up to two', () => {
  assert.equal(initialsOf('Weather App'), 'WA');
  assert.equal(initialsOf('weather'), 'WE');
  assert.equal(initialsOf('x'), 'X');
  assert.equal(initialsOf('  my-cool_app  '), 'MC');
  assert.equal(initialsOf('(Beta) Notes'), 'BN');
  assert.equal(initialsOf('Ärger Öl'), 'ÄÖ');
});

test('initials: an empty or symbol-only name gives a question mark', () => {
  assert.equal(initialsOf(''), '?');
  assert.equal(initialsOf(null), '?');
  assert.equal(initialsOf(undefined), '?');
  assert.equal(initialsOf('---'), '?');
});

test('tintIndex is stable and within range', () => {
  assert.equal(tintIndex('app-1'), tintIndex('app-1'));
  for (const seed of ['', 'a', 'app-1', 'app-2', 'a long name with many words', 'ÄÖÜ']) {
    const t = tintIndex(seed);
    assert.ok(Number.isInteger(t) && t >= 0 && t < APP_ICON_TINTS, seed);
  }
  assert.equal(tintIndex(null), tintIndex(''));
  const seen = new Set<number>();
  for (let i = 0; i < 40; i += 1) seen.add(tintIndex(`app-${i}`));
  assert.ok(seen.size > 1, 'the tints are spread');
});

test('sizes: named sizes map to pixels, numbers are clamped', () => {
  assert.equal(appIconPixels('md'), APP_ICON_PX.md);
  assert.equal(appIconPixels('xl'), 64);
  assert.equal(appIconPixels(40.4), 40);
  assert.equal(appIconPixels(2), 12);
  assert.equal(appIconPixels('bogus' as never), APP_ICON_PX.md);
});

test('alt text: decorative beside a name, named when alone', () => {
  assert.equal(iconAlt('Weather', true), '');
  assert.equal(iconAlt('Weather', false), 'Weather icon');
  assert.equal(iconAlt('  ', false), 'App icon');
  assert.equal(iconAlt(null, false), 'App icon');
});
