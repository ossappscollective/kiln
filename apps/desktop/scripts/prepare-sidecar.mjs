#!/usr/bin/env node
// Stages the desktop server for Tauri. See docs/adr/0004-desktop-sidecar.md.
//
// For one target triple this puts into src-tauri/binaries (git-ignored):
//   kiln-node-<triple>[.exe]   the Node binary. Tauri `externalBin` entry "binaries/kiln-node".
//   server/                   launcher.mjs (the whole server, bundled and minified by esbuild: no
//                             node_modules, no loose sources), locales/, licenses/ and web/ (the built
//                             UI). Tauri `resources` entry.
//
// No network: the Node binary and the web UI are copied, the server is bundled by
// scripts/bundle-server.mjs (needs the esbuild devDependency of @kiln/desktop).
//
//   node scripts/prepare-sidecar.mjs --check        show what would happen, write nothing
//   node scripts/prepare-sidecar.mjs                stage for the host target
//   node scripts/prepare-sidecar.mjs --smoke        stage, then start the staged server once
//
// Options: --target <triple>  --node <path>  --out <dir>  --allow-missing-web  --help
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildServer, writeServer } from './bundle-server.mjs';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '../..');

// Same floor as the root package.json "engines". The bundle itself needs only node:sqlite (Node 22.13+).
const MIN_NODE = [22, 18, 0];

// Tauri target triple -> what `process.platform` and `process.arch` report for its Node binary,
// and the name of the matching archive at https://nodejs.org/dist/.
const TARGETS = {
  'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64', dist: 'darwin-arm64' },
  'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64', dist: 'darwin-x64' },
  'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64', dist: 'linux-x64' },
  'aarch64-unknown-linux-gnu': { platform: 'linux', arch: 'arm64', dist: 'linux-arm64' },
  'x86_64-pc-windows-msvc': { platform: 'win32', arch: 'x64', dist: 'win-x64' },
  'aarch64-pc-windows-msvc': { platform: 'win32', arch: 'arm64', dist: 'win-arm64' },
};

const { values: options } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    smoke: { type: 'boolean', default: false },
    target: { type: 'string' },
    node: { type: 'string' },
    out: { type: 'string' },
    'allow-missing-web': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (options.help) {
  console.log(
    'Usage: node scripts/prepare-sidecar.mjs [--check] [--smoke] [--target <triple>]\n' +
      '         [--node <path>] [--out <dir>] [--allow-missing-web]\n\n' +
      '  --check              validate inputs and print the plan; write nothing\n' +
      '  --smoke              after staging, start the staged server once and call it\n' +
      '  --target <triple>    default: the host triple (rustc, or guessed from Node)\n' +
      '  --node <path>        Node binary to ship; required when --target is not the host\n' +
      '  --out <dir>          default: apps/desktop/src-tauri/binaries\n' +
      '  --allow-missing-web  do not fail when apps/web/dist has not been built',
  );
  process.exit(0);
}
if (options.check && options.smoke) fail('--smoke needs a real run; drop --check.');

const errors = [];
const warnings = [];
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
const problem = (message) => errors.push(message);
const caution = (message) => warnings.push(message);

// ---- target triple ---------------------------------------------------------------------------

function guessTriple() {
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  if (!arch) return undefined;
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  if (process.platform === 'linux') {
    const glibc = process.report?.getReport().header.glibcVersionRuntime;
    return `${arch}-unknown-linux-${glibc ? 'gnu' : 'musl'}`;
  }
  return undefined;
}

/** Tauri names the sidecar after rustc's host triple, so ask rustc when it is installed. */
function hostTriple() {
  const printed = spawnSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' });
  if (printed.status === 0 && printed.stdout.trim()) {
    return { triple: printed.stdout.trim(), source: 'rustc --print host-tuple' };
  }
  const verbose = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  const host = verbose.status === 0 ? /^host: (.+)$/m.exec(verbose.stdout) : null;
  if (host?.[1]) return { triple: host[1].trim(), source: 'rustc -vV' };
  const guessed = guessTriple();
  if (guessed) return { triple: guessed, source: 'guessed from this Node (rustc not found)' };
  return fail(`Cannot work out the host target triple. Pass --target <triple>.`);
}

