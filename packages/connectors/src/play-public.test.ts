import assert from 'node:assert/strict';
import { test } from 'node:test';
import { playAppHtml, playChangedHtml, playSearchHtml } from './aso.fixtures.ts';
import { AsoError, decodeEntities } from './aso-common.ts';
import {
  PlayPublicConnector,
  parsePlayApp,
  parsePlaySearch,
  playDetailsUrl,
  playSearchUrl,
} from './play-public.ts';

// The HTML here is SYNTHETIC (aso.fixtures.ts): it tests the parsers' logic and the safety rules,
// not that Google Play still serves this markup.

type Seen = { url: string; init: RequestInit | undefined };
function fakeFetch(respond: (url: string) => Response | Promise<Response>): {
  fetch: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      seen.push({ url: String(input), init });
      return respond(String(input));
    },
  };
}
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });

const failure = async (run: () => Promise<unknown>): Promise<AsoError> => {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof AsoError, String(error));
    return error;
  }
  assert.fail('expected an AsoError');
};

test('switched off: no request is made, and the answer says so', async () => {
  const { fetch, seen } = fakeFetch(() => html(playSearchHtml));
  const play = new PlayPublicConnector({ enabled: false, fetch });
  assert.equal(play.enabled, false);
  const a = await failure(() => play.search({ term: 'habit', country: 'us' }));
  const b = await failure(() => play.getApp({ packageName: 'com.example.alpha', country: 'us' }));
  for (const e of [a, b]) assert.deepEqual([e.kind, e.reason], ['unavailable', 'disabled']);
  assert.equal(seen.length, 0);
});

test('search: package names in page order, once each, only app links', () => {
  assert.deepEqual(parsePlaySearch(playSearchHtml), [
    'com.example.alpha',
    'com.example.beta',
    'com.example.own',
    'com.example.delta',
  ]);
  // Links inside embedded JSON (escaped slashes, \\u003d for =).
  assert.deepEqual(
    parsePlaySearch(
      '"\\/store\\/apps\\/details?id\\u003dcom.json.one" "/store/apps/details?id=com.json.two"',
    ),
    ['com.json.one', 'com.json.two'],
  );
  assert.deepEqual(parsePlaySearch(playChangedHtml), []);
});

test('a search is one GET to the fixed host: no cookie, no login, redirects not followed, a timeout', async () => {
  const { fetch, seen } = fakeFetch(() => html(playSearchHtml));
  const play = new PlayPublicConnector({ enabled: true, fetch });
  const result = await play.search({
    term: 'habit tracker',
    country: 'DE',
    language: 'de_DE',
    limit: 3,
  });
  assert.deepEqual(result.ids, ['com.example.alpha', 'com.example.beta', 'com.example.own']);
  assert.equal(result.total, 3);
  assert.equal(seen.length, 1);
  const url = new URL(seen[0]?.url ?? '');
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'play.google.com');
  assert.equal(url.pathname, '/store/search');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    q: 'habit tracker',
    c: 'apps',
    hl: 'de-DE',
    gl: 'de',
  });
  assert.equal(seen[0]?.init?.redirect, 'manual');
  const headers = new Headers(seen[0]?.init?.headers);
  assert.equal(headers.get('cookie'), null);
  assert.equal(headers.get('authorization'), null);
  assert.match(headers.get('user-agent') ?? '', /mobile-release-manager/);
  assert.ok(seen[0]?.init?.signal);
});

test('urls are built from constants and validated pieces only', () => {
  assert.equal(
    playSearchUrl({ term: ' a&b=c ', country: 'US' }),
    'https://play.google.com/store/search?q=a%26b%3Dc&c=apps&hl=en&gl=us',
  );
  assert.equal(
    playDetailsUrl('com.example.alpha', 'us', 'pt_BR'),
    'https://play.google.com/store/apps/details?id=com.example.alpha&hl=pt-BR&gl=us',
  );
  assert.throws(() => playSearchUrl({ term: 'x', country: 'usa' }), AsoError);
  assert.throws(() => playSearchUrl({ term: 'x', country: 'us', language: 'en&gl=zz' }), AsoError);
});

test('a layout change is "unavailable", never "no result" and never a rank', async () => {
  const play = (body: string, status = 200) =>
    new PlayPublicConnector({ enabled: true, fetch: fakeFetch(() => html(body, status)).fetch });
  const empty = await failure(() => play(playChangedHtml).search({ term: 'x', country: 'us' }));
  assert.deepEqual([empty.kind, empty.reason], ['unavailable', 'layout_changed']);
  const noName = await failure(() =>
    play(playChangedHtml).getApp({ packageName: 'com.example.alpha', country: 'us' }),
  );
  assert.deepEqual([noName.kind, noName.reason], ['unavailable', 'layout_changed']);
});

