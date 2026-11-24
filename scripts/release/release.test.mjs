import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collect } from './collect.mjs';
import { notes } from './notes.mjs';
import { plan } from './plan.mjs';
import { summary } from './summary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const temps = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'kiln-release-'));
  temps.push(d);
  return d;
};
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe('plan', () => {
  const tagPush = { EVENT_NAME: 'push', REF: 'refs/tags/v1.2.3', REF_TYPE: 'tag' };

  test('a tag push is a full release of every default platform with Docker', () => {
    const { errors, outputs } = plan(tagPush);
    assert.deepEqual(errors, []);
    assert.equal(outputs.mode, 'release');
    assert.equal(outputs.release, 'true');
    assert.equal(outputs.checkout_ref, 'refs/tags/v1.2.3');
    assert.equal(outputs.docker, 'true');
    const keys = JSON.parse(outputs.matrix).include.map((e) => e.key);
    assert.deepEqual(keys, ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64', 'linux-arm64']);
  });

  test('macOS Apple Silicon and Intel are separate legs with their own target', () => {
    const include = JSON.parse(plan(tagPush).outputs.matrix).include;
    const targets = Object.fromEntries(include.map((e) => [e.key, e.target]));
    assert.equal(targets['macos-arm64'], 'aarch64-apple-darwin');
    assert.equal(targets['macos-x64'], 'x86_64-apple-darwin');
  });

  test('a manual run defaults to build-only on the selected ref', () => {
    const { errors, outputs } = plan({
      EVENT_NAME: 'workflow_dispatch',
      REF: 'refs/heads/main',
      REF_TYPE: 'branch',
    });
    assert.deepEqual(errors, []);
    assert.equal(outputs.mode, 'build-only');
    assert.equal(outputs.release, 'false');
    assert.equal(outputs.checkout_ref, 'refs/heads/main');
  });

  test('release mode needs a v tag', () => {
    const base = { EVENT_NAME: 'workflow_dispatch', INPUT_MODE: 'release' };
    assert.match(
      plan({ ...base, REF: 'refs/heads/main', REF_TYPE: 'branch' }).errors[0],
      /needs a vX\.Y\.Z tag/,
    );
    assert.match(
      plan({ ...base, REF: 'refs/tags/release-1', REF_TYPE: 'tag' }).errors[0],
      /does not start with "v"/,
    );
    assert.match(
      plan({ ...base, REF: 'refs/tags/v1.2', REF_TYPE: 'tag' }).errors[0],
      /not vX\.Y\.Z/,
    );
    assert.deepEqual(plan({ ...base, REF: 'refs/tags/v1.2.3-rc.1', REF_TYPE: 'tag' }).errors, []);
  });

  test('a bare tag name in ref is normalised, a branch name is refused in release mode', () => {
    const base = { EVENT_NAME: 'workflow_dispatch', INPUT_MODE: 'release', REF: 'refs/heads/main' };
    assert.equal(plan({ ...base, INPUT_REF: 'v1.2.3' }).outputs.checkout_ref, 'refs/tags/v1.2.3');
    assert.ok(plan({ ...base, INPUT_REF: 'main' }).errors.length > 0);
  });

  test('the version override is only for build-only and must be valid', () => {
    const base = { EVENT_NAME: 'workflow_dispatch', REF: 'refs/heads/main' };
    assert.equal(
      plan({ ...base, INPUT_VERSION: '1.2.3-rc.1' }).outputs.version_override,
      '1.2.3-rc.1',
    );
    assert.ok(plan({ ...base, INPUT_VERSION: 'banana' }).errors.length > 0);
    assert.ok(
      plan({ ...base, INPUT_MODE: 'release', REF: 'refs/tags/v1.0.0', INPUT_VERSION: '1.0.0' })
        .errors.length > 0,
    );
  });

  test('platform subset, none, opt-in windows-arm64 and unknown names', () => {
    const base = { EVENT_NAME: 'workflow_dispatch', REF: 'refs/heads/main' };
    const keys = (p) =>
      JSON.parse(plan({ ...base, INPUT_PLATFORMS: p }).outputs.matrix).include.map((e) => e.key);
    assert.deepEqual(keys('linux-x64, macos-arm64'), ['macos-arm64', 'linux-x64']);
    assert.deepEqual(keys('windows-arm64'), ['windows-arm64']);
    assert.equal(plan({ ...base, INPUT_PLATFORMS: 'none' }).outputs.desktop, 'false');
    assert.equal(keys('all').length, 5);
    assert.match(plan({ ...base, INPUT_PLATFORMS: 'beos' }).errors[0], /Unknown platform/);
  });

  test('docker input and unsafe refs', () => {
    const base = { EVENT_NAME: 'workflow_dispatch', REF: 'refs/heads/main' };
    assert.equal(plan({ ...base, INPUT_DOCKER: 'false' }).outputs.docker, 'false');
    assert.ok(plan({ ...base, INPUT_REF: 'main; rm -rf /' }).errors.length > 0);
    assert.ok(plan({ ...base, INPUT_REF: '../x' }).errors.length > 0);
  });
});

describe('collect', () => {
  function fakeBundle(names) {
    const root = tmp();
    for (const [rel, content] of Object.entries(names)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    return root;
  }

  test('renames Linux bundles to kiln_<version>_<os>_<arch>.<ext>', () => {
    const bundleDir = fakeBundle({
      'deb/Kiln_1.2.3_arm64.deb': 'd',
      'rpm/Kiln-1.2.3-1.aarch64.rpm': 'r',
      'appimage/Kiln_1.2.3_aarch64.AppImage': 'a',
    });
    const out = join(tmp(), 'dist');
    collect({
      bundleDir,
      version: '1.2.3',
      os: 'linux',
      arch: 'arm64',
      bundles: ['deb', 'rpm', 'appimage'],
      out,
    });
    assert.deepEqual(readdirSync(out).sort(), [
      'kiln_1.2.3_linux_arm64.AppImage',
      'kiln_1.2.3_linux_arm64.deb',
      'kiln_1.2.3_linux_arm64.rpm',
    ]);
  });

  test('Windows nsis setup exe and msi', () => {
    const bundleDir = fakeBundle({
      'nsis/Kiln_1.2.3_x64-setup.exe': 'n',
      'msi/Kiln_1.2.3_x64_en-US.msi': 'm',
    });
    const out = join(tmp(), 'dist');
    collect({
      bundleDir,
      version: '1.2.3',
      os: 'windows',
      arch: 'x64',
      bundles: ['nsis', 'msi'],
      out,
    });
    assert.deepEqual(readdirSync(out).sort(), [
      'kiln_1.2.3_windows_x64.exe',
      'kiln_1.2.3_windows_x64.msi',
    ]);
  });

  test('macOS: dmg is copied and the .app is archived', () => {
    const bundleDir = fakeBundle({
      'dmg/Kiln_1.2.3_aarch64.dmg': 'x',
      'macos/Kiln.app/Contents/Info.plist': 'p',
    });
    const out = join(tmp(), 'dist');
    collect({
      bundleDir,
      version: '1.2.3',
      os: 'macos',
      arch: 'arm64',
      bundles: ['app', 'dmg'],
      out,
    });
    assert.deepEqual(readdirSync(out).sort(), [
      'kiln_1.2.3_macos_arm64.app.tar.gz',
      'kiln_1.2.3_macos_arm64.dmg',
    ]);
    const list = spawnSync('tar', ['-tzf', join(out, 'kiln_1.2.3_macos_arm64.app.tar.gz')], {
      encoding: 'utf8',
    });
    assert.match(list.stdout, /Kiln\.app\/Contents\/Info\.plist/);
  });

  test('a missing or ambiguous bundle fails', () => {
    const missing = fakeBundle({ 'deb/Kiln_1.2.3_amd64.deb': 'd' });
    assert.throws(
      () =>
        collect({
          bundleDir: missing,
          version: '1',
          os: 'linux',
          arch: 'x64',
          bundles: ['deb', 'rpm'],
          out: tmp(),
        }),
      /Expected one rpm/,
    );
    const two = fakeBundle({ 'deb/a.deb': 'd', 'deb/b.deb': 'd' });
    assert.throws(
      () =>
        collect({
          bundleDir: two,
          version: '1',
          os: 'linux',
          arch: 'x64',
          bundles: ['deb'],
          out: tmp(),
        }),
      /found 2/,
    );
  });
});

describe('notes', () => {
  function dist(signing) {
    const d = tmp();
    const dir = join(d, 'dist');
    const meta = join(d, 'meta');
    mkdirSync(dir);
    mkdirSync(meta);
    writeFileSync(join(dir, 'kiln_1.2.3_macos_arm64.dmg'), 'x');
    writeFileSync(join(dir, 'kiln_1.2.3_windows_x64.exe'), 'x');
    writeFileSync(join(dir, 'kiln_1.2.3_linux_x64.AppImage'), 'x');
    writeFileSync(join(dir, 'SHA256SUMS'), 'x');
    writeFileSync(
      join(meta, 'macos-arm64.json'),
      JSON.stringify({ os: 'macos', signing: signing.mac }),
    );
    writeFileSync(
      join(meta, 'windows-x64.json'),
      JSON.stringify({ os: 'windows', signing: signing.win }),
    );
    return { dir, meta };
  }
  const args = {
    version: '1.2.3',
    tag: 'v1.2.3',
    repo: 'o/k',
    prerelease: false,
    image: 'ghcr.io/o/k',
    dockerDigest: 'sha256:abc',
  };

  test('unsigned builds get the Gatekeeper and SmartScreen instructions', () => {
    const { dir, meta } = dist({ mac: 'unsigned', win: 'unsigned' });
    const text = notes({ ...args, dist: dir, meta });
    assert.match(text, /not signed or notarized/);
    assert.match(text, /xattr -dr com\.apple\.quarantine/);
    assert.match(text, /SmartScreen/);
    assert.match(text, /chmod \+x/);
    assert.match(text, /docker pull ghcr\.io\/o\/k:1\.2\.3/);
    assert.match(
      text,
      /\| macOS, Apple Silicon \(M1 and later\) \| `kiln_1\.2\.3_macos_arm64\.dmg`/,
    );
    assert.doesNotMatch(text, /SHA256SUMS`? \|/);
  });

  test('notarized and signed builds omit the warnings', () => {
    const { dir, meta } = dist({ mac: 'notarized', win: 'signed' });
    const text = notes({ ...args, dist: dir, meta });
    assert.doesNotMatch(text, /Gatekeeper/);
    assert.doesNotMatch(text, /SmartScreen/);
  });

  test('signed but not notarized says so; pre-release is flagged', () => {
    const { dir, meta } = dist({ mac: 'signed', win: 'signed' });
    const text = notes({ ...args, prerelease: true, dist: dir, meta });
    assert.match(text, /signed but not notarized/);
    assert.match(text, /Pre-release 1\.2\.3/);
  });
});

describe('shell scripts', () => {
  const sourceSigning = (env) =>
    spawnSync(
      'bash',
      [
        '-c',
        `. "${join(here, 'signing-env.sh')}" >/dev/null; echo "$KILN_SIGNING_STATE|\${APPLE_ID-unset}|\${APPLE_CERTIFICATE-unset}"`,
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ...env },
      },
    ).stdout.trim();

  test('signing-env: no secrets means unsigned and the empty variables are unset', () => {
    assert.equal(
      sourceSigning({ RUNNER_OS: 'macOS', APPLE_ID: '', APPLE_CERTIFICATE: '' }),
      'unsigned|unset|unset',
    );
  });
  test('signing-env: certificate only means signed, notary variables dropped', () => {
    const env = {
      RUNNER_OS: 'macOS',
      APPLE_CERTIFICATE: 'c',
      APPLE_CERTIFICATE_PASSWORD: 'p',
      APPLE_SIGNING_IDENTITY: 'i',
      APPLE_ID: '',
    };
    assert.equal(sourceSigning(env), 'signed|unset|c');
  });
  test('signing-env: full set means notarized', () => {
    const env = {
      RUNNER_OS: 'macOS',
      APPLE_CERTIFICATE: 'c',
      APPLE_CERTIFICATE_PASSWORD: 'p',
      APPLE_SIGNING_IDENTITY: 'i',
      APPLE_ID: 'a',
      APPLE_PASSWORD: 'w',
      APPLE_TEAM_ID: 't',
    };
    assert.equal(sourceSigning(env), 'notarized|a|c');
  });
  test('signing-env: a partial certificate is not used; Linux never signs', () => {
    assert.equal(
      sourceSigning({ RUNNER_OS: 'macOS', APPLE_CERTIFICATE: 'c', APPLE_SIGNING_IDENTITY: 'i' }),
      'unsigned|unset|unset',
    );
    assert.equal(
      sourceSigning({ RUNNER_OS: 'Linux', APPLE_CERTIFICATE: 'c' }),
      'unsigned|unset|unset',
    );
    assert.equal(
      sourceSigning({ RUNNER_OS: 'Windows', KILN_WINDOWS_THUMBPRINT: 'abc' }),
      'signed|unset|unset',
    );
  });
  test('signing-env never prints a secret value', () => {
    const res = spawnSync('bash', ['-c', `. "${join(here, 'signing-env.sh')}"`], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        RUNNER_OS: 'macOS',
        APPLE_CERTIFICATE: 'TOPSECRET1',
        APPLE_CERTIFICATE_PASSWORD: 'TOPSECRET2',
        APPLE_SIGNING_IDENTITY: 'TOPSECRET3',
      },
    });
    assert.doesNotMatch(res.stdout + res.stderr, /TOPSECRET/);
  });
  test('docker-smoke.sh parses', () => {
    assert.equal(spawnSync('bash', ['-n', join(here, 'docker-smoke.sh')]).status, 0);
  });
});

describe('summary', () => {
  test('lists installers with signing state and says nothing was published in build-only', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'desktop-macos-arm64'));
    mkdirSync(join(dir, 'meta-macos-arm64'));
    writeFileSync(join(dir, 'desktop-macos-arm64', 'kiln_1.0.0_macos_arm64.dmg'), 'x');
    writeFileSync(join(dir, 'meta-macos-arm64', 'macos-arm64.json'), '{"signing":"unsigned"}');
    const text = summary({
      ARTIFACTS_DIR: dir,
      MODE: 'build-only',
      VERSION: '1.0.0',
      RESULTS: JSON.stringify({ desktop: 'success', 'docker-oci': 'success' }),
    });
    assert.match(text, /Nothing was published/);
    assert.match(text, /kiln_1\.0\.0_macos_arm64\.dmg` \| 0\.0 MB \| unsigned/);
    assert.match(text, /\*\*unsigned\*\*/);
    assert.match(text, /docker-oci. artifact/);
  });
  test('release mode names the pushed digest', () => {
    const text = summary({
      ARTIFACTS_DIR: join(tmp(), 'none'),
      MODE: 'release',
      VERSION: '1.0.0',
      RESULTS: '{}',
      IMAGE: 'ghcr.io/o/k',
      DOCKER_DIGEST: 'sha256:abc',
    });
    assert.match(text, /draft/i);
    assert.match(text, /Pushed `ghcr\.io\/o\/k`.*sha256:abc/);
    assert.match(text, /No installers were produced/);
  });
});