const host = hostTriple();
const triple = options.target ?? host.triple;
const targetInfo = TARGETS[triple];
const isWindows = triple.includes('windows');
const exe = isWindows ? '.exe' : '';
if (!targetInfo) {
  const known = Object.keys(TARGETS).join(', ');
  caution(`${triple} is not one of the targets this script knows (${known}).`);
}

// ---- the Node binary -------------------------------------------------------------------------

const versionAtLeast = (version, min) => {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) !== min[i]) return (parts[i] ?? 0) > min[i];
  }
  return true;
};

/** Runs the binary to learn what it is. Returns undefined when it cannot run on this machine. */
function inspectNode(binary) {
  const probe = [
    'const v = process.config.variables;',
    'let sqlite = false;',
    "try { require('node:sqlite'); sqlite = true; } catch {}",
    'console.log(JSON.stringify({ version: process.version, platform: process.platform,',
    '  arch: process.arch, sqlite,',
    "  shared: Object.keys(v).filter((k) => k.startsWith('node_shared') && v[k] === true) }));",
  ].join('\n');
  const result = spawnSync(binary, ['--disable-warning=ExperimentalWarning', '-e', probe], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return undefined;
  }
}

const nodeSource = resolve(options.node ?? process.execPath);
const nodeIsHostBinary = triple === host.triple;
let nodeInfo;
if (!existsSync(nodeSource)) {
  problem(`Node binary not found: ${nodeSource}`);
} else if (!options.node && !nodeIsHostBinary) {
  const dist = targetInfo?.dist ?? '<platform>-<arch>';
  problem(
    `--target ${triple} is not the host (${host.triple}), so pass --node with the official ` +
      `Node ${MIN_NODE.slice(0, 2).join('.')}+ binary for it (node-v<version>-${dist} from ` +
      'https://nodejs.org/dist/, checked against SHASUMS256.txt).',
  );
} else {
  nodeInfo = inspectNode(nodeSource);
  if (!nodeInfo) {
    (nodeIsHostBinary ? problem : caution)(
      `Cannot run ${nodeSource} here, so its version and node:sqlite were not checked.`,
    );
  } else {
    if (!versionAtLeast(nodeInfo.version, MIN_NODE)) {
      const floor = MIN_NODE.join('.');
      problem(`Node ${nodeInfo.version} is older than ${floor} (type stripping, node:sqlite).`);
    }
    if (!nodeInfo.sqlite) problem('This Node cannot load node:sqlite.');
    if (nodeInfo.shared.length > 0) {
      problem(
        `This Node uses shared libraries (${nodeInfo.shared.join(', ')}), so the copy would not ` +
          'run on another machine. Use the official binary from nodejs.org (or nvm, fnm, Volta), ' +
          'not a Homebrew or distribution package.',
      );
    }
    const { platform, arch } = nodeInfo;
    const wrongBuild = targetInfo && (platform !== targetInfo.platform || arch !== targetInfo.arch);
    if (wrongBuild) {
      problem(`This Node is ${nodeInfo.platform}-${nodeInfo.arch} but the target is ${triple}.`);
    }
  }
}

// ---- what to stage ---------------------------------------------------------------------------

const outDir = resolve(options.out ?? join(desktopDir, 'src-tauri/binaries'));
const nodeDest = join(outDir, `kiln-node-${triple}${exe}`);
const serverDest = join(outDir, 'server');

/** Every regular file below `dir` (symlinks followed, sorted) as { from, to } copy jobs. */
function collect(dir, destDir, seen = new Set()) {
  const real = realpathSync(dir);
  if (seen.has(real)) return [];
  seen.add(real);
  const jobs = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const from = join(dir, entry.name);
    const kind = entry.isSymbolicLink() ? statSync(from) : entry;
    if (kind.isDirectory()) jobs.push(...collect(from, join(destDir, entry.name), seen));
    else if (kind.isFile()) jobs.push({ from, to: join(destDir, entry.name) });
  }
  return jobs;
}

const jobs = []; // files copied as they are: { from, to } (absolute)
let bundle; // what bundle-server.mjs made: launcher.mjs, locales/, licenses/

