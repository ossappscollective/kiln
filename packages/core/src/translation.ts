/**
 * Review translation: the providers, their credential kinds, the limits and the language tags. Shared
 * by the server (which validates and calls the providers), the connectors (which map a tag to the
 * provider's own code) and the web UI (which builds the Settings form). Plain functions only, no
 * environment APIs, so the web can import it.
 */

export const translationProviders = ['google', 'deepl', 'azure', 'libretranslate'] as const;
export type TranslationProvider = (typeof translationProviders)[number];

export function isTranslationProvider(value: unknown): value is TranslationProvider {
  return typeof value === 'string' && (translationProviders as readonly string[]).includes(value);
}

/** off: nothing is translated, on_demand: a person asks, auto: new reviews are translated after a sync. */
export const translationModes = ['off', 'on_demand', 'auto'] as const;
export type TranslationMode = (typeof translationModes)[number];

export function isTranslationMode(value: unknown): value is TranslationMode {
  return typeof value === 'string' && (translationModes as readonly string[]).includes(value);
}

export type TranslationProviderInfo = {
  label: string;
  /** The vault credential kind that holds this provider's secret. */
  credentialKind:
    | 'translate_google'
    | 'translate_deepl'
    | 'translate_azure'
    | 'translate_libretranslate';
  /** False when the provider can run without a secret (a LibreTranslate instance with no API keys). */
  credentialRequired: boolean;
  /** The workspace needs to give the address of the service (LibreTranslate). */
  needsUrl: boolean;
  /** Who receives the review text. Shown next to the choice: sending it is a privacy decision. */
  privacy: string;
};

export const translationProviderInfo: Record<TranslationProvider, TranslationProviderInfo> = {
  google: {
    label: 'Google Cloud Translation',
    credentialKind: 'translate_google',
    credentialRequired: true,
    needsUrl: false,
    privacy:
      'Review text is sent to Google Cloud. Check Google’s terms for your account before you turn this on.',
  },
  deepl: {
    label: 'DeepL',
    credentialKind: 'translate_deepl',
    credentialRequired: true,
    needsUrl: false,
    privacy:
      'Review text is sent to DeepL. Check DeepL’s terms for your plan (Free or Pro) before you turn this on.',
  },
  azure: {
    label: 'Microsoft Translator (Azure)',
    credentialKind: 'translate_azure',
    credentialRequired: true,
    needsUrl: false,
    privacy:
      'Review text is sent to Microsoft Azure. Check Microsoft’s terms for your resource before you turn this on.',
  },
  libretranslate: {
    label: 'LibreTranslate (your own server or a hosted one)',
    credentialKind: 'translate_libretranslate',
    credentialRequired: false,
    needsUrl: true,
    privacy:
      'Review text is sent to the LibreTranslate server whose address you enter. On your own server it stays with you; on a hosted one it goes to that operator.',
  },
};

export const translationLimits = {
  /** Characters in one text. */
  maxTextChars: 5000,
  /** Texts in one call. */
  maxTexts: 20,
  /** Characters in one call, all texts together. */
  maxRequestChars: 20000,
  /** Reviews in one `reviews/translate` request. */
  maxReviewIds: 25,
  /** Reviews translated automatically after one sync. */
  maxAutoPerSync: 20,
};

// ---------------------------------------------------------------------------------------------
// Language tags

const SUBTAG = /^[A-Za-z0-9]{1,8}$/;

/**
 * A BCP-47 tag in its usual spelling (`en`, `pt-BR`, `zh-Hans`, `sr-Latn-RS`), or undefined when it
 * cannot be one. Accepts `_` for `-` (stores send `pt_BR`). Only the shapes that matter here:
 * a 2 or 3 letter language, an optional 4 letter script, an optional region (2 letters or 3 digits),
 * and nothing else. Extensions, private use and grandfathered tags are refused.
 */
export function normalizeLanguageTag(raw: string): string | undefined {
  const parts = raw.trim().replace(/_/g, '-').split('-');
  if (parts.length === 0 || parts.length > 3) return undefined;
  const language = parts[0] ?? '';
  if (!/^[A-Za-z]{2,3}$/.test(language)) return undefined;
  let script: string | undefined;
  let region: string | undefined;
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    if (!SUBTAG.test(part)) return undefined;
    if (script === undefined && region === undefined && /^[A-Za-z]{4}$/.test(part)) {
      script = part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    } else if (region === undefined && (/^[A-Za-z]{2}$/.test(part) || /^[0-9]{3}$/.test(part))) {
      region = part.toUpperCase();
    } else {
      return undefined;
    }
  }
  return [language.toLowerCase(), script, region]
    .filter((p): p is string => p !== undefined)
    .join('-');
}

/** The language without script or region: `pt-BR` gives `pt`. Empty for something that is not a tag. */
export function baseLanguage(tag: string): string {
  const normalized = normalizeLanguageTag(tag);
  return normalized ? (normalized.split('-')[0] ?? '') : '';
}

/** Whether two tags name the same language, ignoring script and region (`en-GB` and `en` do). */
export function sameLanguage(a: string, b: string): boolean {
  const left = baseLanguage(a);
  return left !== '' && left === baseLanguage(b);
}
