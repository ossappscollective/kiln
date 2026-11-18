import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts secrets (App Store Connect keys, Play service accounts, GitHub App keys,
 * model API keys) with AES-256-GCM before they reach the database.
 *
 * Stored format: v1.<iv>.<tag>.<ciphertext>, each part base64url.
 * `aad` binds a ciphertext to its owner (for example the workspace and credential id),
 * so a row copied to another owner fails to decrypt.
 */

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

/** Parse a base64 master key. Generate one with: openssl rand -base64 32 */
export function parseMasterKey(base64: string): Buffer {
  const key = Buffer.from(base64.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new VaultError(`Master key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer, aad = ''): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, b64(iv), b64(tag), b64(ciphertext)].join('.');
}

export function decryptSecret(stored: string, key: Buffer, aad = ''): string {
  assertKey(key);
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new VaultError('Unrecognized secret format');
  }
  const [, iv, tag, ciphertext] = parts as [string, string, string, string];
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key, wrong owner or tampered data. Do not say which.
    throw new VaultError('Could not decrypt secret');
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new VaultError(`Master key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

function b64(buffer: Buffer): string {
  return buffer.toString('base64url');
}
