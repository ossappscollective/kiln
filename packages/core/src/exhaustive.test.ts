import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNever } from './exhaustive.ts';

type Shape = 'a' | 'b';

const name = (s: Shape): string => {
  switch (s) {
    case 'a':
      return 'A';
    case 'b':
      return 'B';
    default:
      return assertNever(s, 'shape');
  }
};

test('a handled union gives its value and an unexpected one throws with its name', () => {
  assert.equal(name('a'), 'A');
  assert.throws(() => name('c' as Shape), /Unhandled shape: "c"/);
});
