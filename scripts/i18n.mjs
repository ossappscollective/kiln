#!/usr/bin/env node
/**
 * Localisation tooling (docs/i18n.md). Plain Node, no dependencies. It reads the same TypeScript modules the app uses
 * (`apps/web/src/lib/i18n/core.ts`, `locales.ts`; Node strips the types), so the rules cannot drift from the runtime.
 *
 *   node scripts/i18n.mjs check [--strict] [--verbose]   validate catalogs and the keys used in source (fails on errors)
 *   node scripts/i18n.mjs fix                            rewrite every catalog sorted, indented by 2, with a final newline
 *   node scripts/i18n.mjs scan [--files] [--items] [--json]  list user-visible hard-coded strings still in the source (a report, never a gate)
 *
 * `pnpm i18n:check`, `pnpm i18n:fix`, `pnpm i18n:scan`. The web tests run `check` (apps/web/src/lib/i18n/catalogs.test.ts).
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  KEY_PATTERN,
  NAMESPACE_PATTERN,
  SOURCE_LOCALE,
  pluralCategories,
  splitKey,
  splitPluralKey,
  tagProblem,
  tokensOf,
} from '../apps/web/src/lib/i18n/core.ts';
import { localeCodes } from '../apps/web/src/lib/i18n/locales.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const LOCALES_DIR = join(WEB, 'locales');
const SRC_DIR = join(WEB, 'src');

// ---------------------------------------------------------------------------------------------
// Files

const walk = (dir, accept, out = []) => {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
};

const rel = (full) => relative(ROOT, full).split(sep).join('/');

/** Every `locales/<ns>/<lang>.json` as `{ ns, lang, path, text }` (path relative to the repository). */
export function readCatalogFiles(dir = LOCALES_DIR) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const ns of readdirSync(dir).sort()) {
    const nsDir = join(dir, ns);
    if (!statSync(nsDir).isDirectory()) continue;
    for (const name of readdirSync(nsDir).sort()) {
      const full = join(nsDir, name);
      const match = /^([^.]+)\.json$/.exec(name);
      files.push({
        ns,
        lang: match ? match[1] : null,
        path: rel(full),
        text: readFileSync(full, 'utf8'),
      });
    }
  }
  return files;
}

const sortedObject = (obj) => {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
};

/** The one accepted file layout: keys sorted, two spaces, final newline (what Weblate's JSON formatting add-on writes). */
export const canonicalText = (obj) => `${JSON.stringify(sortedObject(obj), null, 2)}\n`;

// ---------------------------------------------------------------------------------------------
// Catalog check

/** Groups `a_one`, `a_other` into `{ plain: Map(key -> value), groups: Map(base -> Map(category -> value)) }`. */
function shapeOf(catalog) {
  const plain = new Map();
  const groups = new Map();
  for (const key of Object.keys(catalog)) {
    const { base, category } = splitPluralKey(key);
    if (category === null) plain.set(key, catalog[key]);
    else {
      if (!groups.has(base)) groups.set(base, new Map());
      groups.get(base).set(category, catalog[key]);
    }
  }
  return { plain, groups };
}

const setText = (tokens) => (tokens.length === 0 ? 'none' : tokens.join(' '));

function compareTokens(where, actual, required, allowed, errors) {
  const missing = required.filter((t) => !actual.includes(t));
  const extra = actual.filter((t) => !allowed.includes(t));
  if (missing.length > 0)
    errors.push(`${where}: missing ${missing.join(' ')} (English has ${setText(required)}).`);
  if (extra.length > 0)
    errors.push(`${where}: unknown ${extra.join(' ')} (English has ${setText(allowed)}).`);
}

