#!/usr/bin/env node
// Release version guard and bumper. See docs/releasing.md.
//
//   node scripts/check-version.mjs                       all version files agree with each other
//   node scripts/check-version.mjs --tag v1.2.3          ... and equal 1.2.3 (tag must be vX.Y.Z[-pre])
//   node scripts/check-version.mjs --ref refs/tags/v1.2.3  same, from a git ref (fails on a non-tag ref)
//   node scripts/check-version.mjs --set 1.2.3           write 1.2.3 into every version file
//   --github-output   append version, major_minor, prerelease, tag to $GITHUB_OUTPUT
//
// No dependencies, no network. Exit 1 with one message per problem.
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Semantic Versioning 2.0.0 (no build metadata: Docker tags and MSI do not allow "+").
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export function parseVersion(text) {
  const m = SEMVER.exec(text);
  if (!m) return null;
  return {
    version: text,
    major: m[1],
    minor: m[2],
    patch: m[3],
    pre: m[4] ?? '',
    prerelease: m[4] !== undefined,
    majorMinor: `${m[1]}.${m[2]}`,
  };
}

/** "v1.2.3" or "refs/tags/v1.2.3" -> the version text, or an error string. */
export function versionFromRef(ref) {
  const name = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ref;
  if (ref.startsWith('refs/') && !ref.startsWith('refs/tags/')) {
    return { error: `${ref} is not a tag. A release is cut from a tag named vX.Y.Z.` };
  }
  if (!name.startsWith('v')) {
    return { error: `Tag "${name}" does not start with "v" (expected vX.Y.Z).` };
  }
  const text = name.slice(1);
  if (!parseVersion(text)) {
    return {
      error: `Tag "${name}" is not vX.Y.Z or vX.Y.Z-prerelease (Semantic Versioning, no "+build").`,
    };
  }
  return { version: text };
}

// Each entry: where the version lives, how to read it, how to write it.
// `read` returns the version string or null when not found.
const jsonField = {
  read: (text) => JSON.parse(text).version ?? null,
  write: (text, v) => replaceOnce(text, /("version"\s*:\s*)"[^"]*"/, `$1"${v}"`),
};
const cargoToml = {
  // Only the [package] table: the first `version = "..."` line before the next table header.
  read: (text) => /^\[package\][^[]*?^version\s*=\s*"([^"]*)"/ms.exec(text)?.[1] ?? null,
  write: (text, v) => replaceOnce(text, /(^\[package\][^[]*?^version\s*=\s*)"[^"]*"/ms, `$1"${v}"`),
};
const cargoLock = {
  read: (text) => /^name = "kiln-desktop"\nversion = "([^"]*)"/m.exec(text)?.[1] ?? null,
  write: (text, v) => replaceOnce(text, /(^name = "kiln-desktop"\nversion = )"[^"]*"/m, `$1"${v}"`),
};
const versionTs = {
  read: (text) => /export const VERSION = '([^']*)'/.exec(text)?.[1] ?? null,
  write: (text, v) => replaceOnce(text, /(export const VERSION = )'[^']*'/, `$1'${v}'`),
};

function replaceOnce(text, pattern, replacement) {
  if (!pattern.test(text)) throw new Error('version field not found');
  return text.replace(pattern, replacement);
}

export function versionFiles(root) {
  const files = [
    ['package.json', jsonField],
    ['apps/desktop/src-tauri/tauri.conf.json', jsonField],
    ['apps/desktop/src-tauri/Cargo.toml', cargoToml],
    ['apps/desktop/src-tauri/Cargo.lock', cargoLock],
    ['apps/server/src/version.ts', versionTs],
  ];
  for (const group of ['apps', 'packages']) {
    let names = [];
    try {
      names = readdirSync(join(root, group), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {}
    for (const name of names) {
      const path = `${group}/${name}/package.json`;
      try {
        readFileSync(join(root, path));
        files.push([path, jsonField]);
      } catch {}
    }
  }
  return files;
}

/** Read every version. Returns { found: [{path, version}], problems: [string] }. */
export function readVersions(root) {
  const found = [];
  const problems = [];
  for (const [path, kind] of versionFiles(root)) {
    try {
      const version = kind.read(readFileSync(join(root, path), 'utf8'));
      if (version === null) problems.push(`${path}: no version found.`);
      else found.push({ path, version });
    } catch (error) {
      problems.push(`${path}: ${error.message}`);
    }
  }
  return { found, problems };
}

/** Check the files; `expected` (a version string) is optional. Returns problems. */
export function check(root, expected) {
  const { found, problems } = readVersions(root);
  const base = expected ?? found.find((f) => f.path === 'package.json')?.version;
  if (!base) return [...problems, 'No reference version (package.json has none).'];
  if (!parseVersion(base)) {
    problems.push(`"${base}" is not a valid Semantic Version (X.Y.Z[-pre]).`);
  }
  for (const f of found) {
    if (f.version !== base) {
      problems.push(
        `${f.path} is ${f.version}, expected ${base}${expected ? ' (from the tag)' : ' (package.json)'}.`,
      );
    }
  }
  return problems;
}

export function setVersion(root, version) {
  if (!parseVersion(version)) throw new Error(`"${version}" is not a valid Semantic Version.`);
  for (const [path, kind] of versionFiles(root)) {
    const file = join(root, path);
    writeFileSync(file, kind.write(readFileSync(file, 'utf8'), version));
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: 'string' },
      ref: { type: 'string' },
      set: { type: 'string' },
      root: { type: 'string' },
      'github-output': { type: 'boolean', default: false },
    },
  });
  const root = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const fail = (lines) => {
    for (const line of lines) {
      console.error(process.env.GITHUB_ACTIONS ? `::error::${line}` : `error: ${line}`);
    }
    process.exit(1);
  };

  if (values.set !== undefined) {
    try {
      setVersion(root, values.set);
    } catch (error) {
      fail([error.message]);
    }
    console.log(`Set ${values.set} in ${versionFiles(root).length} files. Review with git diff.`);
    return;
  }

  let expected;
  let tag = '';
  const given = values.tag ?? values.ref;
  if (given !== undefined) {
    const parsed = versionFromRef(given);
    if (parsed.error) fail([parsed.error]);
    expected = parsed.version;
    tag = `v${expected}`;
  }
  const problems = check(root, expected);
  if (problems.length > 0) fail(problems);

  const version = expected ?? readVersions(root).found[0].version;
  const info = parseVersion(version);
  console.log(
    `Version ${version} (${info.prerelease ? 'pre-release' : 'stable'}): ${readVersions(root).found.length} files agree.`,
  );
  if (values['github-output'] && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${version}\nmajor_minor=${info.majorMinor}\nprerelease=${info.prerelease}\ntag=${tag}\n`,
    );
  }
  // Informational, never a failure: the bundle identifier is what macOS and Windows key app data on.
  try {
    const id = JSON.parse(
      readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    ).identifier;
    if (typeof id === 'string' && id.startsWith('dev.example.')) {
      console.log(
        `${process.env.GITHUB_ACTIONS ? '::warning::' : 'warning: '}tauri.conf.json identifier is the placeholder "${id}". Choose the real one before the first public release: changing it later moves the app data folder.`,
      );
    }
  } catch {}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
