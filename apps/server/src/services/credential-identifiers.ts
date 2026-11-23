import type { CredentialKind } from '@kiln/core';

/**
 * The NON-SECRET identifiers of a saved credential, read from its decrypted payload so a person can check which
 * account a credential belongs to (for example which service account or which issuer an app really uses).
 *
 * Only the fields named in `ALLOWED` per kind can ever leave this module: there is no "return everything except".
 * Private keys, API keys and tokens are never allowed. The value shapes are checked as well, so a field that holds
 * something else than an identifier (a key pasted into the wrong place) is dropped instead of shown.
 */
export type CredentialIdentifier = {
  /** A stable id of the field; the web app translates the label from it (`credentials:identifier.<key>`). */
  key: string;
  /** English fallback label. */
  label: string;
  value: string;
  /** The value can be copied (an identifier, as opposed to a descriptive value such as a token type). */
  copyable: boolean;
};

type Spec = { key: string; label: string; field: string; max?: number };

const ALLOWED: Partial<Record<CredentialKind, readonly Spec[]>> = {
  app_store_connect: [
    { key: 'issuerId', label: 'Issuer ID', field: 'issuerId', max: 64 },
    { key: 'keyId', label: 'Key ID', field: 'keyId', max: 32 },
  ],
  google_play: [
    { key: 'clientEmail', label: 'Service account', field: 'client_email', max: 200 },
    { key: 'projectId', label: 'Project ID', field: 'project_id', max: 100 },
    { key: 'serviceKeyId', label: 'Private key ID', field: 'private_key_id', max: 64 },
    { key: 'clientId', label: 'Client ID', field: 'client_id', max: 40 },
  ],
  github_app: [
    { key: 'appId', label: 'App ID', field: 'appId', max: 20 },
    { key: 'installationId', label: 'Installation ID', field: 'installationId', max: 20 },
  ],
  // Apple Ads: the three ids Apple Ads shows after the public key is saved. The private key is never allowed.
  apple_ads: [
    { key: 'clientId', label: 'Client ID', field: 'clientId', max: 80 },
    { key: 'teamId', label: 'Team ID', field: 'teamId', max: 80 },
    { key: 'keyId', label: 'Key ID', field: 'keyId', max: 64 },
  ],
  translate_azure: [{ key: 'region', label: 'Region', field: 'region', max: 40 }],
};

/** Field names that must never reach a response, whatever the kind. Used to reject a value that repeats one. */
const SECRET_FIELDS = [
  'privateKey',
  'private_key',
  'apiKey',
  'api_key',
  'token',
  'secret',
  'client_secret',
  'password',
];

/** One line, no spaces, identifier characters only. */
const IDENTIFIER = /^[A-Za-z0-9@._:/+-]+$/;

const GITHUB_TOKEN_TYPES: readonly [RegExp, string][] = [
  [/^github_pat_/, 'fine_grained'],
  [/^ghp_/, 'classic'],
  [/^gho_/, 'oauth'],
  [/^ghu_/, 'user_to_server'],
  [/^ghs_/, 'installation'],
];

function parseObject(secret: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(secret);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function credentialIdentifiers(kind: string, secret: string): CredentialIdentifier[] {
  if (kind === 'github_token') {
    const token = secret.trim();
    const type = GITHUB_TOKEN_TYPES.find(([pattern]) => pattern.test(token))?.[1];
    // Only the type is derived (from the public prefix); no part of the token itself is returned.
    return type ? [{ key: 'tokenType', label: 'Token type', value: type, copyable: false }] : [];
  }
  const specs = ALLOWED[kind as CredentialKind];
  if (!specs) return [];
  const object = parseObject(secret);
  if (!object) return [];
  const secrets = SECRET_FIELDS.map((f) => object[f]).filter(
    (v): v is string => typeof v === 'string' && v.length >= 8,
  );
  const out: CredentialIdentifier[] = [];
  for (const spec of specs) {
    const raw = object[spec.field];
    const value = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    if (!value || value.length > (spec.max ?? 100) || !IDENTIFIER.test(value)) continue;
    if (secrets.some((s) => s.includes(value) || value.includes(s))) continue;
    out.push({ key: spec.key, label: spec.label, value, copyable: true });
  }
  return out;
}
