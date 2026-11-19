import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { encodeCbor, makeAuthenticator } from './step-up-test-helpers.ts';
import { WebAuthnError, decodeCbor, isValidRpId, verifyAssertion, verifyRegistration } from './services/webauthn.ts';

const CHALLENGE = 'Y2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtMTIz';
const expected = { challenge: CHALLENGE, origins: ['http://localhost'], rpId: 'localhost' };

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof WebAuthnError, `expected a WebAuthnError, got ${String(error)}`);
    return error.code;
  }
  return 'no error';
};

test('CBOR: the shapes WebAuthn uses decode; tags, floats, indefinite lengths and duplicate keys are refused', () => {
  const sample = new Map<number | string, never>();
  assert.deepEqual(decodeCbor(encodeCbor(24)).value, 24);
  assert.deepEqual(decodeCbor(encodeCbor(-7)).value, -7);
  assert.deepEqual(decodeCbor(encodeCbor(300)).value, 300);
  assert.deepEqual(decodeCbor(encodeCbor('fmt')).value, 'fmt');
  assert.deepEqual(decodeCbor(encodeCbor([1, 2, 3])).value, [1, 2, 3]);
  assert.equal(decodeCbor(encodeCbor(sample)).value instanceof Map, true);
  const next = decodeCbor(Buffer.concat([encodeCbor(1), encodeCbor(2)]));
  assert.equal(next.next, 1, 'reports where the item ends');
  assert.equal(code(() => decodeCbor(Buffer.from([0xc1, 0x01]))), 'cbor_unsupported', 'tag');
  assert.equal(code(() => decodeCbor(Buffer.from([0xfb, 0, 0, 0, 0, 0, 0, 0, 0]))), 'cbor_unsupported', 'float');
  assert.equal(code(() => decodeCbor(Buffer.from([0x9f, 0x01, 0xff]))), 'cbor_unsupported', 'indefinite');
  assert.equal(code(() => decodeCbor(Buffer.from([0x44, 1, 2]))), 'cbor_truncated');
  assert.equal(code(() => decodeCbor(Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02]))), 'cbor_duplicate_key');
  let deep = Buffer.from([0x01]);
  for (let i = 0; i < 12; i++) deep = Buffer.concat([Buffer.from([0x81]), deep]);
  assert.equal(code(() => decodeCbor(deep)), 'cbor_too_deep');
});

