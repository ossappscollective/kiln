import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appEventTypes,
  appSettingsGroups,
  appSettingsSections,
  resolveAppSettingsSection,
  conventionLines,
  credentialFacts,
  effectiveAnalyticsValues,
  deleteLine,
  listensToApp,
  lowRatingText,
  saveBarText,
  stagedRolloutHint,
  templatesSummary,
  webhookSummary,
} from './app-settings.ts';
import type {
  BuildConventionsView,
  ChecklistTemplate,
  CredentialSummary,
  WebhookEndpoint,
} from './types.ts';

const cred = (over: Partial<CredentialSummary> = {}): CredentialSummary => ({
  id: 'c1',
  kind: 'appstoreconnect',
  label: 'Shop ASC key',
  createdAt: 1,
  rotatedAt: null,
  lastTest: null,
  ...over,
});

const hook = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
  id: 'w',
  url: 'https://x.test/h',
  description: null,
  eventTypes: ['*'],
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  lastDelivery: null,
  ...over,
});

test('credential facts: hidden for a role that cannot read, missing, never tested, failed', () => {
  assert.equal(credentialFacts('c1', null).found, false);
  assert.equal(credentialFacts('c1', null).tone, 'none');
  const missing = credentialFacts('zzz', [cred()]);
  assert.equal(missing.found, false);
  assert.equal(missing.tone, 'bad');
  const never = credentialFacts('c1', [cred()]);
  assert.deepEqual(
    [never.label, never.found, never.status],
    ['Shop ASC key', true, 'Never tested'],
  );
  const failed = credentialFacts(
    'c1',
    [cred({ lastTest: { at: 5, ok: false, message: 'Bad key' } })],
    10,
  );
  assert.equal(failed.status, 'Failed');
  assert.equal(failed.tone, 'bad');
  assert.ok(failed.detail.includes('Bad key'));
});

test('convention lines say where the matching comes from', () => {
  const view = {
    effective: {
      tagPatterns: ['v{version}'],
      releasePatterns: [],
      prefix: '',
      workflow: 'ios.yml',
      usingDefaultTags: false,
      usingDefaultReleases: true,
      source: 'repository',
    },
  } as unknown as BuildConventionsView;
  assert.deepEqual(conventionLines(view), [
    'Set for the repository',
    'Tag patterns: v{version}',
    'Release patterns: none',
    'Workflow: ios.yml',
  ]);
});

test('template summary', () => {
  const t = (builtin: boolean) =>
    ({
      id: String(Math.random()),
      name: 'n',
      description: null,
      items: [],
      builtin,
      createdAt: null,
      updatedAt: null,
    }) as ChecklistTemplate;
  assert.equal(templatesSummary([]), 'No checklist templates yet');
  assert.equal(templatesSummary([t(true), t(true), t(false)]), '3 templates (2 built in, 1 yours)');
});

test('webhooks: a hook hears an app when it asks for everything or an app event; disabled ones do not count', () => {
  assert.equal(listensToApp(hook()), true);
  assert.equal(listensToApp(hook({ eventTypes: ['changeset.created'] })), false);
  assert.equal(listensToApp(hook({ eventTypes: [appEventTypes[0] as string] })), true);
  assert.equal(webhookSummary([]).text, 'No webhooks are set up in this workspace.');
  const s = webhookSummary([
    hook(),
    hook({ enabled: false }),
    hook({ eventTypes: ['changeset.created'] }),
    hook({ lastDelivery: { status: 'failed', at: 1, responseCode: 500 } }),
  ]);
  assert.deepEqual([s.total, s.hearing, s.failing], [4, 2, 1]);
});

test('low rating text', () => {
  assert.ok(lowRatingText(2).includes('2 stars or less'));
  assert.ok(lowRatingText(1).includes('1 star or less'));
  assert.equal(lowRatingText(0), 'Low-rating alerts are off.');
});

test('the rail lists only the sections that exist, in groups with no empty group', () => {
  const labels = (input: Parameters<typeof appSettingsSections>[0]) =>
    appSettingsSections(input).map((s) => s.label);
  assert.deepEqual(labels({ android: false, ai: false, canDelete: false }), [
    'Stores',
    'Repository',
    'Store listing',
    'Expo and RevenueCat',
    'Release defaults',
    'Notifications',
  ]);
  assert.deepEqual(labels({ android: true, ai: true, canDelete: true }), [
    'Stores',
    'Repository',
    'Store listing',
    'Expo and RevenueCat',
    'Release defaults',
    'Google Play releases',
    'Reports bucket',
    'Notifications',
    'AI assistant',
    'Danger zone',
  ]);
  const ids = appSettingsSections({ android: true, ai: true, canDelete: true }).map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('the save bar says whether there is something to save', () => {
  assert.equal(saveBarText(false, false), 'All changes are saved.');
  assert.equal(saveBarText(true, false), 'You have unsaved changes.');
  assert.equal(saveBarText(false, true), 'You have unsaved changes.');
});

test('one-line hints and the Danger zone line', () => {
  assert.match(stagedRolloutHint(true), /has an earlier production release\.$/);
  assert.match(stagedRolloutHint(false), /no earlier production release/);
  assert.match(deleteLine('the App Store'), /Nothing in the App Store is changed/);
});

test('the address opens a section: ?section=, an old part id, else the first; a section the app lacks falls back', () => {
  const ids = appSettingsSections({ android: false, ai: false, canDelete: false }).map((s) => s.id);
  assert.equal(resolveAppSettingsSection('#/apps/a/settings', ids), 'stores');
  assert.equal(resolveAppSettingsSection('#/apps/a/settings?section=notifications', ids), 'notifications');
  assert.equal(resolveAppSettingsSection('#/apps/a/settings?section=app-settings-repository', ids), 'repository');
  assert.equal(resolveAppSettingsSection('#/apps/a/settings?view=app-settings-defaults', ids), 'defaults');
  assert.equal(resolveAppSettingsSection('#/apps/a/settings?section=play-bucket', ids), 'stores');
  assert.deepEqual(appSettingsGroups({ android: false, ai: false, canDelete: false }).map((g) => g.id), ['connections', 'releases', 'data']);
});

test('effective values say where the vendor number and the Play bucket come from', () => {
  assert.deepEqual(effectiveAnalyticsValues(null), []);
  const apple = effectiveAnalyticsValues({
    apple: { mode: 'ongoing', requests: [], vendorNumberSet: true, vendorNumberSource: 'workspace', vendorNumber: '12345678' },
    google: null,
  });
  assert.deepEqual(apple.map((e) => [e.key, e.value, e.origin]), [['vendorNumber', '12345678', 'from the workspace default']]);
  const own = effectiveAnalyticsValues({
    apple: { mode: 'ongoing', requests: [], vendorNumberSet: true, vendorNumberSource: 'credential', vendorNumber: '87654321' },
    google: null,
  });
  assert.equal(own[0]?.origin, 'from this credential');
  const play = (bucketSource: 'app' | 'account' | 'workspace') =>
    effectiveAnalyticsValues({ apple: null, google: { bucketIdSet: true, bucketId: 'pubsite_prod_rev_1', bucketSource } })[0]?.origin;
  assert.deepEqual([play('app'), play('account'), play('workspace')], ['set on this app', 'from this Play account', 'from the workspace default']);
  assert.deepEqual(effectiveAnalyticsValues({ apple: null, google: { bucketIdSet: false } }), []);
});
