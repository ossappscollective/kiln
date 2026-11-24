#!/usr/bin/env node
// Works out what the Release workflow does from the trigger. Reads the environment only, so
// no workflow expression is ever pasted into a shell command. Writes step outputs to
// $GITHUB_OUTPUT (or prints them). See docs/releasing.md.
//
//   EVENT_NAME     github.event_name (push | workflow_dispatch)
//   REF, REF_TYPE  github.ref, github.ref_type
//   INPUT_MODE, INPUT_REF, INPUT_VERSION, INPUT_DOCKER, INPUT_PLATFORMS   workflow_dispatch inputs
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseVersion, versionFromRef } from '../check-version.mjs';

// Runner labels and Tauri bundle names are the unverified part: see docs/releasing.md.
// `default: false` entries are built only when named in `platforms`.
export const PLATFORMS = {
  'macos-arm64': {
    runner: 'macos-15',
    target: 'aarch64-apple-darwin',
    os: 'macos',
    arch: 'arm64',
    bundles: 'app,dmg',
    default: true,
  },
  'macos-x64': {
    runner: 'macos-15-intel',
    target: 'x86_64-apple-darwin',
    os: 'macos',
    arch: 'x64',
    bundles: 'app,dmg',
    default: true,
  },
  'windows-x64': {
    runner: 'windows-latest',
    target: 'x86_64-pc-windows-msvc',
    os: 'windows',
    arch: 'x64',
    bundles: 'nsis,msi',
    default: true,
  },
  'windows-arm64': {
    runner: 'windows-11-arm',
    target: 'aarch64-pc-windows-msvc',
    os: 'windows',
    arch: 'arm64',
    bundles: 'nsis',
    default: false,
  },
  'linux-x64': {
    runner: 'ubuntu-22.04',
    target: 'x86_64-unknown-linux-gnu',
    os: 'linux',
    arch: 'x64',
    bundles: 'deb,rpm,appimage',
    default: true,
  },
  'linux-arm64': {
    runner: 'ubuntu-22.04-arm',
    target: 'aarch64-unknown-linux-gnu',
    os: 'linux',
    arch: 'arm64',
    bundles: 'deb,rpm,appimage',
    default: true,
  },
};

const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

export function plan(env) {
  const errors = [];
  const event = env.EVENT_NAME ?? '';
  const dispatch = event === 'workflow_dispatch';
  if (event !== 'push' && !dispatch) errors.push(`Unsupported event "${event}".`);

  const mode = dispatch ? env.INPUT_MODE || 'build-only' : 'release';
  if (mode !== 'build-only' && mode !== 'release') errors.push(`mode must be build-only or release, got "${mode}".`);
  const release = mode === 'release';

  let checkoutRef = (dispatch && env.INPUT_REF ? env.INPUT_REF : env.REF) ?? '';
  if (!SAFE_REF.test(checkoutRef) || checkoutRef.includes('..')) {
    errors.push('ref contains characters that are not allowed in a branch, tag or commit name.');
  }
  if (release) {
    // A bare "v1.2.3" typed in the ref box is a tag; anything else must already be refs/tags/.
    if (!checkoutRef.startsWith('refs/') && /^v\d/.test(checkoutRef)) checkoutRef = `refs/tags/${checkoutRef}`;
    const parsed = versionFromRef(checkoutRef);
    if (!checkoutRef.startsWith('refs/tags/') || parsed.error) {
      errors.push(
        parsed.error && checkoutRef.startsWith('refs/tags/')
          ? parsed.error
          : `Release mode needs a vX.Y.Z tag. Pick the tag under "Use workflow from", or put it in "ref" (got ${checkoutRef || 'nothing'}).`,
      );
    }
  }

  const versionOverride = dispatch ? (env.INPUT_VERSION ?? '').trim() : '';
  if (versionOverride) {
    if (release) errors.push('version is for build-only test builds. A release takes its version from the tag.');
    else if (!parseVersion(versionOverride)) errors.push(`version "${versionOverride}" is not X.Y.Z or X.Y.Z-prerelease.`);
  }

  const docker = dispatch ? (env.INPUT_DOCKER ?? 'true') !== 'false' : true;

  const asked = (dispatch ? (env.INPUT_PLATFORMS ?? '') : '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let keys;
  if (asked.length === 0 || (asked.length === 1 && asked[0] === 'all')) {
    keys = Object.keys(PLATFORMS).filter((k) => PLATFORMS[k].default);
  } else if (asked.length === 1 && asked[0] === 'none') {
    keys = [];
  } else {
    const unknown = asked.filter((k) => !(k in PLATFORMS));
    if (unknown.length > 0) {
      errors.push(`Unknown platform(s): ${unknown.join(', ')}. Use: ${Object.keys(PLATFORMS).join(', ')}, all or none.`);
    }
    keys = Object.keys(PLATFORMS).filter((k) => asked.includes(k));
  }

  if (errors.length > 0) return { errors };
  return {
    errors,
    outputs: {
      mode,
      release: String(release),
      checkout_ref: checkoutRef,
      version_override: versionOverride,
      docker: String(docker),
      desktop: String(keys.length > 0),
      desktop_count: String(keys.length),
      matrix: JSON.stringify({ include: keys.map((key) => ({ key, ...PLATFORMS[key] })) }),
    },
  };
}

function main() {
  const result = plan(process.env);
  if (result.errors.length > 0) {
    for (const line of result.errors) {
      console.error(process.env.GITHUB_ACTIONS ? `::error::${line}` : `error: ${line}`);
    }
    process.exit(1);
  }
  const lines = Object.entries(result.outputs).map(([k, v]) => `${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
