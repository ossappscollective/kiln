// Shared by the build tests: build once into a temp folder, and a tiny HTML scanner (no dependencies).
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from '../build.mjs';
import { site } from '../lib/config.mjs';

let cached;
export function builtSite() {
  if (!cached) {
    const outDir = mkdtempSync(path.join(tmpdir(), 'kiln-site-'));
    cached = { ...build({ outDir }), outDir };
  }
  return cached;
}

export function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

export function htmlFiles(outDir) {
  return walk(outDir).filter((f) => f.endsWith('.html'));
}

/** Remove the bodies of <script> and <style> so their text is not scanned as markup. */
export function stripRaw(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');
}

export function tags(html) {
  const out = [];
  const re = /<([a-z][a-z0-9-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  for (const m of stripRaw(html).matchAll(re)) {
    const attrs = {};
    for (const a of m[2].matchAll(/([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    out.push({ name: m[1].toLowerCase(), attrs });
  }
  return out;
}

export function ids(html) {
  return tags(html)
    .map((t) => t.attrs.id)
    .filter((v) => v !== undefined);
}

export function decodeAttr(v) {
  return v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const base = new URL(site.siteUrl).pathname;

/** Resolve an internal reference found in `file` (relative to dist) to a file of dist, or null when external. */
export function resolveInternal(outDir, file, ref) {
  const raw = decodeAttr(ref).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  const [pathPart, hash = ''] = raw.split('#');
  let target;
  if (pathPart === '') target = file;
  else if (pathPart.startsWith('/')) target = path.posix.normalize(pathPart.startsWith(base) ? pathPart.slice(base.length) : pathPart.slice(1));
  else target = path.posix.normalize(path.posix.join(path.posix.dirname(file.split(path.sep).join('/')), pathPart));
  const candidates = [target, path.posix.join(target, 'index.html')];
  const found = candidates.find((c) => c !== '' && c !== '.' && existsSync(path.join(outDir, c)) && statSync(path.join(outDir, c)).isFile());
  const resolved = found ?? (target === '' || target === '.' ? 'index.html' : null);
  return { target: resolved, hash, raw };
}

export function read(outDir, rel) {
  return readFileSync(path.join(outDir, rel), 'utf8');
}
