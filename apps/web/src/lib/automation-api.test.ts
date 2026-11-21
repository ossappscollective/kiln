import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createApi, messageFor } from './api.ts';

type Call = { path: string; init: RequestInit | undefined };

function fake(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, api: createApi({ fetch: fetchImpl }) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const empty = () => new Response(null, { status: 204 });

test('token calls use the token endpoints, with ids escaped', async () => {
  const { calls, api } = fake((call) =>
    call.init?.method === 'DELETE'
      ? empty()
      : json({ tokens: [], token: 'kiln_x', summary: {} }, call.init?.method === 'POST' ? 201 : 200),
  );
  await api.apiTokens('w/1');
  await api.createApiToken('w/1', { name: 'CI', role: 'member', expiresAt: 5 });
  await api.revokeApiToken('w/1', 't 1');
  assert.deepEqual(
    calls.map((c) => `${c.init?.method ?? 'GET'} ${c.path}`),
    [
      'GET /api/workspaces/w%2F1/tokens',
      'POST /api/workspaces/w%2F1/tokens',
      'DELETE /api/workspaces/w%2F1/tokens/t%201',
    ],
  );
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    name: 'CI',
    role: 'member',
    expiresAt: 5,
  });
});

test('webhook calls use the webhook endpoints', async () => {
  const { calls, api } = fake((call) =>
    call.init?.method === 'DELETE'
      ? empty()
      : json({ webhooks: [], deliveries: [], deliveryId: 'd', secret: 's', webhook: {} }),
  );
  await api.webhooks('w1');
  await api.createWebhook('w1', { url: 'https://h.example.com/x', eventTypes: ['*'] });
  await api.updateWebhook('w1', 'a/b', { enabled: false });
  await api.deleteWebhook('w1', 'a');
  await api.rotateWebhookSecret('w1', 'a');
  await api.testWebhook('w1', 'a');
  await api.webhookDeliveries('w1', 'a', 5);
  await api.redeliverWebhook('w1', 'a', 'd 1');
  assert.deepEqual(
    calls.map((c) => `${c.init?.method ?? 'GET'} ${c.path}`),
    [
      'GET /api/workspaces/w1/webhooks',
      'POST /api/workspaces/w1/webhooks',
      'PATCH /api/workspaces/w1/webhooks/a%2Fb',
      'DELETE /api/workspaces/w1/webhooks/a',
      'POST /api/workspaces/w1/webhooks/a/rotate-secret',
      'POST /api/workspaces/w1/webhooks/a/test',
      'GET /api/workspaces/w1/webhooks/a/deliveries?limit=5',
      'POST /api/workspaces/w1/webhooks/a/deliveries/d%201/redeliver',
    ],
  );
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { enabled: false });
});

test('errors of the automation endpoints read as sentences a person can act on', async () => {
  assert.equal(
    messageFor(400, { error: 'role_above_yours' }),
    'A token cannot have a higher role than you.',
  );
  assert.equal(
    messageFor(400, { error: 'invalid_url', message: 'Use an https URL.' }),
    'Use an https URL.',
  );
  assert.equal(
    messageFor(400, { error: 'invalid_url' }),
    'That address cannot be used for a webhook.',
  );
  assert.match(messageFor(409, { error: 'too_many_webhooks' }), /too many webhooks/);
  assert.match(messageFor(409, { error: 'too_many_tokens' }), /too many active tokens/);
  assert.match(messageFor(400, { error: 'unknown_app' }), /not in this workspace/);

  const { api } = fake(() =>
    json(
      { error: 'invalid_url', message: 'That address is not allowed. Use a public https URL.' },
      400,
    ),
  );
  await assert.rejects(
    () => api.createWebhook('w1', { url: 'https://10.0.0.1/x', eventTypes: ['*'] }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === 'invalid_url' &&
      /not allowed/.test(error.message),
  );
});
