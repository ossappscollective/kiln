#!/usr/bin/env node
// Copies the installers Tauri built for one target to a flat folder with release names:
//   kiln_<version>_<os>_<arch>.<ext>   (macos|windows|linux, arm64|x64)
// Fails when a bundle that was asked for is missing or ambiguous. See docs/releasing.md.
//
//   node scripts/release/collect.mjs --bundle-dir <.../target/<triple>/release/bundle> \
//     --version 1.2.3 --os macos --arch arm64 --bundles app,dmg --out dist
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// bundle name -> [sub folder of bundle/, matches a file name, release extension]
const BUNDLES = {
  dmg: ['dmg', (n) => n.endsWith('.dmg'), 'dmg'],
  deb: ['deb', (n) => n.endsWith('.deb'), 'deb'],
  rpm: ['rpm', (n) => n.endsWith('.rpm'), 'rpm'],
  appimage: ['appimage', (n) => n.endsWith('.AppImage'), 'AppImage'],
  nsis: ['nsis', (n) => n.endsWith('-setup.exe'), 'exe'],
  msi: ['msi', (n) => n.endsWith('.msi'), 'msi'],
};

export function collect({ bundleDir, version, os, arch, bundles, out }) {
  mkdirSync(out, { recursive: true });
  const written = [];
  const base = `kiln_${version}_${os}_${arch}`;
  for (const name of bundles) {
    if (name === 'app') {
      // The .app is a folder: ship it as a tar.gz made here (Tauri only makes one for the updater).
      const macosDir = join(bundleDir, 'macos');
      const apps = readdirSync(macosDir).filter((n) => n.endsWith('.app'));
      if (apps.length !== 1)
        throw new Error(`Expected one .app in ${macosDir}, found ${apps.length}.`);
      const dest = join(out, `${base}.app.tar.gz`);
      execFileSync('tar', ['-czf', dest, '-C', macosDir, apps[0]]);
      written.push(dest);
      continue;
    }
    const spec = BUNDLES[name];
    if (!spec) throw new Error(`Unknown bundle "${name}".`);
    const [folder, matches, ext] = spec;
    const dir = join(bundleDir, folder);
    let files = [];
    try {
      files = readdirSync(dir).filter(matches);
    } catch {}
    if (files.length !== 1) {
      throw new Error(`Expected one ${name} file in ${dir}, found ${files.length}.`);
    }
    const dest = join(out, `${base}.${ext}`);
    copyFileSync(join(dir, files[0]), dest);
    written.push(dest);
  }
  return written;
}

function main() {
  const { values: v } = parseArgs({
    options: {
      'bundle-dir': { type: 'string' },
      version: { type: 'string' },
      os: { type: 'string' },
      arch: { type: 'string' },
      bundles: { type: 'string' },
      out: { type: 'string' },
    },
  });
  for (const k of ['bundle-dir', 'version', 'os', 'arch', 'bundles', 'out']) {
    if (!v[k]) {
      console.error(`error: --${k} is required.`);
      process.exit(1);
    }
  }
  try {
    const files = collect({
      bundleDir: v['bundle-dir'],
      version: v.version,
      os: v.os,
      arch: v.arch,
      bundles: v.bundles.split(',').filter(Boolean),
      out: v.out,
    });
    for (const f of files) console.log(f);
  } catch (error) {
    console.error(
      process.env.GITHUB_ACTIONS ? `::error::${error.message}` : `error: ${error.message}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