function parseFiles(files, languages, errors) {
  const parsed = new Map(); // ns -> Map(lang -> { object, path })
  for (const file of files) {
    if (file.lang === null) {
      errors.push(`${file.path}: only <language>.json files belong here.`);
      continue;
    }
    if (!NAMESPACE_PATTERN.test(file.ns))
      errors.push(`${file.path}: namespace "${file.ns}" must match ${NAMESPACE_PATTERN}.`);
    if (!languages.includes(file.lang)) {
      errors.push(
        `${file.path}: "${file.lang}" is not registered. Add it to availableLocales in apps/web/src/lib/i18n/locales.ts.`,
      );
      continue;
    }
    let value;
    try {
      value = JSON.parse(file.text);
    } catch (error) {
      errors.push(`${file.path}: not valid JSON (${error.message}).`);
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${file.path}: must be one flat object of key to message.`);
      continue;
    }
    if (file.text !== canonicalText(value))
      errors.push(
        `${file.path}: not formatted (sorted keys, 2 spaces, final newline). Run pnpm i18n:fix.`,
      );
    const bad = Object.keys(value).filter((key) => typeof value[key] !== 'string');
    for (const key of bad)
      errors.push(
        `${file.path}: "${key}" must be a string (the files are flat: no nested objects, no numbers).`,
      );
    if (bad.length > 0) continue;
    if (!parsed.has(file.ns)) parsed.set(file.ns, new Map());
    parsed.get(file.ns).set(file.lang, { object: value, path: file.path });
  }
  return parsed;
}

function checkSource(source, shape, errors) {
  const enCategories = pluralCategories(SOURCE_LOCALE);
  for (const key of Object.keys(source.object)) {
    const where = `${source.path}: "${key}"`;
    if (!KEY_PATTERN.test(key))
      errors.push(
        `${where} is not a valid key (dot-separated camelCase segments, e.g. card.title or delta.up_one).`,
      );
    if (source.object[key] === '') errors.push(`${where} is empty. English is the source text.`);
  }
  for (const [base, forms] of shape.groups) {
    for (const category of forms.keys()) {
      if (!enCategories.includes(category))
        errors.push(
          `${source.path}: "${base}_${category}" is not a plural form of English (use ${enCategories.join(', ')}).`,
        );
    }
    for (const category of enCategories) {
      if (!forms.has(category))
        errors.push(
          `${source.path}: plural "${base}" needs "${base}_${category}" (English has ${enCategories.join(' and ')}).`,
        );
    }
  }
  for (const key of shape.plain.keys()) {
    if (shape.groups.has(key))
      errors.push(`${source.path}: "${key}" is both a plain key and the base of plural keys.`);
  }
}

function checkTranslation(ns, lang, entry, shape, cov, errors) {
  const object = entry ? entry.object : {};
  const categories = pluralCategories(lang);
  if (entry) {
    for (const key of Object.keys(object)) {
      const where = `${entry.path}: "${key}"`;
      if (lang !== SOURCE_LOCALE) {
        if (!KEY_PATTERN.test(key)) errors.push(`${where} is not a valid key.`);
        const { base, category } = splitPluralKey(key);
        const orphan = `${where} does not exist in ${SOURCE_LOCALE}.json (orphan: remove it).`;
        if (category === null) {
          if (!shape.plain.has(key))
            errors.push(
              shape.groups.has(key)
                ? `${where} is a plural in English: translate ${key}_<form> instead.`
                : orphan,
            );
        } else if (!shape.groups.has(base)) {
          errors.push(
            shape.plain.has(base)
              ? `${where} is not a plural in English: translate "${base}" as one message.`
              : orphan,
          );
        } else if (!categories.includes(category)) {
          errors.push(
            `${where}: "${category}" is not a plural form of ${lang} (it has ${categories.join(', ')}).`,
          );
        }
      }
      if (object[key] !== '') {
        const problem = tagProblem(object[key]);
        if (problem) errors.push(`${where}: ${problem}`);
      }
    }
  }
  const check = (key, required, allowed) => {
    cov.total++;
    const value = object[key];
    if (value === undefined || value === '') {
      cov.missing.push(`${ns}:${key}`);
      return;
    }
    cov.translated++;
    if (lang !== SOURCE_LOCALE)
      compareTokens(`${entry.path}: "${key}"`, tokensOf(value), required, allowed, errors);
  };
  for (const [key, enValue] of shape.plain) check(key, tokensOf(enValue), tokensOf(enValue));
  for (const [base, enForms] of shape.groups) {
    const allowed = [...new Set([...enForms.values()].flatMap((v) => tokensOf(v)))].sort();
    for (const category of categories)
      check(
        `${base}_${category}`,
        tokensOf(enForms.get(category) ?? enForms.get('other')),
        allowed,
      );
  }
}

/**
 * Checks the catalog files (`readCatalogFiles()`). Errors are rules the tests enforce; `coverage` is what Weblate still has to fill
 * (never an error). A plural message needs, in each language, the forms that language uses (French: one, many, other).
 * Placeholders and tags: a plain message must have exactly English's; a plural form must have the tokens of the English form of the same
 * category (or of `other`) and nothing English's group does not have.
 */
export function checkCatalogs(files, { languages = localeCodes } = {}) {
  const errors = [];
  const parsed = parseFiles(files, languages, errors);
  const english = new Map();
  const coverage = {};
  for (const lang of languages) coverage[lang] = { total: 0, translated: 0, missing: [] };
  for (const [ns, byLang] of parsed) {
    const source = byLang.get(SOURCE_LOCALE);
    if (!source) {
      errors.push(
        `locales/${ns}: has no ${SOURCE_LOCALE}.json. English is the source: every namespace needs it.`,
      );
      continue;
    }
    const shape = shapeOf(source.object);
    english.set(ns, shape);
    checkSource(source, shape, errors);
    for (const lang of languages)
      checkTranslation(ns, lang, byLang.get(lang), shape, coverage[lang], errors);
  }
  return { errors, warnings: [], coverage, english };
}

// ---------------------------------------------------------------------------------------------
// Source scan: the keys the code uses

/** Blanks comments but keeps every newline, so line numbers stay true. */
export function stripComments(text, svelte = false) {
  const blank = (match) => match.replace(/[^\n]/g, ' ');
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (svelte) out = out.replace(/<!--[\s\S]*?-->/g, blank);
  return out.replace(/(^|[\s;,{}()])\/\/[^\n]*/g, (m, lead) => lead + blank(m.slice(lead.length)));
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** Reads a quoted string starting at `start` (the opening quote). Returns `{ value, end, dynamic }` or null. */
function readString(text, start) {
  const quote = text[start];
  let value = '';
  let i = start + 1;
  let dynamic = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      value += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === quote) return { value, end: i + 1, dynamic };
    if (quote === '`' && ch === '$' && text[i + 1] === '{') dynamic = true;
    if (ch === '\n' && quote !== '`') return null;
    value += ch;
    i++;
  }
  return null;
}

/** The text of a call's first argument, up to the `,` or `)` that ends it. */
function readArgument(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const str = readString(text, i);
      if (str) {
        i = str.end - 1;
        continue;
      }
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return text.slice(start, i).trim();
      depth--;
    } else if (ch === ',' && depth === 0) return text.slice(start, i).trim();
  }
  return text.slice(start).trim();
}

