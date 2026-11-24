// HTML templates: the shared head, header and footer, and the page types. Plain template strings; every dynamic value
// goes through esc() unless it is HTML this module built itself.
import { escapeHtml as esc } from './markdown.mjs';
import { site } from './config.mjs';

const THEME_COLORS = { light: '#f5f6fd', dark: '#0b0d22' };

// Runs before first paint: marks the page as scripted and applies a stored theme choice (storage can throw).
const THEME_BOOT =
  "(function(){var d=document.documentElement;d.classList.add('js');try{var t=localStorage.getItem('kiln-site-theme');if(t==='light'||t==='dark')d.setAttribute('data-theme',t)}catch(e){}})()";

/** Replace {{name}} with vars[name]; an unknown name is an error, so a typo cannot ship. */
export function fill(template, vars) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`Unknown template variable {{${name}}}`);
    return String(vars[name]);
  });
}

const ICON_SUN =
  '<svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const ICON_MOON =
  '<svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>';
const ICON_STAR =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/></svg>';
const ICON_MENU =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';

function header(root, current) {
  const link = (href, label, key) =>
    `<li><a href="${esc(href)}"${current === key ? ' aria-current="page"' : ''}>${label}</a></li>`;
  return `<header class="site-header">
  <div class="wrap">
    <a class="brand" href="${root}"><img src="${root}assets/logo-mark.svg" width="32" height="32" alt="">Kiln</a>
    <nav class="site-nav" id="site-nav" aria-label="Main">
      <ul>
        ${link(`${root}#features`, 'Features', 'features')}
        ${link(`${root}#how-it-works`, 'How it works', 'how')}
        ${link(`${root}#download`, 'Download', 'download')}
        ${link(`${root}docs/`, 'Docs', 'docs')}
      </ul>
    </nav>
    <div class="header-tools">
      <a class="star-link" href="${site.repoUrl}" rel="noopener">${ICON_STAR}<span class="star-text">Star on GitHub</span><span class="visually-hidden">(opens GitHub)</span></a>
      <button class="icon-btn theme-toggle" type="button" data-theme-toggle aria-label="Switch theme">${ICON_SUN}${ICON_MOON}</button>
      <button class="icon-btn menu-toggle" type="button" data-menu-toggle aria-expanded="false" aria-controls="site-nav" aria-label="Menu">${ICON_MENU}</button>
    </div>
  </div>
</header>`;
}

function footer(root, hasReleasing) {
  const docs = (slug, label) => `<li><a href="${root}docs/${slug}/">${label}</a></li>`;
  return `<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <div>
        <a class="brand" href="${root}"><img src="${root}assets/logo-mark.svg" width="32" height="32" alt="">Kiln</a>
        <p class="footer-blurb">Open-source release management and store growth for iOS, macOS and Android apps. Self-hosted, with your keys kept in your own vault.</p>
      </div>
      <nav aria-label="Product">
        <h2>Product</h2>
        <ul>
          <li><a href="${root}#features">Features</a></li>
          <li><a href="${root}#how-it-works">How it works</a></li>
          <li><a href="${root}#security">Security and privacy</a></li>
          <li><a href="${root}#download">Download</a></li>
          <li><a href="${root}#self-host">Self-host</a></li>
        </ul>
      </nav>
      <nav aria-label="Documentation">
        <h2>Docs</h2>
        <ul>
          ${docs('getting-started', 'Getting started')}
          ${docs('self-hosting', 'Self-hosting')}
          ${docs('configuration', 'Configuration')}
          ${docs('credentials', 'Store credentials')}
          ${docs('api', 'API')}
          ${docs('faq', 'FAQ')}
          ${hasReleasing ? docs('releasing', 'Releasing Kiln') : ''}
        </ul>
      </nav>
      <nav aria-label="Project">
        <h2>Project</h2>
        <ul>
          <li><a href="${site.repoUrl}" rel="noopener">GitHub</a></li>
          <li><a href="${site.repoUrl}/releases" rel="noopener">Releases</a></li>
          <li><a href="${site.repoUrl}/issues" rel="noopener">Issues</a></li>
          ${docs('contributing', 'Contributing')}
          ${docs('security', 'Security policy')}
          <li><a href="${site.repoUrl}/blob/main/LICENSE" rel="noopener">License (Apache-2.0)</a></li>
        </ul>
      </nav>
    </div>
    <p class="legal">Kiln is open source under the Apache License 2.0. Kiln is not affiliated with, endorsed by or sponsored by Apple Inc. or Google LLC. App Store, iOS, iPadOS and macOS are trademarks of Apple Inc. Google Play and Android are trademarks of Google LLC. Other names may be trademarks of their owners.</p>
  </div>
</footer>`;
}

/**
 * The full page.
 * @param {object} p
 * @param {string} p.root  prefix to the site root ('./', '../', or an absolute path for 404.html)
 * @param {string} p.path  route of the page under the site root ('' for home, 'docs/faq/')
 */
export function layout(p) {
  const root = p.root;
  const canonical = `${site.siteUrl}${p.path}`;
  const image = `${site.siteUrl}assets/og.png`;
  const alt = 'Kiln: an arch with a flame, and the words ship iOS, macOS and Android releases from one open-source place.';
  const title = esc(p.title);
  const description = esc(p.description);
  const styles = ['tokens.css', 'site.css', ...(p.styles ?? [])]
    .map((f) => `<link rel="stylesheet" href="${root}css/${f}">`)
    .join('\n');
  const scripts = ['site.js', ...(p.scripts ?? [])]
    .map((f) => `<script type="module" src="${root}js/${f}"></script>`)
    .join('\n');
  const jsonld = p.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(p.jsonLd).replace(/</g, '\\u003c')}</script>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="${THEME_COLORS.light}">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${THEME_COLORS.dark}">
${p.noindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="icon" href="${root}assets/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="${p.ogType ?? 'website'}">
<meta property="og:site_name" content="${site.name}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="twitter:image:alt" content="${esc(alt)}">
<script>${THEME_BOOT}</script>
${styles}
${jsonld}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
${header(root, p.current)}
<main id="main" tabindex="-1">
${p.body}
</main>
${footer(root, p.hasReleasing)}
${scripts}
</body>
</html>
`;
}

