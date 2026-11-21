import {
  type AppStoreField,
  type AppStoreListing,
  type FileChange,
  type Listing,
  type ListingProblem,
  type LocaleText,
  validateListing,
} from '@kiln/core';
import type { ProjectDetection, ReadFile, StoreConfigFile } from './detect.ts';

/**
 * EAS Metadata (`store.config.json`) as a store listing. Pure: nothing here touches a network or
 * a disk, and nothing runs code (a dynamic `store.config.js` is never read).
 *
 * What the file is (see docs/spikes/expo-store-config.md for the pages it was checked against):
 * Apple only. `apple.info.<locale>` holds the App Store text of one locale and `apple.copyright`
 * the one app-wide value of the listing. Google Play is not supported by EAS Metadata, so a
 * Play listing can never be read from or written to this file.
 *
 * Mapping to the `@kiln/core` listing model (`Listing.appStore`):
 *
 *   title -> name                 releaseNotes -> release_notes   supportUrl -> support_url
 *   subtitle -> subtitle          promoText -> promotional_text   privacyPolicyUrl -> privacy_url
 *   description -> description    marketingUrl -> marketing_url   apple.copyright -> copyright
 *   privacyPolicyText -> apple_tv_privacy_policy
 *   keywords (array) -> keywords (one comma separated string)
 *
 * Everything else in the file (`apple.review`, `apple.advisory`, screenshots, unknown keys, ...)
 * is outside the model: it is reported in `uncovered` / `unknown` and is never touched.
 *
 * Writing edits the JSON text in place, one value at a time. A value that did not change is not
 * touched, so key order, unrelated keys, indentation, line endings and the trailing newline of
 * the file stay exactly as found. New members copy the file's indentation (2 spaces when it
 * cannot tell).
 */

export class ExpoStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpoStoreConfigError';
  }
}

type InfoKind = 'text' | 'keywords';
type InfoMapping = { json: string; field: AppStoreField; kind: InfoKind };

/** The `apple.info.<locale>` keys that map to the listing model, in EAS's documented order. */
export const EXPO_INFO_FIELDS: readonly InfoMapping[] = [
  { json: 'title', field: 'name', kind: 'text' },
  { json: 'subtitle', field: 'subtitle', kind: 'text' },
  { json: 'description', field: 'description', kind: 'text' },
  { json: 'keywords', field: 'keywords', kind: 'keywords' },
  { json: 'releaseNotes', field: 'release_notes', kind: 'text' },
  { json: 'promoText', field: 'promotional_text', kind: 'text' },
  { json: 'marketingUrl', field: 'marketing_url', kind: 'text' },
  { json: 'supportUrl', field: 'support_url', kind: 'text' },
  { json: 'privacyPolicyUrl', field: 'privacy_url', kind: 'text' },
  { json: 'privacyPolicyText', field: 'apple_tv_privacy_policy', kind: 'text' },
];

/** Locale keys the EAS Metadata schema (version 0) allows under `apple.info`. */
export const EXPO_LOCALES: readonly string[] = [
  'ar-SA',
  'ca',
  'zh-Hans',
  'zh-Hant',
  'hr',
  'cs',
  'da',
  'nl-NL',
  'en-AU',
  'en-CA',
  'en-GB',
  'en-US',
  'fi',
  'fr-FR',
  'fr-CA',
  'de-DE',
  'el',
  'he',
  'hi',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'ms',
  'no',
  'pl',
  'pt-BR',
  'pt-PT',
  'ro',
  'ru',
  'sk',
  'es-MX',
  'es-ES',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
];

const LOCALE_SET: ReadonlySet<string> = new Set(EXPO_LOCALES);
const TOP_KNOWN = new Set(['configVersion', 'apple', '$schema']);
/** Known `apple` keys outside the model. */
const APPLE_OTHER = new Set(['version', 'advisory', 'categories', 'release', 'review', 'appClip']);
const APPLE_KNOWN = new Set(['copyright', 'info', ...APPLE_OTHER]);
/** Known `apple.info.<locale>` keys outside the model. */
const INFO_OTHER = new Set(['privacyChoicesUrl', 'screenshots', 'previews']);
const INFO_MODELED = new Set(EXPO_INFO_FIELDS.map((f) => f.json));

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// ---------------------------------------------------------------------------------------------
// Keywords: a JSON array in the file, one comma separated string in the model

