import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CiArtifact, CiArtifactDownload, CiArtifactList } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { createTestLimiter } from '../../services/credential-tests.ts';
import { bootCi, FakeCi, run } from '../ci/test-helpers.ts';
import {
  axmlManifest,
  binaryPlist,
  infoPlist,
  protoManifest,
  zipOf,
} from './artifact-meta/fixtures.ts';
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

dbTest('inspect: reads the build number once, keeps it, and the list carries it', async (db) => {
  const t = await boot(db);
  try {
    t.serve('1', apk(167));
    const before = await t.list();
    assert.equal(before.body.artifacts[0].build, null);
    assert.equal(before.body.artifacts[0].buildRead, null);
    const res = await t.inspect('1');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.artifact.build, {
      number: '167',
      version: '1.26.2',
      packageId: 'com.acme.android',
      format: 'apk',
    });
    assert.equal(res.body.artifact.buildRead, 'read');
    assert.equal(t.fake.count('openArtifactDownload'), 1);
    assert.deepEqual(await t.leftovers(), [], 'the temporary file is deleted');
    const after = await t.list();
    assert.equal(after.body.artifacts[0].build.number, '167');
    assert.equal(after.body.artifacts[0].buildRead, 'read');
    // Asked again: from the store, no second download.
    const again = await t.inspect('1');
    assert.equal(again.body.artifact.build.number, '167');
    assert.equal(t.fake.count('openArtifactDownload'), 1);
    const audit = await t.auditActions();
    const downloads = audit.filter((a) => a.action === 'build.download');
    assert.equal(downloads.length, 0, 'a read is not audited as a download');
  } finally {
    await t.done();
  }
});

dbTest('inspect: a file with no build number is kept as unreadable and not downloaded again', async (db) => {
  const t = await boot(db);
  try {
    t.serve('1', zipOf([{ name: 'report.txt', data: 'nothing here' }]));
    const first = await t.inspect('1');
    assert.equal(first.status, 200);
    assert.equal(first.body.artifact.build, null);
    assert.equal(first.body.artifact.buildRead, 'unreadable');
    await t.inspect('1');
    assert.equal(t.fake.count('openArtifactDownload'), 1);
    assert.equal((await t.list()).body.artifacts[0].buildRead, 'unreadable');
    t.serve('2', Buffer.from('this is not a zip file at all'));
    assert.equal((await t.inspect('2')).body.artifact.buildRead, 'unreadable');
    assert.deepEqual(await t.leftovers(), []);
  } finally {
    await t.done();
  }
});

dbTest('inspect: an AAB and an IPA are read too (an iOS app)', async (db) => {
  const t = await boot(db);
  try {
    t.serve(
      '1',
      zipOf([
        {
          name: 'base/manifest/AndroidManifest.xml',
          data: protoManifest({
            versionCode: 241,
            versionName: '2.4.1',
            packageName: 'com.acme.android',
          }),
        },
      ]),
    );
    const aab = await t.inspect('1');
    assert.deepEqual(
      [aab.body.artifact.build.number, aab.body.artifact.build.format],
      ['241', 'aab'],
    );
    t.serve(
      '2',
      zipOf([
        {
          name: 'App.ipa',
          data: zipOf([
            {
              name: 'Payload/App.app/Info.plist',
              data: binaryPlist(
                infoPlist({ buildNumber: '88', version: '3.0', bundleId: 'com.acme.ios' }),
              ),
            },
          ]),
        },
      ]),
    );
    const ipa = await t.inspect('2');
    assert.deepEqual(ipa.body.artifact.build, {
      number: '88',
      version: '3.0',
      packageId: 'com.acme.ios',
      format: 'ipa',
    });
  } finally {
    await t.done();
  }
});

dbTest('inspect: switched off answers 409 and never reaches the storage', async (db) => {
  const off = await boot(db, { downloadEnabled: false });
  try {
    off.serve('1', apk(1));
    const res = await off.inspect('1');
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'builds_download_disabled');
    assert.equal(off.fake.count('openArtifactDownload'), 0);
  } finally {
    await off.done();
  }
});

dbTest('inspect: roles and refusals', async (db) => {
  const t = await boot(db, { maxDownloadBytes: 5000 });
  try {
    t.serve('1', apk(1));
    assert.equal((await t.inspect('1', await t.addMember('viewer'))).status, 403);
    assert.equal((await t.inspect('1', await t.addMember('member'))).status, 200);
    t.serve('2', apk(2), { expired: true });
    assert.equal((await t.inspect('2')).status, 410);
    t.serve('3', apk(3), { sizeInBytes: 6000 });
    const big = await t.inspect('3');
    assert.equal(big.status, 413);
    assert.equal(big.body.error, 'artifact_too_large');
    t.serve('4', apk(4), { runId: '999' });
    assert.equal((await t.inspect('4')).status, 404, 'an artifact of a run that is not this app’s');
    assert.equal((await t.inspect('777')).status, 404);
    assert.equal((await t.inspect('x1')).status, 400);
    const reached = t.fake.count('openArtifactDownload');
    assert.equal(reached, 1, 'only the allowed one reached the storage');
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    assert.equal((await t.inspect('1', outsider)).status, 404);
  } finally {
    await t.done();
  }
});

