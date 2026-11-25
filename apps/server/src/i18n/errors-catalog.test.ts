import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CODE_PATTERN } from './problem.ts';
import { pluralCategory } from './runtime.ts';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (p: string) =>
  JSON.parse(readFileSync(join(REPO, p), 'utf8')) as Record<string, string>;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules' || n.startsWith('.')) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory()
      ? files(p)
      : /\.ts$/.test(n) && !/\.test\.ts$/.test(n)
        ? [p]
        : [];
  });

/** Every dot.case code written in the server and connector sources: `coded('a.b')` or `code: 'a.b'`. */
function usedCodes(): Set<string> {
  const found = new Set<string>();
  for (const dir of ['apps/server/src', 'packages/connectors/src']) {
    for (const file of files(join(REPO, dir))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(
        /(?:coded\(|code: )\s*'([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+)'/g,
      ))
        found.add(m[1] as string);
    }
  }
  return found;
}

const hasMessage = (catalog: Record<string, string>, code: string) =>
  [code, `${code}_one`, `${code}_other`].some(
    (k) => typeof catalog[k] === 'string' && catalog[k] !== '',
  );

test('every code the server can send has an English message in the web errors catalog', () => {
  const en = read('apps/web/locales/errors/en.json');
  const missing = [...usedCodes()].filter((c) => !hasMessage(en, c));
  assert.deepEqual(missing, []);
  assert.ok(usedCodes().size > 20);
});

test('every code is well formed', () => {
  for (const code of usedCodes()) assert.match(code, CODE_PATTERN);
});

test('the email catalogs have the same keys in every language and every key the server reads exists', () => {
  const en = read('apps/server/locales/email/en.json');
  for (const lang of ['fr', 'es', 'de']) {
    const other = read(`apps/server/locales/email/${lang}.json`);
    const base = (k: string) => k.replace(/_(one|many|other)$/, '');
    assert.deepEqual(
      [...new Set(Object.keys(other).map(base))].sort(),
      [...new Set(Object.keys(en).map(base))].sort(),
      lang,
    );
    for (const [key, value] of Object.entries(other)) {
      const place = (s: string) =>
        [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)]
          .map((m) => m[1])
          .sort()
          .join(',');
      const source = en[key] ?? en[key.replace(/_(one|many|other)$/, '_other')];
      assert.equal(place(value), place(source as string), `${lang}:${key}`);
    }
  }
  assert.equal(pluralCategory('en', 1), 'one');
  const used = new Set<string>();
  for (const dir of ['apps/server/src']) {
    for (const file of files(join(REPO, dir))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/'email:([A-Za-z0-9.]+)'/g))
        used.add(m[1] as string);
    }
  }
  for (const key of used) assert.ok(hasMessage(en, key), `email:${key}`);
});

/** The top-level comma-separated parts of `a, b: f(x, y), c` (brackets and quotes respected). */
function splitTop(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** Every `coded('a.b', { x, y: expr })` in the server sources: the code and the names of the params it passes. */
function codedCalls(): { code: string; keys: string[]; where: string }[] {
  const calls: { code: string; keys: string[]; where: string }[] = [];
  for (const file of files(join(REPO, 'apps/server/src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bcoded\(\s*'([a-z][A-Za-z0-9.]*)'\s*(,\s*\{)?/g)) {
      let keys: string[] = [];
      if (m[2]) {
        let depth = 1;
        let i = m.index + m[0].length;
        const from = i;
        for (; i < text.length && depth > 0; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') depth--;
        }
        keys = splitTop(text.slice(from, i - 1)).map((part) => {
          const name = /^([A-Za-z_]\w*)\s*(:|$)/.exec(part);
          return name ? (name[1] as string) : '?';
        });
      }
      calls.push({ code: m[1] as string, keys, where: file.slice(REPO.length) });
    }
  }
  return calls;
}

const placeholders = (s: string) =>
  [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1] as string);

test('every placeholder of an English message is passed by each coded() call that sends the code', () => {
  const en = read('apps/web/locales/errors/en.json');
  const calls = codedCalls();
  assert.ok(calls.length > 300, `found ${calls.length} coded() calls`);
  const problems: string[] = [];
  for (const { code, keys, where } of calls) {
    const texts = [code, `${code}_one`, `${code}_other`]
      .map((k) => en[k])
      .filter((t): t is string => typeof t === 'string');
    const needed = new Set(texts.flatMap(placeholders));
    // `wait` is the Retry-After the web app formats itself.
    for (const name of needed)
      if (name !== 'wait' && !keys.includes(name))
        problems.push(`${where}: ${code} needs {{${name}}}`);
  }
  assert.deepEqual(problems, []);
});

test('the four errors catalogs carry the same keys and placeholders for the codes the server sends', () => {
  const catalogs = Object.fromEntries(
    ['en', 'fr', 'es', 'de'].map((l) => [l, read(`apps/web/locales/errors/${l}.json`)]),
  ) as Record<string, Record<string, string>>;
  const en = catalogs.en as Record<string, string>;
  const base = (k: string) => k.replace(/_(one|many|other)$/, '');
  const problems: string[] = [];
  for (const code of usedCodes()) {
    for (const lang of ['fr', 'es', 'de']) {
      const other = catalogs[lang] as Record<string, string>;
      if (!hasMessage(other, code)) {
        problems.push(`${lang}: ${code} is missing`);
        continue;
      }
      const wanted = [...new Set(placeholders([en[code], en[`${code}_other`]].join(' ')))].sort();
      for (const key of [code, `${code}_one`, `${code}_other`]) {
        const text = other[key];
        if (typeof text !== 'string') continue;
        const got = [...new Set(placeholders(text))].sort();
        if (got.join() !== wanted.join()) problems.push(`${lang}:${key} has ${got} not ${wanted}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(Object.keys(en).some((k) => base(k) === 'rate.requests'));
});
