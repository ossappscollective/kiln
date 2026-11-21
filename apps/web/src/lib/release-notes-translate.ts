import { aiProviderInfo, can, type Role, translationProviderInfo } from '@kiln/core';
import {
  type AiConfig,
  aiErrorMessage,
  budgetUsedUp,
  isLocalAddress,
  providerSentence,
  resetText,
} from './ai/ai.ts';
import { ApiError } from './api.ts';
import { type Drafts, normalizeLocale } from './release-notes.ts';
import { translationErrorMessage } from './reviews/translation.ts';
import type { TranslationConfig } from './settings.ts';

/**
 * Translating the "what is new" text of a release (docs/adr/0028-release-notes-translation.md): who sees the buttons and when they are
 * off, what a "translate all" would replace, how an answer is merged into the editors (the languages that worked are kept, the ones that
 * did not are listed), and the sentences. Pure. A translation only changes the text in the editors: nothing is staged here, and the
 * texts are never logged. Written for the ES2017 web build: no flatMap, no fromEntries.
 */

export type TranslateEngine = 'machine' | 'ai';

/** The limits of the server (`POST /apps/{id}/release-notes/translate`). */
export const NOTES_TRANSLATE_MAX_CHARS = 4000;
export const NOTES_TRANSLATE_MAX_TARGETS = 40;

export type TranslateNotesBody = {
  engine: TranslateEngine;
  sourceLocale: string;
  text: string;
  targetLocales: string[];
};

export type TranslateNotesResult = {
  engine: TranslateEngine;
  provider: string;
  model: string | null;
  texts: Record<string, string>;
  failed: Record<string, string>;
  over: Record<string, number>;
  warnings: Record<string, string[]>;
  limit: number;
  usage: { chars: number; inputTokens: number; outputTokens: number };
  warning: {
    kind: 'tokens' | 'cost';
    level: 'soft' | 'limit';
    percent: number;
    message: string;
  } | null;
};

const clean = (text: string): string => text.replace(/\r\n?/g, '\n').trim();

// ---------------------------------------------------------------------------------------------
// Who may, and when it is off

export type EngineState = {
  /** False: draw nothing (this role cannot use it). */
  visible: boolean;
  enabled: boolean;
  /** Why it is off, in a sentence that says which setting to change. */
  reason: string | null;
  /** Where that setting is (`#/settings`), or null. */
  href: string | null;
  /** Who receives the text, in a sentence (shown before anything is sent). */
  sends: string;
};

export const MACHINE_SETTINGS_HREF = '#/settings';
export const AI_SETTINGS_HREF = '#/settings?view=ai';

const HIDDEN: EngineState = { visible: false, enabled: false, reason: null, href: null, sends: '' };

/**
 * "Translate" (the translation provider of Settings > Translation). Hidden for a role that cannot stage text or translate. Off, with the
 * setting to change, when translation is off. `config` is `undefined` while the settings are read and `null` when this person cannot read
 * them: the button then works and the server decides (it answers with the reason).
 */
export function machineEngine(input: {
  role: Role;
  config: TranslationConfig | null | undefined;
}): EngineState {
  const { role, config } = input;
  if (!can(role, 'changesets.write') || !can(role, 'reviews.translate')) return HIDDEN;
  if (config === undefined)
    return {
      visible: true,
      enabled: false,
      reason: 'Checking the translation settings.',
      href: null,
      sends: '',
    };
  if (config === null)
    return {
      visible: true,
      enabled: true,
      reason: null,
      href: null,
      sends: 'The text is sent to the translation provider of this workspace.',
    };
  if (!config.enabled || config.mode === 'off') {
    return {
      visible: true,
      enabled: false,
      reason: can(role, 'settings.write')
        ? 'Machine translation is off. Turn it on in Settings, in the Translation card.'
        : 'Machine translation is off. An admin can turn it on in Settings, in the Translation card.',
      href: MACHINE_SETTINGS_HREF,
      sends: '',
    };
  }
  const label = translationProviderInfo[config.provider]?.label ?? 'the translation provider';
  return {
    visible: true,
    enabled: true,
    reason: null,
    href: null,
    sends: `The text is sent to ${label}.`,
  };
}

/** Whether the AI model is on this machine or a private network (nothing is billed there, so the monthly limit does not stop it). */
export const aiIsLocal = (config: Pick<AiConfig, 'settings'>): boolean =>
  config.settings.provider === 'openai_compatible' &&
  config.settings.baseUrl !== null &&
  isLocalAddress(config.settings.baseUrl);

/**
 * "Translate with AI". Hidden for a role without `ai.use` or the right to stage text. Off, with the setting to change, when AI is off or
 * not set up, and when the monthly limit is used up (unless the model is local). `config` is `null` while it is read or when it could not
 * be: `failed` then lets the button work and the server decide.
 */
