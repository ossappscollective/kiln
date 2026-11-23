import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialKinds } from '@kiln/core';
import { credentialIdentifiers } from './credential-identifiers.ts';

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
const TOKEN = 'ghp_SECRETTOKENVALUE1234567890abcdef';

/** A payload per kind, every secret field filled with a recognisable value, plus extra fields that are not allow-listed. */
const payloads: Record<string, string> = {
  app_store_connect: JSON.stringify({ keyId: 'ABC123DEFG', issuerId: '57246542-96fe-1a63-e053-0824d011072a', privateKey: PEM }),
  google_play: JSON.stringify({
    type: 'service_account',
    project_id: 'my-project-123',
    private_key_id: 'abcdef0123456789abcdef0123456789abcdef01',
    private_key: PEM,
    client_email: 'ci@my-project-123.iam.gserviceaccount.com',
    client_id: '123456789012345678901',
    client_x509_cert_url: 'https://example.invalid/x',
    token_uri: 'https://oauth2.googleapis.com/token',
  }),
  github_app: JSON.stringify({ appId: '12345', installationId: '67890', privateKey: PEM }),
  github_token: TOKEN,
  translate_google: JSON.stringify({ apiKey: 'AIzaSECRETAPIKEY0123456789' }),
  translate_deepl: JSON.stringify({ apiKey: 'deepl-SECRET-KEY-0123456789:fx' }),
  translate_azure: JSON.stringify({ apiKey: 'AZURESECRETKEY0123456789', region: 'westeurope' }),
  translate_libretranslate: JSON.stringify({ apiKey: 'LIBRESECRETKEY0123456789' }),
  ai_anthropic: JSON.stringify({ apiKey: 'sk-ant-SECRETKEY0123456789' }),
  ai_openai: JSON.stringify({ apiKey: 'sk-SECRETKEY0123456789' }),
  ai_openai_compatible: JSON.stringify({ apiKey: 'SECRETKEY0123456789' }),
  expo: 'EXPOSECRETTOKEN0123456789',
  revenuecat: 'sk_REVENUECATSECRET0123456789',
};

const SECRET_NEEDLES = [
  'PRIVATE KEY', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'SECRETTOKENVALUE', 'SECRETAPIKEY', 'SECRET-KEY', 'SECRETKEY',
  'EXPOSECRETTOKEN', 'REVENUECATSECRET', 'private_key"', 'privateKey', 'apiKey', 'token_uri',
];

test('every kind has a payload in this test', () => {
  assert.deepEqual(Object.keys(payloads).sort(), [...credentialKinds].sort());
});

test('no identifier response can contain a secret key name or value, for any kind', () => {
  for (const kind of credentialKinds) {
    const json = JSON.stringify(credentialIdentifiers(kind, payloads[kind] as string));
    for (const needle of SECRET_NEEDLES) assert.equal(json.includes(needle), false, `${kind} leaks ${needle}: ${json}`);
  }
});

test('the allow-listed identifiers are returned, nothing else', () => {
  const pick = (kind: string) => credentialIdentifiers(kind, payloads[kind] as string).map((i) => [i.key, i.value]);
  assert.deepEqual(pick('app_store_connect'), [['issuerId', '57246542-96fe-1a63-e053-0824d011072a'], ['keyId', 'ABC123DEFG']]);
  assert.deepEqual(pick('google_play'), [
    ['clientEmail', 'ci@my-project-123.iam.gserviceaccount.com'],
    ['projectId', 'my-project-123'],
    ['serviceKeyId', 'abcdef0123456789abcdef0123456789abcdef01'],
    ['clientId', '123456789012345678901'],
  ]);
  assert.deepEqual(pick('github_app'), [['appId', '12345'], ['installationId', '67890']]);
  assert.deepEqual(pick('github_token'), [['tokenType', 'classic']]);
  assert.deepEqual(pick('translate_azure'), [['region', 'westeurope']]);
  for (const kind of ['expo', 'revenuecat', 'ai_openai', 'ai_anthropic', 'translate_deepl']) assert.deepEqual(pick(kind), []);
});

test('a value that is not an identifier, or repeats a secret, is dropped; unreadable payloads give nothing', () => {
  assert.deepEqual(credentialIdentifiers('app_store_connect', JSON.stringify({ keyId: PEM, issuerId: 'two words', privateKey: PEM })), []);
  assert.deepEqual(credentialIdentifiers('app_store_connect', JSON.stringify({ keyId: 'SAMESECRETVALUE', privateKey: 'SAMESECRETVALUE' })), []);
  assert.deepEqual(credentialIdentifiers('google_play', 'not json'), []);
  assert.deepEqual(credentialIdentifiers('github_token', 'unknown_prefix_123'), []);
  assert.deepEqual(credentialIdentifiers('nope', '{}'), []);
});
