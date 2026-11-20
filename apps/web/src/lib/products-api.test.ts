import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from './api.ts';

type Call = { path: string; init: RequestInit | undefined };

function fake(body: unknown = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, api: createApi({ fetch: fetchImpl }) };
}

const sent = (call: Call | undefined) => JSON.parse(String(call?.init?.body)) as Record<string, unknown>;

test('the reads and the sync of products use the documented paths and methods', async () => {
  const { calls, api } = fake();
  await api.appProducts('w1', 'a1');
  await api.appProduct('w1', 'a1', 'com.acme.pro');
  await api.syncAppProducts('w1', 'a1');
  assert.deepEqual(
    calls.map((c) => [c.init?.method, c.path]),
    [
      ['GET', '/api/workspaces/w1/apps/a1/products'],
      ['GET', '/api/workspaces/w1/apps/a1/products/com.acme.pro'],
      ['POST', '/api/workspaces/w1/apps/a1/products/sync'],
    ],
  );
  assert.equal(calls[0]?.init?.body, undefined);
  assert.equal(calls[2]?.init?.body, undefined, 'a sync sends no body');
});

test('ids are escaped in product paths', async () => {
  const { calls, api } = fake();
  await api.appProduct('w/1', 'a 1', 'p/1');
  assert.equal(calls[0]?.path, '/api/workspaces/w%2F1/apps/a%201/products/p%2F1');
});

test('a preview sends apply false and no hash, and no grant', async () => {
  const { calls, api } = fake({ preview: {} });
  await api.previewProductLocalization('w1', 'a1', 'com.acme.pro', 'en-US', {
    name: 'Pro',
    description: 'All',
  });
  const call = calls[0];
  assert.equal(call?.init?.method, 'PUT');
  assert.equal(call?.path, '/api/workspaces/w1/apps/a1/products/com.acme.pro/localizations/en-US');
  assert.deepEqual(sent(call), { apply: false, name: 'Pro', description: 'All' });
  assert.equal(JSON.stringify(call?.init?.headers).includes('step-up'), false);
});

test('an apply sends apply true with the preview hash, once, and the grant only in the header', async () => {
  const { calls, api } = fake({ result: {} });
  const body = { name: 'Pro', description: 'All', previewHash: 'a'.repeat(64) };
  await api.applyProductLocalization('w1', 'a1', 'com.acme.pro', 'zh-Hans', body, 'grant-1');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call?.init?.method, 'PUT');
  assert.equal(call?.path.endsWith('/localizations/zh-Hans'), true);
  assert.deepEqual(sent(call), { apply: true, ...body });
  assert.equal(JSON.stringify(sent(call)).includes('grant-1'), false);
  assert.deepEqual(call?.init?.headers, {
    'content-type': 'application/json',
    'x-step-up-grant': 'grant-1',
  });
  await api.applyProductLocalization('w1', 'a1', 'com.acme.pro', 'en-US', body);
  assert.equal(JSON.stringify(calls[1]?.init?.headers).includes('step-up'), false);
});