export function aiEngine(input: {
  role: Role;
  config: AiConfig | null;
  failed?: boolean;
}): EngineState {
  const { role, config } = input;
  if (!can(role, 'changesets.write') || !can(role, 'ai.use')) return HIDDEN;
  if (config === null) {
    return input.failed === true
      ? {
          visible: true,
          enabled: true,
          reason: null,
          href: null,
          sends: 'The text is sent to the AI provider of this workspace.',
        }
      : {
          visible: true,
          enabled: false,
          reason: 'Checking the AI settings.',
          href: null,
          sends: '',
        };
  }
  const admin = can(role, 'settings.write');
  if (config.state === 'off_server') {
    return {
      visible: true,
      enabled: false,
      reason:
        'AI assistance is switched off on this server. Whoever runs the server turns it on with MRM_AI_ENABLED=true.',
      href: null,
      sends: '',
    };
  }
  if (config.state === 'off_workspace') {
    return {
      visible: true,
      enabled: false,
      reason: `AI assistance is off for this workspace. ${admin ? 'Turn it on' : 'An admin can turn it on'} in Settings, in the AI view.`,
      href: AI_SETTINGS_HREF,
      sends: '',
    };
  }
  if (config.state === 'not_configured') {
    return {
      visible: true,
      enabled: false,
      reason: `AI assistance is not set up yet. ${admin ? 'Finish it' : 'An admin can finish it'} in Settings, in the AI view.`,
      href: AI_SETTINGS_HREF,
      sends: '',
    };
  }
  const local = aiIsLocal(config);
  if (!local && budgetUsedUp(config.usage)) {
    return {
      visible: true,
      enabled: false,
      reason: `The monthly AI limit is used up. It starts again on ${resetText(config.usage.resetsAt)}${admin ? '; you can raise it in Settings, in the AI view' : ''}.`,
      href: admin ? AI_SETTINGS_HREF : null,
      sends: '',
    };
  }
  const provider = config.providers.filter((p) => p.id === config.settings.provider)[0] ?? null;
  return {
    visible: true,
    enabled: true,
    reason: null,
    href: null,
    sends: providerSentence(provider),
  };
}

/** "Google Cloud Translation", "Anthropic (Claude)": the name of the provider that answered. */
export const providerName = (engine: TranslateEngine, id: string): string =>
  (
    (engine === 'ai' ? aiProviderInfo : translationProviderInfo) as Record<
      string,
      { label: string } | undefined
    >
  )[id]?.label ?? id;

export const engineLabel = (engine: TranslateEngine): string =>
  engine === 'ai' ? 'AI' : 'machine translation';

// ---------------------------------------------------------------------------------------------
// What to translate

/** The languages with text in the editors, in the order shown. */
export const languagesWithText = (texts: Drafts, locales: readonly string[]): string[] =>
  locales.filter((l) => clean(texts[l] ?? '') !== '');

/** The language to translate from by default: the first one that has text (not `skip`, the language being written). */
export function defaultSource(texts: Drafts, locales: readonly string[], skip = ''): string | null {
  const found = languagesWithText(texts, locales).filter(
    (l) => skip === '' || normalizeLocale(l) !== normalizeLocale(skip),
  )[0];
  return found ?? null;
}

export type TranslatePlan = {
  source: string;
  text: string;
  targets: string[];
  /** Targets that hold text now: translating replaces it. */
  replaces: number;
  /** Targets that are empty now. */
  fills: number;
  /** One request per chunk (the server takes up to 40 languages). */
  chunks: string[][];
  /** Why there is nothing to do, or null. */
  problem: string | null;
};

/**
 * What translating `source` into `targets` (default: every other shown language) would do to the editors. `texts` is what the editors show.
 * The text is the source's, with line ends normalised; a source with no text, or longer than the server takes, is a problem, not a request.
 */
export function translatePlan(
  texts: Drafts,
  locales: readonly string[],
  source: string,
  only?: readonly string[],
): TranslatePlan {
  const text = clean(texts[source] ?? '');
  const wanted = only ?? locales;
  const targets = wanted.filter((l) => normalizeLocale(l) !== normalizeLocale(source));
  const replaces = targets.filter((l) => clean(texts[l] ?? '') !== '').length;
  const chunks: string[][] = [];
  for (let i = 0; i < targets.length; i += NOTES_TRANSLATE_MAX_TARGETS)
    chunks.push(targets.slice(i, i + NOTES_TRANSLATE_MAX_TARGETS));
  let problem: string | null = null;
  if (text === '') problem = `Write the ${source} text first, or choose a language that has text.`;
  else if (text.length > NOTES_TRANSLATE_MAX_CHARS)
    problem = `The ${source} text has ${text.length} characters. At most ${NOTES_TRANSLATE_MAX_CHARS} can be translated at once.`;
  else if (targets.length === 0) problem = 'There is no other language to translate into.';
  return { source, text, targets, replaces, fills: targets.length - replaces, chunks, problem };
}

export const replaceText = (n: number): string =>
  `This replaces ${n} ${n === 1 ? 'text' : 'texts'} that ${n === 1 ? 'is' : 'are'} not empty.`;

// ---------------------------------------------------------------------------------------------
// Putting the answers in the editors

