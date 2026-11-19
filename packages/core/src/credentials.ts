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
  'translate_google',
  'translate_deepl',
  'translate_azure',
  'translate_libretranslate',
  'ai_anthropic',
  'ai_openai',
  'ai_openai_compatible',
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
  /** The value is a secret on its own (an API key): show it masked while typing. */
  secret?: boolean;
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
    fields: [
      { name: 'serviceAccount', label: 'Service account JSON', multiline: true, accept: '.json' },
    ],
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
  translate_google: {
    label: 'Google Cloud Translation API key',
    description: 'An API key for the Cloud Translation API, used to translate customer reviews.',
    fields: [
      {
        name: 'apiKey',
        label: 'API key',
        secret: true,
        hint: 'Restrict the key to the Cloud Translation API in Google Cloud.',
      },
    ],
  },
  translate_deepl: {
    label: 'DeepL API key',
    description: 'An API key for DeepL, used to translate customer reviews.',
    fields: [
      {
        name: 'apiKey',
        label: 'API key',
        secret: true,
        hint: 'A key that ends in :fx is a Free plan key and uses the Free API address.',
      },
    ],
  },
  translate_azure: {
    label: 'Microsoft Translator (Azure) key',
    description: 'A key for an Azure Translator resource, used to translate customer reviews.',
    fields: [
      { name: 'apiKey', label: 'Key', secret: true },
      {
        name: 'region',
        label: 'Region',
        hint: 'Needed for a regional or multi-service resource, for example westeurope. Leave empty for a global resource.',
      },
    ],
  },
  translate_libretranslate: {
    label: 'LibreTranslate API key',
    description:
      'The API key of a LibreTranslate server that requires one. The server address is set under Settings, Translation. A server without API keys needs no credential.',
    fields: [{ name: 'apiKey', label: 'API key', secret: true }],
  },
  ai_anthropic: {
    label: 'Anthropic API key',
    description:
      'An API key for the Anthropic API, used for the AI assistance of a workspace (docs/adr/0016-ai-foundation.md).',
    fields: [
      {
        name: 'apiKey',
        label: 'API key',
        secret: true,
        hint: 'Create a key in the Anthropic Console. Set a spending limit there as well as the monthly token budget here.',
      },
    ],
  },
  ai_openai: {
    label: 'OpenAI API key',
    description: 'An API key for the OpenAI API, used for the AI assistance of a workspace.',
    fields: [
      {
        name: 'apiKey',
        label: 'API key',
        secret: true,
        hint: 'Set a spending limit with OpenAI as well as the monthly token budget here.',
      },
    ],
  },
  ai_openai_compatible: {
    label: 'API key of an OpenAI compatible server',
    description:
      'The API key of an OpenAI compatible server (Ollama, LM Studio, vLLM, a gateway) that requires one. The server address is set under AI settings. A local server without a key needs no credential.',
    fields: [{ name: 'apiKey', label: 'API key', secret: true }],
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
    case 'translate_google':
    case 'translate_deepl':
    case 'translate_libretranslate':
    case 'ai_anthropic':
    case 'ai_openai':
    case 'ai_openai_compatible':
      return JSON.stringify({ apiKey: clean(values.apiKey) });
    case 'translate_azure':
      return JSON.stringify({ apiKey: clean(values.apiKey), region: clean(values.region) });
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
  if (
    kind === 'translate_google' ||
    kind === 'translate_deepl' ||
    kind === 'translate_azure' ||
    kind === 'translate_libretranslate' ||
    kind === 'ai_anthropic' ||
    kind === 'ai_openai' ||
    kind === 'ai_openai_compatible'
  ) {
    const parts = parseObject(secret);
    if (!parts) return 'The secret could not be read.';
    const apiKey = typeof parts.apiKey === 'string' ? parts.apiKey.trim() : '';
    if (!apiKey) return kind === 'translate_azure' ? 'Enter the key.' : 'Enter the API key.';
    if (/\s/.test(apiKey)) return 'A key has no spaces or line breaks.';
    if (kind === 'translate_azure') {
      const region = typeof parts.region === 'string' ? parts.region.trim() : '';
      if (region && !/^[A-Za-z0-9-]{2,40}$/.test(region)) {
        return 'The region is a short name such as westeurope, with no spaces.';
      }
    }
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
    if (!looksLikePrivateKey(object.private_key))
      return 'The private_key in the JSON is not a private key.';
    return undefined;
  }
  const names =
    kind === 'app_store_connect'
      ? ['keyId', 'issuerId', 'privateKey']
      : ['appId', 'installationId', 'privateKey'];
  const labels = credentialKindInfo[kind].fields;
  const absent = missing(object, names).map((n) => labels.find((f) => f.name === n)?.label ?? n);
  if (absent.length) return `Fill in: ${absent.join(', ')}.`;
  if (!looksLikePrivateKey(object.privateKey))
    return 'The private key must be the full file, starting with -----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----.';
  return undefined;
}
