import {
  type TranslationMode,
  type TranslationProvider,
  normalizeLanguageTag,
  translationModes,
  translationProviderInfo,
  translationProviders,
} from '@mrm/core';
import { ApiError } from './api.ts';

/** Workspace settings (docs/api/settings.md): the shapes of the API and the logic of the Settings screen. */

export type SettingValue = number | boolean | string;

export type SettingsUsage = { day: string; used: number; budget: number };

export type SettingsResponse = {
  values: Record<string, SettingValue>;
  defaults: Record<string, SettingValue>;
  overridden: string[];
  /** The keys the caller may change. */
  writable: string[];
  docs: Record<string, string>;
  translation: {
    provider: TranslationProvider;
    credentialRequired: boolean;
    credentialConfigured: boolean;
    /** Only for those who may read credentials. */
    credential?: { id: string; label: string };
    usage: SettingsUsage;
  };
};

export type SettingsUpdateResponse = Omit<SettingsResponse, 'translation'> & { changed: string[] };

export type TranslationTestOutcome = {
  ok: boolean;
  message: string;
  provider?: TranslationProvider;
  reason?: string;
};

/** What the form edits. Numbers are text while typing. */
export type SettingsForm = {
  lowRatingThreshold: string;
  enabled: boolean;
  provider: TranslationProvider;
  targetLanguage: string;
  mode: TranslationMode;
  dailyCharBudget: string;
  libreUrl: string;
};

export const KEYS = {
  lowRatingThreshold: 'reviews.lowRatingThreshold',
  enabled: 'translation.enabled',
  provider: 'translation.provider',
  targetLanguage: 'translation.targetLanguage',
  mode: 'translation.mode',
  dailyCharBudget: 'translation.dailyCharBudget',
  libreUrl: 'translation.libretranslate.url',
} as const;

export const MAX_DAILY_CHAR_BUDGET = 100_000_000;

export function formFromSettings(values: Record<string, SettingValue>): SettingsForm {
  return {
    lowRatingThreshold: String(values[KEYS.lowRatingThreshold] ?? 2),
    enabled: values[KEYS.enabled] === true,
    provider: translationProviders.indexOf(values[KEYS.provider] as TranslationProvider) >= 0 ? (values[KEYS.provider] as TranslationProvider) : 'google',
    targetLanguage: String(values[KEYS.targetLanguage] ?? 'en'),
    mode: translationModes.indexOf(values[KEYS.mode] as TranslationMode) >= 0 ? (values[KEYS.mode] as TranslationMode) : 'on_demand',
    dailyCharBudget: String(values[KEYS.dailyCharBudget] ?? 50000),
    libreUrl: String(values[KEYS.libreUrl] ?? ''),
  };
}

export type FormErrors = Partial<Record<keyof SettingsForm, string>>;

const WHOLE = /^[0-9]{1,12}$/;

/** A hint for the address of a LibreTranslate server. The server decides (it also resolves the name); this only catches typos. */
export function checkLibreUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (value === '') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter the full address, for example https://translate.example.com.';
  }
  if (url.username || url.password) return 'Leave the user name and password out of the address. Put the API key under Credentials.';
  if (url.search || url.hash) return 'The address must not have a query string or a fragment.';
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname);
  if (url.protocol === 'http:' && !loopback) return 'Use https. Plain http is only accepted for a server on the same machine.';
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use an https address.';
  return undefined;
}

export function validateForm(form: SettingsForm): FormErrors {
  const errors: FormErrors = {};
  const threshold = form.lowRatingThreshold.trim();
  if (!WHOLE.test(threshold) || Number(threshold) < 1 || Number(threshold) > 4) {
    errors.lowRatingThreshold = 'A whole number from 1 to 4.';
  }
  if (!normalizeLanguageTag(form.targetLanguage)) {
    errors.targetLanguage = 'A language code such as en, de or pt-BR.';
  }
  const budget = form.dailyCharBudget.trim();
  if (!WHOLE.test(budget) || Number(budget) > MAX_DAILY_CHAR_BUDGET) {
    errors.dailyCharBudget = `A whole number from 0 to ${MAX_DAILY_CHAR_BUDGET.toLocaleString('en-US')} (0 means no limit here).`;
  }
  const url = checkLibreUrl(form.libreUrl);
  if (url) errors.libreUrl = url;
  if (form.provider === 'libretranslate' && form.enabled && form.libreUrl.trim() === '') {
    errors.libreUrl = 'LibreTranslate needs the address of a server.';
  }
  return errors;
}

