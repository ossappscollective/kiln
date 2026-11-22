import {
  normalizeBucketId,
  normalizeLanguageTag,
  normalizeVendorNumber,
  type TranslationMode,
  type TranslationProvider,
  translationModes,
  translationProviderInfo,
  translationProviders,
} from '@kiln/core';
import { ApiError } from './api.ts';
import { timeAgo } from './format.ts';
import { formatDisplayName, formatNumber, formatPercent } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';

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
  /** The scheduled refresh of the stores, as this workspace stands (absent on an older server). */
  sync?: SyncStatus;
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

/** `sync` of `GET /settings` (docs/api/settings.md). */
export type SyncStatus = {
  /** KILN_SYNC_INTERVAL_MINUTES: 0 turns scheduled refreshes off for every workspace. */
  serverMinutes: number;
  enabled: boolean;
  /** What applies: the workspace's choice, else the server's interval. */
  intervalMinutes: number;
  /** Whether a scheduled refresh runs for this workspace at all. */
  running: boolean;
  off?: 'server_off' | 'workspace_off';
  /** Epoch milliseconds of the last scheduled sync of any app, or null. */
  lastScheduledAt: number | null;
};

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
  /** Hours a release may stand still before it is stalled; 0 is off. */
  stalledAfterHours: string;
  /** Hours until the same stall is reminded again; 0 is once. */
  stalledRepeatHours: string;
  /** Hours an unanswered review may wait before a reminder digest; 0 is off. */
  unansweredReminderHours: string;
  /** The highest rating the unanswered digest counts, 1 to 5. */
  unansweredMaxRating: string;
  /** Analytics is read from the stores (off by default; needs analytics.manage to change). */
  analyticsEnabled: boolean;
  /** The Apple vendor number (5 to 12 digits) for Sales and Trends; empty means none. */
  analyticsVendorNumber: string;
  /** The Cloud Storage bucket of the Play Console reports (`pubsite_prod_rev_` and digits); empty means none. */
  analyticsBucketId: string;
  /** The scheduled refresh of the stores is on (default). */
  syncEnabled: boolean;
  /** Minutes between two refreshes of one app, as text (a choice of the list, or the server's own value). */
  syncIntervalMinutes: string;
};

export const KEYS = {
  lowRatingThreshold: 'reviews.lowRatingThreshold',
  enabled: 'translation.enabled',
  provider: 'translation.provider',
  targetLanguage: 'translation.targetLanguage',
  mode: 'translation.mode',
  dailyCharBudget: 'translation.dailyCharBudget',
  libreUrl: 'translation.libretranslate.url',
  stalledAfterHours: 'release.stalledAfterHours',
  stalledRepeatHours: 'release.stalledRepeatHours',
  unansweredReminderHours: 'reviews.unansweredReminderHours',
  unansweredMaxRating: 'reviews.unansweredMaxRating',
  analyticsEnabled: 'analytics.enabled',
  analyticsVendorNumber: 'analytics.appleVendorNumber',
  analyticsBucketId: 'analytics.playBucketId',
  syncEnabled: 'sync.enabled',
  syncIntervalMinutes: 'sync.intervalMinutes',
} as const;

/** The intervals Settings offers, in minutes (the API accepts 5 to 10080). */
export const SYNC_INTERVAL_CHOICES = [15, 30, 60, 360, 1440] as const;
export const MIN_SYNC_MINUTES = 5;
export const MAX_SYNC_MINUTES = 10_080;

/** "15 minutes", "1 hour", "6 hours", "Daily"; any other number is said in the largest whole unit. */
export function syncIntervalLabel(minutes: number): string {
  if (minutes === 1440) return t('settings:interval.daily');
  if (minutes % 1440 === 0) return t('settings:interval.days', { count: minutes / 1440 });
  if (minutes % 60 === 0) return t('settings:interval.hours', { count: minutes / 60 });
  return t('settings:interval.minutes', { count: minutes });
}

/** "Every 15 minutes", "Every day", "Every 6 hours": the option of the picker, written as one message per unit. */
export function syncIntervalEveryLabel(minutes: number): string {
  if (minutes === 1440) return t('settings:interval.everyDay');
  if (minutes % 1440 === 0) return t('settings:interval.everyDays', { count: minutes / 1440 });
  if (minutes % 60 === 0) return t('settings:interval.everyHours', { count: minutes / 60 });
  return t('settings:interval.everyMinutes', { count: minutes });
}

