#!/usr/bin/env node
// Builds the Kiln website into site/dist: node site/build.mjs [--out <dir>]
// No dependencies. Reads site/pages, site/static, site/content and the repository's Markdown docs.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docsGroups, site } from './lib/config.mjs';
import { createLinkResolver } from './lib/links.mjs';
import { renderMarkdown } from './lib/markdown.mjs';
import {
  docPage,
  docsHub,
  fill,
  layout,
  notFoundPage,
  robotsTxt,
  sitemapXml,
  softwareJsonLd,
} from './lib/render.mjs';
import { buildSearchIndex } from './lib/search-index.mjs';
import { copyScreenshots, loadScreenshots, screenshotsSection } from './lib/screenshots.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const RESERVED_IDS = ['main', 'doc-search', 'search-results', 'search-status', 'site-nav'];

function shorten(text, max = 160) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 80 ? cut.lastIndexOf(' ') : cut.length).replace(/[,;:\s]+$/, '')}…`;
}

/** The repository's compose file with the local build replaced by the published image, comments removed. */
export function composeSnippet(compose) {
  return compose
    .split('\n')
    .filter((line) => !/^\s*#/.test(line) && line.trim() !== '')
    .map((line) => (/^\s+build:\s*\.\s*$/.test(line) ? line.replace(/build:.*/, `image: ${site.image}:latest`) : line))
    .join('\n');
}

export const RUN_SNIPPET = `export KILN_MASTER_KEY="$(openssl rand -base64 32)"   # keep a copy somewhere safe
docker run -d --name kiln \\
  -p 127.0.0.1:8787:8787 \\
  -e KILN_MASTER_KEY \\
  -v kiln-data:/data \\
  ${site.image}:latest`;

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function write(outDir, rel, content) {
  const file = path.join(outDir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Copy a folder by reading and writing files (fs.cpSync also copies permissions, which some file systems refuse). */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest);
    else writeFileSync(dest, readFileSync(src));
  }
}

/** Load and render every docs page of the manifest. Pages whose source is missing and marked optional are skipped. */
export function loadDocs({ repo = repoRoot, groups = docsGroups } = {}) {
  const routes = new Map();
  const present = groups.map((g) => ({
    title: g.title,
    pages: g.pages.filter((p) => {
      const exists = existsSync(path.join(repo, p.source));
      if (!exists && !p.optional) throw new Error(`Docs page ${p.slug}: source ${p.source} does not exist`);
      return exists;
    }),
  }));
  for (const g of present) for (const p of g.pages) routes.set(p.source, `docs/${p.slug}/`);
  const slugs = new Set();
  const pages = [];
  const outGroups = [];
  for (const g of present) {
    const outPages = [];
    for (const entry of g.pages) {
      if (slugs.has(entry.slug)) throw new Error(`Duplicate docs slug: ${entry.slug}`);
      slugs.add(entry.slug);
      const source = readFileSync(path.join(repo, entry.source), 'utf8');
      const rendered = renderMarkdown(source, {
        dropFirstH1: true,
        reservedIds: RESERVED_IDS,
        resolveLink: createLinkResolver({
          sourcePath: entry.source,
          routes,
          root: '../../',
          repoUrl: site.repoUrl,
        }),
      });
      const title = rendered.title ?? entry.slug;
      const page = {
        slug: entry.slug,
        source: entry.source,
        route: `docs/${entry.slug}/`,
        group: g.title,
        title,
        nav: entry.nav ?? title,
        description: entry.description ?? (shorten(rendered.firstParagraph) || title),
        headings: rendered.headings,
        html: rendered.html,
      };
      pages.push(page);
      outPages.push({ slug: page.slug, nav: page.nav });
    }
    if (outPages.length) outGroups.push({ title: g.title, pages: outPages });
  }
  return { pages, groups: outGroups };
}

export function build({ outDir = path.join(here, 'dist'), repo = repoRoot, screenshotsDir = path.join(repo, 'docs', 'assets', 'screenshots') } = {}) {
  try {
    rmSync(outDir, { recursive: true, force: true });
  } catch {
    // some file systems refuse deletes: files are overwritten below
  }
  mkdirSync(outDir, { recursive: true });
  copyTree(path.join(here, 'static'), outDir);
  write(outDir, '.nojekyll', '');

  const { pages, groups } = loadDocs({ repo });
  const hasReleasing = pages.some((p) => p.slug === 'releasing');
  const releasesUrl = `${site.repoUrl}/releases/latest`;
  const flat = pages;

  // screenshots: the section exists only when the manifest does
  const screenshots = loadScreenshots(screenshotsDir);
  if (screenshots) copyScreenshots(screenshots.shots, screenshotsDir, outDir);

  // home
  const compose = readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8');
  const homeBody = fill(readFileSync(path.join(here, 'pages', 'home.html'), 'utf8'), {
    root: './',
    repoUrl: site.repoUrl,
    image: site.image,
    releasesUrl,
    githubApi: 'https://api.github.com/repos/ossappscollective/kiln/releases/latest',
    screenshots: screenshotsSection(screenshots, './'),
    runSnippet: esc(RUN_SNIPPET),
    composeSnippet: esc(composeSnippet(compose)),
    releasingNote: hasReleasing
      ? '<p class="note">How releases are built, signed and published: <a href="./docs/releasing/">Releasing Kiln</a>.</p>'
      : '',
  });
  write(
    outDir,
    'index.html',
    layout({
      root: './',
      path: '',
      title: site.title,
      description: site.description,
      body: homeBody,
      current: '',
      styles: ['home.css'],
      scripts: ['home.js'],
      jsonLd: softwareJsonLd(releasesUrl),
      hasReleasing,
    }),
  );

  // docs
  write(outDir, 'docs/index.html', docsHub({ groups, pages, root: '../', hasReleasing }));
  for (const [i, page] of flat.entries()) {
    const html = docPage({
      page,
      groups,
      prev: flat[i - 1],
      next: flat[i + 1],
      root: '../../',
      hasReleasing,
    });
    write(outDir, `${page.route}index.html`, html);
  }

  // 404: served at any depth, so its URLs are absolute paths under the site's base path
  const basePath = new URL(site.siteUrl).pathname;
  write(outDir, '404.html', notFoundPage({ root: basePath, hasReleasing }));

  const routesList = ['', 'docs/', ...flat.map((p) => p.route)];
  write(outDir, 'sitemap.xml', sitemapXml(routesList));
  write(outDir, 'robots.txt', robotsTxt());
  write(outDir, 'search-index.json', JSON.stringify(buildSearchIndex(flat)));
  return { outDir, routes: routesList, pages: flat };
}

function weight(dir) {
  let total = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const result = build(i > -1 ? { outDir: path.resolve(process.argv[i + 1]) } : {});
  console.log(`Built ${result.routes.length} pages into ${path.relative(process.cwd(), result.outDir) || '.'} (${(weight(result.outDir) / 1024).toFixed(0)} KiB)`);
}