/** The keys that differ from the saved values, as the body of `PUT /settings`. Only keys the caller may write. */
export function settingsChanges(
  saved: Record<string, SettingValue>,
  form: SettingsForm,
  writable: readonly string[],
): Record<string, SettingValue> {
  const next: Record<string, SettingValue> = {
    [KEYS.lowRatingThreshold]: Number(form.lowRatingThreshold),
    [KEYS.enabled]: form.enabled,
    [KEYS.provider]: form.provider,
    [KEYS.targetLanguage]: normalizeLanguageTag(form.targetLanguage) ?? form.targetLanguage.trim(),
    [KEYS.mode]: form.mode,
    [KEYS.dailyCharBudget]: Number(form.dailyCharBudget),
    [KEYS.libreUrl]: form.libreUrl.trim(),
  };
  const out: Record<string, SettingValue> = {};
  for (const key of Object.keys(next)) {
    if (writable.indexOf(key) < 0) continue;
    if (next[key] !== saved[key]) out[key] = next[key] as SettingValue;
  }
  return out;
}

export const isDirty = (saved: Record<string, SettingValue>, form: SettingsForm, writable: readonly string[]): boolean =>
  Object.keys(settingsChanges(saved, form, writable)).length > 0;

export type ProviderChoice = {
  id: TranslationProvider;
  label: string;
  privacy: string;
  credentialKind: string;
  credentialRequired: boolean;
  needsUrl: boolean;
  /** Said next to the picker: the default and what each choice costs in privacy. */
  isDefault: boolean;
};

export const providerChoices: ProviderChoice[] = translationProviders.map((id) => ({
  id,
  label: translationProviderInfo[id].label,
  privacy: translationProviderInfo[id].privacy,
  credentialKind: translationProviderInfo[id].credentialKind,
  credentialRequired: translationProviderInfo[id].credentialRequired,
  needsUrl: translationProviderInfo[id].needsUrl,
  isDefault: id === 'google',
}));

export const modeLabels: Record<TranslationMode, { label: string; help: string }> = {
  off: { label: 'Off', help: 'Nothing is translated, even if translation is enabled.' },
  on_demand: { label: 'On demand', help: 'Someone clicks Translate on a review. Only that review is sent.' },
  auto: {
    label: 'Automatic',
    help: 'New reviews in another language are translated after each sync (at most 20 per sync, within the daily budget). Failures never fail the sync.',
  },
};

/** Common targets for the picker; any other valid code can be typed. */
export const languageChoices: { tag: string; label: string }[] = [
  { tag: 'en', label: 'English' },
  { tag: 'de', label: 'German' },
  { tag: 'fr', label: 'French' },
  { tag: 'es', label: 'Spanish' },
  { tag: 'it', label: 'Italian' },
  { tag: 'pt', label: 'Portuguese' },
  { tag: 'pt-BR', label: 'Portuguese (Brazil)' },
  { tag: 'nl', label: 'Dutch' },
  { tag: 'sv', label: 'Swedish' },
  { tag: 'da', label: 'Danish' },
  { tag: 'nb', label: 'Norwegian' },
  { tag: 'fi', label: 'Finnish' },
  { tag: 'pl', label: 'Polish' },
  { tag: 'cs', label: 'Czech' },
  { tag: 'tr', label: 'Turkish' },
  { tag: 'ru', label: 'Russian' },
  { tag: 'uk', label: 'Ukrainian' },
  { tag: 'ar', label: 'Arabic' },
  { tag: 'hi', label: 'Hindi' },
  { tag: 'ja', label: 'Japanese' },
  { tag: 'ko', label: 'Korean' },
  { tag: 'zh-Hans', label: 'Chinese (Simplified)' },
  { tag: 'zh-Hant', label: 'Chinese (Traditional)' },
];