try {
  bundle = await buildServer({ repoRoot });
} catch (error) {
  problem(`Cannot bundle the server: ${error.message}`);
}
if (bundle) {
  for (const file of bundle.files) {
    if (file.from) jobs.push({ from: file.from, to: join(serverDest, file.to) });
  }
}

const webDist = join(repoRoot, 'apps/web/dist');
if (existsSync(join(webDist, 'index.html'))) {
  jobs.push(...collect(webDist, join(serverDest, 'web')));
} else {
  (options['allow-missing-web'] ? caution : problem)(
    `Web UI not built: ${relative(repoRoot, webDist)}/index.html is missing. Run: pnpm build` +
      (options['allow-missing-web'] ? ' (continuing: --allow-missing-web)' : ''),
  );
}

// ---- report ----------------------------------------------------------------------------------

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const bundleBytes = bundle?.stats.bytes ?? 0;
const bytes = jobs.reduce((sum, job) => sum + statSync(job.from).size, 0) + bundleBytes;
const nodeBytes = existsSync(nodeSource) ? statSync(nodeSource).size : 0;
const rel = (p) => {
  const shown = relative(process.cwd(), p) || '.';
  return shown.startsWith('..') ? p : shown;
};

console.log(`${options.check ? 'Check (nothing is written)' : 'Prepare sidecar'}`);
console.log(`  target     ${triple}  (${options.target ? '--target' : host.source})`);
const nodeNote = nodeInfo
  ? `  ${nodeInfo.version}, node:sqlite ${nodeInfo.sqlite ? 'ok' : 'MISSING'}`
  : '';
console.log(`  node       ${nodeSource}${nodeNote}`);
console.log(`  -> binary  ${rel(nodeDest)}  (${mb(nodeBytes)})`);
const fileCount = jobs.length + (bundle ? 1 : 0);
console.log(`  -> server  ${rel(serverDest)}  (${fileCount} files, ${mb(bytes)})`);
if (bundle) {
  const { stats } = bundle;
  console.log(
    `     launcher.mjs  ${mb(bundleBytes)}: ${stats.repoModules} server modules, esbuild, minified`,
  );
  console.log(`     third party   ${stats.packages.join(', ') || '(none)'}`);
  for (const line of stats.stubbed) console.log(`     stubbed       ${line}`);
  for (const message of bundle.warnings) caution(message);
}
for (const message of warnings) console.log(`warning: ${message}`);
for (const message of errors) console.error(`error: ${message}`);

if (errors.length > 0) {
  console.error(`\n${errors.length} problem(s). Nothing was written.`);
  process.exit(1);
}
if (options.check) {
  console.log('\nOK. A real run would stage the files above.');
  process.exit(0);
}

// ---- write -----------------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });

const unchanged =
  existsSync(nodeDest) &&
  statSync(nodeDest).size === statSync(nodeSource).size &&
  statSync(nodeDest).mtimeMs >= statSync(nodeSource).mtimeMs;
if (!unchanged) {
  copyFileSync(nodeSource, nodeDest);
  if (!isWindows) chmodSync(nodeDest, 0o755);
}

rmSync(serverDest, { recursive: true, force: true });
writeServer(bundle.files, serverDest);
for (const job of jobs.filter((j) => j.to.startsWith(join(serverDest, 'web')))) {
  mkdirSync(dirname(job.to), { recursive: true });
  copyFileSync(job.from, job.to);
}
console.log(`\nStaged. Node binary ${unchanged ? 'was up to date' : 'copied'}; server rewritten.`);

if (options.smoke) {
  const outcome = await smoke(nodeDest, serverDest, existsSync(join(serverDest, 'web/index.html')));
  if (!outcome.ok) {
    console.error(`smoke test FAILED: ${outcome.reason}`);
    process.exit(1);
  }
  console.log(`smoke test passed: ${outcome.steps.join('; ')}`);
}

// ---- smoke test ------------------------------------------------------------------------------

