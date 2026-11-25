#!/usr/bin/env node
// Screenshot tool: drives the Kiln demo (`pnpm demo`, http://localhost:8788) with Playwright and writes crisp PNGs
// plus docs/assets/screenshots/manifest.json for the README and the website. See scripts/screenshots/README.md.
//
// Only dependencies: playwright (loaded lazily, so `--list` and the unit tests work without it) and node builtins.
// It never resets the demo unless you pass --reset, and it only ever talks to the demo server you point it at.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  base: 'http://localhost:8788',
  out: resolve(here, '../../docs/assets/screenshots'),
  themes: ['dark', 'light'],
  scale: 2,
};
export const VIEWPORT = { width: 1440, height: 900 };
export const THEMES = ['dark', 'light'];
/** Per-shot budget for the readiness selector (ms). */
const READY_TIMEOUT = 20_000;
const SETTLE_MS = 300;

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit tested in capture.test.mjs)

/** `#/portfolio/<id>[/section][?query]`: the hash routes of apps/web (lib/app-scope.ts `appAddress`). */
export function appRoute(id, section = '', query = {}) {
  const base = `#/portfolio/${encodeURIComponent(id)}${section ? `/${section}` : ''}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const search = params.toString();
  return search === '' ? base : `${base}?${search}`;
}

/** The full URL a shot opens: the server root plus the hash route. */
export function shotUrl(base, route) {
  return `${base.replace(/\/+$/, '')}/${route.startsWith('#') ? route : `#${route}`}`;
}

/** Indexes `GET /api/workspaces/<id>/apps` by name: `{ 'Demo Notes': { ios: id, android: id, first: id } }`. */
export function indexApps(apps) {
  const out = {};
  for (const a of apps ?? []) {
    if (!a || typeof a.name !== 'string' || typeof a.id !== 'string') continue;
    const entry = out[a.name] ?? (out[a.name] = { first: a.id });
    if (typeof a.platform === 'string' && !(a.platform in entry)) entry[a.platform] = a.id;
  }
  return out;
}

/** The id of one app record by name (and platform when given); throws a readable error when the demo lacks it. */
export function appIdOf(index, name, platform) {
  const entry = index[name];
  const id = entry ? (platform ? entry[platform] : entry.first) : undefined;
  if (!id) {
    const known = Object.keys(index).join(', ') || 'none';
    throw new Error(
      `Demo app "${name}"${platform ? ` (${platform})` : ''} not found. Apps in the demo: ${known}. Try --reset.`,
    );
  }
  return id;
}

/** Width and height in pixels from a PNG buffer (IHDR chunk); null when it is not a PNG. */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export const fileNameFor = (name, theme) => `${name}-${theme}.png`;

/** The manifest entries of the website and README: one per shot and theme, sorted by name then theme (dark first). */
export function buildManifest(entries, { scale = DEFAULTS.scale, viewport = VIEWPORT } = {}) {
  const order = (t) => THEMES.indexOf(t);
  const shots = [...entries]
    .map((e) => ({
      name: e.name,
      title: e.title,
      theme: e.theme,
      file: e.file ?? fileNameFor(e.name, e.theme),
      width: e.width,
      height: e.height,
      alt: e.alt,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : order(a.theme) - order(b.theme)));
  return { version: 1, scale, viewport: { ...viewport }, shots };
}

/** Keeps entries of an earlier manifest that this run did not touch (a partial `--only` run), when `keep` says the file still exists. */
export function mergeManifest(previous, entries, keep = () => true) {
  const fresh = new Set(entries.map((e) => `${e.name}/${e.theme}`));
  const old = (previous?.shots ?? []).filter((s) => !fresh.has(`${s.name}/${s.theme}`) && keep(s));
  return [...old, ...entries];
}

/** Parses argv (without node and script). Throws Error with a readable message on a bad flag. */
export function parseArgs(argv, shots = SHOTS) {
  const opts = {
    base: DEFAULTS.base,
    out: DEFAULTS.out,
    only: null,
    themes: [...DEFAULTS.themes],
    scale: DEFAULTS.scale,
    reset: false,
    list: false,
    help: false,
    hideDemoBanner: false,
    headed: false,
  };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : null;
    const take = () => {
      if (inline !== null) return inline;
      const v = value(i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case '--base':
        opts.base = take().replace(/\/+$/, '');
        break;
      case '--out':
        opts.out = resolve(process.cwd(), take());
        break;
      case '--only':
        opts.only = take()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--themes':
        opts.themes = take()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--scale':
        opts.scale = Number(take());
        break;
      case '--reset':
        opts.reset = true;
        break;
      case '--list':
        opts.list = true;
        break;
      case '--hide-demo-banner':
        opts.hideDemoBanner = true;
        break;
      case '--headed':
        opts.headed = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option ${raw}. Try --help.`);
    }
  }
  for (const t of opts.themes)
    if (!THEMES.includes(t)) throw new Error(`Unknown theme "${t}" (use dark, light).`);
  if (opts.themes.length === 0) throw new Error('--themes is empty.');
  if (!Number.isFinite(opts.scale) || opts.scale < 1 || opts.scale > 4)
    throw new Error('--scale must be a number from 1 to 4.');
  if (opts.only) {
    const names = new Set(shots.map((s) => s.name));
    // Accept the short form too: "02" or "app-overview" select 02-app-overview.
    opts.only = opts.only.map((o) => {
      if (names.has(o)) return o;
      const hit = shots.find((s) => s.name.startsWith(`${o}-`) || s.name.slice(3) === o);
      if (!hit) throw new Error(`Unknown shot "${o}". Known: ${[...names].join(', ')}`);
      return hit.name;
    });
  }
  return opts;
}

