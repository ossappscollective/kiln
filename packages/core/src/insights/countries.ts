// Adapted from Open Screenshot Generator (MIT), see THIRD_PARTY_NOTICES.md
//
// The main language of a store country, as the language of the store page a shopper there most likely reads. Used by the language coverage
// view and the "no German store page" insight. Both stores name countries with the ISO 3166-1 alpha-2 code (an App Store storefront, a Google
// Play country), so one table serves both.
//
// It lists the MAJORITY language that the store lets you add a page in, not the census language: where App Store Connect has no page language for
// the local one (Bulgarian, Estonian, ...), the entry is English, so the insight never asks for a translation that cannot be made. Google Play
// offers more languages; `PLAY_EXTRA` names the ones that differ (UNVERIFIED against Google's current list of supported languages). A country
// of a language with several large ones (India, Switzerland, Belgium) shows the one with the most shoppers on the stores.

const GROUPS: Record<string, string> = {
  ar: 'AE BH DZ EG IQ JO KW LB LY MR OM QA SA YE',
  cs: 'CZ',
  da: 'DK',
  de: 'AT CH DE',
  el: 'CY GR',
  en: 'AF AG AI AL AM AU AZ BB BG BM BS BT BW BZ CA DM EE FJ FM GB GD GE GH GM GY IE IN IS JM KE KH KN KY LA LC LK LR LT LV MK MM MN MS MT MU MV MW NA NG NP NR NZ PG PH PK PW RW SB SC SG SI SL SZ TC TO TT TZ UG US VC VG VU XK ZA ZM ZW',
  es: 'AR BO CL CO CR DO EC ES GT HN MX NI PA PE PY SV UY VE',
  fi: 'FI',
  fr: 'BF BJ CD CG CI CM FR GA LU MA MG ML NE SN TD TN',
  he: 'IL',
  hr: 'BA HR ME RS',
  hu: 'HU',
  id: 'ID',
  it: 'IT',
  ja: 'JP',
  ko: 'KR',
  ms: 'BN MY',
  nb: 'NO',
  nl: 'BE NL SR',
  pl: 'PL',
  pt: 'AO BR CV GW MZ PT ST',
  ro: 'MD RO',
  ru: 'BY KG KZ RU TJ TM UZ',
  sk: 'SK',
  sv: 'SE',
  th: 'TH',
  tr: 'TR',
  uk: 'UA',
  vi: 'VN',
  'zh-Hans': 'CN',
  'zh-Hant': 'HK MO TW',
};

/** Google Play countries whose own language the store can show a page in, where the App Store has none (UNVERIFIED, see the header). */
const PLAY_EXTRA: Record<string, string> = {
  bg: 'BG',
  et: 'EE',
  lv: 'LV',
  lt: 'LT',
  sl: 'SI',
  is: 'IS',
  ka: 'GE',
  hy: 'AM',
  az: 'AZ',
  mk: 'MK',
  sq: 'AL',
  sr: 'RS',
  km: 'KH',
  lo: 'LA',
  my: 'MM',
  ne: 'NP',
  si: 'LK',
  mn: 'MN',
  kk: 'KZ',
  be: 'BY',
};

const index = (groups: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const language of Object.keys(groups)) {
    for (const country of (groups[language] as string).split(' ')) out[country] = language;
  }
  return out;
};

const APP_STORE_LANGUAGE = index(GROUPS);
const PLAY_LANGUAGE: Record<string, string> = { ...APP_STORE_LANGUAGE, ...index(PLAY_EXTRA) };

/** The two letter code of a country as the stores write it (`de`, `DE`, ` De `), or null. */
export function normalizeCountryCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Every country the table knows, for the App Store. */
export const COUNTRY_CODES: readonly string[] = Object.keys(APP_STORE_LANGUAGE);

/**
 * The language (`de`, `pt`, `zh-Hans`) a shopper in this country most likely reads the store page in, or null for a country the table does not
 * know. `store` picks the languages the store offers (`google_play` has a few more).
 */
export function mainLanguageOf(country: string, store: 'app_store' | 'google_play' = 'app_store'): string | null {
  const code = normalizeCountryCode(country);
  if (code === null) return null;
  return (store === 'google_play' ? PLAY_LANGUAGE : APP_STORE_LANGUAGE)[code] ?? null;
}

/**
 * A language key that two spellings of the same language share: `pt-BR` and `pt-PT` are `pt`, `no` and `nn` are `nb`, `iw` is `he`, `in` is `id`,
 * `fil` is `tl`, the Chinese tags are `zh-Hans` or `zh-Hant` by script, then by region (`zh-TW`, `zh-HK`, `zh-MO` are traditional), and a bare
 * `zh` is simplified. Null for text that is not a language tag.
 */
export function languageKey(tag: string): string | null {
  const parts = tag.trim().replace(/_/g, '-').split('-').filter((p) => p !== '');
  const primary = (parts[0] ?? '').toLowerCase();
  if (!/^[a-z]{2,3}$/.test(primary)) return null;
  if (primary === 'zh') {
    const rest = parts.slice(1).map((p) => p.toLowerCase());
    if (rest.indexOf('hant') >= 0) return 'zh-Hant';
    if (rest.indexOf('hans') >= 0) return 'zh-Hans';
    return rest.some((p) => p === 'tw' || p === 'hk' || p === 'mo') ? 'zh-Hant' : 'zh-Hans';
  }
  if (primary === 'no' || primary === 'nn') return 'nb';
  if (primary === 'iw') return 'he';
  if (primary === 'in') return 'id';
  if (primary === 'fil') return 'tl';
  return primary;
}

/** The first store locale (`pt-BR`) that is a page in this language (`pt`), or null. */
export function localeCovering(language: string, locales: readonly string[]): string | null {
  const wanted = languageKey(language);
  if (wanted === null) return null;
  for (const locale of locales) if (languageKey(locale) === wanted) return locale;
  return null;
}
