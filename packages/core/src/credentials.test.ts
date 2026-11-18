import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSecret, checkSecret, credentialKindInfo, credentialKinds, isCredentialKind } from './credentials.ts';

const PEM = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';

test('every kind has a label and at least one field', () => {
  for (const kind of credentialKinds) {
    assert.ok(credentialKindInfo[kind].label);
    assert.ok(credentialKindInfo[kind].fields.length > 0);
  }
  assert.equal(isCredentialKind('github_token'), true);
  assert.equal(isCredentialKind('password'), false);
});

test('App Store Connect: assembled from the form, trimmed, and accepted', () => {
  const secret = buildSecret('app_store_connect', { keyId: ' ABC123DEFG ', issuerId: 'uuid-1', privateKey: `${PEM}\n` });
  assert.deepEqual(JSON.parse(secret), { keyId: 'ABC123DEFG', issuerId: 'uuid-1', privateKey: PEM });
  assert.equal(checkSecret('app_store_connect', secret), undefined);
});

test('App Store Connect: names what is missing and rejects a non-key', () => {
  const noIssuer = buildSecret('app_store_connect', { keyId: 'K', issuerId: '', privateKey: PEM });
  assert.equal(checkSecret('app_store_connect', noIssuer), 'Fill in: Issuer ID.');
  const notAKey = buildSecret('app_store_connect', { keyId: 'K', issuerId: 'I', privateKey: 'hello' });
  assert.match(checkSecret('app_store_connect', notAKey) ?? '', /BEGIN PRIVATE KEY/);
});

test('Google Play: needs the service account fields', () => {
  const good = JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: PEM });
  assert.equal(checkSecret('google_play', buildSecret('google_play', { serviceAccount: good })), undefined);
  assert.match(checkSecret('google_play', 'not json') ?? '', /not valid JSON/);
  assert.match(checkSecret('google_play', '{"client_email":"x"}') ?? '', /missing private_key/);
  assert.match(checkSecret('google_play', JSON.stringify({ client_email: 'x', private_key: 'nope' })) ?? '', /not a private key/);
});

test('GitHub App and token', () => {
  const app = buildSecret('github_app', { appId: '1', installationId: '2', privateKey: PEM });
  assert.equal(checkSecret('github_app', app), undefined);
  assert.equal(checkSecret('github_token', 'ghp_abc123'), undefined);
  assert.match(checkSecret('github_token', 'ghp abc') ?? '', /no spaces/);
  assert.match(checkSecret('github_token', '  ') ?? '', /Enter the token/);
});

test('a JSON array or scalar is not an object secret', () => {
  assert.ok(checkSecret('github_app', '[]'));
  assert.ok(checkSecret('github_app', '5'));
});

test('translation kinds: one API key (Azure also a region), trimmed, no spaces', () => {
  for (const kind of ['translate_google', 'translate_deepl', 'translate_libretranslate'] as const) {
    const secret = buildSecret(kind, { apiKey: ' abc123 ' });
    assert.deepEqual(JSON.parse(secret), { apiKey: 'abc123' });
    assert.equal(checkSecret(kind, secret), undefined, kind);
    assert.match(checkSecret(kind, buildSecret(kind, { apiKey: '  ' })) ?? '', /Enter the API key/, kind);
    assert.match(checkSecret(kind, buildSecret(kind, { apiKey: 'ab cd' })) ?? '', /no spaces/, kind);
    assert.ok(checkSecret(kind, 'not json'), kind);
    assert.ok(checkSecret(kind, '[]'), kind);
    assert.ok(credentialKindInfo[kind].fields.every((f) => f.secret === true), `${kind}: the key is masked`);
  }
  const azure = buildSecret('translate_azure', { apiKey: 'k', region: ' westeurope ' });
  assert.deepEqual(JSON.parse(azure), { apiKey: 'k', region: 'westeurope' });
  assert.equal(checkSecret('translate_azure', azure), undefined);
  assert.equal(checkSecret('translate_azure', buildSecret('translate_azure', { apiKey: 'k' })), undefined, 'the region is optional');
  assert.match(checkSecret('translate_azure', buildSecret('translate_azure', { apiKey: 'k', region: 'west europe' })) ?? '', /region/);
  assert.equal(isCredentialKind('translate_deepl'), true);
});
