import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CiArtifact, CiArtifactDownload, CiArtifactList } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { bootCi, FakeCi, run } from '../ci/test-helpers.ts';
import { axmlManifest, zipOf } from './artifact-meta/fixtures.ts';
import { unreadArtifacts } from './facts.ts';
import { clearBuildCaches } from './service.ts';

// A fake GitHub and a fake artifact storage: no live call is made, and the files are small ones
// assembled by hand (not real APK, AAB or IPA).

class FakeBuildsCi extends FakeCi {
  artifacts: CiArtifact[] = [];
  storage = new Map<string, () => CiArtifactDownload>();
  async listArtifacts(): Promise<CiArtifactList> {
    this.calls.push({ name: 'listArtifacts', args: [] });
    return { artifacts: this.artifacts, truncated: false, notModified: false };
  }
  async openArtifactDownload(id: string): Promise<CiArtifactDownload> {
    this.calls.push({ name: 'openArtifactDownload', args: [id] });
    return this.storage.get(id)?.() ?? { status: 'missing' };
  }
}

const T0 = 1_900_000_000_000;
const DAY = 24 * 60 * 60_000;
const art = (id: string, name: string, extra: Partial<CiArtifact> = {}): CiArtifact => ({
  id,
  name,
  sizeInBytes: 1000,
  expired: false,
  createdAt: T0 - Number(id),
  expiresAt: T0 + 30 * DAY,
  runId: '102',
  headBranch: 'main',
  headSha: '1'.repeat(40),
  digest: null,
  ...extra,
});
const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
const apk = (code: number) =>
  zipOf([
    {
      name: 'app-release.apk',
      data: zipOf([
        {
          name: 'AndroidManifest.xml',
          data: axmlManifest({
            versionCode: code,
            versionName: '1.26.2',
            packageName: 'com.acme.android',
          }),
          method: 'deflate',
        },
      ]),
    },
  ]);

async function boot(db: Parameters<typeof bootCi>[0], settings: Record<string, unknown> = {}) {
  clearBuildCaches();
  const fake = new FakeBuildsCi();
  const scratch = await mkdtemp(join(tmpdir(), 'kiln-inspect-test-'));
  const t = await bootCi(
    db,
    {},
    {
      connectorFactory: () => fake,
      builds: { downloadEnabled: true, allowHttpRedirects: true, scratchDir: scratch, ...settings },
    },
  );
  fake.runs = [run('101', { name: 'iOS release' }), run('102', { name: 'Android release' })];
  await t.call(t.owner, 'GET', `${t.base}/workflows/runs?refresh=true`);
  const appId = await t.seedApp('android', [{ version: '2.4.0', build: '240' }], {
    identifier: 'com.acme.android',
  });
  const serve = (id: string, bytes: Uint8Array, extra: Partial<CiArtifact> = {}) => {
    fake.artifacts = [
      ...fake.artifacts.filter((a) => a.id !== id),
      art(id, 'android-release', { sizeInBytes: bytes.length, ...extra }),
    ];
    clearBuildCaches();
    fake.storage.set(id, () => ({
      status: 'ok',
      body: stream(bytes),
      contentLength: bytes.length,
    }));
  };
  return {
    ...t,
    fake,
    appId,
    scratch,
    serve,
    list: (cookie = t.owner) => t.call(cookie, 'GET', `/apps/${appId}/builds/artifacts`),
    inspect: (id: string, cookie = t.owner) =>
      t.call(cookie, 'POST', `/apps/${appId}/builds/artifacts/${id}/inspect`, {}),
    leftovers: () => readdir(scratch),
    done: () => rm(scratch, { recursive: true, force: true }),
  };
}

const seedBuild = (t: Awaited<ReturnType<typeof boot>>, number: string) =>
  t.db.execute(
    `INSERT INTO app_builds (app_id, platform, build_number, workspace_id, store_id, version, processing_state, raw_state, expired, uploaded_at, first_seen_at, last_seen_at)
     VALUES (?, 'android', ?, ?, ?, NULL, 'processed', 'PROCESSED', 0, NULL, 5, 5)`,
    [t.appId, number, t.workspaceId, `b-${number}`],
  );
const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};
const rowOf = (res: { body: { store: { buildNumber: string }[] } }, n: string) =>
  res.body.store.find((b) => b.buildNumber === n) as unknown as { origin: Record<string, unknown> };

dbTest(
  'build facts: a store build gets its date and version from the CI file read in the background, and the reason while there is none',
  async (db) => {
    const t = await boot(db);
    try {
      await seedBuild(t, '412');
      t.serve('1', apk(412));
      const first = await t.list();
      assert.equal(first.status, 200);
      assert.equal(rowOf(first, '412').origin.builtAt, null, 'nothing was read yet');
      assert.equal(rowOf(first, '412').origin.builtGap, 'not_read');
      // The list itself started the read of the unread artifact (nobody pressed "Read build info from CI").
      const read = await waitFor(
        async () =>
          (await t.db.query('SELECT 1 FROM ci_artifact_meta WHERE app_id = ?', [t.appId])).length >
          0,
      );
      assert.ok(read, 'the file was read in the background');
      assert.equal(t.fake.count('openArtifactDownload'), 1);
      clearBuildCaches();
      const second = await t.list();
      const o = rowOf(second, '412').origin;
      assert.equal(o.builtAt, T0 - 1, 'the date GitHub made the artifact');
      assert.equal(o.builtFrom, 'ci');
      assert.equal(o.version, '1.26.2');
      assert.equal(o.builtGap, null);
      // Not read again: the pause and the stored answer.
      assert.equal(t.fake.count('openArtifactDownload'), 1);
    } finally {
      await t.done();
    }
  },
);

dbTest(
  'build facts: with downloads off nothing is read and the gap says to enable build reads',
  async (db) => {
    const t = await boot(db, { downloadEnabled: false });
    try {
      await seedBuild(t, '412');
      t.serve('1', apk(412));
      const res = await t.list();
      assert.equal(rowOf(res, '412').origin.builtGap, 'reads_disabled');
      assert.equal(rowOf(res, '412').origin.builtAt, null);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(t.fake.count('openArtifactDownload'), 0);
    } finally {
      await t.done();
    }
  },
);

dbTest(
  'build facts: the background read takes the newest unread artifacts only, once per pause',
  async (db) => {
    const t = await boot(db);
    try {
      for (const id of ['1', '2', '3', '4', '5']) t.serve(id, apk(Number(id)));
      const list = (await t.list()).body;
      assert.deepEqual(
        unreadArtifacts(list.artifacts, { platform: 'android' }).map((a) => a.id),
        ['1', '2', '3'],
        'a batch of the newest (the fake dates fall with the id)',
      );
      await waitFor(async () => t.fake.count('openArtifactDownload') >= 3);
      await waitFor(
        async () =>
          (await t.db.query('SELECT 1 FROM ci_artifact_meta WHERE app_id = ?', [t.appId])).length >=
          3,
      );
      assert.equal(t.fake.count('openArtifactDownload'), 3);
      clearBuildCaches();
      await t.list();
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(t.fake.count('openArtifactDownload'), 3, 'the next batch waits for the pause');
    } finally {
      await t.done();
    }
  },
);
