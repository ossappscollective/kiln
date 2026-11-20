import type { Platform } from '../platform.ts';

/**
 * How a build number is found in the name of a git tag or of a GitHub release.
 *
 * A release lane usually decides the build number while it runs (it reads the version code, bumps
 * it, commits and tags), so the number is in the name of the tag it creates, for example
 * `ios/appstore/1.4.0/312`, and in the name of the release, for example
 * `Trail Notes(ios): v1.4.0 Build 312`. A team describes its own naming with a small pattern
 * language; this file compiles a pattern to an anchored regular expression and reads the pieces
 * out of a name. It has no dependencies and no I/O, so the server and the web page share it.
 *
 * A pattern is plain text with these parts. Everything else is literal (it is escaped, never
 * passed to a regular expression as written):
 *
 * - `{buildNumber}`: the build number or version code, digits only (1 to 10). Required, once.
 * - `{version}`: a version such as `1.4.0` or `2.0.0-beta.1` (at most four numbers, an optional
 *   suffix of 20 characters). Optional, once.
 * - `{platform}`: a word such as `ios`, `macos` or `android`. Optional, once. `ios` (also `iphone`,
 *   `ipados`), `macos` (also `mac`, `osx`) and `android` name a platform; any other word is "other".
 * - `{flavor}`: free text up to 40 characters (letters, digits, `.`, `_`, `-`), for example
 *   `appstore` or `playstore`. Optional, once. It names nothing the tool checks.
 * - `{prefix}`: the team's literal prefix for this app (the `TAG_PREFIX` of a monorepo lane), taken
 *   from the convention's `prefix` setting. Empty when none is set. Optional, once.
 * - `*`: any text of up to 80 characters. At most two, never next to each other.
 *
 * Limits keep a pattern from costing much: at most `MAX_PATTERN_LENGTH` characters, every part is
 * bounded, there is no nesting, and a name longer than `MAX_NAME_LENGTH` is never tested, so a
 * match takes a bounded time whatever the pattern or the name. Matching ignores case.
 */

export const MAX_PATTERN_LENGTH = 120;
export const MAX_PATTERNS = 20;
export const MAX_PREFIX_LENGTH = 40;
export const MAX_NAME_LENGTH = 250;
const MAX_WILDCARDS = 2;