for (const kind of ['es256', 'eddsa'] as const) {
  test(`registration and assertion with ${kind}: valid, and each way to be invalid`, () => {
    const a = makeAuthenticator(kind);
    const reg = verifyRegistration(a.register(CHALLENGE), expected);
    assert.equal(reg.credentialId, a.credentialId);
    assert.equal(reg.alg, kind === 'es256' ? -7 : -8);
    assert.equal(reg.signCount, 0);
    const stored = { publicKey: reg.publicKey, alg: reg.alg, signCount: 0 };

    // Registration refusals.
    assert.equal(code(() => verifyRegistration(a.register(CHALLENGE, { origin: 'https://evil.example' }), expected)), 'bad_origin');
    assert.equal(code(() => verifyRegistration(a.register(CHALLENGE, { clientChallenge: 'AAAA' }), expected)), 'bad_challenge');
    assert.equal(code(() => verifyRegistration(a.register(CHALLENGE, { type: 'webauthn.get' }), expected)), 'bad_type');
    assert.equal(code(() => verifyRegistration(a.register(CHALLENGE, { rpId: 'other.example' }), expected)), 'bad_rp_id');
    assert.equal(code(() => verifyRegistration(a.register(CHALLENGE, { flags: 0x41 }), expected)), 'user_not_verified');
    assert.equal(code(() => verifyRegistration(a.register(CHALLENGE, { flags: 0x44 }), expected)), 'user_not_present');
    assert.equal(code(() => verifyRegistration(a.register(CHALLENGE, { flags: 0x05 }), expected)), 'no_credential');
    assert.equal(code(() => verifyRegistration(a.register(CHALLENGE, { fmt: 'packed' }), expected)), 'unsupported_attestation');
    assert.equal(code(() => verifyRegistration({ ...a.register(CHALLENGE), attestationObject: 'AAAA' }, expected)), 'bad_attestation');
    assert.equal(code(() => verifyRegistration({ ...a.register(CHALLENGE), clientDataJSON: '!!' }, expected)), 'bad_encoding');

    // Assertion.
    const ok = verifyAssertion(a.assert(CHALLENGE, { counter: 5 }), stored, expected);
    assert.equal(ok.signCount, 5);
    assert.equal(code(() => verifyAssertion(a.assert(CHALLENGE, { origin: 'http://evil.test' }), stored, expected)), 'bad_origin');
    assert.equal(code(() => verifyAssertion(a.assert(CHALLENGE, { clientChallenge: 'AAAA' }), stored, expected)), 'bad_challenge');
    assert.equal(code(() => verifyAssertion(a.assert(CHALLENGE, { rpId: 'other.example' }), stored, expected)), 'bad_rp_id');
    assert.equal(code(() => verifyAssertion(a.assert(CHALLENGE, { flags: 0x01 }), stored, expected)), 'user_not_verified');
    const other = makeAuthenticator(kind);
    assert.equal(code(() => verifyAssertion(a.assert(CHALLENGE, { signWith: other.privateKey }), stored, expected)), 'bad_signature');
    const tampered = a.assert(CHALLENGE);
    assert.equal(code(() => verifyAssertion({ ...tampered, clientDataJSON: a.assert('AAAA').clientDataJSON }, stored, { ...expected, challenge: 'AAAA' })), 'bad_signature', 'a signature over other data');
    // Counter: it must go up once it is in use; 0 and 0 is how many platform passkeys behave.
    assert.equal(code(() => verifyAssertion(a.assert(CHALLENGE, { counter: 5 }), { ...stored, signCount: 5 }, expected)), 'counter_rollback');
    assert.equal(code(() => verifyAssertion(a.assert(CHALLENGE, { counter: 2 }), { ...stored, signCount: 5 }, expected)), 'counter_rollback');
    assert.equal(verifyAssertion(a.assert(CHALLENGE, { counter: 6 }), { ...stored, signCount: 5 }, expected).signCount, 6);
    assert.equal(verifyAssertion(a.assert(CHALLENGE, { counter: 0 }), stored, expected).signCount, 0);
  });
}

test('a key type that is not ES256 or EdDSA (RS256) is refused at registration', () => {
  const rsa = makeAuthenticator('rs256');
  assert.equal(code(() => verifyRegistration(rsa.register(CHALLENGE), expected)), 'unsupported_algorithm');
});

test('a point that is not on the P-256 curve is refused', () => {
  const a = makeAuthenticator('es256');
  const good = a.register(CHALLENGE);
  const att = decodeCbor(Buffer.from(good.attestationObject, 'base64url')).value as Map<string, Buffer>;
  const data = Buffer.from(att.get('authData') as Buffer);
  data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 0xff; // the last byte of y
  const bad = encodeCbor(new Map<string, never>([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]] as never));
  assert.equal(code(() => verifyRegistration({ ...good, attestationObject: bad.toString('base64url') }, expected)), 'bad_key');
});

test('an assertion cannot be checked against the key of another algorithm', () => {
  const es = makeAuthenticator('es256');
  const ed = makeAuthenticator('eddsa');
  const reg = verifyRegistration(es.register(CHALLENGE), expected);
  assert.equal(code(() => verifyAssertion(ed.assert(CHALLENGE), { publicKey: reg.publicKey, alg: -8, signCount: 0 }, expected)), 'bad_signature');
  const { publicKey } = generateKeyPairSync('ed25519');
  assert.equal(code(() => verifyAssertion(es.assert(CHALLENGE), { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), alg: -7, signCount: 0 }, expected)), 'bad_signature');
});

test('relying party ids: localhost and domains, never an IP address', () => {
  assert.equal(isValidRpId('localhost'), true);
  assert.equal(isValidRpId('mrm.example.com'), true);
  assert.equal(isValidRpId('127.0.0.1'), false);
  assert.equal(isValidRpId('[::1]'), false);
  assert.equal(isValidRpId('intranet'), false);
});
