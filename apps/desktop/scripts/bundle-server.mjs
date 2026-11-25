#!/usr/bin/env node
// Bundles the server into one minified ES module for the desktop app. See docs/adr/0004-desktop-sidecar.md
// (option C). Used by prepare-sidecar.mjs; it can also be run alone:
//
//   node scripts/bundle-server.mjs [--out <dir>] [--no-minify]
//
// What comes out (relative to the server folder):
//   launcher.mjs        the whole server: apps/server, the @kiln/* packages, hono, @hono/node-server, zod.
//                       The desktop shell runs it as `kiln-node --disable-warning=ExperimentalWarning launcher.mjs`.
//   locales/            the server's message catalogs, read at run time (apps/server/src/i18n/catalogs.ts).
//   licenses/<pkg>/     the licence files of the third-party packages that went into the bundle.
//
// `node:*` stays external (node:sqlite is part of the Node binary). `pg`, `drizzle-orm` and the demo server are replaced by
// stubs that throw a clear message when loaded, as the old copy step left them out. esbuild is a devDependency of
// @kiln/desktop and is loaded only when a bundle is made.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, '../../..');

export const SERVER_ENTRY = 'apps/server/src/index.ts';
export const LOCALES_SOURCE = 'apps/server/locales';
export const NODE_TARGET = 'node22';

/**
 * Modules replaced by a stub. The stub throws when it is evaluated, so code that really needs one fails with this message and
 * not with "module not found". Tree shaking removes imports nobody reaches, so a stub only runs when the code path is taken.
 * `match` is tested against the import specifier; `source` is the module body.
 */
export const STUBS = [
  {
    name: 'pg',
    match: /^pg$/,
    reason: 'Postgres driver, imported only when DATABASE_URL points at Postgres (ADR 0002)',
    source:
      "throw new Error('PostgreSQL is not available in the Kiln desktop app, which uses SQLite. " +
      "Remove DATABASE_URL, or run the server from the repository or the Docker image to use Postgres.');",
  },
  {
    name: 'drizzle-orm',
    match: /^drizzle-orm(\/.*)?$/,
    reason: 'only the schema files import it, and the server never loads them',
    source:
      "throw new Error('drizzle-orm is not part of the Kiln desktop app. A schema module was loaded that " +
      "the desktop server must not use; see apps/desktop/scripts/bundle-server.mjs.');",
  },
  {
    name: 'demo server',
    // `import('./demo/main.ts')` in apps/server/src/index.ts. Its "started directly" check
    // (`import.meta.url === process.argv[1]`) would be true in a one-file bundle and start the demo.
    match: /(^|\/)demo\/main\.ts$/,
    reason: 'demo mode (KILN_DEMO) is not part of the desktop app',
    source:
      "export async function runDemo() { throw new Error('Demo mode (KILN_DEMO) is not part of the Kiln desktop app. " +
      "Run it from the repository: pnpm demo.'); }",
  },
];

/** Repository files that may use `import.meta.url` (or dirname/filename) because the bundle accounts for it. */
export const IMPORT_META_ALLOWED = new Map([
  [
    'apps/server/src/i18n/catalogs.ts',
    'the catalog folder; the banner sets KILN_LOCALES_DIR to ./locales next to the bundle',
  ],
]);

/** The text put at the top of the bundle. */
export const BANNER = [
  "import { createRequire as __kilnCreateRequire } from 'node:module';",
  "import { fileURLToPath as __kilnFileURLToPath } from 'node:url';",
  'const require = __kilnCreateRequire(import.meta.url);',
  "process.env.KILN_LOCALES_DIR = __kilnFileURLToPath(new URL('./locales/', import.meta.url));",
].join('\n');

// ---- pure helpers (tested in bundle-server.test.mjs) ---------------------------------------------------------------

export function parseBundleArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      'no-minify': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  return { out: values.out, minify: !values['no-minify'], help: values.help };
}

export const HELP =
  'Usage: node scripts/bundle-server.mjs [--out <dir>] [--no-minify]\n\n' +
  '  --out <dir>   server folder to write (default: apps/desktop/src-tauri/binaries/server)\n' +
  '  --no-minify   keep names and whitespace, for reading the bundle';

/** The stub that answers for an import specifier or resolved path, if any. */
export function stubFor(specifier) {
  return STUBS.find((stub) => stub.match.test(specifier.split(sep).join('/')));
}

/**
 * Root folder of the package that owns a file inside a node_modules tree, as { root, name }. Handles pnpm's
 * `.pnpm/<id>/node_modules/<name>` layout and scoped names. Undefined when the path is not inside node_modules.
 */
export function packageOf(file) {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  if (at === -1 || at + 1 >= parts.length - 1) return undefined;
  const scoped = parts[at + 1].startsWith('@');
  const length = at + (scoped ? 3 : 2);
  if (length >= parts.length) return undefined;
  return { root: parts.slice(0, length).join('/'), name: parts.slice(at + 1, length).join('/') };
}

/** True when the source looks like "run only when this file is the program": it compares import.meta.url with argv[1]. */
export function hasEntryGuard(source) {
  return /process\.argv\[1\]/.test(source) && /import\.meta\.url/.test(source);
}

export function usesImportMeta(source) {
  return /import\.meta\.(url|dirname|filename|resolve)\b/.test(source);
}

/**
 * Looks through the repository sources that went into the bundle for code that depends on where its own file is. In a bundle
 * `import.meta.url` is the bundle, so such code either breaks or (an entry guard) runs when it should not.
 * `read` maps a repository-relative path to its source. Returns a list of problems.
 */
