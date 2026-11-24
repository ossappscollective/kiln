#!/usr/bin/env node
// Dependency-free check of README.md and the community files:
//   - every relative Markdown link resolves to an existing path (or is on the allowlist),
//   - every `pnpm <script>` / `pnpm --filter <pkg> <script>` in README.md exists in a package.json,
//   - code fences are closed and tables have a consistent column count.
// Usage: node scripts/check-readme-links.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Paths produced elsewhere (release and website work) or by the maintainer later.
const allow = new Set([
  'docs/releasing.md',
  'docs/website.md',
  'docs/assets/screenshots/',
  'docs/assets/screenshots',
]);
// The images of the README Screenshots section come from `pnpm screenshots` (scripts/screenshots), so they do not exist until the maintainer runs it.
// Listed one by one: a typo in any other file name still fails the check.
const generated = [
  '02-app-overview',
  '04-store-listing',
  '06-pending-changes',
  '08-reviews-inbox',
].flatMap((n) => [
  `docs/assets/screenshots/${n}-dark.png`,
  `docs/assets/screenshots/${n}-light.png`,
]);
for (const g of generated) allow.add(g);
const files = ['README.md', 'CODE_OF_CONDUCT.md', '.github/PULL_REQUEST_TEMPLATE.md'];
const errors = [];

function lintMarkdown(file, text) {
  let fence = null;
  const lines = text.split('\n');
  let tableCols = null;
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (m) {
      if (fence === null) fence = m[1];
      else if (m[1].startsWith(fence[0]) && m[1].length >= fence.length) fence = null;
      return;
    }
    if (fence !== null) return;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cols =
        line
          .replace(/\\\|/g, '')
          .replace(/`[^`]*`/g, '')
          .split('|').length - 2;
      if (tableCols === null) tableCols = cols;
      else if (cols !== tableCols)
        errors.push(`${file}:${i + 1}: table row has ${cols} columns, expected ${tableCols}`);
    } else tableCols = null;
  });
  if (fence !== null) errors.push(`${file}: unclosed code fence (${fence})`);
  const open = (text.match(/<details/g) || []).length;
  const close = (text.match(/<\/details>/g) || []).length;
  if (open !== close) errors.push(`${file}: ${open} <details> but ${close} </details>`);
}

function checkLinks(file, text) {
  const stripped = text.replace(/```[\s\S]*?```/g, '');
  const targets = [];
  for (const m of stripped.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.push(m[1]);
  for (const m of stripped.matchAll(/(?:src|srcset|href)="([^"]+)"/g)) targets.push(m[1]);
  for (const t of targets) {
    if (/^(https?:|mailto:|#)/.test(t)) continue;
    const path = decodeURIComponent(t.split('#')[0].split('?')[0]);
    if (!path) continue;
    const rel = join(dirname(file), path).replace(/\\/g, '/');
    if (allow.has(rel)) continue;
    if (!existsSync(join(root, rel))) errors.push(`${file}: broken link ${t}`);
  }
}

function packageScripts() {
  const map = new Map(); // package name -> scripts
  const dirs = [
    '.',
    ...['apps', 'packages'].flatMap((d) => readdirSync(join(root, d)).map((n) => `${d}/${n}`)),
  ];
  for (const d of dirs) {
    const p = join(root, d, 'package.json');
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    map.set(j.name, j.scripts ?? {});
  }
  return map;
}

function checkCommands(file, text) {
  const pkgs = packageScripts();
  const rootScripts = pkgs.get('kiln') ?? {};
  const builtin = new Set([
    'install',
    'add',
    'exec',
    'dlx',
    'run',
    'create',
    'update',
    'store',
    'rebuild',
  ]);
  for (const m of text.matchAll(/pnpm\s+(?:--filter\s+(\S+)\s+)?([a-z][\w:.-]*)/g)) {
    const [, filter, script] = m;
    if (filter) {
      const scripts = pkgs.get(filter);
      if (!scripts) errors.push(`${file}: unknown package ${filter}`);
      else if (!(script in scripts) && !builtin.has(script))
        errors.push(`${file}: ${filter} has no script "${script}"`);
    } else if (!(script in rootScripts) && !builtin.has(script))
      errors.push(`${file}: root package.json has no script "${script}"`);
  }
  for (const m of text.matchAll(/node (scripts\/[\w./-]+)/g)) {
    if (!existsSync(join(root, m[1]))) errors.push(`${file}: missing ${m[1]}`);
  }
  for (const m of text.matchAll(/docker compose -f (\S+)/g)) {
    if (!existsSync(join(root, m[1]))) errors.push(`${file}: missing ${m[1]}`);
  }
}

for (const f of files) {
  const p = join(root, f);
  if (!existsSync(p)) {
    errors.push(`${f}: file is missing`);
    continue;
  }
  const text = readFileSync(p, 'utf8');
  lintMarkdown(f, text);
  checkLinks(f, text);
  if (f === 'README.md') checkCommands(f, text);
}
for (const f of [
  'docs/assets/logo.svg',
  'docs/assets/logo-dark.svg',
  '.env.example',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
]) {
  if (!existsSync(join(root, f))) errors.push(`${f}: missing`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`ok: ${files.length} files checked`);
