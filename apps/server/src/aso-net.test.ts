import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsoError } from '@mrm/connectors';
import { ASO_HOSTS, ASO_FETCH_MAX_BYTES, createAsoFetch, createAsoSources } from './services/aso-net.ts';
import type { Exchange, ExchangeResponse } from './services/safe-fetch.ts';

/** The only network ASO has: two fixed hosts, the connectors' User-Agent, caps, a cache and local rate limits. No real request is made. */

const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];
const body = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const reply = (r: Partial<ExchangeResponse> = {}): ExchangeResponse => ({ status: 200, headers: { 'content-type': 'application/json' }, body: body({}), overflow: false, ...r });

function scripted(replies: (Partial<ExchangeResponse> | Error)[]) {
  const seen: { url: string; headers: Record<string, string>; address: string }[] = [];
  const exchange: Exchange = async (request) => {
    seen.push({ url: request.url.toString(), headers: request.headers, address: request.address });
    const next = replies.shift() ?? { status: 500 };
    if (next instanceof Error) throw next;
    return reply(next);
  };
  return { exchange, seen };
}

const appleApp = (id: number, name: string) => ({ wrapperType: 'software', kind: 'software', trackId: id, trackName: name, bundleId: `com.x.a${id}`, version: '1.0', price: 0, currency: 'USD', screenshotUrls: [] });
const appleReply = (...ids: number[]) => ({ resultCount: ids.length, results: ids.map((id) => appleApp(id, `App ${id}`)) });

