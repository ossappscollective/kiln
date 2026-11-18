import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
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

test('a truncated or padded auth tag is rejected, not accepted as a shorter tag', () => {
  const stored = encryptSecret('secret', key, 'ws1:cred1');
  const parts = stored.split('.');
  const tag = Buffer.from(parts[2] as string, 'base64url');
  assert.equal(tag.length, 16);
  for (const bad of [tag.subarray(0, 4), tag.subarray(0, 12), tag.subarray(0, 15), Buffer.concat([tag, tag]), Buffer.alloc(0)]) {
    const forged = [parts[0], parts[1], bad.toString('base64url'), parts[3]].join('.');
    assert.throws(() => decryptSecret(forged, key, 'ws1:cred1'), VaultError);
  }
  assert.equal(decryptSecret(stored, key, 'ws1:cred1'), 'secret');
});

test('a v1 value made without an explicit tag length (as before) still decrypts', () => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('ws1:cred1'));
  const body = Buffer.concat([cipher.update('old secret', 'utf8'), cipher.final()]);
  const stored = ['v1', iv, cipher.getAuthTag(), body].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  assert.equal(decryptSecret(stored, key, 'ws1:cred1'), 'old secret');
});
