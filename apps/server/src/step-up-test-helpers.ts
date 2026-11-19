import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/** A software authenticator for tests: real keys, real CBOR, real signatures. Not a test file, so the runner skips it. */

type CborIn = number | Buffer | string | boolean | null | CborIn[] | [number | string, CborIn][] | Map<number | string, CborIn>;

const head = (major: number, n: number) => {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
};

export function encodeCbor(v: CborIn): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v === null) return Buffer.from([0xf6]);
  if (v === false) return Buffer.from([0xf4]);
  if (v === true) return Buffer.from([0xf5]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, val]) => [encodeCbor(k), encodeCbor(val)])]);
  return Buffer.concat([head(4, v.length), ...(v as CborIn[]).map(encodeCbor)]);
}

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
export const b64u = (b: Buffer) => b.toString('base64url');

export type Authenticator = ReturnType<typeof makeAuthenticator>;

export function makeAuthenticator(kind: 'es256' | 'eddsa' | 'rs256' = 'es256') {
  const credentialId = randomBytes(32);
  const pair =
    kind === 'es256'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : kind === 'eddsa'
        ? generateKeyPairSync('ed25519')
        : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const cose: Map<number, CborIn> =
    kind === 'es256'
      ? new Map<number, CborIn>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x ?? '', 'base64url')], [-3, Buffer.from(jwk.y ?? '', 'base64url')]])
      : kind === 'eddsa'
        ? new Map<number, CborIn>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x ?? '', 'base64url')]])
        : new Map<number, CborIn>([[1, 3], [3, -257], [-1, Buffer.from(jwk.n ?? '', 'base64url')], [-2, Buffer.from(jwk.e ?? '', 'base64url')]]);

  const authData = (o: { rpId: string; flags: number; counter: number; attested?: boolean }) =>
    Buffer.concat([
      sha256(o.rpId),
      Buffer.from([o.flags]),
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(o.counter);
        return b;
      })(),
      ...(o.attested ? [Buffer.alloc(16), Buffer.from([credentialId.length >> 8, credentialId.length & 255]), credentialId, encodeCbor(cose)] : []),
    ]);

  const clientData = (type: string, challenge: string, origin: string, extra: Record<string, unknown> = {}) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }));

  type Opts = { rpId?: string; origin?: string; flags?: number; counter?: number; type?: string; clientChallenge?: string; fmt?: string };

  return {
    kind,
    credentialId: b64u(credentialId),
    /** What `navigator.credentials.create` returns, as the web client sends it. */
    register(challenge: string, o: Opts = {}) {
      const rpId = o.rpId ?? 'localhost';
      const data = authData({ rpId, flags: o.flags ?? 0x45, counter: o.counter ?? 0, attested: true });
      const att = new Map<string, CborIn>([['fmt', o.fmt ?? 'none'], ['attStmt', new Map()], ['authData', data]]);
      return {
        id: b64u(credentialId),
        clientDataJSON: b64u(clientData(o.type ?? 'webauthn.create', o.clientChallenge ?? challenge, o.origin ?? 'http://localhost')),
        attestationObject: b64u(encodeCbor(att)),
      };
    },
    /** What `navigator.credentials.get` returns. */
    assert(challenge: string, o: Opts & { signWith?: KeyObject } = {}) {
      const rpId = o.rpId ?? 'localhost';
      const data = authData({ rpId, flags: o.flags ?? 0x05, counter: o.counter ?? 1 });
      const cd = clientData(o.type ?? 'webauthn.get', o.clientChallenge ?? challenge, o.origin ?? 'http://localhost');
      const signed = Buffer.concat([data, sha256(cd)]);
      const key = o.signWith ?? pair.privateKey;
      const signature = kind === 'eddsa' ? sign(null, signed, key) : sign('sha256', signed, key);
      return { id: b64u(credentialId), clientDataJSON: b64u(cd), authenticatorData: b64u(data), signature: b64u(signature) };
    },
    privateKey: pair.privateKey,
  };
}
