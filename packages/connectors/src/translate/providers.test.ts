import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Answer, fakeFetch } from './fake.ts';
import { createGoogleTranslator } from './google.ts';
import { createTranslator, parseTranslateSecret, probeTranslator } from './index.ts';
import { TranslateError, type TranslateErrorKind, type Translator } from './types.ts';

const REVIEW = 'Great app, but it crashes when I open the camera. Please fix';
const KEY = 'SECRET-KEY-1234567890';

async function kindOf(run: () => Promise<unknown>): Promise<{ kind: TranslateErrorKind; message: string; retry: number | undefined }> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof TranslateError, String(error));
    return { kind: error.kind, message: error.message, retry: error.retryAfterSeconds };
  }
  throw new Error('did not throw');
}

/** No error message may carry the key, the text that was sent, or provider words. */
const clean = (message: string) => {
  assert.ok(!message.includes(KEY), 'the key');
  assert.ok(!message.includes(REVIEW), 'the text');
  assert.ok(!/Invalid value|api key not valid/i.test(message), 'provider text');
};

type Row = [Answer, TranslateErrorKind];
async function expectKinds(make: (answer: Answer) => Translator, rows: Row[]) {
  for (const [answer, kind] of rows) {
    const got = await kindOf(() => make(answer).translate({ texts: [REVIEW], target: 'en' }));
    assert.equal(got.kind, kind, JSON.stringify(answer));
    clean(got.message);
  }
}

// ---- Google --------------------------------------------------------------------------------

test('google: request shape (v2, key in the query, text format), parsing and detected language', async () => {
  const f = fakeFetch({ json: { data: { translations: [{ translatedText: 'Super', detectedSourceLanguage: 'en' }, { translatedText: 'Zwei' }] } } });
  const t = createTranslator({ provider: 'google', secret: JSON.stringify({ apiKey: KEY }), options: { fetch: f.fetch } });
  const out = await t.translate({ texts: ['Great', 'Two'], target: 'pt-BR' });
  assert.deepEqual(out.results, [{ text: 'Super', detectedSource: 'en' }, { text: 'Zwei' }]);
  const [r] = f.requests;
  assert.equal(r?.method, 'POST');
  assert.equal(r?.url, `https://translation.googleapis.com/language/translate/v2?key=${KEY}`);
  assert.deepEqual(r?.body, { q: ['Great', 'Two'], target: 'pt-BR', format: 'text' });
});

test('google: a source is sent when given, the key can go in a header, a bare string secret is the key', async () => {
  const f = fakeFetch({ json: { data: { translations: [{ translatedText: 'x' }] } } });
  const t = createTranslator({ provider: 'google', secret: KEY, options: { fetch: f.fetch } });
  await t.translate({ texts: ['a'], target: 'zh-Hant', source: 'de' });
  assert.deepEqual(f.requests[0]?.body, { q: ['a'], target: 'zh-TW', source: 'de', format: 'text' });
  const h = fakeFetch({ json: { data: { translations: [{ translatedText: 'x' }] } } });
  await createGoogleTranslator({ apiKey: KEY, keyIn: 'header', fetch: h.fetch }).translate({ texts: ['a'], target: 'en' });
  assert.equal(h.requests[0]?.url, 'https://translation.googleapis.com/language/translate/v2');
  assert.equal(h.requests[0]?.headers['x-goog-api-key'], KEY);
});

