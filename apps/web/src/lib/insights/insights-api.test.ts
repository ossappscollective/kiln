import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createApi } from '../api.ts';

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
const line = (c: Call) => `${c.init?.method ?? 'GET'} ${c.path}`;

test('the Insights reads use the app paths with ids escaped, and the count is its own cheap call', async () => {
  const { calls, api } = fake(() => json({ count: 3 }));
  await api.appInsights('w/1', 'a 1');
  await api.appInsights('w/1', 'a 1', true);
  await api.appInsightsCount('w/1', 'a 1');
  await api.appInsightsCountries('w/1', 'a 1');
  await api.appListingChecks('w/1', 'a 1');
  assert.deepEqual(calls.map(line), [
    'GET /api/workspaces/w%2F1/apps/a%201/insights',
    'GET /api/workspaces/w%2F1/apps/a%201/insights?includeHidden=1',
    'GET /api/workspaces/w%2F1/apps/a%201/insights/count',
    'GET /api/workspaces/w%2F1/apps/a%201/insights/countries',
    'GET /api/workspaces/w%2F1/apps/a%201/insights/listing-checks',
  ]);
});

test('dismissing posts to the card, restoring sends one card or none, and a card id is escaped', async () => {
  const { calls, api } = fake(() => json({ ok: true, restored: 1 }));
  await api.dismissInsight('w1', 'a1', 'localize:de');
  await api.restoreInsights('w1', 'a1', 'localize:de');
  await api.restoreInsights('w1', 'a1');
  assert.deepEqual(calls.map(line), [
    'POST /api/workspaces/w1/apps/a1/insights/cards/localize%3Ade/dismiss',
    'POST /api/workspaces/w1/apps/a1/insights/restore',
    'POST /api/workspaces/w1/apps/a1/insights/restore',
  ]);
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { cardId: 'localize:de' });
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {});
});

test('an unknown card is an ApiError the screen can show', async () => {
  const { api } = fake(() => json({ error: 'not_found' }, 404));
  await assert.rejects(
    api.dismissInsight('w1', 'a1', 'gone'),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});
