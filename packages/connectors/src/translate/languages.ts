import { normalizeLanguageTag } from '@mrm/core';
import type { TranslateProviderId } from './types.ts';

/**
 * BCP-47 tags to each provider's own language codes, and the codes a provider reports back to tags.
 *
 * What is verified against the vendor pages (checked 2026-11-18) and what is not:
 * - Google (https://docs.cloud.google.com/translate/docs/languages): `zh-CN` and `zh-TW` for Chinese,
 *   `pt`, `pt-PT`, `pt-BR`, `no`, and both `he`/`iw`, `jv`/`jw`, `fil`/`tl` are listed. Other region
 *   variants are not Google codes, so they map to the language.
 * - DeepL (https://developers.deepl.com/docs/getting-started/supported-languages): the page's list is
 *   rendered by script and could not be read. `NB`, and the variants `EN-GB`, `EN-US`, `PT-BR`, `PT-PT`
 *   and `ZH-HANS` appear in DeepL's own pages; `ZH-HANT` and `ES-419` are UNVERIFIED (a refused code
 *   comes back as `unsupported_language`, never as a wrong translation).
 * - Azure (https://learn.microsoft.com/en-us/azure/ai-services/translator/language-support): `zh-Hans`,
 *   `zh-Hant`, `pt` (Brazil) and `pt-pt`, `nb`, `he`, `fil`, `sr-Cyrl`, `sr-Latn`, `yue`.
 * - LibreTranslate: the codes `zt` (Chinese traditional) and `pb` (Portuguese, Brazil) are UNVERIFIED
 *   (they are what its Argos models use); a server's own `/languages` list is the truth, and a code it
 *   does not know is reported as `unsupported_language`.
 *
 * The tables are data on purpose: a wrong entry is a one line fix with a test beside it.
 */

type Parts = { language: string; script: string | undefined; region: string | undefined; tag: string };

function parts(tag: string): Parts | undefined {
  const normalized = normalizeLanguageTag(tag);
  if (!normalized) return undefined;
  const [language = '', second, third] = normalized.split('-');
  const script = second && /^[A-Za-z]{4}$/.test(second) ? second : undefined;
  const region = script ? third : second;
  return { language, script, region, tag: normalized };
}

const TRADITIONAL_REGIONS = ['TW', 'HK', 'MO'];
const isTraditionalChinese = (p: Parts) =>
  p.script === 'Hant' || (p.script === undefined && p.region !== undefined && TRADITIONAL_REGIONS.includes(p.region));

// ---------------------------------------------------------------------------------------------
// Google

const GOOGLE_ALIASES: Record<string, string> = { nb: 'no', nn: 'no', tl: 'fil' };

export function googleCode(tag: string): string | undefined {
  const p = parts(tag);
  if (!p) return undefined;
  if (p.language === 'zh') return isTraditionalChinese(p) ? 'zh-TW' : 'zh-CN';
  if (p.language === 'pt') return p.region === 'PT' ? 'pt-PT' : p.region === 'BR' ? 'pt-BR' : 'pt';
  return GOOGLE_ALIASES[p.language] ?? p.language;
}

// ---------------------------------------------------------------------------------------------
// DeepL

const DEEPL_ENGLISH_US = ['US', 'CA', 'PH'];

/** A target: DeepL wants a variant for English and Portuguese, and has a Chinese variant per script. */
export function deeplTarget(tag: string): string | undefined {
  const p = parts(tag);
  if (!p) return undefined;
  if (p.language === 'en') return p.region === undefined || DEEPL_ENGLISH_US.includes(p.region) ? 'EN-US' : 'EN-GB';
  if (p.language === 'pt') return p.region === undefined || p.region === 'BR' ? 'PT-BR' : 'PT-PT';
  if (p.language === 'zh') return isTraditionalChinese(p) ? 'ZH-HANT' : 'ZH-HANS';
  if (p.language === 'nb' || p.language === 'no' || p.language === 'nn') return 'NB';
  if (p.language === 'es' && p.region === '419') return 'ES-419';
  return p.language.toUpperCase();
}

/** A source language has no variants: `EN`, `PT`, `ZH`. */
export function deeplSource(tag: string): string | undefined {
  const p = parts(tag);
  if (!p) return undefined;
  if (p.language === 'no' || p.language === 'nn') return 'NB';
  return p.language.toUpperCase();
}

// ---------------------------------------------------------------------------------------------
// Azure

export function azureCode(tag: string): string | undefined {
  const p = parts(tag);
  if (!p) return undefined;
  switch (p.language) {
    case 'zh':
      return isTraditionalChinese(p) ? 'zh-Hant' : 'zh-Hans';
    case 'pt':
      return p.region === 'PT' ? 'pt-pt' : 'pt';
    case 'no':
    case 'nn':
      return 'nb';
    case 'tl':
      return 'fil';
    case 'sr':
      return p.script === 'Latn' ? 'sr-Latn' : 'sr-Cyrl';
    case 'fr':
      return p.region === 'CA' ? 'fr-ca' : 'fr';
    default:
      return p.language;
  }
}

// ---------------------------------------------------------------------------------------------
// LibreTranslate

export function libreTranslateCode(tag: string): string | undefined {
  const p = parts(tag);
  if (!p) return undefined;
  switch (p.language) {
    case 'zh':
      return isTraditionalChinese(p) ? 'zt' : 'zh';
    case 'pt':
      return p.region === 'BR' ? 'pb' : 'pt';
    case 'no':
    case 'nn':
      return 'nb';
    default:
      return p.language;
  }
}

// ---------------------------------------------------------------------------------------------
// The two directions a caller needs

/** The provider's code for a target language, or undefined when the tag is not a language tag. */
export function providerTarget(provider: TranslateProviderId, tag: string): string | undefined {
  switch (provider) {
    case 'google':
      return googleCode(tag);
    case 'deepl':
      return deeplTarget(tag);
    case 'azure':
      return azureCode(tag);
    case 'libretranslate':
      return libreTranslateCode(tag);
  }
}

/**
 * The provider's code for a source language. `undefined` (or `auto`) means the provider detects it:
 * the result is `undefined`, and the adapter sends nothing (LibreTranslate sends `auto`).
 */
export function providerSource(provider: TranslateProviderId, tag: string | undefined): string | undefined {
  if (tag === undefined || tag === '' || tag.toLowerCase() === 'auto') return undefined;
  return provider === 'deepl' ? deeplSource(tag) : providerTarget(provider, tag);
}

const LEGACY: Record<string, string> = { iw: 'he', jw: 'jv', zt: 'zh-Hant', pb: 'pt-BR' };

/**
 * A code a provider reported, as a BCP-47 tag (`EN` gives `en`, `ZH-HANS` gives `zh-Hans`, Google's old
 * `iw` gives `he`). Undefined when it is empty or not a language tag (`und` is "undetermined").
 */
export function detectedTag(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const lower = code.trim().toLowerCase();
  const mapped = LEGACY[lower] ?? code;
  const tag = normalizeLanguageTag(mapped);
  return tag === undefined || tag === 'und' ? undefined : tag;
}