export const PLACEHOLDERS = ['buildNumber', 'version', 'platform', 'flavor', 'prefix'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** What each placeholder means, for help text. */
export const PLACEHOLDER_HELP: Record<Placeholder, string> = {
  buildNumber: 'The build number or version code (digits). Required.',
  version: 'The version, for example 1.4.0.',
  platform:
    'ios, macos (or mac, osx) or android. Any other word is read as another platform and is not matched.',
  flavor: 'Free text such as appstore or playstore. Not checked.',
  prefix: 'The prefix you set for this app (for a monorepo). Empty when none is set.',
};

const CLASSES: Record<Exclude<Placeholder, 'prefix'>, string> = {
  buildNumber: '(\\d{1,10})',
  version: '(\\d{1,5}(?:\\.\\d{1,5}){0,3}(?:-[0-9A-Za-z][0-9A-Za-z.]{0,19})?)',
  platform: '([A-Za-z]{2,12})',
  flavor: '([A-Za-z0-9][A-Za-z0-9._-]{0,39})',
};
const WILDCARD = '[^\\r\\n]{0,80}?';

/** Tag patterns tried when a repository has set none. The first is the fastlane layout. */
export const DEFAULT_TAG_PATTERNS: readonly string[] = [
  '{prefix}{platform}/{flavor}/{version}/{buildNumber}',
  '{prefix}release/{version}/{buildNumber}',
  '{prefix}{platform}/{version}/{buildNumber}',
  '{prefix}{platform}-{version}-{buildNumber}',
  '{prefix}v{version}+{buildNumber}',
  '{prefix}{version}+{buildNumber}',
  '{prefix}v{version}-{buildNumber}',
  '{prefix}{version}-{buildNumber}',
  '{prefix}v{version}({buildNumber})',
  '{prefix}{version}({buildNumber})',
  '{prefix}build-{buildNumber}',
];

/** Release-name patterns tried when a repository has set none. */
export const DEFAULT_RELEASE_PATTERNS: readonly string[] = [
  '*({platform}): v{version} Build {buildNumber}',
  '*: v{version} Build {buildNumber}',
  '*v{version} Build {buildNumber}',
  '*{version} (build {buildNumber})',
  '*v{version} ({buildNumber})',
  '*{version} ({buildNumber})',
  '*Build {buildNumber}',
];

export type PatternKind = 'tag' | 'release';

/** The pieces a name gave. */
export type NameFields = {
  /** What `{platform}` matched, as written. */
  platformWord?: string;
  /** `ios`, `macos` or `android` when the word says so, `other` for any other word (catalyst, tvos, ...). */
  platform?: Platform | 'other';
  flavor?: string;
  version?: string;
  buildNumber: string;
};

export type CompiledPattern = {
  pattern: string;
  /** The pieces of the name, or undefined when the name does not fit the pattern. */
  test(name: string): NameFields | undefined;
};

export type Compiled = { ok: true; compiled: CompiledPattern } | { ok: false; error: string };

/** `ios`, `iphone` and `ipados` are iOS, `macos`, `mac` and `osx` are macOS, `android` is Android, any other word is `other`. */
export function platformFromWord(word: string): Platform | 'other' {
  const w = word.toLowerCase();
  if (w === 'ios' || w === 'iphone' || w === 'ipados') return 'ios';
  if (w === 'macos' || w === 'mac' || w === 'osx') return 'macos';
  if (w === 'android') return 'android';
  return 'other';
}

const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
const CONTROL = /[\x00-\x1f\x7f]/;

/** Why a prefix is not acceptable, or undefined. */
export function prefixProblem(prefix: string): string | undefined {
  if (prefix.length > MAX_PREFIX_LENGTH)
    return `The prefix is too long (${MAX_PREFIX_LENGTH} characters at most).`;
  if (!/^[A-Za-z0-9._/-]*$/.test(prefix))
    return 'A prefix holds letters, digits, . _ - and / only.';
  return undefined;
}

/**
 * Compiles one pattern. The result is anchored (the whole name must fit) and case-insensitive.
 * `prefix` fills `{prefix}`; it is escaped, never read as a pattern.
 */
export function compilePattern(
  pattern: string,
  options: { kind?: PatternKind; prefix?: string } = {},
): Compiled {
  const kind = options.kind ?? 'tag';
  const prefix = options.prefix ?? '';
  const bad = prefixProblem(prefix);
  if (bad) return { ok: false, error: bad };
  if (pattern.length === 0) return { ok: false, error: 'The pattern is empty.' };
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      error: `The pattern is too long (${MAX_PATTERN_LENGTH} characters at most).`,
    };
  }
  if (CONTROL.test(pattern)) return { ok: false, error: 'The pattern has a control character.' };
  if (kind === 'tag' && /\s/.test(pattern))
    return { ok: false, error: 'A tag name has no spaces.' };

  let source = '';
  const slots: Exclude<Placeholder, 'prefix'>[] = [];
  const used = new Set<Placeholder>();
  let wildcards = 0;
  let lastWasWildcard = false;
  let literal = '';
  const flush = () => {
    if (literal) source += escapeRegex(literal);
    literal = '';
  };

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0 || end - i > 20) return { ok: false, error: 'A { has no closing }.' };
      const name = pattern.slice(i + 1, end);
      if (!(PLACEHOLDERS as readonly string[]).includes(name)) {
        return {
          ok: false,
          error: `{${name}} is not a placeholder. Use ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`,
        };
      }
      const placeholder = name as Placeholder;
      if (used.has(placeholder)) return { ok: false, error: `{${placeholder}} can be used once.` };
      used.add(placeholder);
      flush();
      if (placeholder === 'prefix') source += escapeRegex(prefix);
      else {
        source += CLASSES[placeholder];
        slots.push(placeholder);
      }
      lastWasWildcard = false;
      i = end;
    } else if (ch === '}') {
      return { ok: false, error: 'A } has no opening {.' };
    } else if (ch === '*') {
      if (lastWasWildcard) return { ok: false, error: 'Two * cannot stand next to each other.' };
      if (++wildcards > MAX_WILDCARDS)
        return { ok: false, error: `At most ${MAX_WILDCARDS} * in a pattern.` };
      flush();
      source += WILDCARD;
      lastWasWildcard = true;
    } else {
      literal += ch;
      lastWasWildcard = false;
    }
  }
  flush();
  if (!used.has('buildNumber')) return { ok: false, error: 'The pattern needs {buildNumber}.' };

  let regex: RegExp;
  try {
    regex = new RegExp(`^${source}$`, 'i');
  } catch {
    return { ok: false, error: 'The pattern could not be compiled.' };
  }
  return {
    ok: true,
    compiled: {
      pattern,
      test(name) {
        if (name.length === 0 || name.length > MAX_NAME_LENGTH) return undefined;
        const m = regex.exec(name);
        if (!m) return undefined;
        const fields: NameFields = { buildNumber: '' };
        slots.forEach((slot, index) => {
          const value = m[index + 1];
          if (value === undefined) return;
          if (slot === 'platform') {
            fields.platformWord = value;
            fields.platform = platformFromWord(value);
          } else fields[slot] = value;
        });
        return fields;
      },
    },
  };
}