dbTest('inspect: a failed or oversized download is not kept, so it can be tried again', async (db) => {
  const t = await boot(db, { maxDownloadBytes: 4000 });
  try {
    t.serve('1', apk(7));
    const bytes = apk(7);
    // The storage streams more than it declared: the limit stops it while streaming.
    t.fake.storage.set('1', () => ({
      status: 'ok',
      body: stream(Buffer.alloc(5000)),
      contentLength: null,
    }));
    const tooBig = await t.inspect('1');
    assert.equal(tooBig.status, 413);
    t.fake.storage.set('1', () => ({
      status: 'ok',
      body: new ReadableStream<Uint8Array>({
        pull(c) {
          c.error(new Error('connection reset'));
        },
      }),
      contentLength: null,
    }));
    const broken = await t.inspect('1');
    assert.equal(broken.status, 502);
    assert.equal(broken.body.error, 'download_failed');
    assert.deepEqual(await t.leftovers(), []);
    assert.equal((await t.list()).body.artifacts[0].buildRead, null, 'nothing was kept');
    t.fake.storage.set('1', () => ({
      status: 'ok',
      body: stream(bytes),
      contentLength: bytes.length,
    }));
    assert.equal((await t.inspect('1')).body.artifact.build.number, '7');
    t.fake.storage.set('1', () => ({ status: 'gone' }));
    t.serve('5', apk(5));
    t.fake.storage.set('5', () => ({ status: 'gone' }));
    assert.equal((await t.inspect('5')).status, 410, 'the storage says it is gone');
  } finally {
    await t.done();
  }
});

dbTest('inspect: one at a time per app, and the same artifact asked twice at once is downloaded once', async (db) => {
  const t = await boot(db);
  try {
    t.serve('1', apk(11));
    t.serve('2', apk(12));
    let running = 0;
    let most = 0;
    for (const [id, code] of [['1', 11], ['2', 12]] as const) {
      const bytes = apk(code);
      t.fake.storage.set(id, () => {
        running += 1;
        most = Math.max(most, running);
        return {
          status: 'ok',
          contentLength: bytes.length,
          body: new ReadableStream<Uint8Array>({
            async pull(c) {
              await new Promise((r) => setTimeout(r, 20));
              c.enqueue(bytes);
              c.close();
              running -= 1;
            },
          }),
        };
      });
    }
    const answers = await Promise.all([t.inspect('1'), t.inspect('2'), t.inspect('1')]);
    assert.deepEqual(
      answers.map((a) => a.body.artifact.build.number),
      ['11', '12', '11'],
    );
    assert.equal(most, 1, 'never two downloads of one app at once');
    const downloads = t.fake.count('openArtifactDownload');
    assert.equal(downloads, 2, 'the repeat waited and then found the stored answer');
  } finally {
    await t.done();
  }
});

dbTest('inspect: shares the download rate limit; deleting the app deletes what was read', async (db) => {
  const t = await boot(db, { downloadLimiter: createTestLimiter({ limit: 1, now: () => 1 }) });
  try {
    t.serve('1', apk(21));
    t.serve('2', apk(22));
    assert.equal((await t.inspect('1')).status, 200);
    const limited = await t.inspect('2');
    assert.equal(limited.status, 429);
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM ci_artifact_meta'))[0]?.n), 1);
    const del = await t.call(t.owner, 'DELETE', `/apps/${t.appId}`);
    assert.ok(del.status === 200 || del.status === 204, String(del.status));
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM ci_artifact_meta'))[0]?.n), 0);
  } finally {
    await t.done();
  }
});

dbTest('inspect: an old temporary file of a crashed read is swept at the first read', async (db) => {
  const t = await boot(db);
  try {
    const stale = join(t.scratch, 'kiln-inspect-old.zip');
    const fresh = join(t.scratch, 'kiln-inspect-new.zip');
    const other = join(t.scratch, 'keep-me.txt');
    for (const f of [stale, fresh, other]) await writeFile(f, 'x');
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    await utimes(stale, old, old);
    await utimes(other, old, old);
    t.serve('1', apk(31));
    assert.equal((await t.inspect('1')).status, 200);
    assert.deepEqual((await t.leftovers()).sort(), ['keep-me.txt', 'kiln-inspect-new.zip']);
  } finally {
    await t.done();
  }
});
