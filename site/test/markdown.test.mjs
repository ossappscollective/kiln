import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLinkResolver } from '../lib/links.mjs';
import { escapeHtml, inlineText, renderInline, renderMarkdown, safeUrl, slugify } from '../lib/markdown.mjs';
import { buildSearchIndex, tokenize } from '../lib/search-index.mjs';

const md = (src, options) => renderMarkdown(src, options).html;

test('headings get unique ids, anchors and are collected', () => {
  const r = renderMarkdown('# Title\n\n## Same\n\n## Same\n\n### Third `code`\n');
  assert.equal(r.title, 'Title');
  assert.deepEqual(
    r.headings.map((h) => h.id),
    ['title', 'same', 'same-2', 'third-code'],
  );
  assert.match(r.html, /<h2 id="same-2">Same<a class="anchor" href="#same-2"/);
});

test('dropFirstH1 keeps the title but not the heading', () => {
  const r = renderMarkdown('# Title\n\nBody text.', { dropFirstH1: true });
  assert.equal(r.title, 'Title');
  assert.ok(!r.html.includes('<h1'));
  assert.equal(r.firstParagraph, 'Body text.');
});

test('slugify handles accents, punctuation and empty input', () => {
  assert.equal(slugify('Café & Crème: 2 things!'), 'cafe-creme-2-things');
  assert.equal(slugify('!!!'), 'section');
});

test('paragraphs, emphasis, strong, inline code and line breaks', () => {
  assert.equal(
    md('Some **bold**, _it_ and *star* with `a < b` here.'),
    '<p>Some <strong>bold</strong>, <em>it</em> and <em>star</em> with <code>a &lt; b</code> here.</p>',
  );
  assert.equal(md('snake_case_name stays'), '<p>snake_case_name stays</p>');
  assert.match(md('one  \ntwo'), /one<br>\ntwo/);
});

test('inline code protects its content from other markup', () => {
  assert.equal(renderInline('`**not bold** [x](y)`'), '<code>**not bold** [x](y)</code>');
});