export type ChunkAnswer =
  | { ok: true; result: TranslateNotesResult }
  | { ok: false; message: string; locales: readonly string[] };

export type Applied = {
  drafts: Drafts;
  /** Languages whose editor got a text. */
  applied: string[];
  failed: { locale: string; message: string }[];
  /** Applied texts longer than the store allows. */
  over: { locale: string; chars: number; limit: number }[];
  /** Applied texts with something to check (codes from the server). */
  warnings: { locale: string; codes: string[] }[];
  /** The newest warning about the month's AI usage, or null. */
  usageWarning: string | null;
};

/**
 * Merges the answers of one translation into the drafts: every text that came back replaces the text of its language, and nothing
 * else is touched (the source language never is). A language that failed, or a whole request that failed, is listed with its sentence;
 * the languages that worked in the other requests are kept. Server languages are matched ignoring case and `_`/`-`.
 */
export function applyTranslations(
  drafts: Drafts,
  targets: readonly string[],
  answers: readonly ChunkAnswer[],
): Applied {
  const next: Drafts = { ...drafts };
  const out: Applied = {
    drafts: next,
    applied: [],
    failed: [],
    over: [],
    warnings: [],
    usageWarning: null,
  };
  const mine = (locale: string): string | undefined =>
    targets.filter((t) => normalizeLocale(t) === normalizeLocale(locale))[0];
  const settled: Record<string, boolean> = {};
  for (const answer of answers) {
    if (!answer.ok) {
      for (const l of answer.locales) {
        out.failed.push({ locale: l, message: answer.message });
        settled[l] = true;
      }
      continue;
    }
    const r = answer.result;
    if (r.warning) out.usageWarning = r.warning.message;
    for (const key of Object.keys(r.texts)) {
      const locale = mine(key);
      if (locale === undefined) continue;
      next[locale] = r.texts[key] as string;
      out.applied.push(locale);
      settled[locale] = true;
      const chars = (r.texts[key] as string).length;
      if (chars > r.limit) out.over.push({ locale, chars, limit: r.limit });
      const codes = Object.keys(r.warnings).filter(
        (k) => normalizeLocale(k) === normalizeLocale(key),
      )[0];
      if (codes !== undefined && (r.warnings[codes] as string[]).length > 0)
        out.warnings.push({ locale, codes: r.warnings[codes] as string[] });
    }
    for (const key of Object.keys(r.failed)) {
      const locale = mine(key);
      if (locale === undefined || settled[locale]) continue;
      out.failed.push({ locale, message: r.failed[key] as string });
      settled[locale] = true;
    }
  }
  for (const t of targets) {
    if (!settled[t])
      out.failed.push({ locale: t, message: 'No answer came back for this language.' });
  }
  return out;
}

const WARNING_WORDS: Record<string, string> = {
  version_missing: 'a version number of the source is missing',
  brand_term_missing: 'a name to keep as written is missing',
};

/** The lines under the buttons after a translation. The first line is always whether anything was put in the editors, and that nothing is staged. */
export function translateLines(
  applied: Applied,
  engine: TranslateEngine,
  provider: string,
): { tone: 'ok' | 'warn' | 'error'; lines: string[] } {
  const lines: string[] = [];
  const n = applied.applied.length;
  const by = provider ? ` by ${provider}` : '';
  if (n > 0)
    lines.push(
      `Put the ${engineLabel(engine)}${by} text in ${n} ${n === 1 ? 'language' : 'languages'}: ${applied.applied.join(', ')}. Read it before you stage it. Not staged yet.`,
    );
  else lines.push('Nothing was translated. The editors are as they were.');
  if (applied.failed.length > 0)
    lines.push(
      `Not translated: ${applied.failed
        .slice(0, 5)
        .map((f) => `${f.locale} (${f.message})`)
        .join('; ')}${applied.failed.length > 5 ? `; and ${applied.failed.length - 5} more` : ''}.`,
    );
  if (applied.over.length > 0)
    lines.push(
      `Too long for the store, shorten before staging: ${applied.over.map((o) => `${o.locale} (${o.chars} of ${o.limit})`).join(', ')}.`,
    );
  for (const w of applied.warnings.slice(0, 5))
    lines.push(`Check ${w.locale}: ${w.codes.map((c) => WARNING_WORDS[c] ?? c).join('; ')}.`);
  if (applied.usageWarning) lines.push(applied.usageWarning);
  return {
    tone: n === 0 ? 'error' : applied.failed.length > 0 || applied.over.length > 0 ? 'warn' : 'ok',
    lines,
  };
}

/** One sentence for a failed request. The words of a provider are never shown; the server's sentences are fixed. */
export function translateErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code.indexOf('translation_') === 0)
    return translationErrorMessage(error);
  if (error instanceof ApiError && error.code === 'forbidden')
    return 'Your role does not allow that, or this access token does not have the right for it.';
  if (error instanceof ApiError && error.code === 'invalid_request')
    return 'The text or the languages cannot be translated. Check them and try again.';
  return aiErrorMessage(error, 'That did not work. Try again.');
}
