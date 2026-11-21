import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords, RFC 6238 on top of RFC 4226: HMAC-SHA-1, 6 digits, a 30 second step. These are the values every
 * authenticator app (Google Authenticator, Authy, 1Password, Aegis, Microsoft Authenticator, Apple Passwords) implements. Pure code: no
 * database, no clock of its own. The store and the replay rule are in two-factor.ts.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** A code from the step before or after the current one is accepted (a clock that is a little off). */
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding (what authenticator apps take). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The bytes of a base32 text (case, spaces, dashes and `=` ignored), or undefined if it holds another character. */
export function base32Decode(text: string): Buffer | undefined {
  const clean = text.toUpperCase().replace(/[\s=-]+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = B32.indexOf(ch);
    if (index < 0) return undefined;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = (): Buffer => randomBytes(TOTP_SECRET_BYTES);

/** RFC 4226 HOTP: the 6 digit code for a counter. */
export function hotp(secret: Uint8Array, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = (mac[mac.length - 1] as number) & 15;
  const binary =
    (((mac[offset] as number) & 127) << 24) |
    (((mac[offset + 1] as number) & 255) << 16) |
    (((mac[offset + 2] as number) & 255) << 8) |
    ((mac[offset + 3] as number) & 255);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** The time step (the HOTP counter) of a moment in epoch milliseconds. */
export const totpStep = (atMs: number): number => Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);

/** The code an authenticator shows at a moment. */
export const totpAt = (secret: Uint8Array, atMs: number): string => hotp(secret, totpStep(atMs));

/** What a person typed, as six digits, or undefined (spaces and a dash in the middle are fine: `123 456`). */
export function normalizeTotpCode(input: string): string | undefined {
  const digits = input.replace(/[\s-]+/g, '');
  return /^\d{6}$/.test(digits) ? digits : undefined;
}

export type TotpCheck =
  | { ok: true; step: number }
  | { ok: false; reason: 'malformed' | 'invalid' | 'replay' };

/**
 * Checks a typed code against the secret at `atMs`, within one step either way. Every candidate step is compared in constant time (no
 * early exit). `lastStep` is the step of the last accepted code: a code that matches only a step at or before it is a REPLAY and is
 * refused, so the same six digits cannot be used twice. The caller stores the returned `step` (with a conditional update, so two
 * requests with one code cannot both win).
 */
export function checkTotp(
  secret: Uint8Array,
  typed: string,
  atMs: number,
  lastStep: number | null,
): TotpCheck {
  const code = normalizeTotpCode(typed);
  if (code === undefined) return { ok: false, reason: 'malformed' };
  const given = Buffer.from(code);
  const current = totpStep(atMs);
  let matched: number | undefined;
  let matchedOld = false;
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const step = current + delta;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, given)) {
      if (lastStep !== null && step <= lastStep) matchedOld = true;
      else if (matched === undefined || step > matched) matched = step;
    }
  }
  if (matched !== undefined) return { ok: true, step: matched };
  return { ok: false, reason: matchedOld ? 'replay' : 'invalid' };
}

/** The `otpauth://` link an authenticator app reads from a QR code (Key URI Format). */
export function otpauthUri(input: { issuer: string; account: string; secret: Uint8Array }): string {
  const issuer = input.issuer.replace(/[:\r\n]+/g, ' ').trim() || 'Kiln';
  const account = input.account.replace(/[:\r\n]+/g, ' ').trim() || 'account';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = `secret=${base32Encode(input.secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
  return `otpauth://totp/${label}?${query}`;
}
