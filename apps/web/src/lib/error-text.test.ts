import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiError, createApi, messageFor } from './api.ts';
import { codedText, errorText, legacyCode, noteText, paramsOf, waitText } from './error-text.ts';
import { useLocale } from './i18n/test-setup.ts';

const ERRORS = fileURLToPath(new URL('../../locales/errors/', import.meta.url));
const read = (lang: string): Record<string, string> =>
  JSON.parse(readFileSync(`${ERRORS}${lang}.json`, 'utf8'));

describe('legacyCode', () => {
  it('turns the legacy error word into the implicit code', () => {
    assert.equal(legacyCode('not_found'), 'api.notFound');
    assert.equal(legacyCode('too_many_attempts'), 'api.tooManyAttempts');
    assert.equal(legacyCode('forbidden'), 'api.forbidden');
  });
});

describe('paramsOf', () => {
  it('keeps scalars and drops everything else', () => {
    assert.deepEqual(paramsOf({ a: 'x', b: 2, c: true, d: null, e: { f: 1 }, g: [1] }), {
      a: 'x',
      b: 2,
      c: true,
      d: null,
    });
    assert.deepEqual(paramsOf(undefined), {});
    assert.deepEqual(paramsOf([1, 2]), {});
  });
});

describe('codedText (English)', () => {
  it('fills params and picks plural forms', () => {
    assert.equal(codedText('store.rateLimited', { store: 'Apple', count: 1 })?.includes('1 second'), true);
    assert.equal(codedText('sync.tooManySyncs', { count: 1 }), 'Too many syncs. Try again in 1 second.');
    assert.equal(codedText('sync.tooManySyncs', { count: 30 }), 'Too many syncs. Try again in 30 seconds.');
  });
  it('is undefined for a code this app does not know and for a malformed one', () => {
    assert.equal(codedText('store.neverHeardOfIt'), undefined);
    assert.equal(codedText('not a code'), undefined);
    assert.equal(codedText('smtp_timeout'), undefined);
  });
});

describe('errorText', () => {
  it('prefers the explicit code, then the legacy word', () => {
    assert.equal(errorText({ error: 'whatever', code: 'sync.inProgress' }), 'A sync of this app is already running.');
    assert.equal(errorText({ error: 'not_found' }), 'That no longer exists.');
    assert.equal(errorText({ error: 'unheard_of' }), undefined);
  });
  it('leaves invalid_request with issues and local_ errors to the caller', () => {
    assert.equal(errorText({ error: 'invalid_request', issues: [{ path: 'a', message: 'b' }] } as never), undefined);
    assert.equal(errorText({ error: 'invalid_request' }), 'Check the form and try again.');
    assert.equal(errorText({ error: 'local_not_allowed' }), undefined);
  });
  it('uses the retry wait for rate limits', () => {
    assert.equal(errorText({ error: 'too_many_attempts' }, 30), 'Too many attempts. Try again in 30 seconds.');
    assert.equal(errorText({ error: 'too_many_attempts' }, 61), 'Too many attempts. Try again in 2 minutes.');
  });
});

describe('noteText', () => {
  it('translates a stored note with a code and keeps the saved English otherwise', () => {
    assert.equal(
      noteText({ message: 'old', code: 'sync.timeout', params: null }),
      'The store did not answer in time. Try again.',
    );
    assert.equal(noteText({ message: 'old English', code: null }), 'old English');
    assert.equal(noteText({ message: 'old English', code: 'store.unknownCode' }), 'old English');
  });
});

describe('messageFor with codes', () => {
  it('shows the coded sentence, the server message for an unknown code, and the old table otherwise', () => {
    assert.equal(
      messageFor(409, { error: 'sync_in_progress', message: 'x', code: 'sync.inProgress' }),
      'A sync of this app is already running.',
    );
    assert.equal(
      messageFor(502, { error: 'store_error', message: 'Server words', code: 'store.fromTheFuture' }),
      'Server words',
    );
    assert.equal(messageFor(401, { error: 'unauthenticated' }), 'Your session has ended. Sign in again.');
    assert.equal(messageFor(500, {}), 'The server had a problem. Try again.');
    assert.equal(messageFor(418, {}), 'The request failed (418).');
    assert.equal(messageFor(429, {}, 90), 'Too many requests. Try again in 2 minutes.');
  });
  it('ignores a legacy code field that is not dot.case', () => {
    assert.equal(messageFor(502, { error: 'smtp_failed', code: 'smtp_timeout' }), 'The server had a problem. Try again.');
  });
});

