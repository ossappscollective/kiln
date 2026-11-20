import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapOrNull, nullableNumber, nullableString, oneOf, oneOfOrNull } from './row.ts';

test('nullable readers turn NULL and a missing column into null and convert the rest', () => {
  assert.equal(nullableString(null), null);
  assert.equal(nullableString(undefined), null);
  assert.equal(nullableString(12), '12');
  assert.equal(nullableNumber(undefined), null);
  assert.equal(nullableNumber('1700000000000'), 1_700_000_000_000);
  assert.equal(
    mapOrNull('x', (v) => `${String(v)}!`),
    'x!',
  );
  assert.equal(mapOrNull(null, String), null);
});

test('oneOf returns the union type and throws on anything else', () => {
  const platforms = ['ios', 'android'] as const;
  const p: 'ios' | 'android' = oneOf('ios', platforms, 'platform');
  assert.equal(p, 'ios');
  assert.throws(() => oneOf('windows', platforms, 'platform'), /Column platform holds "windows"/);
  assert.equal(oneOfOrNull(null, platforms, 'platform'), null);
  assert.equal(oneOfOrNull('android', platforms, 'platform'), 'android');
});
