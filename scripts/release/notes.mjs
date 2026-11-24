#!/usr/bin/env node
// Writes the hand-written part of the GitHub Release notes to stdout (the workflow adds the
// generated changelog after it). Reads the collected installers and the per-platform
// build metadata, so the signing notes always match what was actually built.
//
//   node scripts/release/notes.mjs --version 1.2.3 --tag v1.2.3 --repo owner/name --dist dist \
//     --meta meta [--prerelease] [--image ghcr.io/owner/name] [--docker-digest sha256:...]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const LABELS = {
  'macos-arm64': 'macOS, Apple Silicon (M1 and later)',
  'macos-x64': 'macOS, Intel',
  'windows-x64': 'Windows, x64',
  'windows-arm64': 'Windows, ARM64',
  'linux-x64': 'Linux, x64',
  'linux-arm64': 'Linux, ARM64',
};

const size = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

export function notes({ version, tag, repo, dist, meta, prerelease, image, dockerDigest }) {
  const files = existsSync(dist)
    ? readdirSync(dist)
        .filter((n) => n.startsWith('kiln_'))
        .sort()
    : [];
  const metas = existsSync(meta)
    ? readdirSync(meta)
        .filter((n) => n.endsWith('.json'))
        .map((n) => JSON.parse(readFileSync(join(meta, n), 'utf8')))
    : [];
  const out = [];

  if (prerelease)
    out.push(`> Pre-release ${version}. Not tagged \`latest\` on Docker; expect rough edges.\n`);

  out.push('## Downloads\n', '| Platform | File | Size |', '| --- | --- | --- |');
  for (const name of files) {
    const m = /^kiln_.+?_(macos|windows|linux)_(arm64|x64)\./.exec(name);
    const label = m ? (LABELS[`${m[1]}-${m[2]}`] ?? `${m[1]} ${m[2]}`) : '';
    out.push(`| ${label} | \`${name}\` | ${size(statSync(join(dist, name)).size)} |`);
  }
  out.push(
    '',
    'Check a download against `SHA256SUMS`, and its build provenance with the GitHub CLI:',
    '',
    '```sh',
    'sha256sum -c SHA256SUMS --ignore-missing',
    `gh attestation verify <file> --repo ${repo}`,
    '```',
    '',
  );

  if (image) {
    const base = `${image}:${version}`;
    out.push('## Docker', '', '```sh', `docker pull ${base}`, '```', '');
    if (dockerDigest)
      out.push(`Image digest: \`${dockerDigest}\` (linux/amd64 and linux/arm64).`, '');
    out.push(
      `Setup: [docs/deployment.md](https://github.com/${repo}/blob/${tag}/docs/deployment.md).`,
      '',
    );
  }

  const unsignedMac = metas.filter((m) => m.os === 'macos' && m.signing !== 'notarized');
  const unsignedWin = metas.filter((m) => m.os === 'windows' && m.signing !== 'signed');
  if (
    unsignedMac.length > 0 ||
    unsignedWin.length > 0 ||
    files.some((n) => n.endsWith('.AppImage'))
  ) {
    out.push('## Opening the apps', '');
  }
  if (unsignedMac.length > 0) {
    const state = unsignedMac.every((m) => m.signing === 'unsigned')
      ? 'not signed or notarized'
      : 'signed but not notarized';
    out.push(
      `**macOS.** The macOS app in this release is ${state} by Apple, so Gatekeeper blocks the first launch ("Kiln is damaged" or "cannot be opened"). Either:`,
      '',
      '- Drag Kiln to Applications, then run `xattr -dr com.apple.quarantine /Applications/Kiln.app` in Terminal, or',
      '- Try to open it once, then open System Settings, Privacy & Security, and choose "Open Anyway".',
      '',
      'Only do this for a download whose checksum and attestation you verified.',
      '',
    );
  }
  if (unsignedWin.length > 0) {
    out.push(
      '**Windows.** The installer is not code-signed, so SmartScreen shows "Windows protected your PC": choose "More info", then "Run anyway".',
      '',
    );
  }
  if (files.some((n) => n.endsWith('.AppImage'))) {
    out.push('**Linux.** Make the AppImage executable first: `chmod +x kiln_*.AppImage`.', '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function main() {
  const { values: v } = parseArgs({
    options: {
      version: { type: 'string' },
      tag: { type: 'string' },
      repo: { type: 'string' },
      dist: { type: 'string' },
      meta: { type: 'string' },
      prerelease: { type: 'boolean', default: false },
      image: { type: 'string' },
      'docker-digest': { type: 'string' },
    },
  });
  for (const k of ['version', 'tag', 'repo', 'dist', 'meta']) {
    if (!v[k]) {
      console.error(`error: --${k} is required.`);
      process.exit(1);
    }
  }
  process.stdout.write(notes({ ...v, dockerDigest: v['docker-digest'] }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