/** The choices for the picker: the standard ones, plus the current value when it is none of them (a server interval of 45 minutes). */
export function syncIntervalOptions(current: number): { value: number; label: string }[] {
  const all: number[] = [...SYNC_INTERVAL_CHOICES];
  if (
    Number.isInteger(current) &&
    current >= MIN_SYNC_MINUTES &&
    current <= MAX_SYNC_MINUTES &&
    all.indexOf(current) < 0
  ) {
    all.push(current);
    all.sort((a, b) => a - b);
  }
  return all.map((value) => ({ value, label: syncIntervalLabel(value) }));
}

/** What the card says about the last scheduled refresh: when it ran, or that none ran yet. */
export function lastRefreshText(sync: SyncStatus | undefined, now: number = Date.now()): string {
  if (!sync) return '';
  if (sync.lastScheduledAt === null) return t('settings:lastRefresh.never');
  return t('settings:lastRefresh.ran', { when: timeAgo(sync.lastScheduledAt, now) });
}

/** Why no refresh runs, or '' when one does. */
export function syncOffText(sync: SyncStatus | undefined): string {
  if (!sync || sync.running) return '';
  if (sync.off === 'server_off') return t('settings:syncOff.server');
  return t('settings:syncOff.workspace');
}

/** The most hours a release or reminder setting takes (docs/api/settings.md). */
export const MAX_HOURS = 720;

export const MAX_DAILY_CHAR_BUDGET = 100_000_000;

export function formFromSettings(values: Record<string, SettingValue>): SettingsForm {
  return {
    lowRatingThreshold: String(values[KEYS.lowRatingThreshold] ?? 2),
    enabled: values[KEYS.enabled] === true,
    provider:
      translationProviders.indexOf(values[KEYS.provider] as TranslationProvider) >= 0
        ? (values[KEYS.provider] as TranslationProvider)
        : 'google',
    targetLanguage: String(values[KEYS.targetLanguage] ?? 'en'),
    mode:
      translationModes.indexOf(values[KEYS.mode] as TranslationMode) >= 0
        ? (values[KEYS.mode] as TranslationMode)
        : 'on_demand',
    dailyCharBudget: String(values[KEYS.dailyCharBudget] ?? 50000),
    libreUrl: String(values[KEYS.libreUrl] ?? ''),
    stalledAfterHours: String(values[KEYS.stalledAfterHours] ?? 6),
    stalledRepeatHours: String(values[KEYS.stalledRepeatHours] ?? 24),
    unansweredReminderHours: String(values[KEYS.unansweredReminderHours] ?? 0),
    unansweredMaxRating: String(values[KEYS.unansweredMaxRating] ?? 5),
    analyticsEnabled: values[KEYS.analyticsEnabled] === true,
    analyticsVendorNumber: String(values[KEYS.analyticsVendorNumber] ?? ''),
    analyticsBucketId: String(values[KEYS.analyticsBucketId] ?? ''),
    syncEnabled: values[KEYS.syncEnabled] !== false,
    syncIntervalMinutes: String(values[KEYS.syncIntervalMinutes] ?? 30),
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
    return t('settings:libreUrl.fullAddress');
  }
  if (url.username || url.password)
    return t('settings:libreUrl.noCredentials');
  if (url.search || url.hash) return t('settings:libreUrl.noQuery');
  const loopback =
    url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname);
  if (url.protocol === 'http:' && !loopback)
    return t('settings:libreUrl.useHttps');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return t('settings:libreUrl.useHttpsAddress');
  return undefined;
}

