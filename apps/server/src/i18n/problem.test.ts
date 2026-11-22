import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanParams, coded, codingOf, legacyCode, messageCoding } from './problem.ts';

test('coded() checks the code and keeps only safe scalar params', () => {
  assert.deepEqual(coded('sync.inProgress'), { code: 'sync.inProgress' });
  assert.deepEqual(coded('store.rateLimited', { store: 'Google Play', count: 30 }), {
    code: 'store.rateLimited',
    params: { store: 'Google Play', count: 30 },
  });
  assert.throws(() => coded('not_dotted'));
  assert.throws(() => coded('Bad.code'));
});

test('params never carry a secret-looking name, an object, or long text', () => {
  const clean = cleanParams({
    apiKey: 'k',
    accessToken: 't',
    client_secret: 's',
    password: 'p',
    branch: 'main',
    nested: { a: 1 } as never,
    long: 'x'.repeat(1000),
    n: Number.NaN,
    gone: undefined,
    ok: true,
  });
  assert.deepEqual(Object.keys(clean ?? {}).sort(), ['branch', 'long', 'ok']);
  assert.equal((clean?.long as string).length, 300);
  assert.equal(cleanParams({}), undefined);
});

test('legacyCode, codingOf and messageCoding', () => {
  assert.equal(legacyCode('not_found'), 'api.notFound');
  assert.equal(legacyCode('rate_limited'), 'api.rateLimited');
  assert.deepEqual(codingOf({ code: 'a.b', params: { x: 1, token: 'z' } }), { code: 'a.b', params: { x: 1 } });
  assert.deepEqual(codingOf({ code: 'nodots' }), {});
  assert.deepEqual(codingOf(null), {});
  const err = Object.assign(new Error('Same.'), { code: 'a.b' });
  assert.deepEqual(messageCoding(err, 'Same.'), { code: 'a.b' });
  assert.deepEqual(messageCoding(err, 'Same. And more.'), {});
  assert.deepEqual(messageCoding('text', 'text'), {});
});
