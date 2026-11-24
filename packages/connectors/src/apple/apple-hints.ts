import { AsoError, checkStatus, getCapped } from '../aso-common.ts';

/**
 * Apple, the App Store search hints: the suggestions the App Store shows under the search box while a person types.
 * One GET to a fixed host, no credential. Used only to ESTIMATE how popular a term is (docs/adr/0057-keyword-estimates.md):
 * it is not Apple's popularity score, which exists only inside Apple Ads.
 *
 * UNVERIFIED (written from how the service is widely observed to answer, no network was available when this was written, and
 * Apple documents nothing about it): `GET https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=<term>`
 * answers an XML property list whose `hints` array holds dictionaries with a `term` string; the storefront is taken from the
 * `X-Apple-Store-Front` header (`<storefront id>-1,29`); the order is the order the App Store shows. The parser reads every
 * `term` string and accepts a list with none, so a change on Apple's side gives no hints and not an error. The storefront ids
 * below are the well known ones; a country that is not here is not asked (a wrong storefront would be a wrong signal).
 * Search terms never appear in an error message, and nothing is logged here.
 */

export const APPLE_HINTS_URL =
  'https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints';
export const APPLE_HINTS_HOST = 'search.itunes.apple.com';
export const APPLE_HINTS_MAX = 10;
const MAX_BYTES = 256 * 1024;

const STOREFRONTS: Record<string, number> = {
  us: 143441,
  gb: 143444,
  ca: 143455,
  au: 143460,
  nz: 143461,
  ie: 143449,
  de: 143443,
  at: 143445,
  ch: 143459,
  fr: 143442,
  be: 143446,
  nl: 143452,
  es: 143454,
  pt: 143453,
  it: 143450,
  se: 143456,
  no: 143457,
  dk: 143458,
  fi: 143447,
  pl: 143478,
  gr: 143448,
  tr: 143480,
  ru: 143469,
  jp: 143462,
  kr: 143466,
  cn: 143465,
  hk: 143463,
  tw: 143470,
  sg: 143464,
  in: 143467,
  th: 143475,
  id: 143476,
  my: 143473,
  ph: 143474,
  vn: 143471,
  br: 143503,
  mx: 143468,
  ar: 143505,
  cl: 143483,
  co: 143501,
  za: 143472,
  ae: 143481,
  sa: 143479,
  il: 143491,
};

/** The storefront id of a two letter country, or undefined when it is not one of the known ones. */
export function appleStorefrontId(country: string): number | undefined {
  return STOREFRONTS[country.toLowerCase()];
}

export function appleHintsUrl(term: string): string {
  return `${APPLE_HINTS_URL}?clientApplication=Software&term=${encodeURIComponent(term)}`;
}

const decode = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d{1,6});/g, (_m, n: string) =>
      String.fromCodePoint(Math.min(Number(n), 0x10ffff)),
    )
    .replace(/&amp;/g, '&');

/** The suggestions of a hints answer: lower case, trimmed, each once, in order, at most `APPLE_HINTS_MAX`. Pure. */
export function parseAppleHints(text: string): string[] {
  const out: string[] = [];
  const pattern = /<key>\s*term\s*<\/key>\s*<string>([^<]{0,200})<\/string>/g;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const term = decode(m[1] ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
    if (term !== '' && !out.includes(term)) out.push(term);
    if (out.length >= APPLE_HINTS_MAX) break;
  }
  return out;
}

/** Asks the App Store for the hints of a term in a storefront. Throws `AsoError`. */
export async function fetchAppleHints(options: {
  term: string;
  country: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<string[]> {
  const term = options.term.trim();
  if (term === '' || term.length > 200)
    throw new AsoError('apple_search', 'invalid_input', 'The search term is empty or too long.');
  const storefront = appleStorefrontId(options.country);
  if (storefront === undefined)
    throw new AsoError('apple_search', 'invalid_input', 'No search hints for this storefront.');
  const got = await getCapped({
    source: 'apple_search',
    url: appleHintsUrl(term),
    accept: 'application/xml',
    maxBytes: MAX_BYTES,
    headers: { 'x-apple-store-front': `${storefront}-1,29` },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  checkStatus('apple_search', got);
  return parseAppleHints(got.text);
}