export function validateForm(form: SettingsForm): FormErrors {
  const errors: FormErrors = {};
  const threshold = form.lowRatingThreshold.trim();
  if (!WHOLE.test(threshold) || Number(threshold) < 1 || Number(threshold) > 4) {
    errors.lowRatingThreshold = t('settings:form.lowRating');
  }
  if (!normalizeLanguageTag(form.targetLanguage)) {
    errors.targetLanguage = t('settings:form.targetLanguage');
  }
  const budget = form.dailyCharBudget.trim();
  if (!WHOLE.test(budget) || Number(budget) > MAX_DAILY_CHAR_BUDGET) {
    errors.dailyCharBudget = t('settings:form.dailyCharBudget', { max: formatNumber(MAX_DAILY_CHAR_BUDGET) });
  }
  const hours = (text: string): boolean =>
    WHOLE.test(text.trim()) && Number(text.trim()) <= MAX_HOURS;
  if (!hours(form.stalledAfterHours))
    errors.stalledAfterHours = t('settings:form.stalledAfterHours', { max: formatNumber(MAX_HOURS) });
  if (!hours(form.stalledRepeatHours))
    errors.stalledRepeatHours = t('settings:form.stalledRepeatHours', { max: formatNumber(MAX_HOURS) });
  if (!hours(form.unansweredReminderHours))
    errors.unansweredReminderHours = t('settings:form.unansweredReminderHours', { max: formatNumber(MAX_HOURS) });
  const top = form.unansweredMaxRating.trim();
  if (!WHOLE.test(top) || Number(top) < 1 || Number(top) > 5)
    errors.unansweredMaxRating = t('settings:form.unansweredMaxRating');
  if (
    form.analyticsVendorNumber.trim() !== '' &&
    !normalizeVendorNumber(form.analyticsVendorNumber)
  ) {
    errors.analyticsVendorNumber = t('settings:form.vendorNumber');
  }
  if (form.analyticsBucketId.trim() !== '' && !normalizeBucketId(form.analyticsBucketId)) {
    errors.analyticsBucketId = t('settings:form.bucketId');
  }
  const every = form.syncIntervalMinutes.trim();
  if (!WHOLE.test(every) || Number(every) < MIN_SYNC_MINUTES || Number(every) > MAX_SYNC_MINUTES)
    errors.syncIntervalMinutes = t('settings:form.syncInterval', {
      min: formatNumber(MIN_SYNC_MINUTES),
      max: formatNumber(MAX_SYNC_MINUTES),
    });
  const url = checkLibreUrl(form.libreUrl);
  if (url) errors.libreUrl = url;
  if (form.provider === 'libretranslate' && form.enabled && form.libreUrl.trim() === '') {
    errors.libreUrl = t('settings:form.libreNeedsUrl');
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
    [KEYS.stalledAfterHours]: Number(form.stalledAfterHours),
    [KEYS.stalledRepeatHours]: Number(form.stalledRepeatHours),
    [KEYS.unansweredReminderHours]: Number(form.unansweredReminderHours),
    [KEYS.unansweredMaxRating]: Number(form.unansweredMaxRating),
    [KEYS.analyticsEnabled]: form.analyticsEnabled,
    [KEYS.analyticsVendorNumber]:
      normalizeVendorNumber(form.analyticsVendorNumber) ?? form.analyticsVendorNumber.trim(),
    [KEYS.analyticsBucketId]:
      normalizeBucketId(form.analyticsBucketId) ?? form.analyticsBucketId.trim(),
    [KEYS.syncEnabled]: form.syncEnabled,
    [KEYS.syncIntervalMinutes]: Number(form.syncIntervalMinutes),
  };
  const out: Record<string, SettingValue> = {};
  for (const key of Object.keys(next)) {
    if (writable.indexOf(key) < 0) continue;
    if (next[key] !== saved[key]) out[key] = next[key] as SettingValue;
  }
  return out;
}

export const isDirty = (
  saved: Record<string, SettingValue>,
  form: SettingsForm,
  writable: readonly string[],
): boolean => Object.keys(settingsChanges(saved, form, writable)).length > 0;

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

/** The privacy sentence of each provider as a message key (the English text is the one of `translationProviderInfo`). */
const PRIVACY_KEYS: Record<TranslationProvider, string> = {
  google: k('settings:provider.privacy.google'),
  deepl: k('settings:provider.privacy.deepl'),
  azure: k('settings:provider.privacy.azure'),
  libretranslate: k('settings:provider.privacy.libretranslate'),
};

/** The privacy sentence of a provider, in the language of the app. */
export const providerPrivacy = (id: TranslationProvider): string => {
  const key = PRIVACY_KEYS[id];
  return key ? t(key) : translationProviderInfo[id].privacy;
};

