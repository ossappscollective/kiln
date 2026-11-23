import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { StoreHttp } from '../store-http.ts';
import { enableSharedGoogleTokens, GoogleTokenProvider, type ServiceAccount } from './google-auth.ts';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const account: ServiceAccount = { clientEmail: 'sa@example.iam.gserviceaccount.com', privateKey };

function provider(exchanges: { n: number }, scope?: string, now = () => 1_000_000) {
  const fetchFake = (async () => {
    exchanges.n++;
    return new Response(JSON.stringify({ access_token: `tok-${exchanges.n}`, expires_in: 3600 }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const http = new StoreHttp({ store: 'googleplay', fetch: fetchFake, now });
  return scope ? new GoogleTokenProvider(account, http, scope) : new GoogleTokenProvider(account, http);
}

test('without the shared cache every provider exchanges its own token', async () => {
  enableSharedGoogleTokens(false);
  const exchanges = { n: 0 };
  await provider(exchanges).token();
  await provider(exchanges).token();
  assert.equal(exchanges.n, 2);
});

test('with the shared cache, providers of one account and scope exchange once, even when they ask together', async () => {
  enableSharedGoogleTokens(true);
  try {
    const exchanges = { n: 0 };
    const tokens = await Promise.all([provider(exchanges).token(), provider(exchanges).token(), provider(exchanges).token()]);
    assert.equal(exchanges.n, 1);
    assert.deepEqual(new Set(tokens).size, 1);
    assert.equal(await provider(exchanges).token(), tokens[0]);
    assert.equal(exchanges.n, 1);
    // Another scope is another token, and an expired one is exchanged again.
    await provider(exchanges, 'https://www.googleapis.com/auth/playdeveloperreporting').token();
    assert.equal(exchanges.n, 2);
    await provider(exchanges, undefined, () => 1_000_000 + 3_600_000).token();
    assert.equal(exchanges.n, 3);
  } finally {
    enableSharedGoogleTokens(false);
  }
});

