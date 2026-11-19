import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appEventTypes,
  conventionLines,
  credentialFacts,
  listensToApp,
  lowRatingText,
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
