#!/usr/bin/env node
// Prints the Release workflow's job summary (Markdown) to stdout; the workflow appends it to
// $GITHUB_STEP_SUMMARY. Reads only the environment and the downloaded artifacts:
//
//   ARTIFACTS_DIR   folder holding desktop-<key>/ and meta-<key>/ (download-artifact, not merged)
//   MODE, VERSION, RESULTS (JSON {job: result}), IMAGE, DOCKER_DIGEST, RELEASE_URL (optional)
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

export function summary(env) {
  const dir = env.ARTIFACTS_DIR ?? 'artifacts';
  const mode = env.MODE ?? 'build-only';
  const results = JSON.parse(env.RESULTS ?? '{}');
  const out = [];

  out.push(`## Release workflow: ${mode}`, '');
  out.push(
    mode === 'release'
      ? 'Release mode: a **draft** GitHub Release is created. Review it, then publish it by hand.'
      : '**Build-only run.** Nothing was published: no GitHub Release, no Docker push, no tags. The files below are Actions artifacts and expire after 7 days.',
    '',
    `Version: \`${env.VERSION ?? 'unknown'}\``,
    '',
    '| Job | Result |',
    '| --- | --- |',
  );
  for (const [job, result] of Object.entries(results)) out.push(`| ${job} | ${result} |`);
  out.push('');

  out.push('### Desktop installers', '');
  const rows = [];
  const folders = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.startsWith('desktop-'))
        .sort()
    : [];
  for (const folder of folders) {
    const key = folder.slice('desktop-'.length);
    let signing = 'unknown';
    try {
      signing = JSON.parse(readFileSync(join(dir, `meta-${key}`, `${key}.json`), 'utf8')).signing;
    } catch {}
    for (const name of readdirSync(join(dir, folder)).sort()) {
      const path = join(dir, folder, name);
      const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
      rows.push(
        `| \`${name}\` | ${mb(statSync(path).size)} | ${signing} | \`${sha.slice(0, 16)}...\` |`,
      );
    }
  }
  if (rows.length === 0) {
    out.push('No installers were produced.');
  } else {
    out.push('| File | Size | Signing | SHA-256 (start) |', '| --- | --- | --- | --- |', ...rows);
    if (rows.some((r) => r.includes('| unsigned |'))) {
      out.push(
        '',
        'Some installers are **unsigned** (no signing secrets, or not on that platform). They build and run; macOS Gatekeeper and Windows SmartScreen ask for confirmation. See docs/releasing.md.',
      );
    }
  }
  out.push('');

  out.push('### Docker image', '');
  if (env.DOCKER_DIGEST) {
    out.push(
      `Pushed \`${env.IMAGE}\` (linux/amd64, linux/arm64), digest \`${env.DOCKER_DIGEST}\`.`,
    );
  } else if (results['docker-oci'] === 'success') {
    out.push(
      'Built for linux/amd64 and linux/arm64 and exported as the `docker-oci` artifact (OCI tar). Not pushed.',
    );
  } else if (results['docker-smoke']) {
    out.push(`No image output (smoke test: ${results['docker-smoke']}).`);
  } else {
    out.push('Skipped.');
  }
  if (env.RELEASE_URL) out.push('', `Draft release: ${env.RELEASE_URL}`);
  return `${out.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(summary(process.env));
}
