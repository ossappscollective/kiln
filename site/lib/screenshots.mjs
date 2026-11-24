// The optional Screenshots section of the home page. It exists only when docs/assets/screenshots/manifest.json does
// (written by scripts/screenshots/capture.mjs), and every image it names is copied into dist/assets/screens/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MANIFEST_FILE = 'manifest.json';
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Reads and checks the manifest. Returns null when there is none (the section is then left out).
 * Throws on a manifest that is not valid JSON. A shot with a bad entry or a missing PNG is skipped with a warning,
 * so the page never links to a file that is not there.
 */
export function loadScreenshots(dir, { warn = (m) => console.warn(m) } = {}) {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`${manifestPath} is not valid JSON: ${e.message}`);
  }
  const groups = new Map();
  for (const s of Array.isArray(manifest?.shots) ? manifest.shots : []) {
    const ok =
      s &&
      typeof s.name === 'string' &&
      s.name !== '' &&
      (s.theme === 'dark' || s.theme === 'light') &&
      typeof s.file === 'string' &&
      SAFE_FILE.test(s.file) &&
      Number.isInteger(s.width) &&
      Number.isInteger(s.height) &&
      s.width > 0 &&
      s.height > 0 &&
      typeof s.alt === 'string' &&
      s.alt !== '';
    if (!ok) {
      warn(`screenshots: skipping an invalid manifest entry (${JSON.stringify(s?.name ?? s)})`);
      continue;
    }
    if (!existsSync(path.join(dir, s.file))) {
      warn(`screenshots: ${s.file} is in the manifest but missing; skipped`);
      continue;
    }
    const g = groups.get(s.name) ?? { name: s.name, title: typeof s.title === 'string' && s.title ? s.title : s.name, alt: s.alt, themes: {} };
    g.themes[s.theme] = { file: s.file, width: s.width, height: s.height };
    groups.set(s.name, g);
  }
  const shots = [...groups.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  return shots.length === 0 ? null : { shots };
}

/** Copies the PNGs the shots use into `<outDir>/assets/screens/`. */
export function copyScreenshots(shots, dir, outDir) {
  const dest = path.join(outDir, 'assets', 'screens');
  mkdirSync(dest, { recursive: true });
  for (const g of shots) for (const v of Object.values(g.themes)) writeFileSync(path.join(dest, v.file), readFileSync(path.join(dir, v.file)));
}

/** The picture of one shot: a dark source for prefers-color-scheme, the light image (or the only one) as the fallback. */
export function pictureHtml(g, root, { lazy = true } = {}) {
  const light = g.themes.light ?? g.themes.dark;
  const dark = g.themes.dark ?? g.themes.light;
  const src = (v) => `${root}assets/screens/${v.file}`;
  const size = (v) => `width="${v.width}" height="${v.height}"`;
  return `<picture><source media="(prefers-color-scheme: dark)" srcset="${src(dark)}" ${size(dark)} data-theme-source="dark"><img src="${src(light)}" ${size(light)} alt="${esc(g.alt)}"${lazy ? ' loading="lazy" decoding="async"' : ''} data-light="${src(light)}" data-dark="${src(dark)}"></picture>`;
}

/** The section for the home page; an empty string when there are no shots. */
export function screenshotsSection(data, root) {
  if (!data || data.shots.length === 0) return '';
  const cards = data.shots
    .map((g) => {
      const light = g.themes.light ?? g.themes.dark;
      return `      <li><figure class="shot-card"><a class="shot-link" href="${root}assets/screens/${light.file}" data-shot aria-label="Enlarge: ${esc(g.title)}">${pictureHtml(g, root)}</a><figcaption>${esc(g.title)}</figcaption></figure></li>`;
    })
    .join('\n');
  return `<section class="section" id="screenshots" aria-labelledby="screenshots-title" data-shots>
  <div class="wrap">
    <div class="section-head">
      <h2 id="screenshots-title">See it with the demo data</h2>
      <p>Real screens of the app, captured from the built-in demo workspace. Select a picture to enlarge it.</p>
    </div>
    <ul class="shot-grid" role="list">
${cards}
    </ul>
    <dialog class="shot-dialog" id="shots-dialog" aria-labelledby="shots-dialog-title">
      <form method="dialog" class="shot-bar"><strong id="shots-dialog-title"></strong><button class="btn" type="submit" data-shot-close>Close</button></form>
      <div class="shot-big" data-shot-big></div>
    </dialog>
  </div>
</section>
`;
}