export function softwareJsonLd(releasesUrl) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: site.name,
    url: site.siteUrl,
    description: site.description,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Windows, Linux, Docker',
    license: 'https://www.apache.org/licenses/LICENSE-2.0',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    downloadUrl: releasesUrl,
    sameAs: [site.repoUrl],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Docs

function docsSidebar(root, groups, currentSlug) {
  const nav = groups
    .map(
      (g) =>
        `<h2>${esc(g.title)}</h2>\n<ul>${g.pages
          .map(
            (pg) =>
              `<li><a href="${root}docs/${pg.slug}/"${pg.slug === currentSlug ? ' aria-current="page"' : ''}>${esc(pg.nav)}</a></li>`,
          )
          .join('')}</ul>`,
    )
    .join('\n');
  return `<aside class="docs-side" aria-label="Documentation">
  <details open>
    <summary>Documentation menu</summary>
    <div class="side-inner">
      <div class="search search-js-only" role="search">
        <label class="visually-hidden" for="doc-search">Search the docs</label>
        <input id="doc-search" type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false" aria-controls="search-results">
        <kbd aria-hidden="true">/</kbd>
        <p class="search-status" id="search-status" role="status" aria-live="polite"></p>
        <ul class="search-results" id="search-results"></ul>
      </div>
      <nav aria-label="Docs pages">
${nav}
      </nav>
    </div>
  </details>
</aside>`;
}

