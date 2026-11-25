import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSearchIndex } from '../lib/search-index.mjs';
import { formatSize, isGithubUrl, parseAssetName, pickAssets } from '../static/js/release-assets.js';
import { search, tokenize } from '../static/js/search-core.js';

const asset = (name, size = 1048576) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/v1/${name}`, size });

test('parseAssetName reads kiln_<version>_<os>_<arch>.<ext>', () => {
  assert.deepEqual(parseAssetName('kiln_1.2.3_macos_arm64.dmg'), { version: '1.2.3', os: 'macos', arch: 'arm64', ext: 'dmg' });
  assert.deepEqual(parseAssetName('kiln_1.2.3-rc.1_linux_x64.AppImage'), { version: '1.2.3-rc.1', os: 'linux', arch: 'x64', ext: 'appimage' });
  assert.deepEqual(parseAssetName('kiln_1.0.0_windows_x86_64.msi'), { version: '1.0.0', os: 'windows', arch: 'x64', ext: 'msi' });
  assert.deepEqual(parseAssetName('kiln_1.0.0_macos_arm64.app.tar.gz')?.ext, 'app.tar.gz');
  assert.equal(parseAssetName('SHA256SUMS'), null);
  assert.equal(parseAssetName('Kiln_1.0.0_aarch64.dmg'), null);
});

test('pickAssets offers one file per target and prefers the first extension', () => {
  const picked = pickAssets([
    asset('SHA256SUMS'),
    asset('kiln_1.2.3_macos_arm64.dmg'),
    asset('kiln_1.2.3_macos_arm64.app.tar.gz'),
    asset('kiln_1.2.3_macos_x64.dmg'),
    asset('kiln_1.2.3_windows_x64.exe'),
    asset('kiln_1.2.3_windows_x64.msi'),
    asset('kiln_1.2.3_linux_x64.deb'),
    asset('kiln_1.2.3_linux_x64.AppImage'),
  ]);
  assert.deepEqual(Object.keys(picked).sort(), ['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']);
  assert.equal(picked['macos-arm64'].ext, 'dmg');
  assert.equal(picked['windows-x64'].ext, 'msi');
  assert.equal(picked['linux-x64'].ext, 'appimage');
});

test('pickAssets: a missing target is simply absent, a universal mac build serves both', () => {
  assert.deepEqual(pickAssets([asset('kiln_1_linux_arm64.deb')]), {});
  const picked = pickAssets([asset('kiln_1_macos_universal.dmg')]);
  assert.ok(picked['macos-arm64'] && picked['macos-x64']);
  assert.deepEqual(pickAssets(undefined), {});
});

test('formatSize and isGithubUrl', () => {
  assert.equal(formatSize(0), '');
  assert.equal(formatSize(5 * 1048576), '5.0 MB');
  assert.equal(formatSize(123 * 1048576), '123 MB');
  assert.equal(isGithubUrl('https://github.com/o/r/releases/download/v1/x.dmg'), true);
  assert.equal(isGithubUrl('https://objects.githubusercontent.com/x'), true);
  assert.equal(isGithubUrl('https://evil.example/github.com/x'), false);
  assert.equal(isGithubUrl('javascript:alert(1)'), false);
  assert.equal(isGithubUrl('http://github.com/x'), false);
});

test('client search: prefix matching, all words, ranking', () => {
  const index = buildSearchIndex([
    { title: 'Self-hosting', route: 'docs/self-hosting/', description: 'Run Kiln with Docker', headings: [{ level: 2, text: 'Put TLS in front', id: 'put-tls-in-front' }] },
    { title: 'Security', route: 'docs/security/', description: 'Design rules', headings: [{ level: 2, text: 'Encryption at rest', id: 'encryption-at-rest' }] },
  ]);
  assert.deepEqual(tokenize('TLS front'), ['tls', 'front']);
  assert.equal(search(index, 'encr')[0].url, 'docs/security/#encryption-at-rest');
  assert.equal(search(index, 'secu')[0].title, 'Security');
  assert.equal(search(index, 'tls front')[0].url, 'docs/self-hosting/#put-tls-in-front');
  assert.deepEqual(search(index, 'tls security'), []);
  assert.deepEqual(search(index, ''), []);
  assert.deepEqual(search(index, 'zzz'), []);
});
