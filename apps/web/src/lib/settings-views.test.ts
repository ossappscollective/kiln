import assert from 'node:assert/strict';
import { test } from 'node:test';
import { can, roles } from '@mrm/core';
import {
  isFormView,
  resolveSettingsView,
  settingsViewOf,
  settingsViews,
  settingsViewsFor,
  unsavedViewsNote,
  withSettingsView,
} from './settings-views.ts';

const all = () => true;
const none = () => false;

test('the views are General, Analytics, Security and AI, in that order', () => {
  assert.deepEqual(
    settingsViews.map((v) => v.id),
    ['general', 'analytics', 'security', 'ai'],
  );
  assert.deepEqual(
    settingsViewsFor(all).map((v) => v.label),
    ['General', 'Analytics', 'Security', 'AI'],
  );
});

test('the old address and unknown values are General', () => {
  assert.equal(settingsViewOf('#/settings'), 'general');
  assert.equal(settingsViewOf('#/settings?view=nope'), 'general');
  assert.equal(settingsViewOf(''), 'general');
  assert.equal(settingsViewOf('#/settings?view=security'), 'security');
  assert.equal(settingsViewOf('#/settings?view=ai&x=1'), 'ai');
});

test('a role without settings.read only has the AI view, and nothing to switch', () => {
  assert.deepEqual(
    settingsViewsFor(none).map((v) => v.id),
    [],
  );
  assert.equal(resolveSettingsView('#/settings', none), 'ai');
  assert.equal(resolveSettingsView('#/settings?view=security', none), 'ai');
});

test('every role that can read the settings gets all four views', () => {
  for (const role of roles) {
    const allowed = (a: Parameters<typeof can>[1]) => can(role, a);
    const ids = settingsViewsFor(allowed).map((v) => v.id);
    if (can(role, 'settings.read'))
      assert.deepEqual(ids, ['general', 'analytics', 'security', 'ai'], role);
    else assert.deepEqual(ids, [], role);
  }
});

test('withSettingsView writes the view, drops it for General and keeps other query parts', () => {
  assert.equal(withSettingsView('#/settings', 'security'), '#/settings?view=security');
  assert.equal(withSettingsView('#/settings?view=security', 'general'), '#/settings');
  assert.equal(
    withSettingsView('#/settings?view=ai&x=1', 'analytics'),
    '#/settings?view=analytics&x=1',
  );
  assert.equal(withSettingsView('#/settings', 'bogus'), '#/settings');
});

test('Save settings belongs to the form views; the others warn about unsaved changes', () => {
  assert.equal(isFormView('general'), true);
  assert.equal(isFormView('analytics'), true);
  assert.equal(isFormView('security'), false);
  assert.equal(isFormView('ai'), false);
  assert.equal(unsavedViewsNote('general'), '');
  assert.notEqual(unsavedViewsNote('ai'), '');
});