export const providerChoices: ProviderChoice[] = translationProviders.map((id) => ({
  id,
  label: translationProviderInfo[id].label,
  /** The English text from the core package: the screen shows `providerPrivacy(id)`. */
  privacy: translationProviderInfo[id].privacy,
  credentialKind: translationProviderInfo[id].credentialKind,
  credentialRequired: translationProviderInfo[id].credentialRequired,
  needsUrl: translationProviderInfo[id].needsUrl,
  isDefault: id === 'google',
}));

/** Message keys of the label and the help of each mode: the screen translates them where it draws them. */
export const modeLabels: Record<TranslationMode, { label: string; help: string }> = {
  off: { label: k('settings:mode.off.label'), help: k('settings:mode.off.help') },
  on_demand: { label: k('settings:mode.onDemand.label'), help: k('settings:mode.onDemand.help') },
  auto: { label: k('settings:mode.auto.label'), help: k('settings:mode.auto.help') },
};

/** Common targets for the picker (language codes); any other valid code can be typed. The name is written in the language of the app. */
export const languageChoices: { tag: string }[] = [
  'en', 'de', 'fr', 'es', 'it', 'pt', 'pt-BR', 'nl', 'sv', 'da', 'nb', 'fi', 'pl', 'cs', 'tr', 'ru', 'uk', 'ar', 'hi', 'ja', 'ko', 'zh-Hans', 'zh-Hant',
].map((tag) => ({ tag }));

/** "German" ("allemand" in French), or the code itself when it is not in the list. */
export function languageName(tag: string | null | undefined): string {
  if (!tag) return t('settings:language.another');
  const normalized = normalizeLanguageTag(tag) ?? tag;
  for (const choice of languageChoices) if (choice.tag === normalized) return formatDisplayName(choice.tag, 'language');
  const base = normalized.split('-')[0] ?? normalized;
  for (const choice of languageChoices) if (choice.tag === base) return formatDisplayName(choice.tag, 'language');
  return normalized;
}

/** "12,300 of 50,000 characters used today (UTC)", or the unlimited form. */
export function usageText(usage: SettingsUsage): string {
  const used = formatNumber(usage.used);
  if (usage.budget === 0) return t('settings:usage.unlimited', { count: usage.used });
  const percent = Math.min(100, Math.round((usage.used / usage.budget) * 100));
  // `count` is the budget: the noun "characters" follows the second number of the sentence.
  return t('settings:usage.of', { used, count: usage.budget, percent: formatPercent(percent / 100, { maximumFractionDigits: 0 }) });
}

/** 0 to 1 for a meter, or null when there is no limit. */
export function usageFraction(usage: SettingsUsage): number | null {
  if (usage.budget === 0) return null;
  return Math.max(0, Math.min(1, usage.used / usage.budget));
}

/** Which of the form's fields the caller may edit. A key not in `writable` is read-only. */
export const canEdit = (writable: readonly string[], key: string): boolean =>
  writable.indexOf(key) >= 0;

export function settingsErrorMessage(
  error: unknown,
  action: 'load' | 'save' | 'test' = 'load',
): string {
  if (!(error instanceof ApiError)) return t('common:error.genericRetry');
  const issues = Array.isArray(error.body.issues)
    ? (error.body.issues as { path?: string; message?: string }[])
    : [];
  switch (error.code) {
    case 'forbidden':
      return action === 'load'
        ? t('settings:error.noRole')
        : t('settings:error.ownerOrAdmin');
    case 'not_found':
      return t('settings:error.workspaceGone');
    case 'invalid_setting':
    case 'unknown_setting': {
      const first = issues[0];
      return first?.message
        ? first.path
          ? t('settings:error.issuePath', { path: first.path, message: first.message })
          : first.message
        : error.message;
    }
    case 'rate_limited':
      return error.message;
    default:
      return action === 'save'
        ? t('settings:error.saveFailed')
        : error.message || t('common:error.genericRetry');
  }
}

/** The outcome of "Test", as a sentence for a person. Messages from the server are fixed sentences. */
export function testOutcomeText(outcome: TranslationTestOutcome): string {
  if (outcome.ok) return t('settings:test.ok');
  return outcome.message;
}

// ---------------------------------------------------------------------------------------------
// The translation settings the review screens need (cached, so a page of cards asks once).

export type TranslationConfig = {
  enabled: boolean;
  mode: TranslationMode;
  target: string;
  provider: TranslationProvider;
};

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