/** The environment the desktop shell gives the server (single-user mode, secrets, no argv). */
function serverEnv(dataDir, port, serverDir, extra = {}) {
  return {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    KILN_MODE: 'single_user',
    KILN_LAUNCH_SECRET: randomBytes(32).toString('hex'),
    KILN_MASTER_KEY: randomBytes(32).toString('base64'),
    PORT: String(port),
    KILN_DATA_DIR: dataDir,
    DATABASE_URL: `file:${join(dataDir, 'kiln.db')}`,
    KILN_WEB_DIST: join(serverDir, 'web'),
    KILN_WORKER: 'inline',
    KILN_EXIT_WITH_PARENT: '1',
    ...extra,
  };
}

/** Starts the server with a Postgres URL: the bundle has no driver and must say so and exit non-zero. */
function postgresRefused(nodeBinary, serverDir, dataDir) {
  return new Promise((done) => {
    const child = spawn(
      nodeBinary,
      ['--disable-warning=ExperimentalWarning', join(serverDir, 'launcher.mjs')],
      {
        cwd: dataDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: serverEnv(dataDir, 8788, serverDir, {
          DATABASE_URL: 'postgres://u:p@127.0.0.1:1/kiln',
        }),
      },
    );
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (c) => (output += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
}

/**
 * Starts the staged server the way the desktop shell does (single-user mode, secret and master
 * key in the environment, stdin kept open), calls it, then closes stdin and expects a clean exit.
 */
async function smoke(nodeBinary, serverDir, hasWeb) {
  const dataDir = mkdtempSync(join(tmpdir(), 'kiln-smoke-'));
  const port = await new Promise((done, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => done(free));
    });
  });
  const args = ['--disable-warning=ExperimentalWarning', join(serverDir, 'launcher.mjs')];
  const child = spawn(nodeBinary, args, {
    cwd: dataDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: serverEnv(dataDir, port, serverDir),
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise((done) => child.once('exit', (code) => done({ code })));
  const finish = async (ok, reason, steps = []) => {
    if (child.exitCode === null) child.kill('SIGKILL');
    // Windows keeps the directory locked until the process is really gone, so wait for it and
    // retry; a leftover temp folder must never fail the smoke test.
    await Promise.race([exited, new Promise((wait) => setTimeout(wait, 5000))]);
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      console.warn(`could not remove ${dataDir}: ${error.code ?? error}`);
    }
    return { ok, steps, reason: ok ? '' : `${reason}\n--- server output ---\n${output.trim()}` };
  };

  const base = `http://127.0.0.1:${port}`;
  const steps = [];
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i++) {
    if (child.exitCode !== null) {
      return finish(false, `server exited early (code ${child.exitCode})`);
    }
    try {
      healthy = (await fetch(`${base}/api/health`)).status === 200;
    } catch {
      await new Promise((wait) => setTimeout(wait, 200));
    }
  }
  if (!healthy) return finish(false, 'no healthy /api/health within 20 seconds');
  steps.push('/api/health 200');

  if (hasWeb) {
    const page = await fetch(`${base}/`);
    if (page.status !== 200) return finish(false, `GET / answered ${page.status}`);
    steps.push('web UI served');
  }
  // fetch() will not let a caller set Host, so use node:http for the DNS-rebinding check.
  const rebound = await new Promise((done) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: '/api/health', headers: { host: 'evil.example' } },
      (response) => {
        response.resume();
        done(response.statusCode);
      },
    );
    request.once('error', () => done(undefined));
    request.end();
  });
  if (rebound !== 403) return finish(false, `a foreign Host header got ${rebound}, not 403`);
  steps.push('foreign Host refused');

  child.stdin.end();
  const result = await Promise.race([
    exited,
    new Promise((wait) => setTimeout(() => wait(undefined), 5000)),
  ]);
  if (!result) return finish(false, 'server did not exit within 5 seconds of stdin closing');
  if (result.code !== 0) return finish(false, `server exited with code ${result.code}`);
  steps.push('exits cleanly when stdin closes');

  const pg = await postgresRefused(nodeBinary, serverDir, dataDir);
  if (pg.code === 0 || pg.code === null || !pg.output.includes('PostgreSQL is not available')) {
    return finish(false, `a Postgres URL was not refused clearly (exit ${pg.code}): ${pg.output}`);
  }
  steps.push('Postgres refused with a clear message');
  return finish(true, '', steps);
}
