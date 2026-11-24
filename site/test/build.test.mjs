import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { composeSnippet, loadDocs, RUN_SNIPPET } from '../build.mjs';
import { docsGroups, site } from '../lib/config.mjs';
import { builtSite, htmlFiles, ids, read, resolveInternal, tags, walk } from './helpers.mjs';

const { outDir, routes } = builtSite();
const pages = htmlFiles(outDir);
const route = (file) => (file === 'index.html' ? '' : file === '404.html' ? '404.html' : file.replace(/index\.html$/, ''));

test('the build writes the expected files', () => {
  for (const f of ['index.html', '404.html', 'docs/index.html', 'sitemap.xml', 'robots.txt', 'search-index.json', '.nojekyll', 'assets/favicon.svg', 'assets/og.svg', 'assets/logo-mark.svg', 'css/tokens.css', 'js/site.js']) {
    assert.ok(existsSync(path.join(outDir, f)), `missing ${f}`);
  }
  assert.ok(existsSync(path.join(outDir, 'assets/og.png')), 'missing assets/og.png (run site/tools/render-og.py)');
  const docs = docsGroups.flatMap((g) => g.pages).filter((p) => !p.optional || existsSync(path.join(path.resolve(outDir, '../'), p.source)));
  assert.ok(pages.length >= 2 + 10, `only ${pages.length} pages`);
  assert.ok(docs.length > 0);
});

test('every page has a title, description, canonical, language, one h1 and landmarks', () => {
  for (const file of pages) {
    const html = read(outDir, file);
    const t = tags(html);
    assert.match(html, /<html lang="en">/, file);
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
    assert.ok(title && title.length >= 5 && title.length <= 90, `${file}: title "${title}"`);
    const desc = t.find((x) => x.name === 'meta' && x.attrs.name === 'description')?.attrs.content;
    assert.ok(desc && desc.length >= 20 && desc.length <= 300, `${file}: description (${desc?.length})`);
    const canonical = t.find((x) => x.name === 'link' && x.attrs.rel === 'canonical')?.attrs.href;
    assert.equal(canonical, `${site.siteUrl}${route(file)}`, `${file}: canonical`);
    for (const prop of ['og:title', 'og:description', 'og:url', 'og:image', 'og:type']) {
      assert.ok(t.some((x) => x.name === 'meta' && x.attrs.property === prop), `${file}: ${prop}`);
    }
    for (const name of ['twitter:card', 'twitter:title', 'twitter:image']) {
      assert.ok(t.some((x) => x.name === 'meta' && x.attrs.name === name), `${file}: ${name}`);
    }
    assert.equal(t.filter((x) => x.name === 'h1').length, 1, `${file}: h1 count`);
    assert.equal(t.filter((x) => x.name === 'main').length, 1, `${file}: main`);
    assert.ok(t.some((x) => x.name === 'header') && t.some((x) => x.name === 'footer'), `${file}: header/footer`);
    assert.ok(t.some((x) => x.name === 'a' && x.attrs.class === 'skip-link' && x.attrs.href === '#main'), `${file}: skip link`);
    assert.ok(html.includes('id="main"'), `${file}: #main`);
    if (!file.startsWith('docs/') || file === 'docs/index.html') assert.ok(!html.includes('{{'), `${file}: unfilled template`);
  }
});

test('ids are unique on every page', () => {
  for (const file of pages) {
    const all = ids(read(outDir, file));
    const dup = all.filter((id, i) => all.indexOf(id) !== i);
    assert.deepEqual([...new Set(dup)], [], `${file}: duplicate ids`);
  }
});