test('the fetch goes to two hosts only, with the identifying User-Agent, and to the checked address', async () => {
  assert.deepEqual([...ASO_HOSTS].sort(), ['itunes.apple.com', 'play.google.com']);
  const s = scripted([reply({ body: body('{"resultCount":0,"results":[]}') })]);
  const doFetch = createAsoFetch({ resolve: publicResolve, exchange: s.exchange });
  const res = await doFetch('https://itunes.apple.com/search?term=a', { headers: { 'User-Agent': 'mobile-release-manager (test)', Accept: 'application/json' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { resultCount: 0, results: [] });
  assert.equal(s.seen[0]?.address, '93.184.216.34');
  assert.equal(s.seen[0]?.headers['User-Agent'] ?? s.seen[0]?.headers['user-agent'], 'mobile-release-manager (test)');
  const sent = JSON.stringify(s.seen[0]?.headers).toLowerCase();
  assert.equal(sent.includes('cookie'), false);
  assert.equal(sent.includes('authorization'), false);

  for (const url of ['https://example.com/x', 'https://itunes.apple.com.evil.example/x', 'http://itunes.apple.com/search', 'https://play.google.com.evil.example/x', 'https://accounts.google.com/x']) {
    const none = scripted([reply()]);
    await assert.rejects(() => createAsoFetch({ resolve: publicResolve, exchange: none.exchange })(url), TypeError, url);
    assert.equal(none.seen.length, 0, `${url}: nothing was connected`);
  }
});

test('a host that resolves to a private address is refused', async () => {
  const s = scripted([reply()]);
  const doFetch = createAsoFetch({ resolve: async () => [{ address: '10.0.0.5', family: 4 }], exchange: s.exchange });
  await assert.rejects(() => doFetch('https://itunes.apple.com/search?term=a'), TypeError);
  assert.equal(s.seen.length, 0);
});

test('statuses, redirects, big bodies and timeouts map to what the connectors expect', async () => {
  const run = async (r: Partial<ExchangeResponse> | Error) => createAsoFetch({ resolve: publicResolve, exchange: scripted([r]).exchange })('https://itunes.apple.com/search?term=a');
  assert.equal((await run({ status: 429, headers: { 'retry-after': '7' } })).status, 429);
  assert.equal((await run({ status: 503 })).status, 503);
  assert.equal((await run({ status: 404 })).status, 404);
  // A redirect to a host that is not allowed is refused inside safeGet and reported as a redirect (the connectors treat it as unavailable).
  assert.equal((await run({ status: 302, headers: { location: 'https://consent.google.com/x' } })).status, 302);
  await assert.rejects(() => run({ overflow: true, body: new Uint8Array(1) }), { name: 'TooLargeError' });
  assert.ok(ASO_FETCH_MAX_BYTES >= 4 * 1024 * 1024);
});

const makeSources = (replies: (Partial<ExchangeResponse> | Error)[], over: Partial<Parameters<typeof createAsoSources>[0]> = {}) => {
  const s = scripted(replies);
  let clock = 1_000_000;
  const sources = createAsoSources({
    playEnabled: false,
    now: () => clock,
    cacheMs: 60_000,
    appleCallsPerMinute: 3,
    playCallsPerMinute: 1,
    net: { resolve: publicResolve, exchange: s.exchange },
    ...over,
  });
  return { sources, seen: s.seen, advance: (ms: number) => void (clock += ms) };
};

test('Apple: a search is one request, ranked in order, and the same search is served from the cache', async () => {
  const m = makeSources([reply({ body: body(appleReply(11, 22, 33)) })]);
  const input = { platform: 'ios' as const, term: 'Habit Tracker', country: 'us', locale: 'en-US', limit: 50 };
  const first = await m.sources.search(input);
  assert.deepEqual(first.hits.map((h) => h.id), ['11', '22', '33']);
  assert.equal(first.hits[0]?.name, 'App 11');
  assert.equal(first.total, 3);
  assert.equal(first.cached, false);
  assert.match(m.seen[0]?.url ?? '', /^https:\/\/itunes\.apple\.com\/search\?/);
  assert.match(m.seen[0]?.url ?? '', /country=us/);
  assert.match(m.seen[0]?.url ?? '', /limit=50/);
  const second = await m.sources.search({ ...input, term: 'habit tracker' });
  assert.equal(second.cached, true, 'case does not make a new request');
  assert.equal(m.seen.length, 1);
  m.advance(61_000);
  // The cache expired: a request again (this one fails, and a failure is not cached).
  await assert.rejects(() => m.sources.search(input), AsoError);
  assert.equal(m.seen.length, 2);
  // Another storefront is another search.
  await assert.rejects(() => m.sources.search({ ...input, country: 'de' }), AsoError);
  assert.equal(m.seen.length, 3);
});

test('Apple: the limit is clipped to what the API allows, and 0 turns the cache off', async () => {
  const m = makeSources([reply({ body: body(appleReply(1)) }), reply({ body: body(appleReply(1)) })], { cacheMs: 0 });
  const input = { platform: 'ios' as const, term: 'abc', country: 'us', locale: 'en-US', limit: 9999 };
  await m.sources.search(input);
  assert.match(m.seen[0]?.url ?? '', /limit=200/);
  await m.sources.search(input);
  assert.equal(m.seen.length, 2, 'no cache');
});

test('Apple: a lookup of an app that does not exist is undefined, and an existing one is mapped', async () => {
  const m = makeSources([reply({ body: body({ resultCount: 0, results: [] }) }), reply({ body: body(appleReply(7)) })]);
  assert.equal(await m.sources.lookup({ platform: 'ios', id: '6', country: 'us', locale: 'en-US' }), undefined);
  const found = await m.sources.lookup({ platform: 'ios', id: '7', country: 'us', locale: 'en-US' });
  assert.equal(found?.id, '7');
  assert.equal(found?.name, 'App 7');
  assert.equal(found?.screenshotCount, 0);
});

test('the local rate limit stops calls before any request and says so without a store status', async () => {
  const m = makeSources([1, 2, 3, 4].map((n) => reply({ body: body(appleReply(n)) })));
  const search = (term: string) => m.sources.search({ platform: 'ios', term, country: 'us', locale: 'en-US', limit: 10 });
  await search('one');
  await search('two');
  await search('three');
  const err = await search('four').then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof AsoError);
  assert.equal(err.kind, 'rate_limited');
  assert.equal(err.status, undefined, 'it is our limit, not the store’s');
  assert.ok((err.retryAfterSeconds ?? 0) >= 1);
  assert.equal(m.seen.length, 3, 'the fourth made no request');
  m.advance(61_000);
  await search('four');
  assert.equal(m.seen.length, 4);
});

test('a store 429 pauses that source, with its own status, until the Retry-After has passed', async () => {
  const m = makeSources([reply({ status: 429, headers: { 'retry-after': '120' } }), reply({ body: body(appleReply(1)) })]);
  const search = (term: string) => m.sources.search({ platform: 'ios', term, country: 'us', locale: 'en-US', limit: 10 });
  const first = await search('one').then(() => undefined, (e: unknown) => e);
  assert.ok(first instanceof AsoError && first.kind === 'rate_limited');
  assert.equal(first.status, 429);
  assert.equal(first.retryAfterSeconds, 120);
  const paused = await search('two').then(() => undefined, (e: unknown) => e);
  assert.ok(paused instanceof AsoError && paused.kind === 'rate_limited');
  assert.equal(paused.status, undefined, 'the pause is ours');
  assert.equal(m.seen.length, 1, 'no request while paused');
  m.advance(121_000);
  assert.equal((await search('two')).hits.length, 1);
});

test('Google Play: off means unavailable (disabled) and no request; on reads the public page', async () => {
  const off = makeSources([reply()]);
  const e = await off.sources.search({ platform: 'android', term: 'habit', country: 'us', locale: 'en-US', limit: 10 }).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof AsoError);
  assert.equal(e.kind, 'unavailable');
  assert.equal(e.reason, 'disabled');
  await assert.rejects(() => off.sources.lookup({ platform: 'android', id: 'com.x.y', country: 'us', locale: 'en-US' }), AsoError);
  assert.equal(off.seen.length, 0);
  assert.equal(off.sources.playEnabled, false);

  const html = '<html><body><a href="/store/apps/details?id=com.one.app">x</a><a href="/store/apps/details?id=com.two.app">y</a></body></html>';
  const on = makeSources([reply({ headers: { 'content-type': 'text/html' }, body: body(html) })], { playEnabled: true });
  const found = await on.sources.search({ platform: 'android', term: 'habit', country: 'us', locale: 'en-US', limit: 10 });
  assert.deepEqual(found.hits.map((h) => h.id), ['com.one.app', 'com.two.app']);
  assert.equal(found.hits[0]?.name, undefined, 'Play results carry ids only');
  assert.match(on.seen[0]?.url ?? '', /^https:\/\/play\.google\.com\/store\/search\?/);
  assert.equal(JSON.stringify(on.seen[0]?.headers).toLowerCase().includes('cookie'), false);
  assert.equal(on.sources.playEnabled, true);
});

test('Google Play: a changed page is "unavailable", never an empty result', async () => {
  const m = makeSources([reply({ headers: { 'content-type': 'text/html' }, body: body('<html><body><div id="root"></div></body></html>') })], { playEnabled: true });
  const e = await m.sources.search({ platform: 'android', term: 'habit', country: 'us', locale: 'en-US', limit: 10 }).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof AsoError);
  assert.equal(e.kind, 'unavailable');
  assert.equal(e.reason, 'layout_changed');
  assert.equal(String(e.message).includes('play.google.com'), false, 'no address in the message');
});

test('errors carry no term and no address', async () => {
  const m = makeSources([reply({ status: 500 })]);
  const e = await m.sources.search({ platform: 'ios', term: 'zebra tracker', country: 'us', locale: 'en-US', limit: 10 }).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof AsoError);
  const text = `${e.message} ${JSON.stringify(e)}`.toLowerCase();
  assert.equal(text.includes('zebra'), false);
  assert.equal(text.includes('itunes.apple.com'), false);
});
