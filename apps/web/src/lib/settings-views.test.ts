import assert from 'node:assert/strict';
import { test } from 'node:test';
import { can, roles } from '@kiln/core';
import {
  filterSettingsGroups,
  isFormSection,
  resolveSettingsSection,
  settingsGroupsFor,
  settingsSectionOf,
  withSettingsSection,
} from './settings-views.ts';

const all = () => true;
const none = () => false;

test('the groups are Workspace, Just for you, Security, AI and Integrations, in that order', () => {
  const groups = settingsGroupsFor(all);
  assert.deepEqual(
    groups.map((g) => g.id),
    ['workspace', 'personal', 'security', 'ai', 'integrations'],
  );
  assert.deepEqual(
    groups[0]?.items.map((i) => i.label),
    ['Store refresh', 'Reviews', 'Releases', 'Translation', 'Analytics'],
  );
});

test('Slack and Teams is drawn in Settings; webhooks is a link to its page', () => {
  const integrations = settingsGroupsFor(all).find((g) => g.id === 'integrations');
  assert.deepEqual(
    integrations?.items.map((i) => [i.id, i.kind, i.href]),
    [
      ['chat', 'page', undefined],
      ['webhooks', 'link', '#/webhooks'],
    ],
  );
});

test('a role only sees what it may open; empty groups are left out', () => {
  const ids = settingsGroupsFor(none).flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(ids, ['language', 'mcp']);
  for (const role of roles) {
    const allowed = (a: Parameters<typeof can>[1]) => can(role, a);
    const list = settingsGroupsFor(allowed).flatMap((g) => g.items.map((i) => i.id));
    assert.equal(list.includes('mail'), can(role, 'settings.write'), role);
    assert.equal(list.includes('chat'), can(role, 'chat.read'), role);
  }
});

test('the address names a section; the old ?view= addresses open the first section of the old view', () => {
  assert.equal(settingsSectionOf('#/settings'), null);
  assert.equal(settingsSectionOf('#/settings?section=reviews'), 'reviews');
  assert.equal(settingsSectionOf('#/settings?section=nope'), null);
  assert.equal(settingsSectionOf('#/settings?view=general'), 'store-refresh');
  assert.equal(settingsSectionOf('#/settings?view=analytics'), 'analytics');
  assert.equal(settingsSectionOf('#/settings?view=security'), 'confirm');
  assert.equal(settingsSectionOf('#/settings?view=ai'), 'ai');
});

test('the section drawn is the one named when allowed, else the first allowed; a link is never drawn', () => {
  assert.equal(resolveSettingsSection('#/settings', all), 'store-refresh');
  assert.equal(resolveSettingsSection('#/settings?section=translation', all), 'translation');
  assert.equal(resolveSettingsSection('#/settings?section=chat', all), 'chat');
  assert.equal(resolveSettingsSection('#/settings?section=webhooks', all), 'store-refresh');
  assert.equal(resolveSettingsSection('#/settings?section=mail', none), 'language');
  assert.equal(resolveSettingsSection('#/settings?view=ai', none), 'language');
});

test('withSettingsSection writes the section, drops the old view and keeps other query parts', () => {
  assert.equal(withSettingsSection('#/settings', 'reviews'), '#/settings?section=reviews');
  assert.equal(withSettingsSection('#/settings?view=ai&x=1', 'mail'), '#/settings?x=1&section=mail');
  assert.equal(withSettingsSection('#/settings', 'nope'), '#/settings');
});

test('Save settings belongs to the form sections only', () => {
  assert.equal(isFormSection('reviews'), true);
  assert.equal(isFormSection('analytics'), true);
  assert.equal(isFormSection('language'), false);
  assert.equal(isFormSection('mail'), false);
});

test('search matches a section name or its group name, ignoring case and accents', () => {
  const groups = settingsGroupsFor(all);
  assert.deepEqual(
    filterSettingsGroups(groups, 'REVIEWS').flatMap((g) => g.items.map((i) => i.id)),
    ['reviews'],
  );
  assert.deepEqual(
    filterSettingsGroups(groups, 'security').flatMap((g) => g.items.map((i) => i.id)),
    ['confirm', 'second-factor', 'mail'],
  );
  // The keywords of a section count too: "smtp" finds the mail server, "deepl" finds Translation.
  assert.deepEqual(
    filterSettingsGroups(groups, 'smtp').flatMap((g) => g.items.map((i) => i.id)),
    ['mail'],
  );
  assert.ok(filterSettingsGroups(groups, 'deepl').some((g) => g.items.some((i) => i.id === 'translation')));
  assert.deepEqual(filterSettingsGroups(groups, 'zzz'), []);
  assert.equal(filterSettingsGroups(groups, '  ').length, groups.length);
});