describe('Accept-Language and network errors', () => {
  it('sends no header in English without a saved choice', async () => {
    const seen: (HeadersInit | undefined)[] = [];
    const api = createApi({
      fetch: (async (_u: unknown, init?: RequestInit) => {
        seen.push(init?.headers);
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    await api.health();
    assert.equal(seen[0], undefined);
  });
  it('sends the active language otherwise and shows the network error in it', async () => {
    useLocale('fr');
    try {
      const seen: (HeadersInit | undefined)[] = [];
      const api = createApi({
        fetch: (async (_u: unknown, init?: RequestInit) => {
          seen.push(init?.headers);
          throw new Error('offline');
        }) as typeof fetch,
      });
      await assert.rejects(api.health(), (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.message, read('fr')['http.network']);
        return true;
      });
      assert.deepEqual(seen[0], { 'accept-language': 'fr' });
    } finally {
      useLocale('en');
    }
  });
  it('translates a coded response in the active language', async () => {
    useLocale('de');
    try {
      const api = createApi({
        fetch: (async () =>
          new Response(JSON.stringify({ error: 'sync_in_progress', message: 'x', code: 'sync.inProgress' }), {
            status: 409,
          })) as typeof fetch,
      });
      await assert.rejects(api.health(), (e: unknown) => {
        assert.equal((e as ApiError).message, read('de')['sync.inProgress']);
        return true;
      });
    } finally {
      useLocale('en');
    }
  });
});

describe('waitText', () => {
  it('rounds up and uses the unit names of the language', () => {
    assert.equal(waitText(1), '1 second');
    assert.equal(waitText(59.2), '1 minute');
    assert.equal(waitText(59), '59 seconds');
    assert.equal(waitText(600), '10 minutes');
  });
});

describe('the errors catalog', () => {
  it('has every language with the same keys as English', () => {
    const en = Object.keys(read('en'));
    for (const lang of readdirSync(ERRORS).map((f) => f.replace('.json', ''))) {
      const keys = Object.keys(read(lang));
      // Plural groups differ by language (fr and es add _many); compare the base keys.
      const base = (list: string[]) => new Set(list.map((k) => k.replace(/_(zero|one|two|few|many|other)$/, '')));
      assert.deepEqual([...base(keys)].sort(), [...base(en)].sort(), lang);
    }
  });
});

describe('one-off server sentences (codes added in the localisation of the remaining messages)', () => {
  it('plural seconds follow the language and the number', () => {
    try {
      useLocale('fr');
      assert.equal(
        codedText('rate.requests', { count: 1 }),
        'Trop de requêtes. Réessayez dans 1 seconde.',
      );
      assert.match(codedText('rate.requests', { count: 30 }) ?? '', /30 secondes/);
      useLocale('de');
      assert.equal(
        codedText('rate.requests', { count: 1 }),
        'Zu viele Anfragen. Versuchen Sie es in 1 Sekunde erneut.',
      );
      useLocale('en');
      assert.equal(
        codedText('rate.requests', { count: 1 }),
        'Too many requests. Try again in 1 second.',
      );
    } finally {
      useLocale('en');
    }
  });

  it('fills the params of a sentence in every language', () => {
    try {
      for (const lang of ['en', 'fr', 'es', 'de']) {
        useLocale(lang as 'en');
        const text = codedText('confirm.mismatchPublished', { phrase: 'publish MyApp' });
        assert.match(text ?? '', /publish MyApp/, lang);
        assert.doesNotMatch(text ?? '', /\{\{/, lang);
      }
    } finally {
      useLocale('en');
    }
  });

  it('an unknown code still falls back to the server message', () => {
    assert.equal(codedText('nothing.here', {}), undefined);
    assert.equal(errorText({ error: 'x', code: 'nothing.here', message: 'English' }), undefined);
  });
});