/** `labels[status]`, `option.label`, `KEY`: a reference to a value that was made with `k('ns:key')`, not a key built at run time. */
const REFERENCE = /^[A-Za-z_$][\w$]*(\s*\?*\.\s*[A-Za-z_$][\w$]*|\[[^\][]*\])*$/;

/**
 * `t(byFamily(platform, { apple: k('ns:a'), google: k('ns:b') }))` and `t(x ? k('ns:a') : k('ns:b'))`: the expression holds
 * `k('ns:key')` literals and builds no text, so every key it can read is written out and is seen as used.
 */
const KEYS_FROM_K = /^(?![\s\S]*\$\{)(?=[\s\S]*\bk\(\s*['"][a-z][\w-]*:[^'"]+['"]\s*\))[\s\S]*$/;

const CALL = /(?<![\w$.])(t|k)\(\s*/g;
const TAG_KEY_LITERAL =
  /<T\s[^>]*?\bkey\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(['"`])([^'"`$]*)\3\s*\})/g;
const TAG_KEY_ANY = /<T\s[^>]*?\bkey\s*=\s*/g;

/**
 * Finds `t('ns:key')`, `k('ns:key')` and `<T key="ns:key">` in source files (`[{ path, text }]`). `literals` are keys read as
 * written; `indirect` are `t(map[x])` calls, which are fine when the map's values come from `k('ns:key')`; `dynamic` are keys built
 * at run time (a template literal, a concatenation, a call): avoid them.
 */
export function scanKeyUsage(files) {
  const literals = [];
  const dynamic = [];
  const indirect = [];
  for (const file of files) {
    const svelte = file.path.endsWith('.svelte');
    const text = stripComments(file.text, svelte);
    CALL.lastIndex = 0;
    for (let m = CALL.exec(text); m; m = CALL.exec(text)) {
      const at = CALL.lastIndex;
      const ch = text[at];
      if (ch === ')' || ch === undefined) continue;
      const line = lineAt(text, m.index);
      if (ch === "'" || ch === '"' || ch === '`') {
        const str = readString(text, at);
        if (str && !str.dynamic && /^\s*[,)]/.test(text.slice(str.end, str.end + 20))) {
          literals.push({ key: str.value, path: file.path, line, kind: m[1] });
          continue;
        }
      }
      const argument = readArgument(text, at);
      const entry = {
        path: file.path,
        line,
        text: text
          .slice(m.index, m.index + 60)
          .split('\n')[0]
          .trim(),
      };
      if (m[1] === 't' && (REFERENCE.test(argument) || KEYS_FROM_K.test(argument)))
        indirect.push(entry);
      else dynamic.push(entry);
    }
    if (!svelte) continue;
    const seen = new Set();
    TAG_KEY_LITERAL.lastIndex = 0;
    for (let m = TAG_KEY_LITERAL.exec(text); m; m = TAG_KEY_LITERAL.exec(text)) {
      seen.add(m.index);
      literals.push({
        key: m[1] ?? m[2] ?? m[4],
        path: file.path,
        line: lineAt(text, m.index),
        kind: 'T',
      });
    }
    TAG_KEY_ANY.lastIndex = 0;
    for (let m = TAG_KEY_ANY.exec(text); m; m = TAG_KEY_ANY.exec(text)) {
      if (seen.has(m.index)) continue;
      dynamic.push({
        path: file.path,
        line: lineAt(text, m.index),
        text: text
          .slice(m.index, m.index + 60)
          .split('\n')[0]
          .trim(),
      });
    }
  }
  return { literals, dynamic, indirect };
}

/** The `.ts` and `.svelte` files of the web source that count as usage (not tests, not the runtime itself). */
export function readSourceFiles(dir = SRC_DIR) {
  const skip = `${join(dir, 'lib', 'i18n')}${sep}`;
  return walk(
    dir,
    (f) => /\.(ts|svelte)$/.test(f) && !f.endsWith('.test.ts') && !f.startsWith(skip),
  ).map((full) => ({
    path: rel(full),
    text: readFileSync(full, 'utf8'),
  }));
}

const hasTag = (value) => tokensOf(value).some((token) => token.startsWith('<'));

/** Compares the keys the source uses with the English catalogs (`english` is `checkCatalogs(...).english`). */
export function checkUsage(usage, english) {
  const errors = [];
  const warnings = [];
  const used = new Set();
  const tagged = new Set();
  for (const [ns, shape] of english) {
    for (const [key, value] of shape.plain) if (hasTag(value)) tagged.add(`${ns}:${key}`);
    for (const [base, forms] of shape.groups)
      if ([...forms.values()].some(hasTag)) tagged.add(`${ns}:${base}`);
  }
  for (const use of usage.literals) {
    const where = `${use.path}:${use.line}`;
    const parts = splitKey(use.key);
    if (!parts) {
      errors.push(`${where}: "${use.key}" has no namespace. Write 'ns:key'.`);
      continue;
    }
    const shape = english.get(parts.ns);
    if (!shape) {
      errors.push(`${where}: namespace "${parts.ns}" has no locales/${parts.ns}/en.json.`);
      continue;
    }
    if (!shape.plain.has(parts.key) && !shape.groups.has(parts.key)) {
      errors.push(`${where}: "${use.key}" is not in locales/${parts.ns}/en.json.`);
      continue;
    }
    used.add(use.key);
    if (use.kind === 't' && tagged.has(use.key))
      errors.push(
        `${where}: "${use.key}" contains tags: render it with <T key="${use.key}" tags={{ ... }} />, not t().`,
      );
  }
  for (const d of usage.dynamic)
    warnings.push(
      `${d.path}:${d.line}: key is not a literal (${d.text}). Keep literal keys in a typed map with k('ns:key') and call t(map[x]).`,
    );
  const unused = [];
  for (const [ns, shape] of english) {
    // `errors` keys are looked up by the code the server sends (error-text.ts builds `errors:<code>` at run time), so no
    // source file names them: they cannot be reported as unused.
    if (ns === 'errors') continue;
    for (const key of [...shape.plain.keys(), ...shape.groups.keys()])
      if (!used.has(`${ns}:${key}`)) unused.push(`${ns}:${key}`);
  }
  return { errors, warnings, unused: unused.sort(), indirect: usage.indirect ?? [] };
}

/** Everything `pnpm i18n:check` does. With `strict`, an English key that nothing uses is an error. */
export function runCheck({ strict = false } = {}) {
  const catalogs = checkCatalogs(readCatalogFiles());
  const usage = checkUsage(scanKeyUsage(readSourceFiles()), catalogs.english);
  // The server's catalogs (emails) and the desktop's (menus) follow the same rules; their keys are read by their own code, so they are
  // checked as catalogs only, not against the web sources.
  const server = checkCatalogs(readCatalogFiles(join(ROOT, 'apps/server/locales')));
  const desktop = checkCatalogs(readCatalogFiles(join(ROOT, 'apps/desktop/locales')));
  const errors = [...catalogs.errors, ...server.errors, ...desktop.errors, ...usage.errors];
  if (strict) for (const key of usage.unused) errors.push(`${key} is in English but never used.`);
  return {
    errors,
    warnings: usage.warnings,
    unused: usage.unused,
    indirect: usage.indirect,
    coverage: catalogs.coverage,
  };
}

// ---------------------------------------------------------------------------------------------
// Scan: user-visible hard-coded strings

/** The namespace each area of the source is proposed to belong to (docs/i18n.md, "Namespace plan"). */
const COMPONENT_DIRS = {
  ui: 'common',
  ai: 'ai',
  alerts: 'workspace',
  analytics: 'analytics',
  app: 'app',
  aso: 'aso',
  assets: 'assets',
  automation: 'workspace',
  builds: 'builds',
  chat: 'chat',
  ci: 'builds',
  credentials: 'credentials',
  dashboard: 'app',
  eas: 'eas',
  experiments: 'experiments',
  listing: 'listing',
  members: 'workspace',
  portfolio: 'portfolio',
  products: 'products',
  publish: 'publish',
  release: 'release',
  repositories: 'repositories',
  revenuecat: 'products',
  reviews: 'reviews',
  settings: 'settings',
  tokens: 'workspace',
  webhooks: 'workspace',
};
const COMPONENT_ROOT = {
  'Shell.svelte': 'shell',
  'AuthCard.svelte': 'auth',
  'Login.svelte': 'auth',
  'LoginSecondFactor.svelte': 'auth',
  'Setup.svelte': 'auth',
  'AcceptInvite.svelte': 'auth',
  'LaunchRequired.svelte': 'auth',
  'TotpSetup.svelte': 'auth',
  'StepUpDialog.svelte': 'auth',
  'StepUpHost.svelte': 'auth',
  'Alerts.svelte': 'workspace',
  'Audit.svelte': 'workspace',
  'Chat.svelte': 'chat',
  'Members.svelte': 'workspace',
  'Tokens.svelte': 'workspace',
  'Webhooks.svelte': 'workspace',
  'Credentials.svelte': 'credentials',
  'Portfolio.svelte': 'portfolio',
  'Repositories.svelte': 'repositories',
  'Settings.svelte': 'settings',
  'Workflows.svelte': 'builds',
  'QrCode.svelte': 'common',
  'SecretFields.svelte': 'common',
};
const LIB_DIRS = {
  ai: 'ai',
  alerts: 'workspace',
  analytics: 'analytics',
  aso: 'aso',
  assets: 'assets',
  chat: 'chat',
  ci: 'builds',
  eas: 'eas',
  experiments: 'experiments',
  listing: 'listing',
  revenuecat: 'products',
  reviews: 'reviews',
};
const LIB_ROOT_PREFIX = [
  [/^app-|^dashboard|^next-step|^pending|^pipeline-store|^platform-logos/, 'app'],
  [
    /^address|^breadcrumb|^nav-|^shortcuts|^views|^scroll-keep|^section-|^disclosure-state|^demo|^role-label|^page-lead|^toast|^floating|^fit-viewport|^virtual-anchor|^popover-place|^split-view|^readab|^theme/,
    'shell',
  ],
  [/^auth-copy|^two-factor|^step-up/, 'auth'],
  [/^api-tokens|^tokens|^webhooks|^mcp|^format\./, 'workspace'],
  [/^builds|^clone-upkeep|^running/, 'builds'],
  [/^staged|^change-set/, 'publish'],
  [/^release|^start-release|^store-|^play-/, 'release'],
  [/^settings/, 'settings'],
  [/^credentials/, 'credentials'],
  [/^portfolio/, 'portfolio'],
  [/^products/, 'products'],
  [/^experiments/, 'experiments'],
  [/^repositor/, 'repositories'],
];

/** The proposed namespace of a source file (a path relative to the repository), `common` when no area claims it. */
export function namespaceOfSource(path) {
  const inside = path.replace(/^apps\/web\/src\//, '');
  if (inside === 'App.svelte') return 'shell';
  let m = /^components\/([^/]+)\/.+/.exec(inside);
  if (m) return COMPONENT_DIRS[m[1]] ?? 'common';
  m = /^components\/([^/]+)$/.exec(inside);
  if (m) return COMPONENT_ROOT[m[1]] ?? 'common';
  m = /^lib\/([^/]+)\/.+/.exec(inside);
  if (m) return LIB_DIRS[m[1]] ?? 'common';
  m = /^lib\/([^/]+)$/.exec(inside);
  if (m) for (const [pattern, ns] of LIB_ROOT_PREFIX) if (pattern.test(m[1])) return ns;
  return 'common';
}

const HTML_ATTRS = [
  'title',
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'placeholder',
  'alt',
];
const PROP_NAMES = [
  'title',
  'label',
  'description',
  'subtitle',
  'placeholder',
  'hint',
  'summary',
  'message',
  'text',
  'heading',
  'caption',
  'emptyText',
  'helper',
  'tooltip',
  'tip',
  'alt',
  'ariaLabel',
  'error',
  'notice',
  'lead',
  'eyebrow',
  'legend',
  'detail',
  'aria-label',
];
const SKIP_ELEMENTS = ['code', 'kbd', 'pre', 'svg', 'style', 'script'];

const hasWords = (s) => /[A-Za-zÀ-ɏ]{2,}/.test(s);

/** A literal that reads like text for a person, not like code, a class name, an enum value or a path. */
const looksLikeText = (s) => {
  const v = s.trim();
  if (!hasWords(v)) return false;
  if (/^[a-z][a-z0-9_:./#?&=%-]*$/.test(v)) return false;
  if (/^[a-z][a-z0-9-]*:[A-Za-z0-9_.]+$/.test(v)) return false;
  if (/^(https?:|\/|#|\.|--|@)/.test(v)) return false;
  return /\s/.test(v) || /^[A-Z]/.test(v);
};

const blank = (m) => m.replace(/[^\n]/g, ' ');

/** String literals in a piece of expression text, skipping the arguments of t() and k(). */
function literalsIn(expr) {
  const found = [];
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch !== "'" && ch !== '"' && ch !== '`') continue;
    const str = readString(expr, i);
    if (!str) continue;
    if (!/(?<![\w$.])[tk]\(\s*$/.test(expr.slice(Math.max(0, i - 6), i)))
      found.push(ch === '`' ? str.value.replace(/\$\{[^}]*\}/g, ' ') : str.value);
    i = str.end - 1;
  }
  return found;
}

/** The index after the `}` that closes the `{` at `start`. */
function braceEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const str = readString(text, i);
      if (str) {
        i = str.end - 1;
        continue;
      }
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return text.length;
}

function scanTag(tag, at, add) {
  const name = /^([A-Za-z][\w.:-]*)/.exec(tag)?.[1] ?? '';
  const names = /^[A-Z]/.test(name) ? PROP_NAMES : HTML_ATTRS;
  const pattern = /([A-Za-z][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|\{)/g;
  for (let a = pattern.exec(tag); a; a = pattern.exec(tag)) {
    if (!names.includes(a[1])) continue;
    if (a[2] === '{') {
      const open = a.index + a[0].length - 1;
      const end = braceEnd(tag, open);
      for (const literal of literalsIn(tag.slice(open + 1, end - 1)))
        if (looksLikeText(literal)) add(at, 'attr', `${a[1]}: ${literal}`);
      pattern.lastIndex = end;
    } else {
      const value = a[3] ?? a[4] ?? '';
      if (hasWords(value.replace(/\{[^}]*\}/g, ' '))) add(at, 'attr', `${a[1]}: ${value}`);
    }
  }
}

/** Heuristic list of user-visible hard-coded strings in one Svelte component: `[{ line, kind, text }]` (text nodes, attributes, literals in `{}`). */
export function scanSvelte(source) {
  let text = source.replace(/<!--[\s\S]*?-->/g, blank);
  for (const name of SKIP_ELEMENTS)
    text = text.replace(new RegExp(`<${name}(\\s[^>]*)?>[\\s\\S]*?</${name}>`, 'g'), blank);
  const items = [];
  const add = (index, kind, value) =>
    items.push({
      line: lineAt(text, index),
      kind,
      text: value.replace(/\s+/g, ' ').trim().slice(0, 70),
    });
  let i = 0;
  let run = '';
  let runStart = 0;
  const flush = () => {
    if (hasWords(run.replace(/&[a-z#0-9]+;/gi, ' '))) add(runStart, 'text', run);
    run = '';
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      const end = braceEnd(text, i);
      const inner = text.slice(i + 1, end - 1);
      if (!/^\s*[#:/@]/.test(inner))
        for (const literal of literalsIn(inner))
          if (looksLikeText(literal)) add(i, 'expr', literal);
      i = end;
      continue;
    }
    if (ch === '<' && /[A-Za-z/]/.test(text[i + 1] ?? '')) {
      flush();
      let j = i + 1;
      while (j < text.length && text[j] !== '>') {
        if (text[j] === '"' || text[j] === "'") j = readString(text, j)?.end ?? j + 1;
        else if (text[j] === '{') j = braceEnd(text, j);
        else j++;
      }
      const tag = text.slice(i + 1, j);
      if (!tag.startsWith('/')) scanTag(tag, i, add);
      i = j + 1;
      continue;
    }
    if (run === '') runStart = i;
    run += ch;
    i++;
  }
  flush();
  return items;
}

/** String literals in lib code that read like a sentence or a label (two words or more): a rough guide to what still needs a key. */
export function scanLib(source) {
  const text = stripComments(source);
  const items = [];
  const pattern = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ').trim();
    if (!/[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(value)) continue;
    if (/^[a-z]/.test(value) && !/[.!?]$/.test(value)) continue;
    const from = text.lastIndexOf('\n', m.index) + 1;
    const to = text.indexOf('\n', m.index);
    if (
      /^\s*(import|export .* from)\b|console\.|throw new Error|assert/.test(
        text.slice(from, to < 0 ? text.length : to),
      )
    )
      continue;
    items.push({ line: lineAt(text, m.index), kind: 'string', text: value.slice(0, 70) });
  }
  return items;
}

/**
 * What the scan does not report, on purpose (docs/i18n.md, "Intentionally not translated"). Files whose strings are data or developer
 * tooling, and single items that are product names or sample values.
 */
const NOT_TRANSLATED_FILES = [
  // SVG path data, not words.
  /\/src\/lib\/icons\.ts$/,
  // Developer-only page that lists every icon with its name; it is not reachable from the product.
  /\/src\/components\/ui\/IconGallery\.svelte$/,
  // Demo data for the analytics tests and the demo mode: sample metric labels, not product text.
  /\/src\/lib\/analytics\/fixtures\.ts$/,
  // Code and config snippets that a person copies into another tool; they are not prose.
  /\/src\/lib\/mcp\.ts$/,
  /\/src\/lib\/webhooks\.ts$/,
  // A character-class regular expression the scan reads as text.
  /\/src\/lib\/app-icon\.ts$/,
];
/** Product and store names are the same in every language. */
const BRAND_NAME =
  /^(?:(?:Mac )?App Store(?: Connect)?|Google Play(?: Console)?|Play Console|Amazon Appstore|RevenueCat(?: Web Billing)?|TestFlight|EAS|SHA-256|ASO|Android|Android App Bundle \(\.aab\))$/;

/** True for an item that needs no key: a brand name, or a placeholder that is a sample path, address, locale or code. */
function isIntentional(item) {
  const value = item.kind === 'attr' ? item.text.replace(/^[\w-]+: /, '') : item.text;
  if (BRAND_NAME.test(value)) return true;
  return item.kind === 'attr' && item.text.startsWith('placeholder: ') && /^\S*[^A-Za-z\s]\S*$|[/@=:]|^MacBook Touch ID$/.test(value);
}

/** Scans every component and lib module: `[{ path, kind, ns, items, converted }]` (`converted` counts t() and <T> uses). */
export function runScan() {
  const rows = [];
  const accept = (f) =>
    (f.endsWith('.svelte') || f.endsWith('.ts')) &&
    !f.endsWith('.test.ts') &&
    !f.includes(`${sep}i18n${sep}`);
  for (const full of walk(SRC_DIR, accept)) {
    const path = rel(full);
    const svelte = full.endsWith('.svelte');
    if (!svelte && !path.includes('/src/lib/')) continue;
    const source = readFileSync(full, 'utf8');
    const converted = (
      stripComments(source, svelte).match(
        svelte ? /(?<![\w$.])t\(\s*['"`]|<T\s[^>]*\bkey\s*=/g : /(?<![\w$.])t\(\s*['"`]/g,
      ) ?? []
    ).length;
    rows.push({
      path,
      kind: svelte ? 'component' : 'lib',
      ns: namespaceOfSource(path),
      items: NOT_TRANSLATED_FILES.some((re) => re.test(`/${path}`))
        ? []
        : (svelte ? scanSvelte(source) : scanLib(source)).filter((item) => !isIntentional(item)),
      converted,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// CLI

const pad = (value, width) => String(value).padEnd(width);
const num = (value, width) => String(value).padStart(width);
const emptyTotals = () => ({
  components: 0,
  componentsDirty: 0,
  strings: 0,
  libFiles: 0,
  libDirty: 0,
  libStrings: 0,
  converted: 0,
});
const line = (label, n) =>
  `${pad(label, 14)}${num(n.components, 11)}${num(n.componentsDirty, 11)}${num(n.strings, 9)}${num(n.libFiles, 11)}${num(n.libDirty, 11)}${num(n.libStrings, 9)}${num(n.converted, 10)}`;

function printScan(rows, { files, items }) {
  const byNs = new Map();
  for (const row of rows) {
    if (!byNs.has(row.ns)) byNs.set(row.ns, emptyTotals());
    const n = byNs.get(row.ns);
    n.converted += row.converted;
    if (row.kind === 'component') {
      n.components++;
      n.componentsDirty += row.items.length > 0 ? 1 : 0;
      n.strings += row.items.length;
    } else {
      n.libFiles++;
      n.libDirty += row.items.length > 0 ? 1 : 0;
      n.libStrings += row.items.length;
    }
  }
  console.log(
    `${pad('namespace', 14)}${num('components', 11)}${num('with text', 11)}${num('strings', 9)}${num('lib files', 11)}${num('with text', 11)}${num('strings', 9)}${num('t() uses', 10)}`,
  );
  const total = emptyTotals();
  for (const [ns, n] of [...byNs].sort(
    (a, b) => b[1].strings + b[1].libStrings - (a[1].strings + a[1].libStrings),
  )) {
    console.log(line(ns, n));
    for (const key of Object.keys(total)) total[key] += n[key];
  }
  console.log(line('total', total));
  if (files) {
    console.log('\nstrings  namespace      file');
    for (const row of rows
      .filter((r) => r.items.length > 0)
      .sort((a, b) => b.items.length - a.items.length))
      console.log(`${num(row.items.length, 7)}  ${pad(row.ns, 13)} ${row.path}`);
  }
  if (items)
    for (const row of rows)
      for (const item of row.items)
        console.log(`${row.path}:${item.line} ${item.kind} ${item.text}`);
}

function fix() {
  let changed = 0;
  for (const file of [
    ...readCatalogFiles(),
    ...readCatalogFiles(join(ROOT, 'apps/server/locales')),
    ...readCatalogFiles(join(ROOT, 'apps/desktop/locales')),
  ]) {
    if (file.lang === null) continue;
    let value;
    try {
      value = JSON.parse(file.text);
    } catch (error) {
      console.error(`${file.path}: not valid JSON (${error.message}); fix it by hand.`);
      process.exitCode = 1;
      continue;
    }
    const text = canonicalText(value);
    if (text === file.text) continue;
    writeFileSync(join(ROOT, file.path), text);
    console.log(`formatted ${file.path}`);
    changed++;
  }
  console.log(
    changed === 0 ? 'All catalogs are already formatted.' : `Formatted ${changed} file(s).`,
  );
}

function check(flags) {
  const result = runCheck({ strict: flags.includes('--strict') });
  for (const lang of Object.keys(result.coverage)) {
    const c = result.coverage[lang];
    const percent = c.total === 0 ? 100 : Math.floor((c.translated / c.total) * 100);
    console.log(
      `${pad(lang, 4)}${num(percent, 4)}%  ${c.translated}/${c.total} messages${c.missing.length > 0 ? `, ${c.missing.length} still to translate` : ''}`,
    );
    if (flags.includes('--verbose'))
      for (const key of c.missing) console.log(`        missing ${key}`);
  }
  console.log(`\n${result.indirect.length} t(map[x]) call(s) read keys from k() maps.`);
  if (result.unused.length > 0)
    console.log(
      `Unused English keys (${result.unused.length}): ${result.unused.slice(0, 15).join(', ')}${result.unused.length > 15 ? ', ...' : ''}`,
    );
  if (result.warnings.length > 0)
    console.log(
      `\nWarnings (${result.warnings.length})\n${result.warnings.map((w) => `  ${w}`).join('\n')}`,
    );
  if (result.errors.length > 0) {
    console.error(
      `\nErrors (${result.errors.length})\n${result.errors.map((e) => `  ${e}`).join('\n')}`,
    );
    process.exitCode = 1;
  } else console.log('\nCatalogs are valid.');
}

function main(argv) {
  const [command = 'check', ...flags] = argv;
  if (command === 'fix') return fix();
  if (command === 'check') return check(flags);
  if (command === 'scan') {
    const rows = runScan();
    if (flags.includes('--json')) console.log(JSON.stringify(rows, null, 2));
    else printScan(rows, { files: flags.includes('--files'), items: flags.includes('--items') });
    return undefined;
  }
  console.error(
    'Usage: node scripts/i18n.mjs <check [--strict] [--verbose] | fix | scan [--files] [--items] [--json]>',
  );
  process.exitCode = 2;
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
