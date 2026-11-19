import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPS_HINT,
  appsLine,
  dispatchAppsBody,
  initialSelection,
  toggleApp,
} from './dispatch-apps.ts';

const apps = [
  { id: 'a', name: 'Acme', platform: 'ios' as const },
  { id: 'b', name: 'Acme', platform: 'android' as const },
  { id: 'c', name: 'Other', platform: 'ios' as const },
];

test('none selected sends no appIds at all', () => {
  assert.deepEqual(dispatchAppsBody([]), {});
  assert.deepEqual(dispatchAppsBody(['a', 'b', 'a']), { appIds: ['a', 'b'] });
  assert.equal(dispatchAppsBody(Array.from({ length: 30 }, (_, i) => `x${i}`)).appIds?.length, 20);
});

test('the suggested app is preselected only when it belongs to the repository', () => {
  assert.deepEqual(initialSelection(apps, 'b'), ['b']);
  assert.deepEqual(initialSelection(apps, 'zz'), []);
  assert.deepEqual(initialSelection(apps, ''), []);
});

test('toggling keeps the order of the list', () => {
  assert.deepEqual(toggleApp(apps, ['c'], 'a', true), ['a', 'c']);
  assert.deepEqual(toggleApp(apps, ['a', 'c'], 'a', false), ['c']);
  assert.deepEqual(toggleApp(apps, [], 'a', false), []);
});

test('the confirmation says who the run is for, and what none means', () => {
  assert.equal(appsLine(apps, ['a']), 'For the app Acme (iOS).');
  assert.equal(appsLine(apps, ['a', 'b']), 'For the apps Acme (iOS), Acme (Android).');
  assert.match(appsLine(apps, []), /shown on every app of this repository/);
  assert.match(APPS_HINT, /every app of this repository/);
});
