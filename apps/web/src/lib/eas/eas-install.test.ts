import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qrMatrix } from '../qr.ts';
import {
  ORBIT_SCHEME,
  downloadOf,
  fileKind,
  installPlan,
  isMobileUserAgent,
  orbitLink,
} from './eas-install.ts';
import type { EasBuildView } from './eas-status.ts';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const PAGE =
  'https://expo.dev/accounts/acme/projects/trail-notes/builds/b0000000-0000-4000-8000-000000000001';
const APK = 'https://expo.dev/artifacts/eas/abc.apk';

const build = (o: Partial<EasBuildView> = {}) =>
  ({
    status: 'finished',
    platform: 'android',
    distribution: 'internal',
    internal: true,
    simulator: false,
    expoUrl: PAGE,
    artifactUrl: APK,
    artifactExpiresAt: NOW + 86_400_000,
    ...o,
  }) as EasBuildView;

test('installPlan: platform, distribution, state, expiry and simulator', () => {
  const rows: [Partial<EasBuildView>, string | null, boolean][] = [
    [{}, null, true],
    [{ platform: 'ios' }, null, true],
    [{ artifactUrl: null }, null, true],
    [{ status: 'in_progress' }, 'running', false],
    [{ status: 'in_queue' }, 'running', false],
    [{ status: 'errored' }, 'failed', false],
    [{ status: 'canceled' }, 'failed', false],
    [{ artifactExpiresAt: NOW - 1 }, 'expired', false],
    [{ artifactExpiresAt: null }, null, true],
    [{ internal: false, distribution: 'store' }, 'store', false],
    [{ expoUrl: null }, null, false],
    [{ expoUrl: null, artifactUrl: null }, 'noLink', false],
    [{ platform: 'ios', simulator: true, distribution: 'simulator', internal: false }, null, false],
  ];
  for (const [o, block, qr] of rows) {
    const plan = installPlan(build(o), NOW);
    assert.equal(plan.block, block, JSON.stringify(o));
    assert.equal(plan.qr, qr, JSON.stringify(o));
  }
  assert.equal(
    installPlan(build({ simulator: true, distribution: 'simulator' }), NOW).simulator,
    true,
  );
});

test('fileKind reads the end of the address, not the query', () => {
  assert.equal(fileKind('https://x.test/a/b.APK?sig=1'), 'apk');
  assert.equal(fileKind('https://x.test/a.aab'), 'aab');
  assert.equal(fileKind('https://x.test/a.ipa'), 'ipa');
  assert.equal(fileKind('https://x.test/a.tar.gz'), 'tar.gz');
  assert.equal(fileKind('https://x.test/a?file=b.apk'), 'file');
  assert.equal(fileKind('not a url.apk'), 'apk');
});

test('downloadOf needs a finished, unexpired build with an https address', () => {
  assert.deepEqual(downloadOf(build(), NOW), { href: APK, kind: 'apk' });
  assert.equal(downloadOf(build({ artifactUrl: null }), NOW), null);
  assert.equal(downloadOf(build({ artifactUrl: 'http://x.test/a.apk' }), NOW), null);
  assert.equal(downloadOf(build({ artifactUrl: 'javascript:alert(1)' }), NOW), null);
  assert.equal(downloadOf(build({ status: 'in_progress' }), NOW), null);
  assert.equal(downloadOf(build({ artifactExpiresAt: NOW }), NOW), null);
});

test('orbitLink: only builds Orbit can install, with the address encoded', () => {
  assert.equal(orbitLink(build(), NOW), `${ORBIT_SCHEME}?url=${encodeURIComponent(APK)}`);
  assert.equal(orbitLink(build({ artifactUrl: 'https://x.test/a.aab' }), NOW), null, 'an AAB');
  assert.equal(
    orbitLink(build({ internal: false, distribution: 'store' }), NOW),
    null,
    'a store build',
  );
  assert.equal(orbitLink(build({ artifactUrl: null }), NOW), null);
  assert.equal(orbitLink(build({ artifactExpiresAt: NOW - 1 }), NOW), null);
  const sim = build({
    platform: 'ios',
    simulator: true,
    distribution: 'simulator',
    internal: false,
    artifactUrl: 'https://x.test/a.tar.gz',
  });
  assert.ok(orbitLink(sim, NOW)?.startsWith('expo-orbit://download?url=https%3A%2F%2Fx.test'));
  assert.equal(orbitLink({ ...sim, platform: 'android' }, NOW), null, 'no Android simulator build');
  assert.ok(orbitLink(build({ platform: 'ios', artifactUrl: 'https://x.test/a.ipa' }), NOW));
  const tricky = build({ artifactUrl: 'https://x.test/a.apk?x=1&y=2 3' });
  assert.ok(
    !orbitLink(tricky, NOW)?.includes('&y='),
    'the query of the address cannot leak into the link',
  );
});

test('isMobileUserAgent', () => {
  assert.equal(
    isMobileUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605'),
    false,
  );
  assert.equal(isMobileUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120'), false);
  assert.equal(
    isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'),
    true,
  );
  assert.equal(isMobileUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari'), true);
  assert.equal(isMobileUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), true);
});

test('the Expo page address of a build fits the local QR encoder', () => {
  const m = qrMatrix(PAGE);
  assert.ok(m, 'encodes');
  assert.equal(m.length % 4, 1, 'size is 4v+17');
  assert.ok(m.length >= 29 && m.length <= 57);
});
