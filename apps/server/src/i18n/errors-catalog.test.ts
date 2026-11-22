import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CODE_PATTERN } from './problem.ts';
import { pluralCategory } from './runtime.ts';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(join(REPO, p), 'utf8')) as Record<string, string>;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules' || n.startsWith('.')) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });

/** Every dot.case code written in the server and connector sources: `coded('a.b')` or `code: 'a.b'`. */
function usedCodes(): Set<string> {
  const found = new Set<string>();
  for (const dir of ['apps/server/src', 'packages/connectors/src']) {
    for (const file of files(join(REPO, dir))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:coded\(|code: )\s*'([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+)'/g)) found.add(m[1] as string);
    }
  }
  return found;
}

const hasMessage = (catalog: Record<string, string>, code: string) =>
  [code, `${code}_one`, `${code}_other`].some((k) => typeof catalog[k] === 'string' && catalog[k] !== '');

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
    const base = (k: string) => k.replace(/_(one|other)$/, '');
    assert.deepEqual([...new Set(Object.keys(other).map(base))].sort(), [...new Set(Object.keys(en).map(base))].sort(), lang);
    for (const [key, value] of Object.entries(other)) {
      const place = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');
      const source = en[key] ?? en[key.replace(/_(one|other)$/, '_other')];
      assert.equal(place(value), place(source as string), `${lang}:${key}`);
    }
  }
  assert.equal(pluralCategory('en', 1), 'one');
  const used = new Set<string>();
  for (const dir of ['apps/server/src']) {
    for (const file of files(join(REPO, dir))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/'email:([A-Za-z0-9.]+)'/g)) used.add(m[1] as string);
    }
  }
  for (const key of used) assert.ok(hasMessage(en, key), `email:${key}`);
});
