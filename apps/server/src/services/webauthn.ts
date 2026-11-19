import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

/**
 * WebAuthn (level 2) verification with node:crypto only: a minimal CBOR decoder, the authenticator
 * data parser, COSE keys for ES256 (-7, P-256) and EdDSA (-8, Ed25519), and the checks of a
 * registration (attestation `none`) and of an assertion. No library, so nothing here is a
 * dependency to audit; the price is that only what is listed is supported, and everything else is
 * refused (docs/adr/0019-step-up-confirmation.md).
 *
 * Pure: no database, no clock, no request. The caller owns challenges, origins and counter storage.
 */

export const COSE_ES256 = -7;
export const COSE_EDDSA = -8;
export const SUPPORTED_ALGS: readonly number[] = [COSE_ES256, COSE_EDDSA];

export class WebAuthnError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
const fail = (code: string, message: string): never => {
  throw new WebAuthnError(code, message);
};

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
export const fromB64u = (value: string): Buffer => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) return fail('bad_encoding', 'Not base64url.');
  return Buffer.from(value, 'base64url');
};

// ---------------------------------------------------------------------------------------------
// CBOR: unsigned and negative integers, byte and text strings, arrays, maps, false/true/null.
// Anything else (tags, floats, indefinite lengths, undefined) is refused.

export type Cbor = number | Buffer | string | boolean | null | Cbor[] | Map<number | string, Cbor>;

const MAX_DEPTH = 8;
const MAX_ITEMS = 256;

function readArgument(buf: Buffer, at: number, info: number): { value: number; next: number } {
  if (info < 24) return { value: info, next: at };
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
  if (size === 0) return fail('cbor_unsupported', 'Unsupported CBOR length.');
  if (at + size > buf.length) return fail('cbor_truncated', 'CBOR ends early.');
  const value = size === 1 ? buf.readUInt8(at) : size === 2 ? buf.readUInt16BE(at) : buf.readUInt32BE(at);
  return { value, next: at + size };
}

/** Decodes one item at `offset`. Returns the item and the offset after it. */
export function decodeCbor(buf: Buffer, offset = 0, depth = 0): { value: Cbor; next: number } {
  if (depth > MAX_DEPTH) return fail('cbor_too_deep', 'CBOR is nested too deeply.');
  if (offset >= buf.length) return fail('cbor_truncated', 'CBOR ends early.');
  const head = buf.readUInt8(offset);
  const major = head >> 5;
  const info = head & 0x1f;
  let at = offset + 1;
  if (major === 7) {
    if (info === 20) return { value: false, next: at };
    if (info === 21) return { value: true, next: at };
    if (info === 22) return { value: null, next: at };
    return fail('cbor_unsupported', 'Unsupported CBOR simple value.');
  }
  if (major === 6) return fail('cbor_unsupported', 'CBOR tags are not supported.');
  if (info === 31) return fail('cbor_unsupported', 'Indefinite CBOR lengths are not supported.');
  const arg = readArgument(buf, at, info);
  at = arg.next;
  const n = arg.value;
  switch (major) {
    case 0:
      return { value: n, next: at };
    case 1:
      return { value: -1 - n, next: at };
    case 2:
    case 3: {
      if (at + n > buf.length) return fail('cbor_truncated', 'CBOR ends early.');
      const slice = buf.subarray(at, at + n);
      return { value: major === 2 ? Buffer.from(slice) : slice.toString('utf8'), next: at + n };
    }
    case 4: {
      if (n > MAX_ITEMS) return fail('cbor_too_large', 'CBOR array is too long.');
      const items: Cbor[] = [];
      for (let i = 0; i < n; i++) {
        const item = decodeCbor(buf, at, depth + 1);
        items.push(item.value);
        at = item.next;
      }
      return { value: items, next: at };
    }
    default: {
      if (n > MAX_ITEMS) return fail('cbor_too_large', 'CBOR map is too large.');
      const map = new Map<number | string, Cbor>();
      for (let i = 0; i < n; i++) {
        const key = decodeCbor(buf, at, depth + 1);
        if (typeof key.value !== 'number' && typeof key.value !== 'string') return fail('cbor_unsupported', 'Unsupported CBOR map key.');
        if (map.has(key.value)) return fail('cbor_duplicate_key', 'Duplicate CBOR map key.');
        const val = decodeCbor(buf, key.next, depth + 1);
        map.set(key.value, val.value);
        at = val.next;
      }
      return { value: map, next: at };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Authenticator data

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;

export type AuthData = {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  attested?: { aaguid: Buffer; credentialId: Buffer; cose: Map<number | string, Cbor> };
};

export function parseAuthData(data: Buffer): AuthData {
  if (data.length < 37) return fail('bad_auth_data', 'Authenticator data is too short.');
  const out: AuthData = { rpIdHash: data.subarray(0, 32), flags: data.readUInt8(32), signCount: data.readUInt32BE(33) };
  if (out.flags & FLAG_AT) {
    if (data.length < 55) return fail('bad_auth_data', 'Attested credential data is too short.');
    const aaguid = data.subarray(37, 53);
    const idLength = data.readUInt16BE(53);
    if (idLength < 16 || idLength > 1023 || 55 + idLength > data.length) return fail('bad_auth_data', 'Credential id has a bad length.');
    const credentialId = Buffer.from(data.subarray(55, 55 + idLength));
    const key = decodeCbor(data, 55 + idLength);
    if (!(key.value instanceof Map)) return fail('bad_auth_data', 'The credential public key is not a COSE map.');
    out.attested = { aaguid: Buffer.from(aaguid), credentialId, cose: key.value };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// COSE keys -> SPKI DER

/** Turns an ES256 or EdDSA COSE key into SPKI DER (base64url) and its algorithm. Refuses anything else. */
export function coseToSpki(cose: Map<number | string, Cbor>): { alg: number; spki: string } {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const crv = cose.get(-1);
  const x = cose.get(-2);
  try {
    if (kty === 2 && alg === COSE_ES256 && crv === 1) {
      const y = cose.get(-3);
      if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) return fail('bad_key', 'Bad P-256 key.');
      const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) }, format: 'jwk' });
      return { alg: COSE_ES256, spki: b64u(key.export({ type: 'spki', format: 'der' })) };
    }
    if (kty === 1 && alg === COSE_EDDSA && crv === 6) {
      if (!Buffer.isBuffer(x) || x.length !== 32) return fail('bad_key', 'Bad Ed25519 key.');
      const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(x) }, format: 'jwk' });
      return { alg: COSE_EDDSA, spki: b64u(key.export({ type: 'spki', format: 'der' })) };
    }
  } catch (error) {
    if (error instanceof WebAuthnError) throw error;
    return fail('bad_key', 'The public key is not valid.');
  }
  return fail('unsupported_algorithm', 'Only ES256 (P-256) and EdDSA (Ed25519) keys are supported.');
}

