import assert from 'node:assert/strict';
import { test } from 'node:test';
import { platformLogoUrl } from './platform-logos.ts';

test('no logo files means the generic glyph (null) for every platform', () => {
  for (const p of ['ios', 'macos', 'android', 'tizen', null, undefined])
    assert.equal(platformLogoUrl({}, p), null);
});

test('a dropped-in logo is found by platform, in any case, and only for that platform', () => {
  const modules = {
    '../../assets/platforms/ios.svg': '/assets/ios-abc.svg',
    '../../assets/platforms/Android.svg': '/a.svg',
  };
  assert.equal(platformLogoUrl(modules, 'ios'), '/assets/ios-abc.svg');
  assert.equal(platformLogoUrl(modules, 'IOS'), '/assets/ios-abc.svg');
  assert.equal(platformLogoUrl(modules, 'android'), '/a.svg');
  assert.equal(platformLogoUrl(modules, 'macos'), null);
});

test('an empty or non-string url is ignored', () => {
  assert.equal(platformLogoUrl({ 'x/ios.svg': '' }, 'ios'), null);
});
