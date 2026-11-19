import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * scrypt, from node:crypto, so there is no native dependency. The parameters are stored in
 * the hash, so raising the cost later does not lock anyone out.
 * Format: scrypt$N$r$p$salt$hash (salt and hash in base64url).
 */
export type ScryptCost = { N: number; r: number; p: number };

// 2^15 x 8 x 1 uses about 32 MiB per hash and takes tens of milliseconds.
export const defaultCost: ScryptCost = { N: 32768, r: 8, p: 1 };

const KEY_LENGTH = 32;
const maxmemFor = ({ N, r }: ScryptCost) => 128 * N * r * 2;

function derive(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { N: cost.N, r: cost.r, p: cost.p, maxmem: maxmemFor(cost) },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(
  password: string,
  cost: ScryptCost = defaultCost,
): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, cost);
  return [
    'scrypt',
    cost.N,
    cost.r,
    cost.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !N || !r || !p || !salt || !hash) return false;
  const cost = { N: Number(N), r: Number(r), p: Number(p) };
  if (![cost.N, cost.r, cost.p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), cost);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
