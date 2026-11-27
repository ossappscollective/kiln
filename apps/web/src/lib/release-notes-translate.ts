import {
  APP_STORE_RELEASE_NOTES_LIMIT,
  aiProviderInfo,
  can,
  localeKey,
  notesLengthOf,
  type Role,
  translationProviderInfo,
} from '@kiln/core';
import {
  type AiConfig,
  aiErrorMessage,
  budgetUsedUp,
  isLocalAddress,
  providerSentence,
  resetText,
} from './ai/ai.ts';
import { ApiError } from './api.ts';
import { k, t } from './i18n/t.ts';
import type { Drafts } from './release-notes.ts';
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
export const NOTES_TRANSLATE_MAX_CHARS: number = APP_STORE_RELEASE_NOTES_LIMIT;
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
      reason: t('release-stepper:tr.checkingTranslation'),
      href: null,
      sends: '',
    };
  if (config === null)
    return {
      visible: true,
      enabled: true,
      reason: null,
      href: null,
      sends: t('release-stepper:tr.sendsProvider'),
    };
  if (!config.enabled || config.mode === 'off') {
    return {
      visible: true,
      enabled: false,
      reason: can(role, 'settings.write')
        ? t('release-stepper:tr.machineOffAdmin')
        : t('release-stepper:tr.machineOffMember'),
      href: MACHINE_SETTINGS_HREF,
      sends: '',
    };
  }
  const label = translationProviderInfo[config.provider]?.label;
  return {
    visible: true,
    enabled: true,
    reason: null,
    href: null,
    sends: label
      ? t('release-stepper:tr.sendsTo', { provider: label })
      : t('release-stepper:tr.sendsProvider'),
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
          sends: t('release-stepper:tr.sendsAi'),
        }
      : {
          visible: true,
          enabled: false,
          reason: t('release-stepper:tr.checkingAi'),
          href: null,
          sends: '',
        };
  }
  const admin = can(role, 'settings.write');
  if (config.state === 'off_server') {
    return {
      visible: true,
      enabled: false,
      reason: t('release-stepper:tr.aiOffServer', { env: 'KILN_AI_ENABLED' }),
      href: null,
      sends: '',
    };
  }
  if (config.state === 'off_workspace') {
    return {
      visible: true,
      enabled: false,
      reason: admin
        ? t('release-stepper:tr.aiOffWorkspaceAdmin')
        : t('release-stepper:tr.aiOffWorkspaceMember'),
      href: AI_SETTINGS_HREF,
      sends: '',
    };
  }
  if (config.state === 'not_configured') {
    return {
      visible: true,
      enabled: false,
      reason: admin
        ? t('release-stepper:tr.aiNotSetUpAdmin')
        : t('release-stepper:tr.aiNotSetUpMember'),
      href: AI_SETTINGS_HREF,
      sends: '',
    };
  }
  const local = aiIsLocal(config);
  if (!local && budgetUsedUp(config.usage)) {
    return {
      visible: true,
      enabled: false,
      reason: admin
        ? t('release-stepper:tr.aiLimitAdmin', { date: resetText(config.usage.resetsAt) })
        : t('release-stepper:tr.aiLimit', { date: resetText(config.usage.resetsAt) }),
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
  engine === 'ai' ? t('release-stepper:tr.engine.ai') : t('release-stepper:tr.engine.machine');

// ---------------------------------------------------------------------------------------------
// What to translate

/** The languages with text in the editors, in the order shown. */
export const languagesWithText = (texts: Drafts, locales: readonly string[]): string[] =>
  locales.filter((l) => clean(texts[l] ?? '') !== '');

/** The language to translate from by default: the first one that has text (not `skip`, the language being written). */
export function defaultSource(texts: Drafts, locales: readonly string[], skip = ''): string | null {
  const found = languagesWithText(texts, locales).filter(
    (l) => skip === '' || localeKey(l) !== localeKey(skip),
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
  const targets = wanted.filter((l) => localeKey(l) !== localeKey(source));
  const replaces = targets.filter((l) => clean(texts[l] ?? '') !== '').length;
  const chunks: string[][] = [];
  for (let i = 0; i < targets.length; i += NOTES_TRANSLATE_MAX_TARGETS)
    chunks.push(targets.slice(i, i + NOTES_TRANSLATE_MAX_TARGETS));
  let problem: string | null = null;
  if (text === '') problem = t('release-stepper:tr.problem.writeFirst', { source });
  else if (notesLengthOf('app_store', text) > NOTES_TRANSLATE_MAX_CHARS)
    problem = t('release-stepper:tr.problem.tooLong', {
      source,
      chars: notesLengthOf('app_store', text),
      max: NOTES_TRANSLATE_MAX_CHARS,
    });
  else if (targets.length === 0) problem = t('release-stepper:tr.problem.noTarget');
  return { source, text, targets, replaces, fills: targets.length - replaces, chunks, problem };
}

export const replaceText = (n: number): string => t('release-stepper:tr.replaces', { count: n });

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
    targets.filter((target) => localeKey(target) === localeKey(locale))[0];
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
      const codes = Object.keys(r.warnings).filter((k) => localeKey(k) === localeKey(key))[0];
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
  for (const target of targets) {
    if (!settled[target])
      out.failed.push({ locale: target, message: t('release-stepper:tr.noAnswer') });
  }
  return out;
}

const WARNING_WORDS: Record<string, string> = {
  version_missing: k('release-stepper:tr.warn.versionMissing'),
  brand_term_missing: k('release-stepper:tr.warn.brandMissing'),
};

/** The lines under the buttons after a translation. The first line is always whether anything was put in the editors, and that nothing is staged. */
export function translateLines(
  applied: Applied,
  engine: TranslateEngine,
  provider: string,
): { tone: 'ok' | 'warn' | 'error'; lines: string[] } {
  const lines: string[] = [];
  const n = applied.applied.length;
  const params = {
    engine: engineLabel(engine),
    provider,
    count: n,
    list: applied.applied.join(', '),
  };
  if (n > 0)
    lines.push(
      provider
        ? t('release-stepper:tr.lines.appliedBy', params)
        : t('release-stepper:tr.lines.applied', params),
    );
  else lines.push(t('release-stepper:tr.lines.nothing'));
  if (applied.failed.length > 0) {
    const list = applied.failed
      .slice(0, 5)
      .map((f) => t('release-stepper:tr.lines.item', { locale: f.locale, message: f.message }))
      .join('; ');
    lines.push(
      applied.failed.length > 5
        ? t('release-stepper:tr.lines.failedMore', { list, more: applied.failed.length - 5 })
        : t('release-stepper:tr.lines.failed', { list }),
    );
  }
  if (applied.over.length > 0)
    lines.push(
      t('release-stepper:tr.lines.over', {
        list: applied.over
          .map((o) =>
            t('release-stepper:tr.lines.overItem', {
              locale: o.locale,
              chars: o.chars,
              limit: o.limit,
            }),
          )
          .join(', '),
      }),
    );
  for (const w of applied.warnings.slice(0, 5))
    lines.push(
      t('release-stepper:tr.lines.check', {
        locale: w.locale,
        what: w.codes
          .map((c) => {
            const key = WARNING_WORDS[c];
            return key === undefined ? c : t(key);
          })
          .join('; '),
      }),
    );
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
    return t('release-stepper:tr.err.forbidden');
  if (error instanceof ApiError && error.code === 'invalid_request')
    return t('release-stepper:tr.err.invalid');
  return aiErrorMessage(error, t('release-stepper:tr.err.generic'));
}
