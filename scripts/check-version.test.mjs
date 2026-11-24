import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check, parseVersion, setVersion, versionFiles, versionFromRef } from './check-version.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts/check-version.mjs');
const temps = [];

/** A copy of just the version files, so tests may change them. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kiln-version-'));
  temps.push(root);
  for (const [path] of versionFiles(repo)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repo, path), join(root, path));
  }
  return root;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const run = (args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '', ...env },
  });

describe('parseVersion', () => {
  test('accepts stable and pre-release versions', () => {
    assert.equal(parseVersion('1.2.3')?.prerelease, false);
    assert.equal(parseVersion('1.2.3')?.majorMinor, '1.2');
    assert.equal(parseVersion('1.2.3-rc.1')?.prerelease, true);
    assert.equal(parseVersion('0.0.0')?.version, '0.0.0');
  });
  test('rejects everything else', () => {
    for (const bad of ['1.2', '01.2.3', '1.2.3+build', 'v1.2.3', '1.2.3-', '1.2.3-01', '', 'x']) {
      assert.equal(parseVersion(bad), null, bad);
    }
  });
});

describe('versionFromRef', () => {
  test('accepts tags', () => {
    assert.deepEqual(versionFromRef('v1.2.3'), { version: '1.2.3' });
    assert.deepEqual(versionFromRef('refs/tags/v1.2.3-rc.1'), { version: '1.2.3-rc.1' });
  });
  test('rejects branches and malformed tags', () => {
    assert.match(versionFromRef('refs/heads/main').error, /not a tag/);
    assert.match(versionFromRef('1.2.3').error, /start with "v"/);
    assert.match(versionFromRef('refs/tags/v1.2').error, /not vX\.Y\.Z/);
    assert.match(versionFromRef('refs/pull/3/merge').error, /not a tag/);
  });
});

describe('check', () => {
  test('the repository is consistent with itself', () => {
    assert.deepEqual(check(repo), []);
  });
  test('a tag that differs from the files fails and names each file', () => {
    const problems = check(fixture(), '9.9.9');
    assert.ok(problems.length >= 5);
    assert.ok(problems.some((p) => p.startsWith('apps/desktop/src-tauri/Cargo.toml')));
    assert.ok(problems.some((p) => p.startsWith('apps/desktop/src-tauri/tauri.conf.json')));
  });
  test('setVersion makes every file agree, including pre-releases', () => {
    const root = fixture();
    setVersion(root, '1.4.0-rc.2');
    assert.deepEqual(check(root, '1.4.0-rc.2'), []);
    assert.match(readFileSync(join(root, 'apps/server/src/version.ts'), 'utf8'), /'1\.4\.0-rc\.2'/);
    // Only the kiln-desktop entry of Cargo.lock changes, not other crates.
    const lock = readFileSync(join(root, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8');
    assert.equal(lock.match(/version = "1\.4\.0-rc\.2"/g)?.length, 1);
  });
  test('setVersion refuses an invalid version and writes nothing', () => {
    const root = fixture();
    assert.throws(() => setVersion(root, '1.2'), /not a valid/);
    assert.deepEqual(check(root), []);
  });
  test('one file out of step is reported', () => {
    const root = fixture();
    setVersion(root, '2.0.0');
    const cargo = join(root, 'apps/desktop/src-tauri/Cargo.toml');
    writeFileSync(
      cargo,
      readFileSync(cargo, 'utf8').replace('version = "2.0.0"', 'version = "2.0.1"'),
    );
    const problems = check(root, '2.0.0');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Cargo\.toml is 2\.0\.1, expected 2\.0\.0/);
  });
});

describe('command line', () => {
  test('matching tag passes and writes outputs', () => {
    const root = fixture();
    setVersion(root, '1.2.3');
    const out = join(root, 'out.txt');
    const res = run(['--root', root, '--tag', 'v1.2.3', '--github-output'], { GITHUB_OUTPUT: out });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      readFileSync(out, 'utf8'),
      'version=1.2.3\nmajor_minor=1.2\nprerelease=false\ntag=v1.2.3\n',
    );
  });
  test('pre-release tag sets prerelease=true', () => {
    const root = fixture();
    setVersion(root, '1.2.3-rc.1');
    const out = join(root, 'out.txt');
    const res = run(['--root', root, '--ref', 'refs/tags/v1.2.3-rc.1', '--github-output'], {
      GITHUB_OUTPUT: out,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(readFileSync(out, 'utf8'), /prerelease=true/);
  });
  test('wrong tag, branch ref and bad version exit 1', () => {
    const root = fixture();
    assert.equal(run(['--root', root, '--tag', 'v7.7.7']).status, 1);
    assert.equal(run(['--root', root, '--ref', 'refs/heads/main']).status, 1);
    assert.equal(run(['--root', root, '--set', 'banana']).status, 1);
    const bad = run(['--root', root, '--tag', 'v7.7.7']);
    assert.match(bad.stderr, /expected 7\.7\.7 \(from the tag\)/);
  });
  test('annotations use workflow commands under GitHub Actions', () => {
    const root = fixture();
    const res = run(['--root', root, '--tag', 'v7.7.7'], { GITHUB_ACTIONS: 'true' });
    assert.match(res.stderr, /^::error::/m);
  });
});
