import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bannerKinds,
  type ConnectRow,
  canLink,
  choiceValue,
  counts,
  decodeChoice,
  looksLikeExpo,
  pendingApps,
  repositoriesToDetect,
  toLink,
  withValue,
} from './connect.ts';

const apps = [
  { id: 'a1', platform: 'ios', repositoryId: 'r1' },
  { id: 'a2', platform: 'android', repositoryId: 'r1' },
  { id: 'a3', platform: 'macos', repositoryId: null },
] as never[];
const key = (kind: string) => ({ id: 'c', kind, label: `${kind} key` }) as never;

test('pending apps: eligible and not linked; unknown links give none', () => {
  assert.deepEqual(
    pendingApps('expo', apps, { revenuecat: [], expo: ['a1'] }).map((a: { id: string }) => a.id),
    ['a2'],
  );
  assert.deepEqual(pendingApps('expo', apps, null), []);
});

test('banner: needs a key, a pending record and the right to write', () => {
  const links = { revenuecat: [], expo: [] };
  const on = bannerKinds({ mayWrite: true, credentials: [key('expo')], apps, links });
  assert.deepEqual(
    on.map((b) => [b.kind, b.pending]),
    [['expo', 2]],
  );
  assert.deepEqual(bannerKinds({ mayWrite: false, credentials: [key('expo')], apps, links }), []);
  assert.deepEqual(bannerKinds({ mayWrite: true, credentials: [], apps, links }), []);
  assert.deepEqual(
    bannerKinds({
      mayWrite: true,
      credentials: [key('expo')],
      apps,
      links: { revenuecat: [], expo: ['a1', 'a2'] },
    }),
    [],
  );
});

test('choice values round-trip and reject incomplete ones', () => {
  assert.deepEqual(decodeChoice(choiceValue('p', 'x')), { projectId: 'p', revenueCatAppId: 'x' });
  assert.equal(decodeChoice('p'), null);
  assert.equal(decodeChoice(''), null);
});

const row = (over: Partial<ConnectRow>): ConnectRow => ({
  appId: 'a',
  name: 'A',
  platform: 'ios',
  identifier: 'x',
  status: 'none',
  choices: [],
  value: '',
  checked: false,
  ...over,
});

test('only checked rows that can be saved are written; linked rows never', () => {
  const rc = [
    row({ appId: '1', status: 'proposed', value: choiceValue('p', 'x'), checked: true }),
    row({ appId: '2', status: 'ambiguous', value: '', checked: true }),
    row({ appId: '3', status: 'linked', value: choiceValue('p', 'y'), checked: true }),
    row({ appId: '4', status: 'proposed', value: choiceValue('p', 'z'), checked: false }),
  ];
  assert.deepEqual(
    toLink('revenuecat', rc).map((r) => r.appId),
    ['1'],
  );
  assert.equal(
    canLink('revenuecat', withValue('revenuecat', rc[1] as ConnectRow, choiceValue('p', 'q'))),
    true,
  );
  assert.equal(withValue('revenuecat', rc[1] as ConnectRow, choiceValue('p', 'q')).checked, true);
  assert.deepEqual(counts(rc), { linked: 1, proposed: 2, ambiguous: 1, none: 0 });
});

test('expo detection reads one repository once and skips linked records', () => {
  assert.deepEqual(repositoriesToDetect(apps, { revenuecat: [], expo: [] }), [
    { repositoryId: 'r1', appId: 'a1' },
  ]);
  assert.deepEqual(repositoriesToDetect(apps, { revenuecat: [], expo: ['a1'] }), [
    { repositoryId: 'r1', appId: 'a2' },
  ]);
});

test('looksLikeExpo: only an app.json or dynamic config of Expo counts', () => {
  assert.equal(looksLikeExpo(null), false);
  assert.equal(looksLikeExpo({ detected: { projectId: 'x' }, reason: null }), true);
  assert.equal(looksLikeExpo({ detected: null, reason: 'dynamic_config' }), true);
  assert.equal(looksLikeExpo({ detected: null, reason: 'no_project_id' }), true);
  for (const reason of [
    'no_repository',
    'repository_unavailable',
    'no_app_json',
    'unreadable',
    'read_failed',
  ]) {
    assert.equal(looksLikeExpo({ detected: null, reason }), false, reason);
  }
});
