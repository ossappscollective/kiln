/**
 * The kinds of secret the tool stores and what each looks like. Shared by the API (which
 * refuses a malformed secret) and the UI (which builds the form and assembles the secret).
 *
 * A stored secret is always one string. Kinds with several parts store a JSON object.
 */
export const credentialKinds = [
  'app_store_connect',
  'google_play',
  'github_app',
  'github_token',
] as const;
export type CredentialKind = (typeof credentialKinds)[number];

export function isCredentialKind(value: unknown): value is CredentialKind {
  return typeof value === 'string' && (credentialKinds as readonly string[]).includes(value);
}

export type CredentialField = {
  name: string;
  label: string;
  /** Show a text area, and offer to load the value from a file. */
  multiline?: boolean;
  /** File types to offer when loading from a file, e.g. ".p8". */
  accept?: string;
  hint?: string;
};

export type CredentialKindInfo = {
  label: string;
  description: string;
  fields: CredentialField[];
};

export const credentialKindInfo: Record<CredentialKind, CredentialKindInfo> = {
  app_store_connect: {
    label: 'App Store Connect API key',
    description: 'A team key from App Store Connect, under Users and Access, Integrations.',
    fields: [
      { name: 'keyId', label: 'Key ID', hint: 'Ten characters, shown next to the key.' },
      { name: 'issuerId', label: 'Issuer ID', hint: 'A UUID shown at the top of the Keys page.' },
      { name: 'privateKey', label: 'Private key (.p8)', multiline: true, accept: '.p8,.pem,.txt' },
    ],
  },
  google_play: {
    label: 'Google Play service account',
    description: 'The JSON key of a service account that has been invited in Play Console.',
    fields: [{ name: 'serviceAccount', label: 'Service account JSON', multiline: true, accept: '.json' }],
  },
  github_app: {
    label: 'GitHub App installation',
    description: 'An app installed on the organization or account that owns your repositories.',
    fields: [
      { name: 'appId', label: 'App ID' },
      { name: 'installationId', label: 'Installation ID' },
      { name: 'privateKey', label: 'Private key (.pem)', multiline: true, accept: '.pem,.txt' },
    ],
  },
  github_token: {
    label: 'GitHub personal access token',
    description: 'For trying things out. Prefer a GitHub App for a team.',
    fields: [{ name: 'token', label: 'Token' }],
  },
};

const clean = (value: string | undefined) => (value ?? '').trim();

/** Turns the form values into the single string that is stored. Does not validate. */
export function buildSecret(kind: CredentialKind, values: Record<string, string>): string {
  switch (kind) {
    case 'app_store_connect':
      return JSON.stringify({
        keyId: clean(values.keyId),
        issuerId: clean(values.issuerId),
        privateKey: clean(values.privateKey),
      });
    case 'github_app':
      return JSON.stringify({
        appId: clean(values.appId),
        installationId: clean(values.installationId),
        privateKey: clean(values.privateKey),
      });
    case 'google_play':
      return clean(values.serviceAccount);
    case 'github_token':
      return clean(values.token);
  }
}

const looksLikePrivateKey = (value: unknown) =>
  typeof value === 'string' && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);

function parseObject(secret: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(secret);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const missing = (object: Record<string, unknown>, names: string[]) =>
  names.filter((n) => typeof object[n] !== 'string' || (object[n] as string).trim() === '');

/** A message for a person when the secret cannot be right, or undefined when it looks usable. */
export function checkSecret(kind: CredentialKind, secret: string): string | undefined {
  if (kind === 'github_token') {
    if (!secret.trim()) return 'Enter the token.';
    if (/\s/.test(secret.trim())) return 'A token has no spaces or line breaks.';
    return undefined;
  }
  const object = parseObject(secret);
  if (!object) {
    return kind === 'google_play'
      ? 'That is not valid JSON. Paste the whole service account key file.'
      : 'The secret could not be read.';
  }
  if (kind === 'google_play') {
    const absent = missing(object, ['client_email', 'private_key']);
    if (absent.length) return `The service account JSON is missing ${absent.join(' and ')}.`;
    if (!looksLikePrivateKey(object.private_key)) return 'The private_key in the JSON is not a private key.';
    return undefined;
  }
  const names = kind === 'app_store_connect' ? ['keyId', 'issuerId', 'privateKey'] : ['appId', 'installationId', 'privateKey'];
  const labels = credentialKindInfo[kind].fields;
  const absent = missing(object, names).map((n) => labels.find((f) => f.name === n)?.label ?? n);
  if (absent.length) return `Fill in: ${absent.join(', ')}.`;
  if (!looksLikePrivateKey(object.privateKey)) return 'The private key must be the full file, starting with -----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----.';
  return undefined;
}