test('google: errors map to stable kinds and fixed messages', async () => {
  const make = (answer: Answer) => createTranslator({ provider: 'google', secret: JSON.stringify({ apiKey: KEY }), options: { fetch: fakeFetch(answer).fetch } });
  await expectKinds(make, [
    [{ status: 400, json: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', errors: [{ reason: 'badRequest' }] } } }, 'auth'],
    [{ status: 400, json: { error: { message: 'Invalid Value', errors: [{ reason: 'invalid' }] } } }, 'unsupported_language'],
    [{ status: 401, json: {} }, 'auth'],
    [{ status: 403, json: { error: { message: 'Daily Limit Exceeded', errors: [{ reason: 'dailyLimitExceeded' }] } } }, 'quota'],
    [{ status: 403, json: { error: { message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } } }, 'rate_limited'],
    [{ status: 403, json: { error: { message: 'Cloud Translation API has not been used in project 1 before or it is disabled.' } } }, 'auth'],
    [{ status: 429, json: {}, headers: { 'retry-after': '12' } }, 'rate_limited'],
    [{ status: 500, text: 'oops' }, 'unavailable'],
    [{ status: 200, json: { data: {} } }, 'unavailable'],
    [{ status: 200, json: { data: { translations: [{ translatedText: 'a' }, { translatedText: 'b' }] } } }, 'unavailable'],
    [{ status: 200, text: '<html>' }, 'unavailable'],
    [{ throws: new Error(`connect ECONNREFUSED ${KEY}`) }, 'unavailable'],
    [{ throws: Object.assign(new Error('x'), { name: 'TimeoutError' }) }, 'timeout'],
  ]);
  const got = await kindOf(() => make({ status: 429, json: {}, headers: { 'retry-after': '12' } }).translate({ texts: ['a'], target: 'en' }));
  assert.equal(got.retry, 12);
});

// ---- DeepL ---------------------------------------------------------------------------------

test('deepl: Free keys use the Free address, Pro keys the Pro address, header and body shape', async () => {
  const free = fakeFetch({ json: { translations: [{ detected_source_language: 'PT', text: 'Great' }] } });
  const out = await createTranslator({ provider: 'deepl', secret: JSON.stringify({ apiKey: 'abc-123:fx' }), options: { fetch: free.fetch } }).translate({
    texts: ['Ótimo'],
    target: 'en-GB',
  });
  assert.deepEqual(out.results, [{ text: 'Great', detectedSource: 'pt' }]);
  assert.equal(free.requests[0]?.url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(free.requests[0]?.headers.authorization, 'DeepL-Auth-Key abc-123:fx');
  assert.deepEqual(free.requests[0]?.body, { text: ['Ótimo'], target_lang: 'EN-GB' });

  const pro = fakeFetch({ json: { translations: [{ text: 'x' }] } });
  await createTranslator({ provider: 'deepl', secret: JSON.stringify({ apiKey: 'abc-123' }), options: { fetch: pro.fetch } }).translate({ texts: ['a'], target: 'pt-PT', source: 'en-US' });
  assert.equal(pro.requests[0]?.url, 'https://api.deepl.com/v2/translate');
  assert.deepEqual(pro.requests[0]?.body, { text: ['a'], target_lang: 'PT-PT', source_lang: 'EN' });
});

test('deepl: errors (403, 456, 429, 529, 413, 400 on a language, 5xx)', async () => {
  const make = (answer: Answer) => createTranslator({ provider: 'deepl', secret: JSON.stringify({ apiKey: KEY }), options: { fetch: fakeFetch(answer).fetch } });
  await expectKinds(make, [
    [{ status: 403, json: { message: 'Forbidden' } }, 'auth'],
    [{ status: 456, json: { message: 'Quota exceeded' } }, 'quota'],
    [{ status: 429, json: {}, headers: { 'retry-after': '5' } }, 'rate_limited'],
    [{ status: 529, json: {} }, 'rate_limited'],
    [{ status: 413, json: {} }, 'too_large'],
    [{ status: 400, json: { message: "Value for 'target_lang' not supported." } }, 'unsupported_language'],
    [{ status: 400, json: { message: 'Bad request' } }, 'unavailable'],
    [{ status: 504, text: '' }, 'unavailable'],
    [{ status: 200, json: { translations: [] } }, 'unavailable'],
  ]);
});

// ---- Azure ---------------------------------------------------------------------------------

test('azure: v3.0 request (query, key and region headers, Text objects) and the reply', async () => {
  const f = fakeFetch({
    json: [
      { detectedLanguage: { language: 'de', score: 0.9 }, translations: [{ text: 'Hello', to: 'en' }] },
      { translations: [{ text: 'World', to: 'en' }] },
    ],
  });
  const t = createTranslator({ provider: 'azure', secret: JSON.stringify({ apiKey: KEY, region: 'westeurope' }), options: { fetch: f.fetch } });
  const out = await t.translate({ texts: ['Hallo', 'Welt'], target: 'en-GB' });
  assert.deepEqual(out.results, [{ text: 'Hello', detectedSource: 'de' }, { text: 'World' }]);
  const r = f.requests[0];
  assert.equal(r?.url, 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en&textType=plain');
  assert.equal(r?.headers['ocp-apim-subscription-key'], KEY);
  assert.equal(r?.headers['ocp-apim-subscription-region'], 'westeurope');
  assert.deepEqual(r?.body, [{ Text: 'Hallo' }, { Text: 'Welt' }]);
});

test('azure: no region header for a global resource, from is sent for a source, pt-PT and zh codes', async () => {
  for (const region of ['', 'global']) {
    const f = fakeFetch({ json: [{ translations: [{ text: 'x' }] }] });
    await createTranslator({ provider: 'azure', secret: JSON.stringify({ apiKey: KEY, region }), options: { fetch: f.fetch } }).translate({ texts: ['a'], target: 'pt-PT', source: 'zh-TW' });
    assert.equal(f.requests[0]?.headers['ocp-apim-subscription-region'], undefined, region);
    assert.equal(f.requests[0]?.url, 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=pt-pt&textType=plain&from=zh-Hant');
  }
});

test('azure: errors (401 auth, 403 quota, 429, 400 language, 408, 503)', async () => {
  const make = (answer: Answer) => createTranslator({ provider: 'azure', secret: JSON.stringify({ apiKey: KEY }), options: { fetch: fakeFetch(answer).fetch } });
  await expectKinds(make, [
    [{ status: 401, json: { error: { code: 401000, message: 'The request is not authorized' } } }, 'auth'],
    [{ status: 403, json: { error: { code: 403000, message: 'free translations used up' } } }, 'quota'],
    [{ status: 429, json: { error: { code: 429000 } }, headers: { 'retry-after': '7' } }, 'rate_limited'],
    [{ status: 400, json: { error: { code: 400036, message: 'The target field is missing or is not a valid language' } } }, 'unsupported_language'],
    [{ status: 400, json: { error: { code: 400000, message: 'One of the request inputs is not valid.' } } }, 'unavailable'],
    [{ status: 408, json: {} }, 'unavailable'],
    [{ status: 503, json: {} }, 'unavailable'],
    [{ status: 200, json: { not: 'a list' } }, 'unavailable'],
    [{ status: 200, json: [{ translations: [] }] }, 'unavailable'],
  ]);
});

// ---- LibreTranslate -----------------------------------------------------------------------

test('libretranslate: a custom base URL, JSON body with source auto and the key in the body', async () => {
  const f = fakeFetch({ json: { translatedText: 'Hola', detectedLanguage: { confidence: 90, language: 'en' } } });
  const t = createTranslator({ provider: 'libretranslate', secret: JSON.stringify({ apiKey: KEY }), baseUrl: 'https://lt.example.com/sub/', options: { fetch: f.fetch } });
  const out = await t.translate({ texts: ['Hello'], target: 'es' });
  assert.deepEqual(out.results, [{ text: 'Hola', detectedSource: 'en' }]);
  assert.equal(f.requests[0]?.url, 'https://lt.example.com/sub/translate');
  assert.deepEqual(f.requests[0]?.body, { q: 'Hello', source: 'auto', target: 'es', format: 'text', api_key: KEY });
});

test('libretranslate: no key means no api_key field; a source is mapped; batches use a list', async () => {
  const f = fakeFetch({ json: { translatedText: ['A', 'B'], detectedLanguage: [{ language: 'zt' }, { language: 'pb' }] } });
  const t = createTranslator({ provider: 'libretranslate', baseUrl: 'http://127.0.0.1:5000', options: { fetch: f.fetch } });
  const out = await t.translate({ texts: ['a', 'b'], target: 'pt-BR', source: 'zh-Hant' });
  assert.deepEqual(out.results, [{ text: 'A', detectedSource: 'zh-Hant' }, { text: 'B', detectedSource: 'pt-BR' }]);
  assert.deepEqual(f.requests[0]?.body, { q: ['a', 'b'], source: 'zt', target: 'pb', format: 'text' });
});

test('libretranslate: a server that answers a list with one string is asked text by text', async () => {
  const f = fakeFetch({ json: { translatedText: 'first only' } }, { json: { translatedText: 'one' } }, { json: { translatedText: 'two' } });
  const t = createTranslator({ provider: 'libretranslate', baseUrl: 'https://lt.example.com', options: { fetch: f.fetch } });
  const out = await t.translate({ texts: ['a', 'b'], target: 'en' });
  assert.deepEqual(out.results.map((r) => r.text), ['one', 'two']);
  assert.equal(f.requests.length, 3);
});

test('libretranslate: errors (403 key, 400 key required, 429, unsupported, text limit, redirect)', async () => {
  const make = (answer: Answer) => createTranslator({ provider: 'libretranslate', baseUrl: 'https://lt.example.com', options: { fetch: fakeFetch(answer).fetch } });
  await expectKinds(make, [
    [{ status: 403, json: { error: 'Invalid API key' } }, 'auth'],
    [{ status: 400, json: { error: 'Please contact the server operator to get an API key' } }, 'auth'],
    [{ status: 403, json: { error: 'Too many request limits violations' } }, 'rate_limited'],
    [{ status: 429, json: { error: 'Slowdown: 5 per 1 minute' } }, 'rate_limited'],
    [{ status: 400, json: { error: 'xx is not supported' } }, 'unsupported_language'],
    [{ status: 400, json: { error: 'English (en) is not available as a target language from German (de)' } }, 'unsupported_language'],
    [{ status: 400, json: { error: 'Invalid request: request (6000) exceeds text limit (5000)' } }, 'too_large'],
    [{ status: 302, text: '', headers: { location: 'http://169.254.169.254/' } }, 'unavailable'],
    [{ status: 500, text: 'boom' }, 'unavailable'],
    [{ status: 200, json: {} }, 'unavailable'],
  ]);
});

// ---- shared ---------------------------------------------------------------------------------

test('a missing key or address is not_configured; an unknown language is refused before any request', async () => {
  const notConfigured = (e: unknown) => e instanceof TranslateError && e.kind === 'not_configured';
  for (const provider of ['google', 'deepl', 'azure'] as const) {
    assert.throws(() => createTranslator({ provider, secret: JSON.stringify({ apiKey: ' ' }) }), notConfigured, provider);
    assert.throws(() => createTranslator({ provider }), notConfigured, provider);
  }
  assert.throws(() => createTranslator({ provider: 'libretranslate' }), notConfigured);
  const f = fakeFetch({ json: {} });
  for (const provider of ['google', 'deepl', 'azure', 'libretranslate'] as const) {
    const t = createTranslator({ provider, secret: JSON.stringify({ apiKey: KEY }), baseUrl: 'https://lt.example.com', options: { fetch: f.fetch } });
    assert.equal((await kindOf(() => t.translate({ texts: ['a'], target: '???' }))).kind, 'unsupported_language', provider);
    assert.equal((await kindOf(() => t.translate({ texts: ['a'], target: 'en', source: '???' }))).kind, 'unsupported_language', provider);
  }
  assert.equal(f.requests.length, 0);
});

test('a reply over the size cap never succeeds, and the request does not follow redirects', async () => {
  const big = fakeFetch({ text: JSON.stringify({ data: { translations: [{ translatedText: 'x'.repeat(2000) }] } }) });
  const t = createTranslator({ provider: 'google', secret: KEY, options: { fetch: big.fetch, maxResponseBytes: 500 } });
  assert.equal((await kindOf(() => t.translate({ texts: ['a'], target: 'en' }))).kind, 'unavailable');
  let seen: RequestInit | undefined;
  const spy = (async (_url: string, init?: RequestInit) => {
    seen = init;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  await kindOf(() => createTranslator({ provider: 'google', secret: KEY, options: { fetch: spy } }).translate({ texts: ['a'], target: 'en' }));
  assert.equal(seen?.redirect, 'manual');
});

test('a call that is too slow is a timeout', async () => {
  const slow = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
  const t = createTranslator({ provider: 'deepl', secret: KEY, options: { fetch: slow, timeoutMs: 20 } });
  assert.equal((await kindOf(() => t.translate({ texts: ['a'], target: 'en' }))).kind, 'timeout');
});

test('parseTranslateSecret reads JSON, a bare string, and nothing', () => {
  assert.deepEqual(parseTranslateSecret('{"apiKey":" k ","region":" r "}'), { apiKey: 'k', region: 'r' });
  assert.deepEqual(parseTranslateSecret(' bare '), { apiKey: 'bare', region: '' });
  assert.deepEqual(parseTranslateSecret(undefined), { apiKey: '', region: '' });
  assert.deepEqual(parseTranslateSecret('[]'), { apiKey: '[]', region: '' });
});

test('probeTranslator translates one fixed word and reports fixed sentences only', async () => {
  const ok = fakeFetch({ json: { translations: [{ text: 'Bonjour' }] } });
  const t: Translator = createTranslator({ provider: 'deepl', secret: KEY, options: { fetch: ok.fetch } });
  assert.deepEqual(await probeTranslator(t), { ok: true, provider: 'deepl' });
  assert.deepEqual(ok.requests[0]?.body, { text: ['Hello'], target_lang: 'FR' });
  const bad = await probeTranslator(createTranslator({ provider: 'deepl', secret: KEY, options: { fetch: fakeFetch({ status: 403, json: { message: KEY } }).fetch } }));
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.kind, 'auth');
    assert.ok(!bad.message.includes(KEY));
  }
});

test('libretranslate: an unavailable pair names the codes, never the server text', async () => {
  const f = fakeFetch({ status: 400, json: { error: 'English (en) is not available as a target language from Catalan (ca)' } });
  const t = createTranslator({ provider: 'libretranslate', baseUrl: 'http://127.0.0.1:5000', options: { fetch: f.fetch } });
  await assert.rejects(
    () => t.translate({ texts: ['Hola'], target: 'en' }),
    (e: unknown) => e instanceof TranslateError && e.kind === 'unsupported_language' && e.detail === 'pair_ca_to_en',
  );
});
