import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_BANNER_KEY, isDemoStatus } from './demo.ts';
import { t } from './i18n/t.ts';

test('only an answer that says demo: true is the demo workspace', () => {
  assert.equal(isDemoStatus({ demo: true, seededAt: 1, workspace: null }), true);
  assert.equal(isDemoStatus({ demo: false }), false);
  assert.equal(isDemoStatus({ demo: 'true' }), false);
  assert.equal(isDemoStatus({}), false);
  assert.equal(isDemoStatus(null), false);
  assert.equal(isDemoStatus(undefined), false);
  assert.equal(isDemoStatus('<!doctype html>'), false);
});

test('the bar says what the demo is', () => {
  assert.match(t(DEMO_BANNER_KEY), /^Demo workspace/);
  assert.match(t(DEMO_BANNER_KEY), /nothing leaves your machine/);
});