// ---------------------------------------------------------------------------------------------
// Client data

export type Expected = {
  /** The challenge the server issued, base64url. */
  challenge: string;
  /** Every origin the page may have: normally one. */
  origins: readonly string[];
  rpId: string;
};

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function checkClientData(raw: Buffer, type: 'webauthn.create' | 'webauthn.get', expected: Expected): void {
  let data: unknown;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    return fail('bad_client_data', 'clientDataJSON is not JSON.');
  }
  if (typeof data !== 'object' || data === null) return fail('bad_client_data', 'clientDataJSON is not an object.');
  const d = data as Record<string, unknown>;
  if (d.type !== type) return fail('bad_type', 'The ceremony type is wrong.');
  if (typeof d.challenge !== 'string' || !sameText(d.challenge, expected.challenge)) return fail('bad_challenge', 'The challenge does not match.');
  if (typeof d.origin !== 'string' || !expected.origins.includes(d.origin)) return fail('bad_origin', 'The origin is not this server.');
  if (d.crossOrigin === true) return fail('bad_origin', 'Cross-origin ceremonies are refused.');
}

function checkAuthFlags(auth: AuthData, expected: Expected): void {
  if (!timingSafeEqual(auth.rpIdHash, sha256(expected.rpId))) return fail('bad_rp_id', 'The relying party id does not match.');
  if (!(auth.flags & FLAG_UP)) return fail('user_not_present', 'User presence was not confirmed.');
  if (!(auth.flags & FLAG_UV)) return fail('user_not_verified', 'User verification (biometric or PIN) was not performed.');
}

// ---------------------------------------------------------------------------------------------
// Registration (attestation `none` only)

export type Registration = { credentialId: string; publicKey: string; alg: number; signCount: number };

export function verifyRegistration(input: { clientDataJSON: string; attestationObject: string }, expected: Expected): Registration {
  checkClientData(fromB64u(input.clientDataJSON), 'webauthn.create', expected);
  const att = decodeCbor(fromB64u(input.attestationObject)).value;
  if (!(att instanceof Map)) return fail('bad_attestation', 'The attestation object is not a map.');
  if (att.get('fmt') !== 'none') return fail('unsupported_attestation', 'Only attestation "none" is accepted.');
  const stmt = att.get('attStmt');
  if (!(stmt instanceof Map) || stmt.size !== 0) return fail('bad_attestation', 'The attestation statement must be empty.');
  const authData = att.get('authData');
  if (!Buffer.isBuffer(authData)) return fail('bad_attestation', 'No authenticator data.');
  const auth = parseAuthData(authData);
  checkAuthFlags(auth, expected);
  if (!auth.attested) return fail('no_credential', 'No credential in the authenticator data.');
  const key = coseToSpki(auth.attested.cose);
  return { credentialId: b64u(auth.attested.credentialId), publicKey: key.spki, alg: key.alg, signCount: auth.signCount };
}

// ---------------------------------------------------------------------------------------------
// Assertion

export type StoredKey = { publicKey: string; alg: number; signCount: number };

export function verifyAssertion(
  input: { clientDataJSON: string; authenticatorData: string; signature: string },
  stored: StoredKey,
  expected: Expected,
): { signCount: number } {
  const clientData = fromB64u(input.clientDataJSON);
  checkClientData(clientData, 'webauthn.get', expected);
  const authBytes = fromB64u(input.authenticatorData);
  const auth = parseAuthData(authBytes);
  checkAuthFlags(auth, expected);
  const signed = Buffer.concat([authBytes, sha256(clientData)]);
  let ok = false;
  try {
    const key = createPublicKey({ key: fromB64u(stored.publicKey), format: 'der', type: 'spki' });
    const signature = fromB64u(input.signature);
    if (stored.alg === COSE_ES256) ok = cryptoVerify('sha256', signed, key, signature);
    else if (stored.alg === COSE_EDDSA) ok = cryptoVerify(null, signed, key, signature);
  } catch {
    ok = false;
  }
  if (!ok) return fail('bad_signature', 'The signature is not valid.');
  // A counter that does not go up means a cloned authenticator. Many platform passkeys always send 0:
  // then both are 0 and there is nothing to compare.
  if ((stored.signCount > 0 || auth.signCount > 0) && auth.signCount <= stored.signCount) {
    return fail('counter_rollback', 'The signature counter did not increase.');
  }
  return { signCount: auth.signCount };
}

/** Whether `host` can be a relying party id: a domain name or localhost, never an IP address. */
export function isValidRpId(host: string): boolean {
  if (host === 'localhost') return true;
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host);
}