test('every internal link, script, stylesheet and image resolves to a built file (and fragment)', () => {
  const idCache = new Map();
  const idsOf = (rel) => {
    if (!idCache.has(rel)) idCache.set(rel, new Set(ids(read(outDir, rel))));
    return idCache.get(rel);
  };
  let checked = 0;
  const problems = [];
  for (const file of pages) {
    const html = read(outDir, file);
    for (const t of tags(html)) {
      const ref = t.name === 'a' || t.name === 'link' ? t.attrs.href : t.name === 'script' || t.name === 'img' ? t.attrs.src : undefined;
      if (ref === undefined) continue;
      if (t.name === 'link' && t.attrs.rel === 'canonical') continue;
      const res = resolveInternal(outDir, file, ref);
      if (res === null) continue; // external
      checked++;
      if (!res.target) problems.push(`${file}: "${ref}" does not resolve`);
      else if (res.hash && res.target.endsWith('.html') && !idsOf(res.target).has(decodeURIComponent(res.hash))) {
        problems.push(`${file}: "${ref}" has no target id #${res.hash}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked > 200, `only ${checked} references checked`);
});

test('pages load nothing from other origins: scripts, styles, images and icons are all local', () => {
  for (const file of pages) {
    for (const t of tags(read(outDir, file))) {
      const ref = t.name === 'script' || t.name === 'img' ? t.attrs.src : t.name === 'link' && t.attrs.rel !== 'canonical' ? t.attrs.href : undefined;
      if (ref === undefined) continue;
      assert.ok(!/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(ref), `${file}: external resource ${ref}`);
    }
  }
  for (const f of walk(outDir).filter((x) => x.endsWith('.css'))) {
    assert.ok(!/url\(\s*['"]?https?:/i.test(read(outDir, f)), `${f}: external url()`);
  }
});

test('images have alt text, and external links are noopener', () => {
  for (const file of pages) {
    for (const t of tags(read(outDir, file))) {
      if (t.name === 'img') assert.ok('alt' in t.attrs, `${file}: img without alt`);
      if (t.name === 'a' && /^https?:/.test(t.attrs.href ?? '') && t.attrs.target === '_blank') assert.match(t.attrs.rel ?? '', /noopener/, file);
    }
  }
});

test('docs pages: one aria-current in the sidebar, previous and next, contents and a page title', () => {
  const docPages = pages.filter((f) => f.startsWith('docs/') && f !== 'docs/index.html');
  assert.ok(docPages.length >= 10);
  for (const file of docPages) {
    const html = read(outDir, file);
    const current = tags(html).filter((t) => t.name === 'a' && t.attrs['aria-current'] === 'page' && /docs-side|^\.\.\/\.\.\/docs\//.test(t.attrs.href));
    assert.ok(current.length >= 1, `${file}: no aria-current in the sidebar`);
    assert.ok(html.includes('class="pager"'), `${file}: pager`);
    assert.ok(html.includes('id="doc-search"'), `${file}: search box`);
  }
});

test('sitemap.xml lists every page except 404 and nothing else', () => {
  const xml = read(outDir, 'sitemap.xml');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const expected = pages.filter((f) => f !== '404.html').map((f) => `${site.siteUrl}${route(f)}`);
  assert.deepEqual([...locs].sort(), expected.sort());
  assert.deepEqual([...routes].map((r) => `${site.siteUrl}${r}`).sort(), expected.sort());
  assert.ok(!xml.includes('404'));
  assert.match(read(outDir, 'robots.txt'), new RegExp(`Sitemap: ${site.siteUrl}sitemap.xml`));
});

test('404.html works at any depth: absolute paths under the base path', () => {
  const html = read(outDir, '404.html');
  const base = new URL(site.siteUrl).pathname;
  for (const t of tags(html)) {
    const ref = t.name === 'script' ? t.attrs.src : t.name === 'link' && t.attrs.rel !== 'canonical' ? t.attrs.href : t.name === 'img' ? t.attrs.src : undefined;
    if (ref !== undefined) assert.ok(ref.startsWith(base), `404 uses ${ref}`);
  }
  assert.match(html, /<meta name="robots" content="noindex">/);
});

test('the search index points at real pages and headings', () => {
  const index = JSON.parse(read(outDir, 'search-index.json'));
  assert.ok(index.entries.length > 50);
  for (const [title, url] of index.entries) {
    assert.ok(title);
    const [p, hash] = url.split('#');
    const file = path.posix.join(p, 'index.html');
    assert.ok(existsSync(path.join(outDir, file)), `search entry ${url}`);
    if (hash) assert.ok(new Set(ids(read(outDir, file))).has(hash), `search entry ${url}: no #${hash}`);
  }
  for (const list of Object.values(index.terms)) for (const i of list) assert.ok(index.entries[i]);
});

test('JSON-LD on the home page is valid SoftwareApplication data without invented ratings', () => {
  const html = read(outDir, 'index.html');
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m);
  const data = JSON.parse(m[1]);
  assert.equal(data['@type'], 'SoftwareApplication');
  assert.equal(data.license, 'https://www.apache.org/licenses/LICENSE-2.0');
  assert.ok(!('aggregateRating' in data) && !('review' in data));
});

test('home page: sections, download cards, snippets built from the repository', () => {
  const html = read(outDir, 'index.html');
  for (const id of ['features', 'how-it-works', 'security', 'download', 'self-host', 'docs']) assert.ok(html.includes(`id="${id}"`), id);
  for (const target of ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64']) assert.ok(html.includes(`data-target="${target}"`), target);
  assert.ok(html.includes('data-api="https://api.github.com/repos/ossappscollective/kiln/releases/latest"'));
  assert.ok(html.includes(`${site.repoUrl}/releases/latest`));
  assert.ok(html.includes('ghcr.io/ossappscollective/kiln'));
  assert.ok(html.includes('Not a screenshot'), 'the illustration is labelled');
  assert.ok(html.includes('KILN_MASTER_KEY'));
  assert.ok(html.includes('postgres:17'));
  assert.ok(!/build: \./.test(html), 'compose snippet still builds locally');
  const footer = /<footer[\s\S]*<\/footer>/.exec(html)[0];
  assert.match(footer, /Not affiliated|not affiliated/);
  assert.match(footer, /Apache/);
  assert.ok(footer.includes('docs/security/') && footer.includes('docs/contributing/'));
});

test('compose snippet: comments removed, local build replaced by the image, env names kept', () => {
  const out = composeSnippet('services:\n  app:\n    build: .\n    # a comment\n\n    environment:\n      KILN_MASTER_KEY: ${KILN_MASTER_KEY:?x}\n');
  assert.equal(out, `services:\n  app:\n    image: ${site.image}:latest\n    environment:\n      KILN_MASTER_KEY: \${KILN_MASTER_KEY:?x}`);
  assert.match(RUN_SNIPPET, /-e KILN_MASTER_KEY/);
});

test('loadDocs fails loudly on a missing required source and skips a missing optional one', () => {
  assert.throws(() => loadDocs({ groups: [{ title: 'x', pages: [{ slug: 'a', source: 'does/not/exist.md' }] }] }), /does not exist/);
  const r = loadDocs({ groups: [{ title: 'x', pages: [{ slug: 'a', source: 'does/not/exist.md', optional: true }, { slug: 'f', source: 'site/content/faq.md' }] }] });
  assert.deepEqual(r.pages.map((p) => p.slug), ['f']);
  assert.throws(() => loadDocs({ groups: [{ title: 'x', pages: [{ slug: 'f', source: 'site/content/faq.md' }, { slug: 'f', source: 'site/content/faq.md' }] }] }), /Duplicate/);
});

test('size budget: JavaScript is small, no single page is heavy', () => {
  const js = walk(outDir).filter((f) => f.endsWith('.js'));
  const jsBytes = js.reduce((n, f) => n + statSync(path.join(outDir, f)).size, 0);
  assert.ok(jsBytes < 30 * 1024, `JavaScript is ${jsBytes} bytes`);
  for (const f of pages) assert.ok(statSync(path.join(outDir, f)).size < 400 * 1024, `${f} is heavy`);
  for (const f of walk(outDir).filter((x) => x.endsWith('.css'))) assert.ok(statSync(path.join(outDir, f)).size < 40 * 1024, `${f} is heavy`);
  assert.ok(!js.some((f) => /\.min\./.test(f)));
});