export function checkSources(paths, read) {
  const problems = [];
  for (const path of paths) {
    const source = read(path);
    if (hasEntryGuard(source)) {
      problems.push(
        `${path} starts itself when it is the entry point (import.meta.url vs process.argv[1]); in the bundle that is always true. Stub it in STUBS.`,
      );
    }
    if (usesImportMeta(source) && !IMPORT_META_ALLOWED.has(path)) {
      problems.push(
        `${path} uses import.meta.url/dirname/filename, which points at the bundle. Handle it (like i18n/catalogs.ts) and list it in IMPORT_META_ALLOWED.`,
      );
    }
  }
  return problems;
}

// ---- esbuild ---------------------------------------------------------------------------------------------------

export async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error(
      'esbuild is not installed. It is a devDependency of @kiln/desktop: run `pnpm install` ' +
        '(or `pnpm add -D esbuild --filter @kiln/desktop` the first time).',
    );
  }
}

/** The esbuild plugin that swaps the STUBS in. Exported only so the tests can see the plugin shape. */
export function stubPlugin() {
  return {
    name: 'kiln-stubs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        const stub = stubFor(args.path);
        return stub ? { path: stub.name, namespace: 'kiln-stub' } : undefined;
      });
      build.onLoad({ filter: /.*/, namespace: 'kiln-stub' }, (args) => ({
        contents: STUBS.find((stub) => stub.name === args.path).source,
        loader: 'js',
      }));
    },
  };
}

function listFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}

/**
 * Bundles the server and works out the files that go beside it. Writes nothing.
 * Returns { files, stats, warnings } where `files` are { to, contents } or { to, from } (copy), `to` relative to the server folder.
 * Throws an Error whose message lists the problems.
 */
export async function buildServer({ repoRoot = defaultRepoRoot, esbuild, minify = true } = {}) {
  const entry = join(repoRoot, SERVER_ENTRY);
  const localesFrom = join(repoRoot, LOCALES_SOURCE);
  for (const path of [entry, localesFrom]) {
    if (!existsSync(path)) throw new Error(`Missing ${relative(repoRoot, path)}.`);
  }
  const { build } = esbuild ?? (await loadEsbuild());

  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    outfile: 'launcher.mjs', // never written: write is false
    write: false,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: NODE_TARGET,
    minify,
    treeShaking: true,
    legalComments: 'none',
    banner: { js: BANNER },
    plugins: [stubPlugin()],
    metafile: true,
    logLevel: 'silent',
    // Imports in the sources say `.ts`; esbuild reads that as written. Packages are found through node_modules like Node does.
  });

  const inputs = Object.keys(result.metafile.inputs);
  const own = inputs.filter((path) => !path.includes('node_modules') && !path.includes(':'));
  const problems = checkSources(own, (path) => readFileSync(join(repoRoot, path), 'utf8'));
  if (problems.length > 0) {
    throw new Error(`The server cannot be bundled as it is:\n- ${problems.join('\n- ')}`);
  }

  const warnings = result.warnings.map(
    (w) => `${w.location ? `${w.location.file}:${w.location.line}: ` : ''}${w.text}`,
  );
  const output = result.outputFiles[0];
  const files = [{ to: 'launcher.mjs', contents: output.contents }];

  for (const from of listFiles(localesFrom)) {
    files.push({ to: join('locales', relative(localesFrom, from)), from });
  }

  const packages = new Map(); // name -> { root, version }
  for (const input of inputs) {
    const owner = packageOf(input);
    if (!owner || packages.has(owner.name)) continue;
    const manifest = JSON.parse(readFileSync(join(repoRoot, owner.root, 'package.json'), 'utf8'));
    packages.set(owner.name, { root: join(repoRoot, owner.root), version: manifest.version });
  }
  const noLicence = [];
  for (const [name, { root }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const licences = readdirSync(root).filter((file) => /^(licen[cs]e|notice|copying)/i.test(file));
    if (licences.length === 0) noLicence.push(name);
    for (const file of licences) {
      files.push({ to: join('licenses', name, file), from: join(root, file) });
    }
  }
  if (noLicence.length > 0) warnings.push(`No licence file found for: ${noLicence.join(', ')}`);

  return {
    files,
    warnings,
    stats: {
      bytes: output.contents.byteLength,
      repoModules: own.length,
      externals: [
        ...new Set(
          Object.values(result.metafile.outputs).flatMap((out) =>
            out.imports.filter((i) => i.external).map((i) => i.path),
          ),
        ),
      ].sort(),
      packages: [...packages].map(([name, { version }]) => `${name}@${version}`),
      stubbed: STUBS.map((stub) => `${stub.name}: ${stub.reason}`),
    },
  };
}

/** Writes what buildServer returned under `serverDir`. */
export function writeServer(files, serverDir) {
  for (const file of files) {
    const to = join(serverDir, file.to);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, file.contents ?? readFileSync(file.from));
  }
}

// ---- command line ----------------------------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseBundleArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  try {
    const { files, warnings, stats } = await buildServer({ minify: args.minify });
    const out = resolve(args.out ?? join(here, '../src-tauri/binaries/server'));
    writeServer(files, out);
    for (const warning of warnings) console.warn(`warning: ${warning}`);
    console.log(
      `Bundled ${stats.repoModules} server modules + ${stats.packages.join(', ')} ` +
        `-> ${out}/launcher.mjs (${stats.bytes} bytes)`,
    );
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
