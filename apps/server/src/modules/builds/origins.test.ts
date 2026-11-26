import assert from 'node:assert/strict';
import type { CiArtifact, CiArtifactList } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { getApp } from '../../services/apps.ts';
import { bootCi, FakeCi, run } from '../ci/test-helpers.ts';
import { saveArtifactMeta } from './artifact-meta-store.ts';
import { loadOriginSources } from './origins.ts';
import { clearBuildCaches, createBuildsContext } from './service.ts';

// The join behind "which version, and when was it built" of a version code: what the Test builds page cached
// (ci_artifact_meta) plus the artifact list of GitHub and the store builds the sync recorded. A fake GitHub; no live call.

class FakeBuildsCi extends FakeCi {
  artifacts: CiArtifact[] = [];
  fail = false;
  async listArtifacts(): Promise<CiArtifactList> {
    this.calls.push({ name: 'listArtifacts', args: [] });
    if (this.fail) throw new Error('GitHub is down');
    return { artifacts: this.artifacts, truncated: false, notModified: false };
  }
}

const T0 = 1_900_000_000_000;
const art = (id: string, extra: Partial<CiArtifact> = {}): CiArtifact => ({
  id,
  name: 'android-release',
  sizeInBytes: 1000,
  expired: false,
  createdAt: T0 - Number(id),
  expiresAt: T0 + 30 * 86_400_000,
  runId: '102',
  headBranch: 'main',
  headSha: 'a'.repeat(40),
  digest: null,
  ...extra,
});

async function boot(db: Parameters<typeof bootCi>[0]) {
  clearBuildCaches();
  const fake = new FakeBuildsCi();
  const t = await bootCi(db, {}, { connectorFactory: () => fake });
  fake.runs = [run('102', { name: 'Android release', runNumber: 41 })];
  await t.call(t.owner, 'GET', `${t.base}/workflows/runs?refresh=true`);
  const appId = await t.seedApp('android', [{ version: '2.4.0', build: '240' }], {
    identifier: 'com.acme.android',
  });
  const read = async (actor = { type: 'user' as const, id: 'someone' }) => {
    clearBuildCaches();
    const app = await getApp(db, t.workspaceId, appId);
    assert.ok(app);
    const ctx = createBuildsContext({ ...t.context({ now: T0 }), connectorFactory: () => fake });
    return loadOriginSources(ctx, { workspaceId: t.workspaceId, app, actor });
  };
  const cache = (id: string, number: string, version: string | null, packageId = 'com.acme.android') =>
    saveArtifactMeta(db, {
      workspaceId: t.workspaceId,
      appId,
      artifactId: id,
      meta: { buildNumber: number, version, packageId, format: 'aab' },
      at: T0,
    });
  const store = (build: string, version: string | null, uploadedAt: number | null) =>
    db.execute(
      `INSERT INTO app_builds (app_id, platform, build_number, workspace_id, version, processing_state, uploaded_at, first_seen_at, last_seen_at)
       VALUES (?, 'android', ?, ?, ?, 'processed', ?, 1, 1)`,
      [appId, build, t.workspaceId, version, uploadedAt],
    );
  return { ...t, fake, appId, read, cache, store };
}

dbTest('origins: a cache hit carries the version, the artifact date and the run; the store builds ride along', async (db) => {
  const t = await boot(db);
  t.fake.artifacts = [art('1')];
  await t.cache('1', '90', '2.00.1');
  await t.store('89', '2.00.0', null);
  const sources = await t.read();
  assert.equal(sources.artifacts.length, 1);
  const [hit] = sources.artifacts;
  assert.equal(hit?.number, '90');
  assert.equal(hit?.version, '2.00.1');
  assert.equal(hit?.packageId, 'com.acme.android');
  assert.equal(hit?.createdAt, T0 - 1);
  assert.equal(hit?.run?.runNumber, 41);
  assert.equal(hit?.run?.branch, 'main');
  assert.equal(hit?.run?.commit, '1111111');
  assert.ok(hit?.run?.url?.includes('/102'));
  assert.deepEqual(sources.store, [{ buildNumber: '89', version: '2.00.0', uploadedAt: null }]);
});

dbTest('origins: nothing in the cache means no artifact list is asked at all, and the store builds still come', async (db) => {
  const t = await boot(db);
  t.fake.artifacts = [art('1')];
  await t.store('88', '1.15.2', 5);
  const sources = await t.read();
  assert.deepEqual(sources.artifacts, []);
  assert.equal(sources.store.length, 1);
  assert.equal(t.fake.calls.filter((c) => c.name === 'listArtifacts').length, 0);
});

dbTest('origins: a GitHub failure keeps the version from the cache and leaves the date empty', async (db) => {
  const t = await boot(db);
  t.fake.fail = true;
  await t.cache('7', '90', '2.00.1');
  const sources = await t.read();
  assert.equal(sources.artifacts[0]?.version, '2.00.1');
  assert.equal(sources.artifacts[0]?.createdAt, null);
  assert.equal(sources.artifacts[0]?.run, null);
});

dbTest('origins: an artifact GitHub no longer lists still gives its version; an unreadable file gives nothing', async (db) => {
  const t = await boot(db);
  t.fake.artifacts = [];
  await t.cache('9', '91', '2.01.0');
  await saveArtifactMeta(db, { workspaceId: t.workspaceId, appId: t.appId, artifactId: '10', meta: null, at: T0 });
  const sources = await t.read();
  assert.equal(sources.artifacts.length, 1);
  assert.equal(sources.artifacts[0]?.version, '2.01.0');
  assert.equal(sources.artifacts[0]?.createdAt, null);
});
