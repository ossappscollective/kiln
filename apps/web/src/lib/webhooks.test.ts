import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebhookDelivery, WebhookEndpoint } from './types.ts';
import {
  canRedeliver,
  createWebhookInput,
  deliveryDetail,
  deliveryView,
  emptyWebhookForm,
  eventsSummary,
  formFromEndpoint,
  hostOf,
  lastDeliveryLabel,
  patchFor,
  validateWebhookForm,
  verifySnippet,
  webhookEventChoices,
} from './webhooks.ts';

const now = Date.UTC(2026, 10, 18, 12, 0, 0);

const endpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
  id: 'w1',
  url: 'https://hooks.example.com/mrm',
  description: null,
  eventTypes: ['*'],
  enabled: true,
  createdAt: now,
  updatedAt: now,
  lastDelivery: null,
  ...over,
});

const delivery = (over: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id: 'd1',
  endpointId: 'w1',
  eventId: 1,
  eventType: 'app.synced',
  status: 'success',
  attempts: 1,
  responseCode: 200,
  responseBody: null,
  error: null,
  redeliveryOf: null,
  createdAt: now,
  deliveredAt: now,
  ...over,
});

test('the form needs an address that parses and at least one event', () => {
  const ok = { ...emptyWebhookForm(), url: 'https://hooks.example.com/x' };
  assert.deepEqual(validateWebhookForm(ok), {});
  assert.ok(validateWebhookForm({ ...ok, url: '' }).url);
  assert.ok(validateWebhookForm({ ...ok, url: 'hooks.example.com' }).url);
  assert.ok(validateWebhookForm({ ...ok, url: 'ftp://hooks.example.com' }).url);
  assert.ok(validateWebhookForm({ ...ok, url: 'https://a:b@hooks.example.com' }).url);
  assert.ok(validateWebhookForm({ ...ok, all: false, types: [] }).types);
  assert.deepEqual(validateWebhookForm({ ...ok, all: false, types: ['app.synced'] }), {});
  // http is the server's call (it allows localhost on a private network): the form does not refuse it.
  assert.deepEqual(validateWebhookForm({ ...ok, url: 'http://localhost:9000/x' }), {});
});

test('the request is trimmed, and "all events" is the single type *', () => {
  const form = { ...emptyWebhookForm(), url: ' https://hooks.example.com/x ', description: '  CI  ' };
  assert.deepEqual(createWebhookInput(form), { url: 'https://hooks.example.com/x', description: 'CI', eventTypes: ['*'], enabled: true });
  assert.deepEqual(
    createWebhookInput({ ...form, description: '', all: false, types: ['app.synced', 'app.synced', 'changeset.failed'], enabled: false }),
    { url: 'https://hooks.example.com/x', eventTypes: ['app.synced', 'changeset.failed'], enabled: false },
  );
});

test('editing starts from the endpoint, and the patch holds only what changed', () => {
  const e = endpoint({ description: 'CI', eventTypes: ['changeset.applied', 'app.synced'] });
  const form = formFromEndpoint(e);
  assert.equal(form.all, false);
  assert.deepEqual(form.types, ['changeset.applied', 'app.synced']);
  assert.deepEqual(patchFor(e, form), {}, 'nothing changed, nothing to send');
  assert.deepEqual(patchFor(e, { ...form, enabled: false }), { enabled: false });
  assert.deepEqual(patchFor(e, { ...form, types: ['app.synced', 'changeset.applied'] }), {}, 'the order of events does not matter');
  assert.deepEqual(patchFor(e, { ...form, all: true }), { eventTypes: ['*'] });
  assert.deepEqual(patchFor(e, { ...form, description: '' }), { description: null });
  assert.deepEqual(patchFor(e, { ...form, url: 'https://other.example.com/x' }), { url: 'https://other.example.com/x' });
  assert.equal(formFromEndpoint(endpoint()).all, true);
});

test('summaries and labels', () => {
  assert.equal(eventsSummary(endpoint()), 'All events');
  assert.equal(eventsSummary(endpoint({ eventTypes: ['app.synced'] })), 'app.synced');
  assert.equal(eventsSummary(endpoint({ eventTypes: ['app.synced', 'changeset.failed'] })), '2 events');
  assert.equal(hostOf('https://hooks.example.com:8443/x?y=1'), 'hooks.example.com:8443');
  assert.equal(hostOf('nonsense'), 'nonsense');
  assert.equal(lastDeliveryLabel(endpoint(), now), 'No deliveries yet');
  assert.equal(
    lastDeliveryLabel(endpoint({ lastDelivery: { status: 'failed', at: now - 120_000, responseCode: 500 } }), now),
    'Failed, 2 minutes ago',
  );
});

test('every delivery status says what it is in words', () => {
  assert.deepEqual(deliveryView('success'), { label: 'Delivered', tone: 'ok' });
  assert.deepEqual(deliveryView('failed'), { label: 'Failed', tone: 'bad' });
  assert.deepEqual(deliveryView('retrying'), { label: 'Retrying', tone: 'warn' });
  assert.deepEqual(deliveryView('pending'), { label: 'Waiting', tone: 'info' });
  assert.equal(deliveryView('odd').label, 'odd');
});

test('the delivery line shows the answer, the attempts and the problem', () => {
  assert.equal(deliveryDetail(delivery()), 'Answered 200');
  assert.equal(deliveryDetail(delivery({ status: 'failed', responseCode: 500, attempts: 5, error: 'The receiver answered 500.' })), 'Answered 500 · 5 attempts · The receiver answered 500.');
  assert.equal(deliveryDetail(delivery({ status: 'failed', responseCode: null, error: 'The connection failed.' })), 'The connection failed.');
  assert.equal(deliveryDetail(delivery({ status: 'pending', responseCode: null, attempts: 0 })), '');
});

test('only a finished delivery can be sent again', () => {
  assert.equal(canRedeliver(delivery({ status: 'success' })), true);
  assert.equal(canRedeliver(delivery({ status: 'failed' })), true);
  assert.equal(canRedeliver(delivery({ status: 'retrying' })), false);
  assert.equal(canRedeliver(delivery({ status: 'pending' })), false);
});

test('the verification snippet matches the signing scheme the server documents', () => {
  assert.match(verifySnippet, /x-mrm-signature/);
  assert.match(verifySnippet, /x-mrm-timestamp/);
  assert.match(verifySnippet, /createHmac\('sha256'/);
  assert.match(verifySnippet, /timingSafeEqual/);
  assert.match(verifySnippet, /\$\{timestamp\}\.\$\{rawBody\}/);
});

test('the event list has no duplicates and uses dotted names', () => {
  const types = webhookEventChoices.map((c) => c.type);
  assert.equal(new Set(types).size, types.length);
  for (const type of types) assert.match(type, /^[a-z]+(\.[a-z_]+)+$/);
});
