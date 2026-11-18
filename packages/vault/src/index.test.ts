import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { VaultError, decryptSecret, encryptSecret, parseMasterKey } from './index.ts';

const key = randomBytes(32);

test('round trip', () => {
  const stored = encryptSecret('-----BEGIN PRIVATE KEY-----', key, 'ws1:cred1');
  assert.ok(stored.startsWith('v1.'));
  assert.equal(decryptSecret(stored, key, 'ws1:cred1'), '-----BEGIN PRIVATE KEY-----');
});

test('same plaintext encrypts differently each time', () => {
  assert.notEqual(encryptSecret('x', key), encryptSecret('x', key));
});

test('wrong key fails', () => {
  const stored = encryptSecret('secret', key);
  assert.throws(() => decryptSecret(stored, randomBytes(32)), VaultError);
});

test('wrong owner (aad) fails', () => {
  const stored = encryptSecret('secret', key, 'ws1:cred1');
  assert.throws(() => decryptSecret(stored, key, 'ws2:cred1'), VaultError);
});

test('tampering fails', () => {
  const stored = encryptSecret('secret', key);
  const parts = stored.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.'), key), VaultError);
});

test('rejects unknown formats', () => {
  assert.throws(() => decryptSecret('nope', key), /Unrecognized/);
  assert.throws(() => decryptSecret('v2.a.b.c', key), /Unrecognized/);
});

test('master key must be 32 bytes', () => {
  assert.throws(() => parseMasterKey(randomBytes(16).toString('base64')), /32 bytes/);
  assert.equal(parseMasterKey(randomBytes(32).toString('base64')).length, 32);
});

test('handles unicode', () => {
  const stored = encryptSecret('clé secrète 🔑', key);
  assert.equal(decryptSecret(stored, key), 'clé secrète 🔑');
});
