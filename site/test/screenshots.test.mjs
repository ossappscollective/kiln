import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from '../build.mjs';
import { loadScreenshots, screenshotsSection } from '../lib/screenshots.mjs';
import { read, resolveInternal, tags, walk } from './helpers.mjs';

// A valid 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tmp = (p) => mkdtempSync(path.join(tmpdir(), `kiln-${p}-`));

function fixture(manifest, files) {
  const dir = tmp('shots');
  for (const f of files) writeFileSync(path.join(dir, f), PNG);
  if (manifest) writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}
const entry = (name, theme, extra = {}) => ({ name, title: name, theme, file: `${name}-${theme}.png`, width: 2880, height: 1800, alt: `Alt for ${name}`, ...extra });

test('without a manifest the home page has no Screenshots section and nothing dangling', () => {
  const outDir = tmp('out');
  build({ outDir, screenshotsDir: fixture(null, []) });
  const html = read(outDir, 'index.html');
  assert.ok(!html.includes('id="screenshots"'));
  assert.ok(!html.includes('data-shots'));
  assert.ok(!html.includes('assets/screens/'));
  assert.ok(!html.includes('{{'));
  assert.ok(!existsSync(path.join(outDir, 'assets/screens')));
  assert.ok(existsSync(path.join(outDir, 'js/gallery.js')), 'gallery.js is static and harmless without the section');
});

test('with a manifest the section is built, the PNGs are copied and every reference resolves', () => {
  const dir = fixture(
    {
      version: 1,
      shots: [
        entry('02-app-overview', 'dark'),
        entry('02-app-overview', 'light'),
        entry('04-store-listing', 'dark', { title: 'Store <b>listing</b>', alt: 'A "quoted" <alt>' }),
        entry('05-gone', 'dark', { file: 'missing.png' }),
        entry('06-evil', 'dark', { file: '../evil.png' }),
        entry('07-bad', 'dark', { width: 0 }),
      ],
    },
    ['02-app-overview-dark.png', '02-app-overview-light.png', '04-store-listing-dark.png'],
  );
  const warnings = [];
  const data = loadScreenshots(dir, { warn: (m) => warnings.push(m) });
  assert.deepEqual(
    data.shots.map((s) => s.name),
    ['02-app-overview', '04-store-listing'],
  );
  assert.equal(warnings.length, 3);

  const outDir = tmp('out');
  build({ outDir, screenshotsDir: dir });
  const files = walk(path.join(outDir, 'assets/screens')).sort();
  assert.deepEqual(files, ['02-app-overview-dark.png', '02-app-overview-light.png', '04-store-listing-dark.png']);

  const html = read(outDir, 'index.html');
  const section = /<section[^>]*id="screenshots"[\s\S]*?<\/section>/.exec(html)?.[0];
  assert.ok(section, 'section present');
  const t = tags(section);
  const imgs = t.filter((x) => x.name === 'img');
  assert.equal(imgs.length, 2);
  for (const img of imgs) {
    assert.equal(img.attrs.loading, 'lazy');
    assert.equal(img.attrs.width, '2880');
    assert.equal(img.attrs.height, '1800');
    assert.ok(img.attrs.alt.length > 3);
  }
  assert.ok(t.some((x) => x.name === 'source' && x.attrs.media === '(prefers-color-scheme: dark)'));
  assert.equal(t.filter((x) => x.name === 'picture').length, 2);
  assert.ok(t.some((x) => x.name === 'dialog'), 'enlarge dialog');
  assert.equal(t.filter((x) => x.name === 'a' && 'data-shot' in x.attrs).length, 2);
  // Text from the manifest is escaped.
  assert.ok(!section.includes('<b>listing'));
  assert.ok(section.includes('Store &lt;b&gt;listing&lt;/b&gt;'));
  // Every link, image and srcset of the section points at a built file.
  const refs = [];
  for (const x of t) {
    if (x.name === 'a' && x.attrs.href) refs.push(x.attrs.href);
    if (x.name === 'img') refs.push(x.attrs.src, x.attrs['data-light'], x.attrs['data-dark']);
    if (x.name === 'source') refs.push(x.attrs.srcset);
  }
  assert.ok(refs.length >= 8);
  for (const ref of refs) {
    const res = resolveInternal(outDir, 'index.html', ref);
    assert.ok(res?.target?.startsWith('assets/screens/'), `${ref} does not resolve`);
  }
  // The coded hero illustration stays.
  assert.ok(html.includes('class="mock-window"'));
});

test('an invalid manifest fails the build loudly, an empty one leaves the section out', () => {
  assert.throws(() => loadScreenshots((() => { const d = tmp('bad'); writeFileSync(path.join(d, 'manifest.json'), '{nope'); return d; })()), /not valid JSON/);
  const dir = fixture({ version: 1, shots: [] }, []);
  assert.equal(loadScreenshots(dir), null);
  assert.equal(screenshotsSection(null, './'), '');
  const out = tmp('out');
  mkdirSync(out, { recursive: true });
  build({ outDir: out, screenshotsDir: dir });
  assert.ok(!read(out, 'index.html').includes('id="screenshots"'));
});