test('a redirect (a consent page), a robot check, a 429 and a 5xx are told apart; the term never shows', async () => {
  const run = (response: () => Response) =>
    failure(() =>
      new PlayPublicConnector({ enabled: true, fetch: fakeFetch(response).fetch }).search({
        term: 'private words',
        country: 'us',
      }),
    );
  const redirect = await run(() =>
    html('', 302, { location: 'https://consent.google.com/m?continue=x' }),
  );
  assert.deepEqual([redirect.kind, redirect.reason], ['unavailable', 'redirect']);
  const robot = await run(() =>
    html('<html>Our systems have detected unusual traffic from your computer network.</html>'),
  );
  assert.deepEqual([robot.kind, robot.reason], ['unavailable', 'blocked']);
  const limited = await run(() => html('', 429, { 'retry-after': '300' }));
  assert.deepEqual([limited.kind, limited.retryAfterSeconds], ['rate_limited', 300]);
  assert.equal((await run(() => html('', 403))).kind, 'rate_limited');
  assert.equal((await run(() => html('', 500))).kind, 'server');
  for (const e of [redirect, robot, limited]) assert.equal(/private/.test(e.message), false);
  const boom = await failure(() =>
    new PlayPublicConnector({
      enabled: true,
      fetch: async () => {
        throw new TypeError('getaddrinfo ENOTFOUND play.google.com private words');
      },
    }).search({ term: 'private words', country: 'us' }),
  );
  assert.equal(boom.kind, 'network');
  assert.equal(/private|getaddrinfo/.test(boom.message), false);
});

test('an app page is parsed: JSON-LD first, with fallbacks, and nothing invented', () => {
  const app = parsePlayApp(playAppHtml, 'com.example.alpha');
  assert.deepEqual(app, {
    packageName: 'com.example.alpha',
    name: 'Alpha Habits & Goals',
    description: 'Build streaks.\nReach goals.\nNo ads & no login.',
    version: '3.4.1',
    ratingMilli: 4600,
    ratingCount: 20480,
    price: '0',
    currency: 'USD',
    iconUrl: 'https://play-lh.googleusercontent.com/alpha-icon=w512',
    screenshotCount: 3,
    developer: 'Alpha Labs',
    category: 'HEALTH_AND_FITNESS',
  });
  // Only a title: the name and nothing else.
  const bare = parsePlayApp('<title>Solo App - Apps on Google Play</title>', 'com.example.solo');
  assert.deepEqual(bare, { packageName: 'com.example.solo', name: 'Solo App' });
  // A rating from an aria-label when there is no JSON-LD; garbage ratings are dropped.
  const aria = parsePlayApp(
    '<h1>Aria</h1><div aria-label="Rated 4.5 stars out of five stars"></div>',
    'com.example.aria',
  );
  assert.equal(aria?.ratingMilli, 4500);
  const junk = parsePlayApp(
    '<script type="application/ld+json">{"@type":"SoftwareApplication","name":"J","aggregateRating":{"ratingValue":"9.9","ratingCount":"-3"}}</script><script type="application/ld+json">{broken</script>',
    'com.example.j',
  );
  assert.deepEqual(junk, { packageName: 'com.example.j', name: 'J' });
  assert.equal(parsePlayApp(playChangedHtml, 'com.example.x'), undefined);
});

test('getApp: one GET, 404 is "no such app", an invalid package name makes no request', async () => {
  const { fetch, seen } = fakeFetch((url) =>
    url.includes('com.example.alpha') ? html(playAppHtml) : html('', 404),
  );
  const play = new PlayPublicConnector({ enabled: true, fetch });
  const app = await play.getApp({ packageName: 'com.example.alpha', country: 'us' });
  assert.equal(app?.name, 'Alpha Habits & Goals');
  assert.equal(
    seen[0]?.url,
    'https://play.google.com/store/apps/details?id=com.example.alpha&hl=en&gl=us',
  );
  assert.equal(await play.getApp({ packageName: 'com.example.gone', country: 'us' }), undefined);
  for (const packageName of ['', 'nodots', 'com.example.a/b', 'com.example.alpha&gl=zz', '../x']) {
    assert.equal(
      (await failure(() => play.getApp({ packageName, country: 'us' }))).kind,
      'invalid_input',
      packageName,
    );
  }
  assert.equal(seen.length, 2);
});

test('a page above the size cap is too large', async () => {
  const play = new PlayPublicConnector({
    enabled: true,
    fetch: fakeFetch(() => html('a'.repeat(4 * 1024 * 1024))).fetch,
  });
  assert.equal((await failure(() => play.search({ term: 'x', country: 'us' }))).kind, 'too_large');
});

test('decodeEntities and tags in text are plain text', () => {
  assert.equal(
    decodeEntities('a &amp; b &lt;i&gt; &#39;q&#39; &#x41; &bogus; &#1;'),
    "a & b <i> 'q' A &bogus; &#1;",
  );
  const app = parsePlayApp('<h1>Evil <script>alert(1)</script></h1>', 'com.example.evil');
  assert.equal(app?.name.includes('<'), false);
});