/** The model's keyword string to the file's array. Empty entries are dropped. */
export function keywordsToArray(value: string): string[] {
  return value
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------------------------------------
// Reading

export type ExpoStoreSnapshot = {
  /** Repository path of the file. */
  path: string;
  /** The raw text. This is what a change set is diffed from. */
  text: string;
  /** `appStore` only: EAS Metadata has no Google Play. Empty when the file could not be read. */
  listing: Listing;
  /** Whether the file has any `apple.info` locale or `apple.copyright`. */
  found: boolean;
  /** Set when the text is not valid JSON or not an object. Nothing else is usable then. */
  error?: string;
  /** JSON paths that EAS knows but the listing model does not cover (left untouched). */
  uncovered: string[];
  /** JSON paths that are not in the EAS Metadata schema (left untouched). */
  unknown: string[];
  warnings: string[];
};

export type ReadExpoStoreOptions = {
  /** Locales the workspace expects; each one without an `apple.info` entry is a warning. */
  expectedLocales?: readonly string[];
};

const summarize = (paths: string[]) =>
  paths.length <= 8
    ? paths.join(', ')
    : `${paths.slice(0, 8).join(', ')} and ${paths.length - 8} more`;

export function readExpoStoreConfig(
  path: string,
  text: string,
  options: ReadExpoStoreOptions = {},
): ExpoStoreSnapshot {
  const snapshot: ExpoStoreSnapshot = {
    path,
    text,
    listing: {},
    found: false,
    uncovered: [],
    unknown: [],
    warnings: [],
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (e) {
    snapshot.error = `${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
    return snapshot;
  }
  if (!isObject(parsed)) {
    snapshot.error = `${path} is not a JSON object.`;
    return snapshot;
  }

  const warn = (message: string) => snapshot.warnings.push(message);
  const appStore: AppStoreListing = { locales: {} };
  snapshot.listing = { appStore };

  if (parsed.configVersion === undefined) {
    warn(`${path} has no configVersion; the EAS schema requires it (only 0 is documented).`);
  } else if (parsed.configVersion !== 0) {
    const shown = JSON.stringify(parsed.configVersion);
    warn(`${path} has configVersion ${shown}; only 0 is documented.`);
  }
  for (const key of Object.keys(parsed)) {
    if (!TOP_KNOWN.has(key)) snapshot.unknown.push(key);
  }

  const apple = parsed.apple;
  if (apple === undefined) {
    warn(`${path} has no apple section.`);
  } else if (!isObject(apple)) {
    warn(`apple in ${path} is not an object, so it was not read.`);
  } else {
    for (const key of Object.keys(apple)) {
      if (APPLE_OTHER.has(key)) snapshot.uncovered.push(`apple.${key}`);
      else if (!APPLE_KNOWN.has(key)) snapshot.unknown.push(`apple.${key}`);
    }
    if (apple.copyright !== undefined) {
      if (typeof apple.copyright === 'string') {
        appStore.copyright = apple.copyright;
        snapshot.found = true;
      } else {
        warn('apple.copyright is not a string, so it was not read.');
      }
    }
    readInfo(apple.info, snapshot, appStore);
  }

  for (const locale of options.expectedLocales ?? []) {
    if (appStore.locales[locale] === undefined) {
      warn(`Locale ${locale} is expected but has no entry in apple.info.`);
    }
  }
  if (snapshot.uncovered.length > 0) {
    const list = summarize(snapshot.uncovered);
    warn(`Not part of the listing model, so read-only here and left untouched: ${list}.`);
  }
  if (snapshot.unknown.length > 0) {
    const list = summarize(snapshot.unknown);
    warn(`Not in the EAS Metadata schema (version 0), left untouched: ${list}.`);
  }
  return snapshot;
}

function readInfo(info: unknown, snapshot: ExpoStoreSnapshot, appStore: AppStoreListing) {
  const warn = (message: string) => snapshot.warnings.push(message);
  if (info === undefined) return;
  if (!isObject(info)) {
    warn('apple.info is not an object, so no locale was read.');
    return;
  }
  for (const [locale, entry] of Object.entries(info)) {
    const where = `apple.info.${locale}`;
    if (!LOCALE_SET.has(locale)) {
      snapshot.unknown.push(where);
      continue;
    }
    if (!isObject(entry)) {
      warn(`${where} is not an object, so it was not read.`);
      continue;
    }
    const text: LocaleText<AppStoreField> = {};
    appStore.locales[locale] = text;
    snapshot.found = true;
    for (const key of Object.keys(entry)) {
      if (INFO_OTHER.has(key)) snapshot.uncovered.push(`${where}.${key}`);
      else if (!INFO_MODELED.has(key)) snapshot.unknown.push(`${where}.${key}`);
    }
    for (const { json, field, kind } of EXPO_INFO_FIELDS) {
      const value = entry[json];
      if (value === undefined) continue;
      if (kind === 'keywords') {
        if (Array.isArray(value) && value.every((k) => typeof k === 'string')) {
          const list = value as string[];
          if (list.some((k) => k.includes(','))) {
            warn(
              `${where}.keywords has an entry with a comma; the model keeps keywords as one comma separated string, so it reads as several.`,
            );
          }
          text[field] = list.join(',');
        } else {
          warn(`${where}.keywords is not an array of strings, so it was not read.`);
        }
      } else if (typeof value === 'string') {
        text[field] = value;
      } else {
        warn(`${where}.${json} is not a string, so it was not read.`);
      }
    }
  }
}

/** Problems against the store limits in `@kiln/core`, ordered by locale and field. */
export function validateExpoStoreConfig(snapshot: ExpoStoreSnapshot): ListingProblem[] {
  return validateListing(snapshot.listing);
}

// ---------------------------------------------------------------------------------------------
// Detection helpers

/** The store configs that are plain JSON (a `store.config.js` is code and is never read). */
export function staticStoreConfigs(detection: ProjectDetection): StoreConfigFile[] {
  return detection.expo?.storeConfigs.filter((c) => !c.dynamic) ?? [];
}

/**
 * Reads the project's store config, found by `detectProject`. Returns undefined when the project
 * is not Expo or has no JSON store config. A config that cannot be read comes back as a snapshot
 * with `error` set.
 */
export async function loadExpoStoreConfig(
  detection: ProjectDetection,
  read: ReadFile,
  options?: ReadExpoStoreOptions,
): Promise<ExpoStoreSnapshot | undefined> {
  const configs = staticStoreConfigs(detection);
  const first = configs[0];
  if (!first) return undefined;
  const text = await read(first.path);
  const snapshot = readExpoStoreConfig(first.path, text ?? '', options);
  if (text === undefined) snapshot.error = `${first.path} could not be read.`;
  if (configs.length > 1) {
    const names = configs.map((c) => c.path).join(', ');
    snapshot.warnings.unshift(`Several store configs were found (${names}). Using ${first.path}.`);
  }
  return snapshot;
}

// ---------------------------------------------------------------------------------------------
// JSON text with positions

type ObjectNode = { kind: 'object'; start: number; end: number; members: Member[] };
type Node = ObjectNode | { kind: 'array' | 'string' | 'scalar'; start: number; end: number };
type Member = { key: string; start: number; end: number; value: Node };

/** Positions of every value in a text that `JSON.parse` has already accepted. */
function parseSpans(text: string): Node {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skip = () => {
    while (i < text.length && ' \t\r\n'.includes(text.charAt(i))) i++;
  };
  const string = () => {
    const from = i;
    i++;
    while (i < text.length && text.charAt(i) !== '"') i += text.charAt(i) === '\\' ? 2 : 1;
    i++;
    return text.slice(from, i);
  };
  const value = (): Node => {
    skip();
    const start = i;
    const c = text.charAt(i);
    if (c === '{') {
      i++;
      const members: Member[] = [];
      skip();
      if (text.charAt(i) === '}') {
        i++;
        return { kind: 'object', start, end: i, members };
      }
      for (;;) {
        skip();
        const keyStart = i;
        const key = JSON.parse(string()) as string;
        skip();
        i++; // the colon
        const v = value();
        members.push({ key, start: keyStart, end: v.end, value: v });
        skip();
        if (text.charAt(i) === ',') {
          i++;
          continue;
        }
        i++; // the closing brace
        return { kind: 'object', start, end: i, members };
      }
    }
    if (c === '[') {
      let depth = 0;
      while (i < text.length) {
        const ch = text.charAt(i);
        if (ch === '"') {
          string();
        } else {
          i++;
          if (ch === '[') depth++;
          else if (ch === ']' && --depth === 0) break;
        }
      }
      return { kind: 'array', start, end: i };
    }
    if (c === '"') {
      string();
      return { kind: 'string', start, end: i };
    }
    while (i < text.length && !',]} \t\r\n'.includes(text.charAt(i))) i++;
    return { kind: 'scalar', start, end: i };
  };
  return value();
}

/** The last member with this key (`JSON.parse` keeps the last of duplicate keys). */
function member(node: Node, key: string): Member | undefined {
  if (node.kind !== 'object') return undefined;
  for (let i = node.members.length - 1; i >= 0; i--) {
    const m = node.members[i];
    if (m?.key === key) return m;
  }
  return undefined;
}

type Style = { eol: string; unit: string; arrayInline: boolean; arraySep: string };

/** Indentation, line ending and keyword array layout of the file, for members it has to add. */
function detectStyle(text: string, root: Node): Style {
  const unit = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  let arrayInline = true;
  let arraySep = ', ';
  const apple = member(root, 'apple')?.value;
  const info = apple ? member(apple, 'info')?.value : undefined;
  for (const locale of info?.kind === 'object' ? info.members : []) {
    const kw = locale.value.kind === 'object' ? member(locale.value, 'keywords')?.value : undefined;
    if (kw?.kind === 'array') {
      const raw = text.slice(kw.start, kw.end);
      arrayInline = !raw.includes('\n');
      arraySep = raw.includes('","') ? ',' : ', ';
      break;
    }
  }
  return { eol: text.includes('\r\n') ? '\r\n' : '\n', unit, arrayInline, arraySep };
}

/** Leading whitespace of the line that holds `pos`. */
function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, pos))?.[0] ?? '';
}

/** `indent`: whitespace of the line the value starts on, or undefined to write it on one line. */
function render(
  value: unknown,
  style: Style,
  indent: string | undefined,
  inline?: boolean,
): string {
  const { eol, unit } = style;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => JSON.stringify(v));
    if (indent === undefined || (inline ?? style.arrayInline)) {
      return `[${items.join(style.arraySep)}]`;
    }
    const child = indent + unit;
    return `[${eol}${items.map((s) => child + s).join(`,${eol}`)}${eol}${indent}]`;
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    if (indent === undefined) {
      const body = entries.map(([k, v]) => `${JSON.stringify(k)}: ${render(v, style, undefined)}`);
      return `{${body.join(', ')}}`;
    }
    const child = indent + unit;
    const body = entries.map(
      ([k, v]) => `${child}${JSON.stringify(k)}: ${render(v, style, child)}`,
    );
    return `{${eol}${body.join(`,${eol}`)}${eol}${indent}}`;
  }
  return JSON.stringify(value);
}

const splice = (text: string, start: number, end: number, insert: string) =>
  text.slice(0, start) + insert + text.slice(end);

type Located =
  | { found: true; parent: ObjectNode; member: Member }
  | { found: false; parent: ObjectNode; rest: string[] };

function locate(root: Node, path: string[]): Located {
  let current = root;
  for (let i = 0; i < path.length; i++) {
    if (current.kind !== 'object') {
      throw new ExpoStoreConfigError(`${path.slice(0, i).join('.')} is not an object.`);
    }
    const m = member(current, path[i] as string);
    if (!m) return { found: false, parent: current, rest: path.slice(i) };
    if (i === path.length - 1) return { found: true, parent: current, member: m };
    current = m.value;
  }
  throw new ExpoStoreConfigError('Empty path.');
}

/** Sets one value, or adds the member (and any missing objects above it) at the end. */
function setValue(text: string, path: string[], value: unknown): string {
  const root = parseSpans(text);
  const style = detectStyle(text, root);
  const at = locate(root, path);
  if (at.found) {
    const old = at.member.value;
    const inline =
      old.kind === 'array' ? !text.slice(old.start, old.end).includes('\n') : undefined;
    const shown = render(value, style, lineIndent(text, old.start), inline);
    return splice(text, old.start, old.end, shown);
  }
  const key = JSON.stringify(at.rest[0]);
  let nested: unknown = value;
  for (const k of at.rest.slice(1).reverse()) nested = { [k]: nested };
  const { parent } = at;
  const first = parent.members[0];
  const last = parent.members[parent.members.length - 1];
  if (!first || !last) {
    const outer = lineIndent(text, parent.start);
    const child = outer + style.unit;
    const body = `${key}: ${render(nested, style, child)}`;
    const open = `{${style.eol}${child}${body}${style.eol}${outer}}`;
    return splice(text, parent.start, parent.end, open);
  }
  if (!text.slice(parent.start, first.start).includes('\n')) {
    return splice(text, last.end, last.end, `, ${key}: ${render(nested, style, undefined)}`);
  }
  const child = lineIndent(text, last.start);
  const body = `${key}: ${render(nested, style, child)}`;
  return splice(text, last.end, last.end, `,${style.eol}${child}${body}`);
}

/** Deletes one member, with its comma. A path that is not there is left alone. */
function removeMember(text: string, path: string[]): string {
  let at: Located;
  try {
    at = locate(parseSpans(text), path);
  } catch {
    return text;
  }
  if (!at.found) return text;
  const { members } = at.parent;
  const index = members.indexOf(at.member);
  const next = members[index + 1];
  const prev = members[index - 1];
  if (next) return splice(text, at.member.start, next.start, '');
  if (prev) return splice(text, prev.end, at.member.end, '');
  return splice(text, at.parent.start + 1, at.parent.end - 1, '');
}

function isEmptyObjectAt(text: string, path: string[]): boolean {
  try {
    const at = locate(parseSpans(text), path);
    return at.found && at.member.value.kind === 'object' && at.member.value.members.length === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Writing

export type ExpoStoreChange = {
  /** Empty when nothing changed, otherwise the one file with its text before and after. */
  changes: FileChange[];
  /** Things in `after` that could not be written to this file. */
  warnings: string[];
};

/**
 * The change that turns the file in `before` into `after.appStore`. Same contract as
 * `listingChangeSet` for fastlane: a value that did not change is not touched, a value that is
 * gone from `after` is removed, a locale that is gone has its modeled fields removed (and the
 * locale entry too, when nothing else is left in it). Values are compared against
 * `before.listing`, so unrelated keys, key order and formatting stay as found. Google Play data
 * in `after`, and locales EAS does not know, cannot be written and are reported in `warnings`.
 *
 * Throws `ExpoStoreConfigError` when `before` could not be read: there is nothing to edit.
 */
export function expoStoreChangeSet(before: ExpoStoreSnapshot, after: Listing): ExpoStoreChange {
  if (before.error !== undefined) throw new ExpoStoreConfigError(before.error);
  const warnings: string[] = [];
  if (after.googlePlay) {
    warnings.push('EAS Metadata does not support Google Play; the Play listing was not written.');
  }
  const next = after.appStore;
  if (!next) return { changes: [], warnings };
  const was = before.listing.appStore ?? { locales: {} };

  let text = before.text;
  const locales = Object.keys(next.locales);
  for (const locale of Object.keys(was.locales)) {
    if (!locales.includes(locale)) locales.push(locale);
  }
  for (const locale of locales) {
    if (!LOCALE_SET.has(locale)) {
      warnings.push(`Locale ${locale} is not one EAS Metadata supports, so it was not written.`);
      continue;
    }
    const want = next.locales[locale] ?? {};
    const had = was.locales[locale] ?? {};
    let removed = false;
    for (const { json, field, kind } of EXPO_INFO_FIELDS) {
      const to = want[field];
      const from = had[field];
      const path = ['apple', 'info', locale, json];
      if (to === undefined) {
        if (from !== undefined) {
          text = removeMember(text, path);
          removed = true;
        }
      } else if (kind === 'keywords') {
        const list = keywordsToArray(to);
        if (from === undefined || !sameList(keywordsToArray(from), list)) {
          text = setValue(text, path, list);
        }
      } else if (from !== to) {
        text = setValue(text, path, to);
      }
    }
    if (removed && isEmptyObjectAt(text, ['apple', 'info', locale])) {
      text = removeMember(text, ['apple', 'info', locale]);
    }
  }
  if (next.copyright === undefined) {
    if (was.copyright !== undefined) text = removeMember(text, ['apple', 'copyright']);
  } else if (next.copyright !== was.copyright) {
    text = setValue(text, ['apple', 'copyright'], next.copyright);
  }

  if (text === before.text) return { changes: [], warnings };
  try {
    JSON.parse(stripBom(text));
  } catch {
    throw new ExpoStoreConfigError(`Editing ${before.path} gave invalid JSON; nothing changed.`);
  }
  return { changes: [{ path: before.path, before: before.text, after: text }], warnings };
}