function toc(headings) {
  const items = headings.filter((h) => h.level === 2 || h.level === 3);
  if (items.length < 2) return { aside: '', inline: '' };
  const lis = items
    .map((h) => `<li class="l${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
    .join('');
  return {
    aside: `<nav class="toc" aria-label="On this page"><h2>On this page</h2><ul>${lis}</ul></nav>`,
    inline: `<details class="toc-inline"><summary>On this page</summary><ul>${items
      .filter((h) => h.level === 2)
      .map((h) => `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
      .join('')}</ul></details>`,
  };
}

export function docPage({ page, groups, prev, next, root, hasReleasing }) {
  const t = toc(page.headings);
  const pager = `<nav class="pager" aria-label="Previous and next page">${
    prev ? `<a class="prev" href="${root}docs/${prev.slug}/" rel="prev"><small>Previous</small><strong>${esc(prev.nav)}</strong></a>` : ''
  }${next ? `<a class="next" href="${root}docs/${next.slug}/" rel="next"><small>Next</small><strong>${esc(next.nav)}</strong></a>` : ''}</nav>`;
  const body = `<div class="wrap docs-shell">
${docsSidebar(root, groups, page.slug)}
<article class="doc">
  <header class="doc-head">
    <p class="crumbs"><a href="${root}docs/">Docs</a> / ${esc(page.group)}</p>
    <h1>${esc(page.title)}</h1>
    <p class="desc">${esc(page.description)}</p>
    <p class="doc-meta">Source: <code>${esc(page.source)}</code> <span class="edit">(<a href="${site.repoUrl}/blob/main/${esc(page.source)}" rel="noopener">view or edit on GitHub</a>)</span></p>
  </header>
  ${t.inline}
  <div class="prose">
${page.html}
  </div>
  ${pager}
</article>
${t.aside}
</div>`;
  return layout({
    root,
    path: page.route,
    title: `${page.title} - Kiln docs`,
    description: page.description,
    body,
    current: 'docs',
    styles: ['docs.css'],
    scripts: ['docs.js'],
    ogType: 'article',
    hasReleasing,
  });
}

export function docsHub({ groups, pages, root, hasReleasing }) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const sections = groups
    .map(
      (g) => `<section aria-labelledby="g-${esc(g.title.toLowerCase().replace(/\W+/g, '-'))}">
<h2 id="g-${esc(g.title.toLowerCase().replace(/\W+/g, '-'))}">${esc(g.title)}</h2>
<ul class="doc-links">${g.pages
        .map((pg) => {
          const p = bySlug.get(pg.slug);
          return `<li><a href="${root}docs/${pg.slug}/"><div class="card"><h3>${esc(pg.nav)}</h3><p>${esc(p.description)}</p></div></a></li>`;
        })
        .join('')}</ul>
</section>`,
    )
    .join('\n');
  const body = `<div class="wrap docs-shell">
${docsSidebar(root, groups, '')}
<article class="doc" style="max-width:none">
  <header class="doc-head">
    <h1>Documentation</h1>
    <p class="desc">Everything you need to run Kiln, connect your stores and use it. Press <kbd>/</kbd> to search. These pages come from the Markdown files in the repository, so they match the version of the code you are reading.</p>
  </header>
  <div class="prose docs-hub">
${sections}
  </div>
</article>
</div>`;
  return layout({
    root,
    path: 'docs/',
    title: 'Documentation - Kiln',
    description: 'Guides for running, configuring and using Kiln: getting started, self-hosting, store credentials, the API, security and the FAQ.',
    body,
    current: 'docs',
    styles: ['docs.css'],
    scripts: ['docs.js'],
    hasReleasing,
  });
}

export function notFoundPage({ root, hasReleasing }) {
  const body = `<div class="wrap center-page">
  <p class="eyebrow">404</p>
  <h1>This page could not be found</h1>
  <p>The address may be mistyped, or the page may have moved. Try the <a href="${root}docs/">documentation</a> or go back to the <a href="${root}">home page</a>.</p>
</div>`;
  return layout({
    root,
    path: '404.html',
    title: 'Page not found - Kiln',
    description: 'This page could not be found.',
    body,
    noindex: true,
    hasReleasing,
  });
}

export function sitemapXml(routes) {
  const urls = routes
    .map((r) => `  <url><loc>${esc(site.siteUrl + r)}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt() {
  return `User-agent: *\nAllow: /\n\nSitemap: ${site.siteUrl}sitemap.xml\n`;
}