/** Problems of a list of patterns, one message per bad entry (`Pattern 2: ...`). Empty is fine. */
export function patternListProblems(
  patterns: readonly string[],
  options: { kind?: PatternKind; prefix?: string } = {},
): string[] {
  const problems: string[] = [];
  if (patterns.length > MAX_PATTERNS) problems.push(`At most ${MAX_PATTERNS} patterns.`);
  const seen = new Set<string>();
  patterns.slice(0, MAX_PATTERNS).forEach((pattern, index) => {
    const done = compilePattern(pattern, options);
    if (!done.ok) problems.push(`Pattern ${index + 1}: ${done.error}`);
    else if (seen.has(pattern)) problems.push(`Pattern ${index + 1}: listed twice.`);
    seen.add(pattern);
  });
  return problems;
}

/** Compiles every pattern that is valid, in order; invalid ones are skipped (see `patternListProblems`). */
export function compilePatterns(
  patterns: readonly string[],
  options: { kind?: PatternKind; prefix?: string } = {},
): CompiledPattern[] {
  const out: CompiledPattern[] = [];
  for (const pattern of patterns.slice(0, MAX_PATTERNS)) {
    const done = compilePattern(pattern, options);
    if (done.ok) out.push(done.compiled);
  }
  return out;
}

export type NameMatch = { pattern: string; fields: NameFields };

/** The first pattern that fits the name, with what it read. */
export function matchName(
  name: string,
  compiled: readonly CompiledPattern[],
): NameMatch | undefined {
  for (const c of compiled) {
    const fields = c.test(name);
    if (fields) return { pattern: c.pattern, fields };
  }
  return undefined;
}

/** One name of a preview: what the patterns read from it, and whether that fits the wanted platform. */
export type PreviewRow = {
  name: string;
  matched: boolean;
  pattern?: string;
  fields?: NameFields;
  /** When a platform was asked for: false when the name says another platform. Undefined when it says none. */
  platformOk?: boolean;
};

/**
 * Shows what a list of patterns reads from a list of names, for the "build number conventions"
 * dialog. `platform` is the platform of the app being looked at: a name that says the other
 * platform is marked `platformOk: false` (it would not be used for that app).
 */
export function previewPatterns(
  names: readonly string[],
  patterns: readonly string[],
  options: { kind?: PatternKind; prefix?: string; platform?: Platform } = {},
): PreviewRow[] {
  const compiled = compilePatterns(patterns, options);
  return names.map((name): PreviewRow => {
    const hit = matchName(name, compiled);
    if (!hit) return { name, matched: false };
    const row: PreviewRow = { name, matched: true, pattern: hit.pattern, fields: hit.fields };
    if (options.platform && hit.fields.platform !== undefined)
      row.platformOk = hit.fields.platform === options.platform;
    return row;
  });
}

type Span = { start: number; end: number; token: string };

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isDigitOrDot = (c: string | undefined) => isDigit(c) || c === '.';
const isAlnum = (c: string | undefined) => c !== undefined && /[A-Za-z0-9]/.test(c);

