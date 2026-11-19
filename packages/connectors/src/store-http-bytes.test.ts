import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError, StoreRateLimitError } from './errors.ts';
import { MAX_ERROR_BYTES, StoreHttp } from './store-http.ts';

const URL_SECRET = 'https://files.example.test/a/b.csv.gz?X-Amz-Signature=TOPSECRETSIGNATURE&X-Amz-Expires=300';

const http = (fetchFn: typeof fetch, extra: { maxRateLimitRetries?: number } = {}) =>
  new StoreHttp({ store: 'appstoreconnect', fetch: fetchFn, sleep: async () => undefined, ...extra });

const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });

test('sendBytes returns the bytes untouched, sends only the headers it is given, and does not parse', async () => {
  let seen: Headers | undefined;
  const reply = await http(async (_url, init) => {
    seen = new Headers(init?.headers);
    return new Response(new Uint8Array([0x1f, 0x8b, 1, 2, 3]), { status: 200 });
  }).sendBytes('GET', URL_SECRET, { maxBytes: 100 });
  assert.deepEqual([...reply.bytes], [0x1f, 0x8b, 1, 2, 3]);
  assert.equal(reply.status, 200);
  assert.equal(seen?.get('authorization'), null, 'no token unless a caller adds one');
  assert.notEqual(seen?.get('accept'), 'application/json', 'bytes mode does not ask for JSON');
});

test('sendBytes: more than maxBytes is too_large, by Content-Length and by counting', async () => {
  const declared = await http(async () => new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': '5000' } }))
    .sendBytes('GET', URL_SECRET, { maxBytes: 100 })
    .catch((e) => e as StoreError);
  assert.ok(declared instanceof StoreError);
  assert.equal(declared.kind, 'too_large');

  // No Content-Length (chunked): the bytes are counted and the read stops at the cap.
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(40));
      if (pulled > 1000) controller.close();
    },
  });
  const counted = await http(async () => new Response(body, { status: 200 })).sendBytes('GET', URL_SECRET, { maxBytes: 100 }).catch((e) => e as StoreError);
  assert.ok(counted instanceof StoreError);
  assert.equal(counted.kind, 'too_large');
  assert.ok(pulled < 20, `the body was not read to the end (${pulled} chunks)`);
});

test('sendBytes: an error answer is read up to a small cap only', async () => {
  const reply = await http(async () => new Response(streamOf([new Uint8Array(MAX_ERROR_BYTES), new Uint8Array(MAX_ERROR_BYTES)]), { status: 500 })).sendBytes('GET', URL_SECRET, { maxBytes: 10 });
  assert.equal(reply.status, 500);
  assert.equal(reply.bytes.length, MAX_ERROR_BYTES);
});

test('sendBytes: the link and its query never appear in a message, and are redacted from `known` text', async () => {
  const h = http(async () => {
    throw new TypeError(`fetch failed for ${URL_SECRET}`);
  });
  const error = await h.sendBytes('GET', URL_SECRET, { maxBytes: 10 }).catch((e) => e as StoreError);
  assert.ok(error instanceof StoreError);
  assert.equal(error.kind, 'network');
  assert.ok(!error.message.includes('TOPSECRETSIGNATURE'));
  assert.ok(!error.message.includes('X-Amz'));
  assert.match(error.message, /files\.example\.test/);
  assert.equal(h.redact(`broke at ${URL_SECRET}`).includes('TOPSECRETSIGNATURE'), false);
  assert.equal(h.redact('query ?X-Amz-Signature=TOPSECRETSIGNATURE&X-Amz-Expires=300 here').includes('TOPSECRETSIGNATURE'), false);
});

test('sendBytes waits out a 429 like send, within the bound', async () => {
  let n = 0;
  const reply = await http(async () => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : new Response(new Uint8Array([7]), { status: 200 }))).sendBytes('GET', URL_SECRET, { maxBytes: 10 });
  assert.equal(n, 2);
  assert.deepEqual([...reply.bytes], [7]);
  const limited = await http(async () => new Response('', { status: 429, headers: { 'retry-after': '3600' } })).sendBytes('GET', URL_SECRET, { maxBytes: 10 }).catch((e) => e);
  assert.ok(limited instanceof StoreRateLimitError);
});
