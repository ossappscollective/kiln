import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupAvailability } from './assets/groups.ts';
import { buildNumberLabel } from './ci/ci.ts';
import { nextAction } from './dashboard.ts';
import { limitText } from './listing/matrix.ts';
import { defaultPullSummary } from './listing/pull.ts';
import { deviceLabel } from './listing/sections.ts';
import {
  candidateKey,
  credentialKindFor,
  credentialsFor,
  groupReleases,
  identifierLabel,
  platformLabel,
  platformRank,
  sortApps,
  storeName,
  validateDraft,
} from './portfolio.ts';
import { limitNote, rolloutView } from './release.ts';
import { storeName as stagedStoreName } from './staged.ts';
import { actionLabel, actionsFor } from './store-rollout.ts';
import { releaseStatement, storeLabel } from './store-submit.ts';
import type { AppSummary, ReleaseSummary } from './types.ts';

// macOS is a third platform of the same app entry: the labels, the store family rules and the sort order.

test('labels and stores of macOS come from the one platform helper', () => {
  assert.equal(platformLabel('macos'), 'macOS');
  assert.equal(storeName('macos'), 'Mac App Store');
  assert.equal(stagedStoreName('macos'), 'the Mac App Store');
  assert.equal(storeLabel('macos'), 'Mac App Store review');
  assert.equal(identifierLabel('macos'), 'Bundle ID');
  assert.equal(buildNumberLabel('macos'), 'Build');
  assert.equal(buildNumberLabel('android'), 'Version code');
  assert.equal(
    defaultPullSummary('Trail', 'macos'),
    'Pull the Mac App Store listing of Trail into the repository',
  );
  assert.equal(deviceLabel('APP_DESKTOP'), 'Mac');
  assert.deepEqual(
    [platformRank('ios'), platformRank('macos'), platformRank('android')],
    [0, 1, 2],
  );
});

test('a macOS app uses the App Store Connect credential and the bundle id rules', () => {
  assert.equal(credentialKindFor('macos'), 'app_store_connect');
  const credentials = [{ kind: 'app_store_connect' }, { kind: 'google_play' }];
  assert.deepEqual(credentialsFor('macos', credentials), [{ kind: 'app_store_connect' }]);
  const draft = {
    platform: 'macos' as const,
    identifier: 'com.acme.mac-app',
    credentialId: 'c',
    name: '',
    repositoryId: '',
  };
  assert.deepEqual(validateDraft(draft), {
    ok: true,
    input: { platform: 'macos', identifier: 'com.acme.mac-app', credentialId: 'c' },
  });
  const bad = validateDraft({ ...draft, identifier: 'not a bundle id' });
  assert.equal(bad.ok, false);
  // Bundle ids are not case sensitive for Apple platforms, package names are.
  assert.equal(
    candidateKey({ platform: 'macos', identifier: 'Com.Acme.App' }),
    'macos:com.acme.app',
  );
  assert.equal(
    candidateKey({ platform: 'android', identifier: 'Com.Acme.App' }),
    'android:Com.Acme.App',
  );
});

const app = (id: string, platform: AppSummary['platform']): AppSummary => ({
  id,
  name: 'Trail',
  platform,
  identifier: 'com.acme.trail',
  storeAppId: null,
  credentialId: 'c',
  repositoryId: null,
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncAttemptAt: null,
  lastSyncError: null,
});

const release = (platform: ReleaseSummary['platform'], track: string | null): ReleaseSummary =>
  ({
    id: `${platform}-${track}`,
    appId: platform,
    platform,
    version: '3.0',
    track,
    status: 'live',
    rawState: 'READY_FOR_SALE',
    build: '9',
    versionCodes: null,
    rolloutFraction: null,
    storeUpdatedAt: 1,
    syncedAt: 1,
  }) as unknown as ReleaseSummary;

test('apps and release groups sort iOS, then macOS, then Android', () => {
  assert.deepEqual(
    sortApps([app('a', 'android'), app('m', 'macos'), app('i', 'ios')]).map((a) => a.id),
    ['i', 'm', 'a'],
  );
  const groups = groupReleases([
    release('android', 'production'),
    release('macos', null),
    release('ios', null),
  ]);
  assert.deepEqual(
    groups.map((g) => g.platform),
    ['ios', 'macos', 'android'],
  );
  assert.equal(groups[1]?.title, 'macOS · Mac App Store');
});

test('macOS is Apple on every store rule: steps, rollout actions, submit wording and drift columns', () => {
  assert.equal(nextAction({ platform: 'macos', status: 'live' }).kind, 'done');
  assert.match(
    nextAction({ platform: 'macos', status: 'draft', planned: true }).text,
    /App Store Connect/,
  );
  assert.equal(
    rolloutView({ platform: 'macos', status: 'rolling_out', rolloutFraction: null }).title,
    'Phased release',
  );
  const config = { actions: { android: ['halt'], ios: ['pause', 'resume'] } };
  assert.deepEqual(actionsFor(config, 'macos'), ['pause', 'resume']);
  assert.equal(actionLabel('resume', 'macos'), 'Resume phased release');
  assert.ok(releaseStatement('macos').includes('App Review'));
  assert.match(limitNote('macos'), /Mac App Store allows 4,000/);
  assert.equal(
    limitText({ platforms: ['ios', 'macos'], limits: { ios: 30, macos: 30 } }),
    'max 30',
  );
  assert.equal(
    limitText({ platforms: ['ios', 'macos'], limits: { ios: 4000, macos: 2000 } }),
    'iOS 4,000 / macOS 2,000',
  );
});

test('the Play graphics group is not available on a macOS record', () => {
  const g = groupAvailability('play_graphics', 'macos');
  assert.equal(g.available, false);
  assert.match(g.reason ?? '', /Google Play only\. This record is on the Mac App Store\./);
});