/** "German", or the code itself when it is not in the list. */
export function languageName(tag: string | null | undefined): string {
  if (!tag) return 'another language';
  const normalized = normalizeLanguageTag(tag) ?? tag;
  for (const choice of languageChoices) if (choice.tag === normalized) return choice.label;
  const base = normalized.split('-')[0] ?? normalized;
  for (const choice of languageChoices) if (choice.tag === base) return choice.label;
  return normalized;
}

/** "12,300 of 50,000 characters used today (UTC)", or the unlimited form. */
export function usageText(usage: SettingsUsage): string {
  const used = usage.used.toLocaleString('en-US');
  if (usage.budget === 0) return `${used} characters used today (UTC). There is no daily limit here.`;
  const percent = Math.min(100, Math.round((usage.used / usage.budget) * 100));
  return `${used} of ${usage.budget.toLocaleString('en-US')} characters used today (UTC), ${percent}%.`;
}

/** 0 to 1 for a meter, or null when there is no limit. */
export function usageFraction(usage: SettingsUsage): number | null {
  if (usage.budget === 0) return null;
  return Math.max(0, Math.min(1, usage.used / usage.budget));
}

/** Which of the form's fields the caller may edit. A key not in `writable` is read-only. */
export const canEdit = (writable: readonly string[], key: string): boolean => writable.indexOf(key) >= 0;

export function settingsErrorMessage(error: unknown, action: 'load' | 'save' | 'test' = 'load'): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  const issues = Array.isArray(error.body.issues) ? (error.body.issues as { path?: string; message?: string }[]) : [];
  switch (error.code) {
    case 'forbidden':
      return action === 'load' ? 'Your role does not include workspace settings.' : 'Only an owner or an admin can change settings.';
    case 'not_found':
      return 'This workspace no longer exists.';
    case 'invalid_setting':
    case 'unknown_setting': {
      const first = issues[0];
      return first?.message ? `${first.path ? `${first.path}: ` : ''}${first.message}` : error.message;
    }
    case 'rate_limited':
      return error.message;
    default:
      return action === 'save' ? 'The settings could not be saved. Try again.' : error.message || 'Something went wrong. Try again.';
  }
}

/** The outcome of "Test", as a sentence for a person. Messages from the server are fixed sentences. */
export function testOutcomeText(outcome: TranslationTestOutcome): string {
  if (outcome.ok) return 'The provider translated a test word. Saved settings and key work.';
  return outcome.message;
}

// ---------------------------------------------------------------------------------------------
// The translation settings the review screens need (cached, so a page of cards asks once).

export type TranslationConfig = { enabled: boolean; mode: TranslationMode; target: string; provider: TranslationProvider };

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<TranslationConfig | null> }>();

/**
 * The translation settings of a workspace, or null when the caller may not read settings. One request
 * is shared by every review card on the page and kept for 30 seconds; the Settings screen drops it on save.
 */
export function loadTranslationConfig(
  api: { workspaceSettings(workspaceId: string): Promise<SettingsResponse> },
  workspaceId: string,
  now: number = Date.now(),
): Promise<TranslationConfig | null> {
  const hit = cache.get(workspaceId);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = api.workspaceSettings(workspaceId).then(
    (s) => ({
      enabled: s.values[KEYS.enabled] === true,
      mode: (s.values[KEYS.mode] as TranslationMode) ?? 'on_demand',
      target: String(s.values[KEYS.targetLanguage] ?? 'en'),
      provider: (s.values[KEYS.provider] as TranslationProvider) ?? 'google',
    }),
    () => null,
  );
  cache.set(workspaceId, { at: now, value });
  return value;
}

export function forgetTranslationConfig(workspaceId?: string): void {
  if (workspaceId === undefined) cache.clear();
  else cache.delete(workspaceId);
}
