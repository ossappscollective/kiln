import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoreBuild, StoreVersion } from '@kiln/connectors';
import { pickBuild } from '../../services/apps.ts';

const version = (over: Partial<StoreVersion> = {}): StoreVersion => ({
  storeId: 'v1',
  appStoreId: 'a1',
  platform: 'ios',
  versionString: '2.0.1',
  rawState: 'PREPARE_FOR_SUBMISSION',
  lifecycleState: 'draft',
  ...over,
});
const build = (storeId: string, buildNumber: string, over: Partial<StoreBuild> = {}): StoreBuild => ({
  storeId,
  appStoreId: 'a1',
  platform: 'ios',
  buildNumber,
  versionString: '2.0.1',
  processing: 'processed',
  uploadedAt: 1000 + Number(buildNumber),
  ...over,
});

test('an editable version takes the build Apple says is attached, and none when Apple names none (no guess)', () => {
  const builds = [build('b1', '10'), build('b2', '11')];
  assert.equal(pickBuild(version({ buildStoreId: 'b1' }), builds)?.buildNumber, '10');
  // The draft has no build attached: the plan must say "attach", not "submit".
  assert.equal(pickBuild(version(), builds), undefined);
  assert.equal(pickBuild(version({ lifecycleState: 'rejected' }), builds), undefined);
  assert.equal(pickBuild(version({ lifecycleState: 'ready' }), builds), undefined);
});

test('a version past editing still falls back to its newest processed build of the same version', () => {
  const builds = [build('b1', '10'), build('b2', '11'), build('b3', '12', { processing: 'processing' })];
  assert.equal(
    pickBuild(version({ lifecycleState: 'live', rawState: 'READY_FOR_SALE' }), builds)?.buildNumber,
    '11',
  );
  assert.equal(
    pickBuild(version({ lifecycleState: 'in_review', rawState: 'IN_REVIEW' }), builds)?.buildNumber,
    '11',
  );
});
