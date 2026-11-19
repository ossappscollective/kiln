import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RELEASE_STATES, roles } from '@mrm/core';
import { isIconName } from './icons.ts';
import { roleIcons, statusIcon, statusIcons, toneIcon } from './status-icons.ts';

test('every release state has a registered icon, and the icons are distinct', () => {
  for (const state of RELEASE_STATES) assert.ok(isIconName(statusIcons[state]), state);
  assert.equal(new Set(RELEASE_STATES.map((s) => statusIcons[s])).size, RELEASE_STATES.length);
});

test('a missing status gets the neutral help glyph', () => {
  assert.equal(statusIcon(null), 'help');
  assert.equal(statusIcon(undefined), 'help');
  assert.equal(statusIcon('live'), 'check-circle');
});

test('every tone has a registered icon; an unknown tone is neutral', () => {
  for (const tone of ['neutral', 'ok', 'bad', 'warn', 'info', 'accent'])
    assert.ok(isIconName(toneIcon(tone)), tone);
  assert.equal(toneIcon('ok'), 'check-circle');
  assert.equal(toneIcon('bad'), 'x-circle');
  assert.equal(toneIcon('none'), 'minus');
  assert.equal(toneIcon(undefined), 'minus');
});

test('every role has a registered icon', () => {
  for (const role of roles) assert.ok(isIconName(roleIcons[role]), role);
});
