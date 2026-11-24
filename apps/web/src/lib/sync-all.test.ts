import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import { clientKinds, syncRest } from './sync-all.ts';

const allowedFor = (set: string[]) => (a: string) => set.includes(a);

test('the browser runs products for a role that may sync, and TestFlight only for iOS', () => {
  assert.deepEqual(clientKinds('ios', allowedFor(['apps.sync']) as never), [
    'products',
    'testflight',
  ]);
  assert.deepEqual(clientKinds('android', allowedFor(['apps.sync']) as never), ['products']);
  assert.deepEqual(clientKinds('ios', allowedFor([]) as never), []);
});

const fake = (over: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const api = {
    syncAppAll: async (
      _w: string,
      id: string,
      opts: { without?: string; kinds?: string[]; sources?: string[] } = {},
    ) => {
      calls.push(
        `all:${id}:${opts.without ?? opts.kinds?.join('+') ?? ''}${opts.sources ? `:${opts.sources.join('+')}` : ''}`,
      );
      return { plan: [{ kind: 'reviews', state: 'queued', jobId: 'j' }] };
    },
    syncAppProducts: async () => {
      calls.push('products');
      return {};
    },
    syncAppTestflight: async () => {
      calls.push('testflight');
      return {};
    },
    ...over,
  };
  return { api: api as never, calls };
};

test('the queue goes first (without the app kind), then products, then TestFlight', async () => {
  const { api, calls } = fake();
  const seen: string[] = [];
  const r = await syncRest(api, 'w', { id: 'a', platform: 'ios' }, 'owner', (k, s) =>
    seen.push(`${k}:${s}`),
  );
  assert.deepEqual(calls, ['all:a:app', 'products', 'testflight']);
  assert.deepEqual(r.extra, { products: 'done', testflight: 'done' });
  assert.deepEqual(seen, [
    'products:running',
    'products:done',
    'testflight:running',
    'testflight:done',
  ]);
});

test('one failure never stops the rest: 4xx is "does not apply", other errors are failures', async () => {
  const { api, calls } = fake({
    syncAppProducts: async () => {
      throw new ApiError(404, 'not_found', 'nope');
    },
    syncAppTestflight: async () => {
      throw new ApiError(500, 'boom', 'boom');
    },
  });
  const r = await syncRest(api, 'w', { id: 'a', platform: 'ios' }, 'owner');
  assert.deepEqual(r.extra, { products: 'skipped', testflight: 'failed' });
  assert.equal(calls[0], 'all:a:app');
});

test('a failed queue request is reported and the browser kinds still run', async () => {
  const { api } = fake({
    syncAppAll: async () => {
      throw new ApiError(429, 'rate_limited', 'Too many syncs.');
    },
  });
  const r = await syncRest(api, 'w', { id: 'a', platform: 'android' }, 'owner');
  assert.equal(r.problem, 'Too many syncs.');
  assert.deepEqual(r.extra, { products: 'done' });
});

test("a page's Sync asks for its kinds only: no queue call for a browser-only page, the queue kinds and sources otherwise", async () => {
  const one = fake();
  const r1 = await syncRest(one.api, 'w', { id: 'a', platform: 'ios' }, 'owner', undefined, {
    kinds: ['products'],
  });
  assert.deepEqual(one.calls, ['products']);
  assert.deepEqual(r1.extra, { products: 'done' });

  const two = fake();
  await syncRest(two.api, 'w', { id: 'a', platform: 'ios' }, 'owner', undefined, {
    kinds: ['eas', 'testflight'],
  });
  assert.deepEqual(two.calls, ['all:a:eas', 'testflight']);

  const three = fake();
  await syncRest(three.api, 'w', { id: 'a', platform: 'android' }, 'owner', undefined, {
    kinds: ['analytics'],
    sources: ['play_vitals'],
  });
  assert.deepEqual(three.calls, ['all:a:analytics:play_vitals']);
});
