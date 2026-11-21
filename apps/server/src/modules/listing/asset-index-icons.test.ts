import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AssetFacts, validateAssets } from '@kiln/core';
import { validatedFacts } from './asset-index.ts';

const icon = (path: string, size: number | null): AssetFacts => ({
  path,
  store: 'app_store',
  locale: 'default',
  kind: 'app_icon',
  device: null,
  order: 1,
  bytes: 10,
  width: size,
  height: size,
  format: 'png',
  extension: 'png',
  hasAlpha: false,
  read: 'read',
});

test('an AppIcon.appiconset is held to the 1024 px icon only, not to every slot', () => {
  const all = [
    icon('a/20.png', 20),
    icon('a/60.png', 60),
    icon('a/1024.png', 1024),
    icon('a/120.png', 120),
  ];
  assert.equal(
    validateAssets('app_store', all).filter((p) => p.rule === 'apple.icon.size').length,
    3,
  );
  const kept = validatedFacts(all);
  assert.deepEqual(
    kept.map((f) => f.path),
    ['a/1024.png'],
  );
  assert.equal(validateAssets('app_store', kept).length, 0);
});

test('without a 1024 px icon the largest one is checked, so a real mistake is still reported', () => {
  const kept = validatedFacts([icon('a/20.png', 20), icon('a/120.png', 120)]);
  assert.deepEqual(
    kept.map((f) => f.path),
    ['a/120.png'],
  );
  assert.equal(
    validateAssets('app_store', kept).filter((p) => p.rule === 'apple.icon.size').length,
    1,
  );
});

test('other files and a single icon are untouched', () => {
  const shot: AssetFacts = { ...icon('s.png', 100), kind: 'screenshot', device: 'iphone_6_9' };
  assert.equal(validatedFacts([icon('only.png', 60), shot]).length, 2);
});