export const selectShots = (opts, shots = SHOTS) =>
  opts.only ? shots.filter((s) => opts.only.includes(s.name)) : shots;

export const HELP = `Usage: node capture.mjs [options]

  --base <url>          demo server (default ${DEFAULTS.base})
  --out <dir>           output folder (default docs/assets/screenshots)
  --only <a,b>          shot names, numbers or short names (02, 04-store-listing, app-overview)
  --themes <dark,light> themes to capture (default dark,light)
  --scale <n>           device scale factor 1-4 (default ${DEFAULTS.scale})
  --reset               POST /demo/reset first (wipes the demo data and seeds again)
  --hide-demo-banner    hide the permanent "Demo workspace" bar
  --headed              show the browser while capturing
  --list                print the shots and routes, no browser needed
`;

// ---------------------------------------------------------------------------------------------
// In-page helpers (Playwright)

/** Waits for a selector without failing the shot; true when it showed up. */
async function soft(page, selector, timeout = 6_000) {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/** Clicks the first collapsed expander (aria-expanded=false) matching `selector`, preferring a text row over a graphics row. */
async function expandFirstTextRow(page, selector) {
  const buttons = page.locator(selector);
  await buttons.first().waitFor({ state: 'visible', timeout: 10_000 });
  const n = await buttons.count();
  let pick = 0;
  for (let i = 0; i < n; i++) {
    const label = (await buttons.nth(i).getAttribute('aria-label')) ?? '';
    if (!/screenshot|graphic|asset|image|icon/i.test(label)) {
      pick = i;
      break;
    }
  }
  await buttons.nth(pick).click();
}

// ---------------------------------------------------------------------------------------------
// The shots. path(ctx) is the hash route; ready is a selector (or async (page) => void) that must show before the picture;
// before(page, ctx) does the clicking; clip is 'viewport' (default), 'fullPage' or a selector.
// ctx.app(name, platform?) is the id of one record of a demo app. Apps are random UUIDs, looked up through the API after sign-in.

const NOTES = 'Demo Notes';

export const SHOTS = [
  {
    name: '01-all-apps',
    title: 'All apps',
    alt: 'The portfolio page listing every demo app with its platforms, version and status chips.',
    path: () => '#/portfolio',
    ready: 'main a[href^="#/portfolio/"]',
  },
  {
    name: '02-app-overview',
    title: 'App overview',
    alt: 'The overview of Demo Notes with the app colour tint, the next step card and the left navigation.',
    path: (ctx) => appRoute(ctx.app(NOTES, 'ios'), '', { platform: 'ios' }),
    ready: '[data-testid="next-step"]',
  },
  {
    name: '03-release-prepare',
    title: 'Prepare release',
    alt: 'The Prepare release stepper (Build, Notes, Assets, Review, Confirm) open on the Assets step.',
    path: (ctx) => appRoute(ctx.app(NOTES, 'ios'), 'releases', { platform: 'ios', step: 'assets' }),
    ready: '[data-testid="release-stepper"] [data-testid="stepper-footer"]',
  },
  {
    name: '04-store-listing',
    title: 'Store listing',
    alt: 'The store listing text tab with a table of locales and which fields are filled or have staged changes.',
    path: (ctx) => appRoute(ctx.app(NOTES, 'ios'), 'listing', { platform: 'ios' }),
    ready: 'table.matrix',
  },
  {
    name: '05-graphics',
    title: 'Graphics',
    alt: 'The store listing graphics tab with screenshots and icons for each device size.',
    path: (ctx) =>
      appRoute(ctx.app(NOTES, 'ios'), 'listing', { platform: 'ios', view: 'graphics' }),
    ready: 'h1.page-title',
    before: async (page) => {
      await soft(page, 'main img', 8_000);
    },
  },
  {
    name: '06-pending-changes',
    title: 'Pending changes',
    alt: 'The pending changes page of Demo Notes with one row expanded to show a before and after diff.',
    path: (ctx) => appRoute(ctx.app(NOTES, 'ios'), 'pending', { platform: 'ios' }),
    ready: '[data-testid="pending-item"]',
    before: async (page) => {
      await expandFirstTextRow(page, '[data-testid="pending-item"] button[aria-expanded="false"]');
      await soft(page, '[data-testid="pending-item-preview"]', 10_000);
      await soft(page, '[data-testid="pending-item-preview"] [data-testid="text-diff"]', 4_000);
    },
  },
  {
    name: '07-pending-cart',
    title: 'Pending cart',
    alt: 'The pending changes drawer opened from the top bar, with a text row expanded to show its diff.',
    path: (ctx) => appRoute(ctx.app(NOTES, 'ios'), '', { platform: 'ios' }),
    ready: '[data-testid="pending-cart-button"]',
    before: async (page) => {
      await page.locator('[data-testid="pending-cart-button"]').click();
      await page.waitForSelector('dialog[data-testid="pending-cart"][open]', { timeout: 10_000 });
      await expandFirstTextRow(
        page,
        'dialog[data-testid="pending-cart"] button[aria-expanded="false"]',
      );
      await soft(page, 'dialog[data-testid="pending-cart"] [data-testid="cart-preview"]', 10_000);
      await soft(page, 'dialog[data-testid="pending-cart"] [data-testid="text-diff"]', 4_000);
    },
  },
  {
    name: '08-reviews-inbox',
    title: 'Reviews inbox',
    alt: 'The reviews inbox filtered to Demo Notes, with the app filter chip, status chips and the review list.',
    path: (ctx) => `#/reviews?apps=${encodeURIComponent(ctx.app(NOTES, 'ios'))}`,
    ready: '[data-testid="filter-summary"]',
  },
  {
    name: '09-insights',
    title: 'Insights',
    alt: 'The Insights overview of Demo Notes with downloads, ratings and rank charts.',
    path: (ctx) => appRoute(ctx.app(NOTES, 'ios'), 'insights', { platform: 'ios' }),
    ready: '[data-testid="insights-cards"], [data-testid="insights-headline"]',
    before: async (page) => {
      await soft(page, 'main svg', 8_000);
    },
  },
  {
    name: '10-aso',
    title: 'ASO keywords',
    alt: 'The Keywords view of Insights with tracked search terms, their ranks and rank history.',
    path: (ctx) =>
      appRoute(ctx.app(NOTES, 'ios'), 'insights', { platform: 'ios', view: 'keywords' }),
    ready: 'h1.page-title',
    before: async (page) => {
      await soft(page, 'main table', 8_000);
    },
  },
  {
    name: '11-builds-eas',
    title: 'Test builds',
    alt: 'The test builds view of Demo Notes with builds from CI and ways to install them on a device.',
    path: (ctx) => appRoute(ctx.app(NOTES, 'ios'), 'builds', { platform: 'ios', view: 'tests' }),
    ready: 'h1.page-title',
    before: async (page) => {
      await soft(page, '[data-testid="build-row"], main table', 8_000);
      // The build numbers of the CI rows are read from the files one after another: wait for the first.
      await soft(page, '[data-testid="build-number"]', 8_000);
      // Best effort: open an install dialog when the first build offers one.
      const install = page.getByRole('button', { name: /^install/i }).first();
      if (await install.isVisible().catch(() => false)) {
        await install.click().catch(() => {});
        await soft(page, 'dialog[open]', 4_000);
      }
    },
  },
  {
    name: '12-settings-appearance',
    title: 'App appearance',
    alt: 'The Appearance section of the app settings with the app tint and a live preview.',
    path: (ctx) =>
      appRoute(ctx.app(NOTES, 'ios'), 'settings', { platform: 'ios', section: 'appearance' }),
    ready: '[data-testid="tint-preview"]',
  },
  {
    name: '13-app-switcher',
    title: 'App switcher',
    alt: 'The Go to an app dialog opened with Cmd+K, a searchable list of apps.',
    path: () => '#/portfolio',
    ready: 'main a[href^="#/portfolio/"]',
    before: async (page) => {
      await page.keyboard.press('Control+k');
      await page.waitForSelector('dialog[open] [role="combobox"]', { timeout: 10_000 });
      await soft(page, 'dialog[open] [role="option"], dialog[open] li', 4_000);
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Running

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('WARN', ...a);

async function demoStatus(base) {
  let res;
  try {
    res = await fetch(`${base}/demo/status`, { signal: AbortSignal.timeout(5_000) });
  } catch (e) {
    throw new Error(
      `Cannot reach ${base}/demo/status (${e.cause?.code ?? e.message}).\nStart the demo first: pnpm demo   (or pnpm demo:reset), then run this again.`,
    );
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.demo !== true) {
    throw new Error(
      `${base} answered, but it is not the Kiln demo (GET /demo/status did not say demo:true).\nThis tool only runs against pnpm demo, never a real workspace.`,
    );
  }
  return body;
}

const CSS_QUIET =
  '*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important;caret-color:transparent!important}';
const CSS_NO_BANNER = '[data-testid="demo-banner"]{display:none!important}';

/** Runs in the page before any script: theme and language like the app stores them, plus the quiet CSS. */
function initScript({ theme, css }) {
  try {
    localStorage.setItem('kiln.theme', theme);
    localStorage.setItem('kiln.locale', 'en');
    localStorage.removeItem('kiln.tint');
  } catch {
    /* storage unavailable: the colour scheme of the context still applies */
  }
  const add = () => {
    const el = document.createElement('style');
    el.textContent = css;
    (document.head ?? document.documentElement).appendChild(el);
  };
  if (document.head) add();
  else document.addEventListener('DOMContentLoaded', add, { once: true });
}

async function readySettle(page) {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  // Skeletons and spinners announce themselves as a status with a "loading" label; wait for them to go (best effort).
  await page
    .waitForFunction(
      () => !document.querySelector('[role="status"][aria-label*="oading" i], [aria-busy="true"]'),
      null,
      { timeout: 8_000 },
    )
    .catch(() => {});
  await page
    .waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 8_000 })
    .catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
}

async function takeShot(context, shot, ctx, opts, theme) {
  const page = await context.newPage();
  try {
    await page.goto(shotUrl(opts.base, shot.path(ctx)), { waitUntil: 'load', timeout: 30_000 });
    if (typeof shot.ready === 'function') await shot.ready(page, ctx);
    else await page.waitForSelector(shot.ready, { state: 'visible', timeout: READY_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    if (shot.before) await shot.before(page, ctx);
    await readySettle(page);
    const shotOpts = { animations: 'disabled', caret: 'hide', type: 'png' };
    const clip = shot.clip ?? 'viewport';
    const buf =
      clip === 'viewport'
        ? await page.screenshot(shotOpts)
        : clip === 'fullPage'
          ? await page.screenshot({ ...shotOpts, fullPage: true })
          : await page.locator(clip).first().screenshot(shotOpts);
    const file = fileNameFor(shot.name, theme);
    writeFileSync(join(opts.out, file), buf);
    const size = pngSize(buf) ?? { width: 0, height: 0 };
    return {
      ok: true,
      entry: {
        name: shot.name,
        title: shot.title,
        theme,
        file,
        width: size.width,
        height: size.height,
        alt: shot.alt,
      },
    };
  } catch (e) {
    warn(
      `${shot.name} (${theme}) failed at ${page.url()}\n     ${String(e.message).split('\n')[0]}`,
    );
    return { ok: false, error: String(e.message).split('\n')[0] };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (opts.help) {
    log(HELP);
    return 0;
  }
  const shots = selectShots(opts);
  if (opts.list) {
    const placeholder = { app: (name, platform) => `<${name}${platform ? `:${platform}` : ''}>` };
    for (const s of shots) {
      const ready = typeof s.ready === 'function' ? '(function)' : s.ready;
      log(
        `${s.name.padEnd(24)} ${s.path(placeholder)}\n${' '.repeat(25)}ready: ${ready}   clip: ${s.clip ?? 'viewport'}`,
      );
    }
    log(
      `\n${shots.length} shots x ${opts.themes.length} themes (${opts.themes.join(', ')}) at ${VIEWPORT.width}x${VIEWPORT.height} @${opts.scale}x -> ${opts.out}`,
    );
    return 0;
  }

  let status;
  try {
    status = await demoStatus(opts.base);
    if (opts.reset) {
      log('Resetting the demo (--reset) ...');
      const r = await fetch(`${opts.base}/demo/reset`, {
        method: 'POST',
        headers: { Origin: opts.base },
      });
      if (!r.ok) throw new Error(`POST /demo/reset answered ${r.status}`);
      status = await demoStatus(opts.base);
    }
  } catch (e) {
    console.error(e.message);
    return 2;
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error(
      'Playwright is not installed. Run:\n  cd scripts/screenshots && npm install && npx playwright install chromium',
    );
    return 2;
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: !opts.headed });
  } catch (e) {
    console.error(
      `Could not start Chromium: ${String(e.message).split('\n')[0]}\nRun: cd scripts/screenshots && npx playwright install chromium`,
    );
    return 2;
  }

  mkdirSync(opts.out, { recursive: true });
  const results = [];
  const entries = [];
  try {
    for (const theme of opts.themes) {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: opts.scale,
        colorScheme: theme,
        locale: 'en-US',
        timezoneId: 'UTC',
        reducedMotion: 'reduce',
      });
      await context.addInitScript(initScript, {
        theme,
        css: CSS_QUIET + (opts.hideDemoBanner ? CSS_NO_BANNER : ''),
      });
      try {
        const login = await context.request.get(`${opts.base}/demo/login?json`);
        if (!login.ok()) throw new Error(`GET /demo/login answered ${login.status()}`);
        const wsId = status.workspace?.id;
        if (!wsId) throw new Error('/demo/status has no workspace; reset the demo (--reset).');
        const appsRes = await context.request.get(
          `${opts.base}/api/workspaces/${encodeURIComponent(wsId)}/apps`,
        );
        if (!appsRes.ok())
          throw new Error(`GET /api/workspaces/${wsId}/apps answered ${appsRes.status()}`);
        const index = indexApps((await appsRes.json()).apps);
        const ctx = { workspaceId: wsId, app: (name, platform) => appIdOf(index, name, platform) };
        for (const shot of shots) {
          const r = await takeShot(context, shot, ctx, opts, theme);
          results.push({ shot: shot.name, theme, ...r });
          if (r.ok) entries.push(r.entry);
        }
      } catch (e) {
        warn(`theme ${theme}: ${e.message}`);
        for (const shot of shots)
          if (!results.some((r) => r.shot === shot.name && r.theme === theme))
            results.push({ shot: shot.name, theme, ok: false, error: e.message });
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (entries.length > 0) {
    const manifestPath = join(opts.out, 'manifest.json');
    let previous = null;
    try {
      previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      /* none yet */
    }
    const merged = mergeManifest(previous, entries, (s) => existsSync(join(opts.out, s.file)));
    writeFileSync(
      manifestPath,
      `${JSON.stringify(buildManifest(merged, { scale: opts.scale }), null, 2)}\n`,
    );
    log(`\nWrote ${manifestPath}`);
  }

  log('\nshot'.padEnd(26) + 'theme'.padEnd(8) + 'result');
  for (const r of results) {
    const size = r.ok ? `${r.entry.width}x${r.entry.height}` : `FAILED: ${r.error}`;
    log(`${r.shot.padEnd(25)} ${r.theme.padEnd(7)} ${size}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  log(
    `\n${results.length - failed}/${results.length} captured${failed ? `, ${failed} failed` : ''}.`,
  );
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
