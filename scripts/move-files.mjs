#!/usr/bin/env node
// Moves files with `git mv` and rewrites every relative import that points at them (and the moved files' own
// relative imports), so a folder can be reorganised without breaking the build.
//
//   node scripts/move-files.mjs <root> from=to [from=to ...]
//
// <root> is the package source folder (for example apps/server/src); paths are relative to it. Only
// `from '...'`, `import('...')` and `export ... from '...'` specifiers that are relative and end in .ts or .svelte are
// handled. Run the type check afterwards: it is the proof that nothing was missed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const [root, ...pairs] = process.argv.slice(2);
if (!root || pairs.length === 0) {
  console.error('usage: node scripts/move-files.mjs <root> from=to [from=to ...]');
  process.exit(2);
}
const base = resolve(root);
const moves = new Map(pairs.map((p) => p.split('=')).map(([a, b]) => [resolve(base, a), resolve(base, b)]));

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|svelte)$/.test(name)) out.push(p);
  }
  return out;
};
const files = walk(base);
const SPEC = /(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+\.(?:ts|svelte))\2/g;

const edits = new Map();
for (const file of files) {
  const newFile = moves.get(file) ?? file;
  const text = readFileSync(file, 'utf8');
  const next = text.replace(SPEC, (all, lead, quote, spec) => {
    const target = resolve(dirname(file), spec);
    const newTarget = moves.get(target) ?? target;
    if (newTarget === target && newFile === file) return all;
    let rel = relative(dirname(newFile), newTarget);
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${lead}${quote}${rel}${quote}`;
  });
  edits.set(file, next);
  if (next !== text) writeFileSync(file, next);
}
for (const [from, to] of moves) {
  mkdirSync(dirname(to), { recursive: true });
  execFileSync('git', ['mv', from, to]);
}
console.log(`moved ${moves.size} file(s)`);