/** Every match of a global expression (`matchAll` needs a newer library than the web build's). */
function allMatches(text: string, pattern: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push(m);
    if (m[0] === '') re.lastIndex += 1;
  }
  return out;
}

/** The last occurrence of `needle` that no `touching` character is next to, or -1. */
function lastWhole(
  text: string,
  needle: string,
  touching: (c: string | undefined) => boolean,
): number {
  let at = text.lastIndexOf(needle);
  while (at >= 0) {
    if (!touching(text[at - 1]) && !touching(text[at + needle.length])) return at;
    at = at > 0 ? text.lastIndexOf(needle, at - 1) : -1;
  }
  return -1;
}

/**
 * Proposes a pattern from one example name, for the "add pattern" helper: the build number (the
 * one given, else the last run of digits), the version (the one given, else the first `1.2.3`),
 * and a platform word become placeholders; a segment between the platform and the version in a
 * `/`-separated name becomes `{flavor}`; everything else stays as it is. Undefined when the name
 * has no build number. The proposal is checked: it compiles and reads the example back.
 */
export function proposePattern(
  example: string,
  hints: { buildNumber?: string; version?: string; kind?: PatternKind } = {},
): { pattern: string; fields: NameFields } | undefined {
  const name = example.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return undefined;
  const kind = hints.kind ?? 'tag';
  const spans: Span[] = [];
  const overlaps = (s: number, e: number) => spans.some((x) => s < x.end && e > x.start);

  // The build number: the one given, else the last whole run of digits.
  let bnStart = -1;
  let bn = hints.buildNumber ?? '';
  if (/^\d{1,10}$/.test(bn)) bnStart = lastWhole(name, bn, isDigit);
  if (bnStart < 0) {
    const runs = allMatches(name, /\d{1,10}/g).filter(
      (m) => !isDigit(name[m.index - 1]) && !isDigit(name[m.index + m[0].length]),
    );
    const last = runs[runs.length - 1];
    if (!last) return undefined;
    bnStart = last.index;
    bn = last[0];
  }
  spans.push({ start: bnStart, end: bnStart + bn.length, token: '{buildNumber}' });

  // The version: the one given, else the first x.y or x.y.z.
  let vStart = -1;
  let ver = hints.version ?? '';
  if (/^\d+(?:\.\d+){0,3}$/.test(ver)) vStart = lastWhole(name, ver, isDigitOrDot);
  if (vStart >= 0 && overlaps(vStart, vStart + ver.length)) vStart = -1;
  if (vStart < 0) {
    for (const m of allMatches(name, /\d{1,5}(?:\.\d{1,5}){1,3}/g)) {
      const end = m.index + m[0].length;
      if (isDigitOrDot(name[m.index - 1]) || isDigitOrDot(name[end])) continue;
      if (overlaps(m.index, end)) continue;
      vStart = m.index;
      ver = m[0];
      break;
    }
  }
  if (vStart >= 0) spans.push({ start: vStart, end: vStart + ver.length, token: '{version}' });

  // The platform: the first whole word that names one.
  let platformSpan: Span | undefined;
  for (const m of allMatches(name, /[A-Za-z]{2,12}/g)) {
    const end = m.index + m[0].length;
    if (isAlnum(name[m.index - 1]) || isAlnum(name[end])) continue;
    if (platformFromWord(m[0]) === 'other' || overlaps(m.index, end)) continue;
    platformSpan = { start: m.index, end, token: '{platform}' };
    break;
  }
  if (platformSpan) spans.push(platformSpan);

  // A flavor: the `/` segment between the platform and the version.
  if (platformSpan && vStart >= 0 && platformSpan.end < vStart) {
    const between = name.slice(platformSpan.end, vStart);
    if (/^\/[A-Za-z0-9][A-Za-z0-9._-]{0,39}\/$/.test(between)) {
      spans.push({ start: platformSpan.end + 1, end: vStart - 1, token: '{flavor}' });
    }
  }

  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += name.slice(at, s.start) + s.token;
    at = s.end;
  }
  out += name.slice(at);
  const compiled = compilePattern(out, { kind });
  if (!compiled.ok) return undefined;
  const fields = compiled.compiled.test(name);
  if (!fields || fields.buildNumber !== bn) return undefined;
  return { pattern: out, fields };
}