test('bullet, numbered, nested and loose lists', () => {
  assert.equal(md('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(md('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.equal(md('3. x\n4. y'), '<ol start="3"><li>x</li><li>y</li></ol>');
  assert.equal(md('- a\n  - b\n- c'), '<ul><li>a\n<ul><li>b</li></ul></li><li>c</li></ul>');
  assert.equal(md('- a\n\n- b'), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  assert.match(md('1. step\n   ```sh\n   run\n   ```\n2. next'), /<li>step\n<div class="code-block"[\s\S]*<\/li><li>next<\/li>/);
});

test('code fences keep content verbatim and escaped, with the language', () => {
  const html = md('```sh\necho "<b>" && ls\n```');
  assert.equal(
    html,
    '<div class="code-block" data-lang="sh"><pre tabindex="0"><code class="language-sh">echo &quot;&lt;b&gt;&quot; &amp;&amp; ls</code></pre></div>',
  );
  assert.match(md('    indented\n    code'), /<code>indented\ncode<\/code>/);
});

test('tables: header, alignment, escaped pipes and pipes inside code', () => {
  const html = md('| a | b |\n| :-- | --: |\n| `x\\|y` | 2 |\n| p \\| q | 3 |');
  assert.match(html, /<th style="text-align:left">a<\/th><th style="text-align:right">b<\/th>/);
  assert.match(html, /<td[^>]*><code>x\|y<\/code><\/td>/);
  assert.match(html, /<td[^>]*>p \| q<\/td>/);
  assert.match(html, /^<div class="table-wrap"/);
});

test('blockquotes and alerts', () => {
  assert.equal(md('> quoted\n> text'), '<blockquote><p>quoted\ntext</p></blockquote>');
  assert.match(md('> [!WARNING]\n> careful'), /<aside class="callout callout-warning"><p class="callout-title">Warning<\/p><p>careful<\/p><\/aside>/);
});

test('horizontal rules and html comments', () => {
  assert.equal(md('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>');
  assert.equal(md('<!-- hidden -->\n\ntext'), '<p>text</p>');
});

test('XSS: raw HTML is shown as text', () => {
  const html = md('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\ntext <b onclick="x">b</b>');
  assert.ok(!/<script|<img|<b /.test(html));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('XSS: dangerous URL schemes are neutralised, including obfuscated ones', () => {
  for (const url of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html;base64,AAAA', 'vbscript:x']) {
    const html = md(`[x](<${url}>)`);
    assert.ok(!/href="[^"]*script:/i.test(html), url);
  }
  assert.equal(safeUrl('java\nscript:alert(1)'), '#');
  assert.equal(safeUrl('https://example.com/a?b=1&c=2'), 'https://example.com/a?b=1&c=2');
  assert.equal(safeUrl('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(safeUrl('../x.md'), '../x.md');
});

test('XSS: quotes in URLs and titles cannot break out of the attribute', () => {
  const html = md('[x](https://a.test/"onmouseover="alert(1) "t\\" onfocus=\\"y")');
  assert.ok(!/<a [^>]*\sonmouseover=/.test(html), html);
  const html2 = md('[x](https://a.test/ "ti\\"tle")');
  assert.ok(!/<a [^>]*"\s+on\w+=/.test(html2));
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

test('XSS: link text and headings are escaped', () => {
  assert.match(md('[<img src=x>](https://a.test)'), /<a href="https:\/\/a.test">&lt;img src=x&gt;<\/a>/);
  assert.match(md('## <script>x</script>'), /<h2 id="script-x-script">&lt;script&gt;x&lt;\/script&gt;/);
});

test('images are rendered as links, never embedded', () => {
  const html = md('![alt text](https://tracker.example/pixel.png)');
  assert.ok(!html.includes('<img'));
  assert.match(html, /<a href="https:\/\/tracker.example\/pixel.png">alt text<\/a>/);
});

test('autolinks and backslash escapes', () => {
  assert.match(md('<https://example.com>'), /<a href="https:\/\/example.com">https:\/\/example.com<\/a>/);
  assert.equal(md('\\*not em\\*'), '<p>*not em*</p>');
});

test('inlineText strips markup', () => {
  assert.equal(inlineText('A **bold** [link](x) and `code`'), 'A bold link and code');
});

// ---- link rewriting ----

const routes = new Map([
  ['docs/deployment.md', 'docs/self-hosting-reference/'],
  ['SECURITY.md', 'docs/security/'],
  ['site/content/faq.md', 'docs/faq/'],
]);
const repoUrl = 'https://github.com/ossappscollective/kiln';
const resolve = (url, sourcePath = 'docs/credentials.md', root = '../../') =>
  createLinkResolver({ sourcePath, routes, root, repoUrl })(url);

test('links: relative .md links to curated pages become site routes', () => {
  assert.equal(resolve('deployment.md'), '../../docs/self-hosting-reference/');
  assert.equal(resolve('deployment.md#tls'), '../../docs/self-hosting-reference/#tls');
  assert.equal(resolve('../SECURITY.md'), '../../docs/security/');
  assert.equal(resolve('../site/content/faq.md', 'docs/x.md', './'), './docs/faq/');
});

test('links: other repo files and folders point at GitHub', () => {
  assert.equal(resolve('adr/0054-pending-cart.md#why'), `${repoUrl}/blob/main/docs/adr/0054-pending-cart.md#why`);
  assert.equal(resolve('../apps/server/'), `${repoUrl}/tree/main/apps/server`);
  assert.equal(resolve('../Dockerfile'), `${repoUrl}/blob/main/Dockerfile`);
  assert.equal(resolve('/LICENSE'), `${repoUrl}/blob/main/LICENSE`);
  assert.equal(resolve('../../../etc/passwd'), repoUrl);
});

test('links: absolute URLs and fragments are left alone', () => {
  assert.equal(resolve('https://example.com/a.md'), 'https://example.com/a.md');
  assert.equal(resolve('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(resolve('#section'), '#section');
});

test('links: the resolver is applied while rendering', () => {
  const html = md('See [deploy](deployment.md#tls) and [adr](adr/0001.md) and [web](https://x.test).', {
    resolveLink: createLinkResolver({ sourcePath: 'docs/credentials.md', routes, root: '../../', repoUrl }),
  });
  assert.match(html, /href="\.\.\/\.\.\/docs\/self-hosting-reference\/#tls"/);
  assert.match(html, /href="https:\/\/github.com\/ossappscollective\/kiln\/blob\/main\/docs\/adr\/0001.md"/);
  assert.match(html, /href="https:\/\/x.test"/);
});

// ---- search index ----

test('search index: tokens, headings and page entries', () => {
  assert.deepEqual(tokenize('Café: Set-up & KILN_MASTER_KEY'), ['cafe', 'set', 'up', 'kiln', 'master', 'key']);
  const idx = buildSearchIndex([
    {
      title: 'Security',
      route: 'docs/security/',
      description: 'Vault and audit',
      headings: [
        { level: 2, text: 'Encryption at rest', id: 'encryption-at-rest' },
        { level: 4, text: 'Deep', id: 'deep' },
      ],
    },
  ]);
  assert.equal(idx.entries.length, 2);
  assert.deepEqual(idx.entries[1], ['Encryption at rest', 'docs/security/#encryption-at-rest', 'Security']);
  assert.deepEqual(idx.terms.encryption, [1]);
  assert.deepEqual(idx.terms.vault, [0]);
  assert.ok(!('deep' in idx.terms));
});
