import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BANNER,
  buildServer,
  checkSources,
  hasEntryGuard,
  IMPORT_META_ALLOWED,
  packageOf,
  parseBundleArgs,
  STUBS,
  stubFor,
  usesImportMeta,
} from './bundle-server.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('parseBundleArgs: defaults, --out, --no-minify', () => {
  assert.deepEqual(parseBundleArgs([]), { out: undefined, minify: true, help: false });
  assert.deepEqual(parseBundleArgs(['--out', '/tmp/x', '--no-minify']), {
    out: '/tmp/x',
    minify: false,
    help: false,
  });
  assert.throws(() => parseBundleArgs(['--bogus']));
});

test('stubFor: pg, drizzle-orm and the demo server are stubbed, nothing else', () => {
  assert.equal(stubFor('pg')?.name, 'pg');
  assert.equal(stubFor('drizzle-orm')?.name, 'drizzle-orm');
  assert.equal(stubFor('drizzle-orm/sqlite-core')?.name, 'drizzle-orm');
  assert.equal(stubFor('./demo/main.ts')?.name, 'demo server');
  for (const other of ['pgp', 'hono', 'zod', 'node:sqlite', './demo/config.ts', '@kiln/db']) {
    assert.equal(stubFor(other), undefined, other);
  }
});

test('the stubs fail with a message that says what to do', () => {
  const pg = STUBS.find((s) => s.name === 'pg');
  assert.throws(() => new Function(pg.source)(), /PostgreSQL is not available.*SQLite/);
  // The smoke test in prepare-sidecar.mjs looks for this sentence.
  assert.match(pg.source, /PostgreSQL is not available/);
  const demo = STUBS.find((s) => s.name === 'demo server');
  assert.match(demo.source, /export async function runDemo/);
  assert.ok(existsSync(join(repoRoot, 'apps/server/src/demo/main.ts')), 'the stubbed file exists');
});

test('packageOf finds the package of a file under node_modules (plain, pnpm, scoped)', () => {
  assert.deepEqual(packageOf('node_modules/hono/dist/index.js'), {
    root: 'node_modules/hono',
    name: 'hono',
  });
  assert.deepEqual(packageOf('node_modules/.pnpm/hono@4.13.19/node_modules/hono/dist/x.js'), {
    root: 'node_modules/.pnpm/hono@4.13.19/node_modules/hono',
    name: 'hono',
  });
  const store =
    'node_modules/.pnpm/@hono+node-server@1.19.19_hono@4/node_modules/@hono/node-server';
  assert.deepEqual(packageOf(`${store}/dist/i.mjs`), { root: store, name: '@hono/node-server' });
  assert.equal(packageOf('packages/db/src/index.ts'), undefined);
  assert.equal(packageOf('node_modules/hono'), undefined);
});

test('hasEntryGuard and usesImportMeta', () => {
  const guarded =
    'if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();';
  assert.equal(hasEntryGuard(guarded), true);
  assert.equal(hasEntryGuard('const a = process.argv[1];'), false);
  assert.equal(hasEntryGuard('const u = import.meta.url;'), false);
  assert.equal(usesImportMeta('new URL("../x", import.meta.url)'), true);
  assert.equal(usesImportMeta('import.meta.dirname'), true);
  assert.equal(usesImportMeta('const a = 1'), false);
});

test('checkSources reports entry guards and unlisted import.meta users', () => {
  const sources = {
    'apps/server/src/i18n/catalogs.ts': 'new URL("../../locales/", import.meta.url)',
    'apps/server/src/a.ts': 'export const a = 1;',
    'apps/server/src/b.ts': 'readFileSync(new URL("./b.sql", import.meta.url))',
    'apps/server/src/c.ts': 'if (import.meta.url === pathToFileURL(process.argv[1]).href) main();',
  };
  assert.ok(IMPORT_META_ALLOWED.has('apps/server/src/i18n/catalogs.ts'));
  const problems = checkSources(Object.keys(sources), (path) => sources[path]);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /b\.ts uses import\.meta/);
  assert.match(problems[1], /c\.ts starts itself/);
  assert.match(problems[2], /c\.ts uses import\.meta/);
});

test('the banner gives the bundle require and points the catalogs next to itself', () => {
  assert.match(BANNER, /createRequire/);
  assert.match(BANNER, /const require = /);
  assert.match(BANNER, /KILN_LOCALES_DIR = .*'\.\/locales\/'/);
  // The server side of that contract.
  const catalogs = readFileSync(join(repoRoot, 'apps/server/src/i18n/catalogs.ts'), 'utf8');
  assert.match(catalogs, /KILN_LOCALES_DIR/);
});

const esbuildAvailable = await import('esbuild').then(
  () => true,
  () => false,
);

const skipWithoutEsbuild = !esbuildAvailable && 'esbuild is not installed';

test('buildServer bundles the real server', { skip: skipWithoutEsbuild }, async () => {
  const { files, stats, warnings } = await buildServer({ repoRoot });
  assert.deepEqual(warnings, []);
  const launcher = files.find((f) => f.to === 'launcher.mjs');
  assert.ok(launcher && launcher.contents.byteLength > 100_000);
  const text = Buffer.from(launcher.contents).toString('utf8');
  assert.ok(text.startsWith('import { createRequire as __kilnCreateRequire }'));
  assert.ok(files.some((f) => f.to.startsWith('locales/')));
  assert.ok(files.some((f) => f.to.startsWith('licenses/hono/')));
  assert.ok(stats.packages.some((p) => p.startsWith('zod@')));
  // Only the Node binary's own modules are left to load at run time: no node_modules, no pg.
  assert.ok(stats.externals.length > 0);
  assert.deepEqual(
    stats.externals.filter((path) => !isBuiltin(path)),
    [],
  );
});
