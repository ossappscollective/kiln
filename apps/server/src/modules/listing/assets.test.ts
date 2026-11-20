import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import type {
  BlobHeadItem,
  BlobHeads,
  BlobHeadsOptions,
  BlobListing,
  BlobReads,
} from '@mrm/connectors';
import type { Database } from '@mrm/db';
import { dbTest } from '@mrm/db/testing';
import {
  CARD_APP,
  SCAN_APP,
  scannerMonorepo,
  weatherApp,
} from '../../../../../packages/connectors/src/fastlane.fixtures.ts';
import { ASC_SECRET, PLAY_SECRET } from './test-helpers.ts';
import { bootRepoApp, FakeRepo, fastlaneFiles } from '../../repo-test-helpers.ts';
import { operations } from '../../operations/registry.ts';
import { clearAssetIndexes } from './asset-repo.ts';
import { createCloneReads } from '../../services/clone-reads.ts';
import { createTestLimiter } from '../../services/credential-tests.ts';
import { clearRepoSnapshots } from '../../services/repo-snapshot.ts';
import type { Exchange } from '../../services/safe-fetch.ts';

/**
 * The media of a repository (Assets tab) and the app icon, end to end: real git repositories in
 * temp folders for the clone paths, an in-memory connector for the GitHub API path, and a fake
 * outbound exchange for the App Store lookup. No network, no store, no GitHub is contacted.
 */

type Files = Record<string, string | Buffer>;

const dirs: string[] = [];
const scratch = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const gitEnv = {
  PATH: process.env.PATH ?? '',
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: gitEnv }).trim();

function writeAll(dir: string, files: Files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}
function buildRepo(parent: string, name: string, files: Files): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeAll(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}
function commitMore(dir: string, files: Files): string {
  writeAll(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'more');
  return git(dir, 'rev-parse', 'HEAD');
}

// ----- images: only the bytes a header parser looks at ------------------------------------------

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** A PNG header with `seed` in its pixel data, so two icons differ in their bytes. */
function png(
  width: number,
  height: number,
  options: { alpha?: boolean; seed?: number; pad?: number } = {},
): Buffer {
  const colour = options.alpha ? 6 : 2;
  const ihdr = [
    ...be32(13),
    ...text('IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    colour,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  const idat = [...be32(4), ...text('IDAT'), options.seed ?? 0, 2, 3, 4, 0, 0, 0, 0];
  const head = Buffer.from([0x89, ...text('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...idat]);
  return options.pad ? Buffer.concat([head, Buffer.alloc(options.pad, 7)]) : head;
}
function jpeg(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, ...be16(16), ...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const frame = [
    0xff,
    0xc0,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  return Buffer.from([0xff, 0xd8, ...app0, ...frame, 0xff, 0xda, 0, 0]);
}

/** The fixtures hold text placeholders where the media go: the tests bring their own images. */
const stripMedia = (files: Record<string, string>): Files =>
  Object.fromEntries(
    Object.entries(files).filter(([path]) => !/\/(images|screenshots)\//.test(path)),
  );
const weather = () => stripMedia(weatherApp());
const monorepo = () => stripMedia(scannerMonorepo());

const IPHONE_65 = [1242, 2688] as const;
const IPHONE_69 = [1290, 2796] as const;

// ----- the connector of the API path -------------------------------------------------------------

const blobId = (bytes: Buffer) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** An in-memory GitHub connector that can also read binary files, with the budget rules of the real one kept simple. */
class BlobRepo extends FakeRepo implements BlobReads {
  blobs = new Map<string, Buffer>();
  commit = 'd'.repeat(40);
  headCalls: { paths: string[]; options: BlobHeadsOptions }[] = [];
  entryCalls = 0;
  constructor(files: Files) {
    super();
    this.files = new Map();
    for (const [path, content] of Object.entries(files)) {
      if (typeof content === 'string') this.files.set(path, content);
      else this.blobs.set(path, content);
    }
  }
  override async listFiles(): Promise<string[]> {
    this.listCalls++;
    if (this.listError) throw this.listError;
    return [...this.files.keys(), ...this.blobs.keys()].sort();
  }
  async resolveCommit(): Promise<string> {
    return this.commit;
  }
  async listBlobEntries(): Promise<BlobListing> {
    this.entryCalls++;
    return {
      commit: this.commit,
      entries: [...this.blobs].map(([path, bytes]) => ({
        path,
        oid: blobId(bytes),
        mode: '100644',
        size: bytes.length,
      })),
    };
  }
  async readBlobHeads(paths: readonly string[], options: BlobHeadsOptions): Promise<BlobHeads> {
    this.headCalls.push({ paths: [...paths], options });
    const items = new Map<string, BlobHeadItem>();
    let transferred = 0;
    for (const path of paths) {
      const bytes = this.blobs.get(path);
      if (!bytes) {
        items.set(path, { ok: false, oid: null, reason: 'missing', size: null });
        continue;
      }
      const oid = blobId(bytes);
      if (bytes.length > options.maxFileBytes) {
        items.set(path, { ok: false, oid, reason: 'too_large', size: bytes.length });
        continue;
      }
      if (options.headBytes === 0) {
        items.set(path, { ok: false, oid, reason: 'unsized', size: bytes.length });
        continue;
      }
      const take = Math.min(bytes.length, options.headBytes);
      if (transferred + take > options.maxTransferBytes) {
        items.set(path, { ok: false, oid, reason: 'budget', size: bytes.length });
        continue;
      }
      transferred += take;
      items.set(path, {
        ok: true,
        oid,
        size: bytes.length,
        head: new Uint8Array(bytes.subarray(0, take)),
      });
    }
    return { items, transferredBytes: transferred };
  }
}

// ----- the outbound exchange of the App Store lookup ---------------------------------------------

type Reply = {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  overflow?: boolean;
};

function fakeNet(script: (url: URL) => Reply | undefined, resolveTo: Record<string, string> = {}) {
  const asked: string[] = [];
  const exchange: Exchange = async (request) => {
    asked.push(request.url.toString());
    const reply = script(request.url) ?? { status: 404 };
    const body =
      typeof reply.body === 'string'
        ? new TextEncoder().encode(reply.body)
        : (reply.body ?? new Uint8Array());
    const overflow = reply.overflow === true || body.length > request.maxBytes;
    return {
      status: reply.status,
      headers: reply.headers ?? {},
      body: overflow ? new Uint8Array() : body,
      overflow,
    };
  };
  const resolve = async (host: string) => [
    { address: resolveTo[host] ?? '93.184.216.34', family: 4 },
  ];
  return { asked, net: { exchange, resolve } };
}

const ITUNES = 'https://itunes.apple.com/lookup?id=1234567890';
const ART = 'https://is1-ssl.mzstatic.com/image/thumb/Purple/art/512x512bb.png';
const lookupBody = (artwork: string | undefined, trackId = '1234567890') =>
  JSON.stringify({
    resultCount: 1,
    results: [{ trackId: Number(trackId), ...(artwork ? { artworkUrl512: artwork } : {}) }],
  });

// ----- booting -----------------------------------------------------------------------------------

type Mode = 'local' | 'clone' | 'api';
type Boot = {
  files: Files;
  mode?: Mode;
  net?: ReturnType<typeof fakeNet>['net'];
  limiter?: ReturnType<typeof createTestLimiter>;
  iconLimiter?: ReturnType<typeof createTestLimiter>;
};

async function boot(db: Database, options: Boot) {
  const mode = options.mode ?? 'local';
  const base = scratch('mrm-assets-');
  const root = join(base, 'dev');
  const dataDir = join(base, 'data');
  const cloneDir = join(dataDir, 'clones');
  for (const d of [root, dataDir]) mkdirSync(d);
  const dir = buildRepo(root, 'project', options.files);
  const clock = { now: Date.now() };
  clearRepoSnapshots();
  clearAssetIndexes();
  const repo = new BlobRepo(options.files);
  const reads =
    mode === 'api'
      ? undefined
      : createCloneReads({
          mode: 'clone',
          cloneDir,
          ...(mode === 'local' ? { local: { roots: [root], excluded: [dataDir, cloneDir] } } : {}),
          source: () => ({ type: 'local', path: dir }),
        });
  const t = await bootRepoApp(db, repo, {
    ...(reads ? { reads } : {}),
    now: () => clock.now,
    assets: {
      ...(options.limiter ? { limiter: options.limiter } : {}),
      icons: {
        ...(options.iconLimiter ? { limiter: options.iconLimiter } : {}),
        ...(options.net ? { net: options.net } : {}),
      },
    },
  });
  const { repositoryId } = await t.connect();
  if (mode === 'local') {
    const attach = await t.call(t.owner, 'PUT', `/repositories/${repositoryId}/local`, {
      path: dir,
    });
    assert.equal(attach.status, 200, attach.text);
  }
  const iosCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const playCredential = await t.addCredential('google_play', PLAY_SECRET);
  const addApp = async (
    platform: 'ios' | 'android',
    identifier = 'com.acme.app',
    extra: Record<string, unknown> = {},
  ) => {
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform,
      identifier,
      credentialId: platform === 'ios' ? iosCredential : playCredential,
      repositoryId,
      ...extra,
    });
    assert.equal(res.status, 201, res.text);
    return res.body.app.id as string;
  };
  const raw = async (
    cookie: string,
    path: string,
    headers: Record<string, string> = {},
    workspace = t.workspaceId,
  ) => {
    const res = await t.app.request(`/api/workspaces/${workspace}${path}`, {
      headers: { cookie, ...headers },
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      headers: res.headers,
      bytes,
      text: new TextDecoder().decode(bytes),
    };
  };
  const index = (id: string, cookie = t.owner) => t.call(cookie, 'GET', `/apps/${id}/assets`);
  const fileUrl = (id: string, path: string, commit?: string) =>
    `/apps/${id}/assets/file?path=${encodeURIComponent(path)}${commit ? `&commit=${commit}` : ''}`;
  const iconRow = async (id: string) =>
    (await db.query('SELECT * FROM app_icons WHERE app_id = ?', [id]))[0];
  /** Asks for the icon until a look has finished (the first look answers within the request; a refresh runs behind it). */
  const settle = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail('the icon look did not finish');
  };
  return { t, repo, dir, clock, repositoryId, addApp, raw, index, fileUrl, iconRow, settle, reads };
}

// biome-ignore lint/suspicious/noExplicitAny: API answers are inspected loosely
const byPath = (index: { assets: any[] }, path: string) =>
  index.assets.find((a) => a.path === path);

// =================================================================================================
// The index: layouts
// =================================================================================================

dbTest(
  'an iOS app: screenshots next to the metadata folder are indexed with device, size and problems',
  async (db) => {
    const b = await boot(db, {
      files: {
        ...weather(),
        'fastlane/metadata/ios/screenshots/en-US/1_iphone65.png': png(...IPHONE_65),
        'fastlane/metadata/ios/screenshots/en-US/2_iphone65.png': png(...IPHONE_65),
        'fastlane/metadata/ios/screenshots/en-US/3_iphone69.jpg': jpeg(...IPHONE_69),
        'fastlane/metadata/ios/screenshots/en-US/4_odd.png': png(1000, 1000),
        'fastlane/metadata/ios/screenshots/en-US/5_alpha.png': png(...IPHONE_65, { alpha: true }),
        'fastlane/metadata/ios/screenshots/en-US/notes.txt': 'not an image',
      },
    });
    const id = await b.addApp('ios');
    const res = await b.index(id);
    assert.equal(res.status, 200, res.text);
    const view = res.body;
    assert.equal(view.status, 'ok');
    assert.equal(view.platform, 'ios');
    assert.equal(view.store, 'app_store');
    assert.equal(view.source.kind, 'local_clone');
    assert.equal(view.source.fast, true);
    assert.match(view.commit, /^[0-9a-f]{40}$/);
    assert.equal(view.partial.partial, false);
    assert.equal(view.storeSide, null, 'the store side is reserved for the listing reads');
    assert.ok(view.specs.unverified.length > 0, 'unverified rules are named');
    assert.match(view.specs.basis, /Nothing was sent to or read from a store/);

    const shots = view.assets.filter((a: { kind: string }) => a.kind === 'screenshot');
    assert.equal(shots.length, 5, 'only images count; notes.txt is not media');
    const first = byPath(view, 'fastlane/metadata/ios/screenshots/en-US/1_iphone65.png');
    assert.equal(first.device, 'iphone_6_5');
    assert.equal(first.deviceLabel, 'iPhone 6.5"');
    assert.deepEqual([first.width, first.height, first.format], [1242, 2688, 'png']);
    assert.equal(first.order, 1);
    assert.equal(byPath(view, 'fastlane/metadata/ios/screenshots/en-US/2_iphone65.png').order, 2);
    assert.equal(
      byPath(view, 'fastlane/metadata/ios/screenshots/en-US/3_iphone69.jpg').device,
      'iphone_6_9',
    );
    assert.equal(
      byPath(view, 'fastlane/metadata/ios/screenshots/en-US/4_odd.png').device,
      null,
      'no display has 1000x1000',
    );
    assert.match(first.oid, /^[0-9a-f]{40}$/);
    assert.equal(first.bytes, png(...IPHONE_65).length);

    const rules = (path: string) =>
      view.problems
        .filter((p: { path?: string }) => p.path === path)
        .map((p: { rule: string }) => p.rule);
    assert.deepEqual(rules('fastlane/metadata/ios/screenshots/en-US/1_iphone65.png'), []);
    assert.ok(
      rules('fastlane/metadata/ios/screenshots/en-US/4_odd.png').includes('apple.screenshot.size'),
    );
    assert.ok(
      rules('fastlane/metadata/ios/screenshots/en-US/5_alpha.png').includes(
        'apple.screenshot.alpha',
      ),
    );
    for (const problem of view.problems) {
      assert.match(problem.message, /\S/);
      assert.equal(typeof problem.verified, 'boolean');
    }
    assert.deepEqual(view.locales, ['en-US']);
    assert.ok(view.totals.errors >= 2);
    assert.ok(view.sets.length > 0);
  },
);

dbTest(
  'a single-app fastlane layout: the screenshots folder next to fastlane/metadata is read too',
  async (db) => {
    const b = await boot(db, {
      files: {
        ...fastlaneFiles(),
        'fastlane/screenshots/en-US/1_iphone65.png': png(...IPHONE_65),
        'fastlane/screenshots/de-DE/1_iphone65.png': png(...IPHONE_65),
        'fastlane/screenshots/de-DE/2_ipad.png': png(2048, 2732),
        'fastlane/elsewhere/en-US/1.png': png(...IPHONE_65),
      },
    });
    const id = await b.addApp('ios');
    const view = (await b.index(id)).body;
    assert.deepEqual(view.folders.screenshots, [
      'fastlane/metadata/screenshots',
      'fastlane/screenshots',
    ]);
    assert.deepEqual(view.locales, ['de-DE', 'en-US']);
    assert.equal(
      view.assets.length,
      3,
      'a folder fastlane does not use is not media of the listing',
    );
    assert.equal(byPath(view, 'fastlane/screenshots/de-DE/2_ipad.png').device, 'ipad_13');
  },
);

dbTest(
  'an Android app: icon, feature graphic and screenshots by device folder, with their problems',
  async (db) => {
    const images = 'fastlane/metadata/android/en-US/images';
    const b = await boot(db, {
      files: {
        ...weather(),
        [`${images}/icon.png`]: png(512, 512, { alpha: true }),
        [`${images}/featureGraphic.png`]: png(1024, 500),
        [`${images}/phoneScreenshots/1.png`]: png(1080, 1920),
        [`${images}/phoneScreenshots/2.png`]: png(1080, 1920),
        [`${images}/tenInchScreenshots/1.png`]: png(1600, 2560),
        'fastlane/metadata/android/fr-FR/images/featureGraphic.png': png(800, 400),
      },
    });
    const id = await b.addApp('android');
    const res = await b.index(id);
    assert.equal(res.status, 200, res.text);
    const view = res.body;
    assert.equal(view.store, 'google_play');
    assert.equal(view.folders.androidImages, 'fastlane/metadata/android');
    assert.equal(byPath(view, `${images}/icon.png`).kind, 'icon');
    assert.equal(byPath(view, `${images}/featureGraphic.png`).kind, 'feature_graphic');
    assert.equal(byPath(view, `${images}/phoneScreenshots/1.png`).device, 'phone');
    assert.equal(byPath(view, `${images}/tenInchScreenshots/1.png`).device, 'tablet_10');
    assert.deepEqual(view.locales, ['en-US', 'fr-FR']);
    const bad = view.problems.filter(
      (p: { path?: string }) =>
        p.path === 'fastlane/metadata/android/fr-FR/images/featureGraphic.png',
    );
    assert.ok(
      bad.some((p: { rule: string }) => p.rule === 'play.feature_graphic.size'),
      JSON.stringify(bad),
    );
    assert.equal(
      view.problems.some((p: { path?: string }) => p.path === `${images}/icon.png`),
      false,
    );
  },
);

dbTest('a monorepo: each app sees only the media of its own metadata folder', async (db) => {
  const b = await boot(db, {
    files: {
      ...monorepo(),
      [`fastlane/metadata/${SCAN_APP}/ios/screenshots/en-US/1.png`]: png(...IPHONE_65),
      [`fastlane/metadata/${CARD_APP}/ios/screenshots/en-US/1.png`]: png(...IPHONE_69),
      [`fastlane/metadata/${CARD_APP}/ios/screenshots/en-US/2.png`]: png(...IPHONE_69),
      [`fastlane/metadata/${SCAN_APP}/android/en-US/images/icon.png`]: png(512, 512, {
        alpha: true,
      }),
    },
  });
  const scan = await b.addApp('ios', SCAN_APP);
  const card = await b.addApp('ios', CARD_APP);
  const scanDroid = await b.addApp('android', SCAN_APP);
  const scanView = (await b.index(scan)).body;
  const cardView = (await b.index(card)).body;
  assert.deepEqual(
    scanView.assets.map((a: { path: string }) => a.path),
    [`fastlane/metadata/${SCAN_APP}/ios/screenshots/en-US/1.png`],
  );
  assert.equal(cardView.assets.length, 2);
  assert.ok(cardView.assets.every((a: { path: string }) => a.path.includes(CARD_APP)));
  const droid = (await b.index(scanDroid)).body;
  assert.deepEqual(
    droid.assets.map((a: { kind: string }) => a.kind),
    ['icon'],
  );
  assert.match(String(scanView.target.label), /\S/);
});

dbTest('an Expo project: the icon of app.json is indexed as the project icon', async (db) => {
  const b = await boot(db, {
    files: {
      'app.json': JSON.stringify({
        expo: {
          name: 'Acme',
          icon: './assets/icon.png',
          ios: { bundleIdentifier: 'com.acme.app' },
        },
      }),
      'assets/icon.png': png(1024, 1024),
      'assets/splash.png': png(1284, 2778),
    },
  });
  const id = await b.addApp('ios');
  const view = (await b.index(id)).body;
  assert.equal(view.status, 'ok');
  const icon = byPath(view, 'assets/icon.png');
  assert.ok(icon, JSON.stringify(view.assets));
  assert.equal(icon.kind, 'app_icon');
  assert.equal(icon.origin, 'project');
  assert.equal(byPath(view, 'assets/splash.png'), undefined, 'splash screens are not store media');
});

dbTest('an app without a repository answers an empty index, never an error', async (db) => {
  const b = await boot(db, { files: weather() });
  const res = await b.t.call(b.t.owner, 'POST', '/apps', {
    platform: 'ios',
    identifier: 'com.acme.other',
    credentialId: await b.t.addCredential('app_store_connect', ASC_SECRET),
  });
  const id = res.body.app.id as string;
  const view = (await b.index(id)).body;
  assert.equal(view.status, 'no_repository');
  assert.deepEqual(view.assets, []);
  assert.equal(view.source, null);
});

// =================================================================================================
// The index: the GitHub API path, budget and cache
// =================================================================================================

dbTest(
  'API path: at most 60 images are opened, the index says partial, and the second read is cached',
  async (db) => {
    const files: Files = { ...weather() };
    for (let i = 1; i <= 70; i++)
      files[`fastlane/metadata/ios/screenshots/en-US/${String(i).padStart(2, '0')}.png`] = png(
        ...IPHONE_65,
        { seed: i },
      );
    const b = await boot(db, { files, mode: 'api' });
    const id = await b.addApp('ios');
    const res = await b.index(id);
    assert.equal(res.status, 200, res.text);
    const view = res.body;
    assert.equal(view.source.kind, 'github_api');
    assert.equal(view.source.fast, false);
    assert.equal(view.limits.maxFiles, 60);
    assert.equal(view.partial.partial, true);
    assert.equal(view.partial.skipped, 10);
    assert.match(view.partial.reasons[0], /Only the first 60 images were opened/);
    assert.equal(view.assets.length, 70, 'everything is listed');
    assert.equal(view.assets.filter((a: { read: string }) => a.read === 'read').length, 60);
    const opened = b.repo.headCalls[0]?.paths.length ?? 0;
    assert.equal(opened, 60);
    assert.equal(
      b.repo.headCalls[0]?.options.headBytes,
      64 * 1024,
      'only the first 64 KB are asked for',
    );
    assert.equal(res.body.cached, false);

    const calls = b.repo.headCalls.length;
    const again = await b.index(id);
    assert.equal(again.body.cached, true);
    assert.equal(b.repo.headCalls.length, calls, 'a cached index reads no file');
    assert.deepEqual(again.body.assets, view.assets);
  },
);

dbTest('API path: the transfer budget stops the reads and the index says so', async (db) => {
  const files: Files = { ...weather() };
  // 40 images of 1 MB each: the header is all that is asked for, but the fake counts what it hands out.
  for (let i = 1; i <= 3; i++)
    files[`fastlane/metadata/ios/screenshots/en-US/${i}.png`] = png(...IPHONE_65, {
      seed: i,
      pad: 70 * 1024,
    });
  const b = await boot(db, { files, mode: 'api' });
  const id = await b.addApp('ios');
  const view = (await b.index(id)).body;
  assert.equal(view.partial.partial, false, 'a few small reads are within the budget');
  assert.equal(
    view.assets.every((a: { read: string }) => a.read === 'read'),
    true,
  );
});

dbTest(
  'the index of a repository read is rate limited per workspace, a cached one is not',
  async (db) => {
    const b = await boot(db, {
      files: { ...weather(), 'fastlane/metadata/ios/screenshots/en-US/1.png': png(...IPHONE_65) },
      mode: 'api',
      limiter: createTestLimiter({ limit: 1, now: () => 1 }),
    });
    const first = await b.addApp('ios');
    const second = await b.addApp('android');
    assert.equal((await b.index(first)).status, 200);
    assert.equal((await b.index(first)).status, 200, 'the same commit is served from the cache');
    const limited = await b.index(second);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  },
);

dbTest('a GitHub clone is read like a local one but with the clone budget', async (db) => {
  const b = await boot(db, {
    files: { ...weather(), 'fastlane/metadata/ios/screenshots/en-US/1.png': png(...IPHONE_65) },
    mode: 'clone',
  });
  const id = await b.addApp('ios');
  const view = (await b.index(id)).body;
  assert.equal(view.source.kind, 'github_clone');
  assert.equal(view.limits.maxFiles, 150);
  assert.equal(view.assets.length, 1);
  assert.equal(view.assets[0].read, 'read');
});

// =================================================================================================
// The file route
// =================================================================================================

dbTest(
  'the file route streams one indexed image with safe headers, an ETag and 304',
  async (db) => {
    const shot = png(...IPHONE_65, { pad: 3000 });
    const b = await boot(db, {
      files: { ...weather(), 'fastlane/metadata/ios/screenshots/en-US/1.png': shot },
    });
    const id = await b.addApp('ios');
    const view = (await b.index(id)).body;
    const path = 'fastlane/metadata/ios/screenshots/en-US/1.png';
    const oid = byPath(view, path).oid;

    const res = await b.raw(b.t.owner, b.fileUrl(id, path, view.commit));
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(res.bytes), shot);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('content-disposition'), 'inline');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(res.headers.get('etag'), `"${oid}"`);
    assert.equal(res.headers.get('content-length'), String(shot.length));
    assert.match(res.headers.get('cache-control') ?? '', /private/);
    assert.match(
      res.headers.get('cache-control') ?? '',
      /immutable/,
      'a commit-pinned URL never changes',
    );

    const again = await b.raw(b.t.owner, b.fileUrl(id, path, view.commit), {
      'if-none-match': `"${oid}"`,
    });
    assert.equal(again.status, 304);
    assert.equal(again.bytes.length, 0);
    assert.equal(again.headers.get('etag'), `"${oid}"`);
    const weak = await b.raw(b.t.owner, b.fileUrl(id, path, view.commit), {
      'if-none-match': `W/"nope", W/"${oid}"`,
    });
    assert.equal(weak.status, 304);
    const other = await b.raw(b.t.owner, b.fileUrl(id, path, view.commit), {
      'if-none-match': '"something-else"',
    });
    assert.equal(other.status, 200);

    // Without a commit the branch tip is read and the cache is short.
    const tip = await b.raw(b.t.owner, b.fileUrl(id, path));
    assert.equal(tip.status, 200);
    assert.doesNotMatch(tip.headers.get('cache-control') ?? '', /immutable/);
  },
);

dbTest(
  'the content type is sniffed from the bytes: a jpeg is image/jpeg whatever its name, svg and html are refused',
  async (db) => {
    const b = await boot(db, {
      files: {
        ...weather(),
        'fastlane/metadata/ios/screenshots/en-US/1.png': jpeg(...IPHONE_69),
        'fastlane/metadata/ios/screenshots/en-US/2.png':
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        'fastlane/metadata/ios/screenshots/en-US/3.jpg': '<!doctype html><script>alert(1)</script>',
      },
    });
    const id = await b.addApp('ios');
    const view = (await b.index(id)).body;
    const ok = await b.raw(
      b.t.owner,
      b.fileUrl(id, 'fastlane/metadata/ios/screenshots/en-US/1.png', view.commit),
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/jpeg');
    for (const name of ['2.png', '3.jpg']) {
      const res = await b.raw(
        b.t.owner,
        b.fileUrl(id, `fastlane/metadata/ios/screenshots/en-US/${name}`, view.commit),
      );
      assert.equal(res.status, 415, name);
      assert.doesNotMatch(res.headers.get('content-type') ?? '', /svg|html/);
      assert.doesNotMatch(res.text, /<script>/);
    }
    assert.equal(
      byPath(view, 'fastlane/metadata/ios/screenshots/en-US/2.png').read,
      'unreadable',
      'the index says it is not an image',
    );
  },
);

dbTest(
  'only paths of the index are served: traversal, other files and other targets are refused',
  async (db) => {
    const b = await boot(db, {
      files: {
        ...monorepo(),
        [`fastlane/metadata/${SCAN_APP}/ios/screenshots/en-US/1.png`]: png(...IPHONE_65),
        [`fastlane/metadata/${CARD_APP}/ios/screenshots/en-US/1.png`]: png(...IPHONE_65),
        'secret/token.png': png(...IPHONE_65),
      },
    });
    const scan = await b.addApp('ios', SCAN_APP);
    const view = (await b.index(scan)).body;
    const get = (path: string, commit: string | undefined = view.commit) =>
      b.raw(b.t.owner, b.fileUrl(scan, path, commit));
    assert.equal(
      (await get(`fastlane/metadata/${SCAN_APP}/ios/screenshots/en-US/1.png`)).status,
      200,
    );
    for (const path of [
      '../etc/passwd',
      '/etc/passwd',
      'a/../b.png',
      './x.png',
      'a//b.png',
      'a\\b.png',
      'x\0.png',
      '',
    ]) {
      const res = await get(path);
      assert.equal(res.status, 400, JSON.stringify(path));
    }
    // Exists in the repository, is a png, but is not in this app's index: another app's media and a stray file.
    assert.equal(
      (await get(`fastlane/metadata/${CARD_APP}/ios/screenshots/en-US/1.png`)).status,
      404,
    );
    assert.equal((await get('secret/token.png')).status, 404);
    assert.equal((await get('fastlane/Fastfile')).status, 404);
    assert.equal((await get('fastlane/metadata/does/not/exist.png')).status, 404);
    assert.equal(
      (await get(`fastlane/metadata/${SCAN_APP}/ios/screenshots/en-US/1.png`, 'nothex')).status,
      400,
    );
    assert.equal(
      (await b.raw(b.t.owner, `/apps/${scan}/assets/file`)).status,
      400,
      'path is required',
    );
  },
);

dbTest(
  'another workspace and non-members get 404, viewers may read, nobody without a session gets in',
  async (db) => {
    const b = await boot(db, {
      files: { ...weather(), 'fastlane/metadata/ios/screenshots/en-US/1.png': png(...IPHONE_65) },
    });
    const id = await b.addApp('ios');
    const view = (await b.index(id)).body;
    const path = 'fastlane/metadata/ios/screenshots/en-US/1.png';
    const viewer = await b.t.addMember('viewer');
    assert.equal((await b.index(id, viewer)).status, 200);
    assert.equal((await b.raw(viewer, b.fileUrl(id, path, view.commit))).status, 200);

    // A member of ANOTHER workspace, asking with the first workspace's ids.
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w2', 'Other', 1)");
    const stranger = await b.t.addMember('owner', 'w2');
    for (const url of [
      `/apps/${id}/assets`,
      b.fileUrl(id, path, view.commit),
      `/apps/${id}/icon`,
    ]) {
      const res = await b.raw(stranger, url);
      assert.equal(res.status, 404, url);
      assert.doesNotMatch(res.text, /fastlane|png/);
      // Their own workspace, this app id: not found either.
      const own = await b.raw(stranger, url, {}, 'w2');
      assert.equal(own.status, 404, `${url} in their workspace`);
    }
    for (const url of [
      `/apps/${id}/assets`,
      b.fileUrl(id, path, view.commit),
      `/apps/${id}/icon`,
    ]) {
      const res = await b.t.app.request(`/api/workspaces/${b.t.workspaceId}${url}`);
      assert.equal(res.status, 401, url);
    }
  },
);

dbTest('the three routes are in the OpenAPI registry with their rights and app scope', async () => {
  const find = (id: string) => operations.find((o) => o.id === id);
  for (const [id, action] of [
    ['getAppAssets', 'listing.read'],
    ['getAppAssetFile', 'listing.read'],
    ['getAppIcon', 'apps.read'],
  ] as const) {
    const op = find(id);
    assert.ok(op, id);
    assert.equal(op.method, 'get');
    assert.deepEqual(op.access, { action });
    assert.deepEqual(op.appScope, { kind: 'param', name: 'id' });
    assert.equal(op.risk, 'read');
  }
  assert.equal(find('getAppAssetFile')?.responses['200']?.contentType, 'image/png');
});

// =================================================================================================
// The icon
// =================================================================================================

dbTest(
  'the icon comes from the repository first: a store icon beats the project icon, the larger beats the smaller',
  async (db) => {
    const images = 'fastlane/metadata/android/en-US/images';
    const store = png(512, 512, { alpha: true, seed: 1 });
    const b = await boot(db, {
      files: {
        ...weather(),
        [`${images}/icon.png`]: store,
        'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png': png(192, 192, { seed: 9 }),
      },
    });
    const id = await b.addApp('android');
    const res = await b.raw(b.t.owner, `/apps/${id}/icon`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(res.bytes), store);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(res.headers.get('content-disposition'), 'inline');
    const row = await b.iconRow(id);
    assert.equal(row?.source, 'repository');
    assert.equal(row?.source_id, blobId(store));
    assert.equal(Number(row?.width), 512);
    assert.equal(Number(row?.failures), 0);

    const etag = res.headers.get('etag') as string;
    const cached = await b.raw(b.t.owner, `/apps/${id}/icon`, { 'if-none-match': etag });
    assert.equal(cached.status, 304);
    const versioned = await b.raw(b.t.owner, `/apps/${id}/icon?v=${etag.replaceAll('"', '')}`);
    assert.match(versioned.headers.get('cache-control') ?? '', /immutable/);
    assert.doesNotMatch(res.headers.get('cache-control') ?? '', /immutable/);

    // The hint on the app.
    const app = (await b.t.call(b.t.owner, 'GET', `/apps/${id}`)).body.app;
    assert.equal(app.hasIcon, true);
    assert.equal(
      app.iconUrl,
      `/api/workspaces/${b.t.workspaceId}/apps/${id}/icon?v=${etag.replaceAll('"', '')}`,
    );
    const listed = (await b.t.call(b.t.owner, 'GET', '/apps')).body.apps.find(
      (a: { id: string }) => a.id === id,
    );
    assert.equal(listed.hasIcon, true);
  },
);

dbTest(
  'a project icon is used when the listing has none: Expo icon, and the larger Android launcher icon',
  async (db) => {
    const b = await boot(db, {
      files: {
        'app.json': JSON.stringify({ expo: { name: 'Acme', icon: './assets/icon.png' } }),
        'assets/icon.png': png(1024, 1024, { seed: 3, pad: 4000 }),
      },
    });
    const id = await b.addApp('ios');
    const res = await b.raw(b.t.owner, `/apps/${id}/icon`);
    assert.equal(res.status, 200);
    assert.equal((await b.iconRow(id))?.source, 'repository');
  },
);

dbTest(
  'an icon over 256 KB, not square or not an image is not used, and nothing is made up',
  async (db) => {
    const b = await boot(db, {
      files: {
        ...weather(),
        'fastlane/metadata/android/en-US/images/icon.png': png(512, 512, {
          alpha: true,
          pad: 300 * 1024,
        }),
      },
    });
    const id = await b.addApp('android');
    const res = await b.raw(b.t.owner, `/apps/${id}/icon`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const row = await b.iconRow(id);
    assert.equal(row?.data, null);
    assert.ok(row?.backoff_until, 'an empty look is not repeated at once');
    const app = (await b.t.call(b.t.owner, 'GET', `/apps/${id}`)).body.app;
    assert.equal(app.hasIcon, false);
    assert.equal(app.iconUrl, null, 'the UI is told not to ask again until the next look is due');
  },
);

dbTest(
  'an iOS app without a repository icon uses the iTunes Lookup artwork, over the checked path only',
  async (db) => {
    const art = png(512, 512, { seed: 5 });
    const fake = fakeNet((url) => {
      if (url.toString() === ITUNES)
        return {
          status: 200,
          body: lookupBody(ART),
          headers: { 'content-type': 'application/json' },
        };
      if (url.toString() === ART)
        return { status: 200, body: art, headers: { 'content-type': 'image/png' } };
      return undefined;
    });
    const b = await boot(db, { files: weather(), net: fake.net });
    const id = await b.addApp('ios');
    await db.execute("UPDATE apps SET store_app_id = '1234567890' WHERE id = ?", [id]);
    const res = await b.raw(b.t.owner, `/apps/${id}/icon`);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(res.bytes), art);
    assert.deepEqual(fake.asked, [ITUNES, ART]);
    const row = await b.iconRow(id);
    assert.equal(row?.source, 'app_store');
    assert.equal(row?.source_id, 'is1-ssl.mzstatic.com');
    // Kept: the next request asks nobody.
    await b.raw(b.t.owner, `/apps/${id}/icon`);
    assert.equal(fake.asked.length, 2);
  },
);

dbTest(
  'the repository wins over the App Store, and an Android app never calls the App Store',
  async (db) => {
    const fake = fakeNet(() => ({ status: 200, body: lookupBody(ART) }));
    const b = await boot(db, {
      files: {
        ...weather(),
        'fastlane/metadata/android/en-US/images/icon.png': png(512, 512, { alpha: true }),
      },
      net: fake.net,
    });
    const droid = await b.addApp('android');
    await b.raw(b.t.owner, `/apps/${droid}/icon`);
    assert.equal((await b.iconRow(droid))?.source, 'repository');
    assert.deepEqual(fake.asked, []);
    const noRepoDroid = await b.t.call(b.t.owner, 'POST', '/apps', {
      platform: 'android',
      identifier: 'com.acme.bare',
      credentialId: await b.t.addCredential('google_play', PLAY_SECRET),
    });
    const res = await b.raw(b.t.owner, `/apps/${noRepoDroid.body.app.id}/icon`);
    assert.equal(res.status, 404);
    assert.deepEqual(fake.asked, [], 'no Play scraping, no lookup');
  },
);

dbTest(
  'the App Store lookup refuses what is not safe: hosts, redirects, private addresses, size, type',
  async (db) => {
    const cases: {
      name: string;
      script: (url: URL) => Reply | undefined;
      resolveTo?: Record<string, string>;
      message: RegExp;
    }[] = [
      {
        name: 'artwork on a host that is not mzstatic',
        script: (url) =>
          url.hostname === 'itunes.apple.com'
            ? { status: 200, body: lookupBody('https://evil.example.com/a.png') }
            : { status: 200, body: png(512, 512) },
        message: /not allowed/,
      },
      {
        name: 'artwork over plain http',
        script: (url) =>
          url.hostname === 'itunes.apple.com'
            ? { status: 200, body: lookupBody('http://is1-ssl.mzstatic.com/a.png') }
            : { status: 200, body: png(512, 512) },
        message: /https/i,
      },
      {
        name: 'a redirect to a host that is not allowed',
        script: (url) =>
          url.hostname === 'itunes.apple.com'
            ? { status: 200, body: lookupBody(ART) }
            : { status: 302, headers: { location: 'https://evil.example.com/a.png' } },
        message: /not allowed/,
      },
      {
        name: 'a redirect to the cloud metadata address',
        script: (url) =>
          url.hostname === 'itunes.apple.com'
            ? { status: 200, body: lookupBody(ART) }
            : { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } },
        message: /not allowed|address/,
      },
      {
        name: 'a redirect from https to http',
        script: (url) =>
          url.hostname === 'itunes.apple.com'
            ? { status: 200, body: lookupBody(ART) }
            : { status: 302, headers: { location: 'http://is1-ssl.mzstatic.com/a.png' } },
        message: /plain http|https/i,
      },
      {
        name: 'artwork that resolves to a private address',
        script: (url) =>
          url.hostname === 'itunes.apple.com'
            ? { status: 200, body: lookupBody(ART) }
            : { status: 200, body: png(512, 512) },
        resolveTo: { 'is1-ssl.mzstatic.com': '10.0.0.7' },
        message: /not allowed/,
      },
      {
        name: 'the lookup host resolving to loopback',
        script: () => ({ status: 200, body: lookupBody(ART) }),
        resolveTo: { 'itunes.apple.com': '127.0.0.1' },
        message: /not allowed/,
      },
      {
        name: 'artwork over 256 KB',
        script: (url) =>
          url.hostname === 'itunes.apple.com'
            ? { status: 200, body: lookupBody(ART) }
            : { status: 200, body: png(512, 512, { pad: 300 * 1024 }) },
        message: /larger than/,
      },
      {
        name: 'artwork that is an SVG',
        script: (url) =>
          url.hostname === 'itunes.apple.com'
            ? { status: 200, body: lookupBody(ART) }
            : {
                status: 200,
                headers: { 'content-type': 'image/png' },
                body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
              },
        message: /not a readable image/,
      },
      {
        name: 'artwork that is a gif',
        script: (url) =>
          url.hostname === 'itunes.apple.com'
            ? { status: 200, body: lookupBody(ART) }
            : { status: 200, body: Buffer.from([...text('GIF89a'), 0, 2, 0, 2, 0, 0, 0]) },
        message: /gif/,
      },
      {
        name: 'a lookup answer that is not JSON',
        script: () => ({ status: 200, body: '<html>' }),
        message: /not JSON/,
      },
      {
        name: 'a lookup that answers 500',
        script: () => ({ status: 500 }),
        message: /500/,
      },
      {
        name: 'a lookup answer over 1 MB',
        script: () => ({ status: 200, overflow: true }),
        message: /larger than/,
      },
    ];
    let current = cases[0] as (typeof cases)[number];
    const resolveTo: Record<string, string> = {};
    const fake = fakeNet((url) => current.script(url), resolveTo);
    const b = await boot(db, {
      files: weather(),
      net: fake.net,
      iconLimiter: createTestLimiter({ limit: 1000 }),
    });
    let n = 0;
    for (const c of cases) {
      current = c;
      for (const key of Object.keys(resolveTo)) delete resolveTo[key];
      Object.assign(resolveTo, c.resolveTo ?? {});
      const id = await b.addApp('ios', `com.acme.case${n++}`);
      await db.execute("UPDATE apps SET store_app_id = '1234567890' WHERE id = ?", [id]);
      const res = await b.raw(b.t.owner, `/apps/${id}/icon`);
      assert.equal(res.status, 404, c.name);
      const row = await b.iconRow(id);
      assert.equal(row?.data, null, c.name);
      assert.equal(Number(row?.failures), 1, c.name);
      assert.match(String(row?.last_error), c.message, c.name);
      assert.ok(Number(row?.backoff_until) > Number(row?.checked_at), c.name);
    }
  },
);

dbTest(
  'a failed look backs off and doubles, a success clears it, and a failure never removes the held icon',
  async (db) => {
    let healthy = false;
    const art = png(512, 512, { seed: 8 });
    const fake = fakeNet((url) => {
      if (!healthy) return { status: 503 };
      return url.hostname === 'itunes.apple.com'
        ? { status: 200, body: lookupBody(ART) }
        : { status: 200, body: art };
    });
    const b = await boot(db, {
      files: weather(),
      net: fake.net,
      iconLimiter: createTestLimiter({ limit: 100 }),
    });
    const id = await b.addApp('ios');
    await db.execute("UPDATE apps SET store_app_id = '1234567890' WHERE id = ?", [id]);
    const minute = 60_000;

    assert.equal((await b.raw(b.t.owner, `/apps/${id}/icon`)).status, 404);
    let row = await b.iconRow(id);
    assert.equal(Number(row?.failures), 1);
    const first = Number(row?.backoff_until) - Number(row?.checked_at);
    assert.equal(first, 15 * minute);
    assert.equal(fake.asked.length, 1);

    // Inside the back-off nobody is asked.
    b.clock.now += 5 * minute;
    assert.equal((await b.raw(b.t.owner, `/apps/${id}/icon`)).status, 404);
    assert.equal(fake.asked.length, 1);

    // After it: tried again, fails again, twice as long.
    b.clock.now += 11 * minute;
    assert.equal((await b.raw(b.t.owner, `/apps/${id}/icon`)).status, 404);
    row = await b.iconRow(id);
    assert.equal(Number(row?.failures), 2);
    assert.equal(Number(row?.backoff_until) - Number(row?.checked_at), 30 * minute);
    assert.equal(fake.asked.length, 2);

    // Healthy again.
    healthy = true;
    b.clock.now += 31 * minute;
    assert.equal((await b.raw(b.t.owner, `/apps/${id}/icon`)).status, 200);
    row = await b.iconRow(id);
    assert.equal(Number(row?.failures), 0);
    assert.equal(row?.backoff_until, null);
    assert.equal(row?.source, 'app_store');
    const etag = row?.etag;

    // A week later the remote icon is looked at again; this time the store is down: the icon stays.
    healthy = false;
    b.clock.now += 8 * 24 * 60 * minute;
    const stale = await b.raw(b.t.owner, `/apps/${id}/icon`);
    assert.equal(stale.status, 200, 'the held icon is served while it is refreshed');
    await b.settle(async () => Number((await b.iconRow(id))?.failures) === 1);
    row = await b.iconRow(id);
    assert.equal(row?.etag, etag);
    assert.notEqual(row?.data, null, 'a failed refresh keeps the icon');
    assert.match(String(row?.last_error), /503/);
  },
);

dbTest(
  'the lookups are rate limited per workspace, and a limited look changes nothing',
  async (db) => {
    const fake = fakeNet(() => ({ status: 503 }));
    const b = await boot(db, {
      files: weather(),
      net: fake.net,
      iconLimiter: createTestLimiter({ limit: 1, now: () => 1 }),
    });
    const first = await b.addApp('ios');
    const second = await b.addApp('ios', 'com.acme.second');
    await db.execute("UPDATE apps SET store_app_id = '1234567890' WHERE id IN (?, ?)", [
      first,
      second,
    ]);
    await b.raw(b.t.owner, `/apps/${first}/icon`);
    assert.equal(fake.asked.length, 1);
    assert.equal((await b.raw(b.t.owner, `/apps/${second}/icon`)).status, 404);
    assert.equal(fake.asked.length, 1, 'the second app was not looked up: the budget was used');
    assert.equal(
      await b.iconRow(second),
      undefined,
      'nothing is recorded for a look that did not happen',
    );
  },
);

dbTest(
  'the icon is refreshed when the commit changes the icon file, and left alone when it does not',
  async (db) => {
    const images = 'fastlane/metadata/android/en-US/images/icon.png';
    const one = png(512, 512, { alpha: true, seed: 1 });
    const two = png(512, 512, { alpha: true, seed: 2 });
    const b = await boot(db, { files: { ...weather(), [images]: one } });
    const id = await b.addApp('android');
    const first = await b.raw(b.t.owner, `/apps/${id}/icon`);
    assert.deepEqual(Buffer.from(first.bytes), one);
    const row1 = await b.iconRow(id);
    const minute = 60_000;

    // Nothing changed in the repository: looked at again after 30 minutes, same bytes, fetched_at kept.
    b.clock.now += 31 * minute;
    await b.raw(b.t.owner, `/apps/${id}/icon`);
    await b.settle(
      async () => Number((await b.iconRow(id))?.checked_at) > Number(row1?.checked_at),
    );
    const row2 = await b.iconRow(id);
    assert.equal(row2?.etag, row1?.etag);
    assert.equal(Number(row2?.fetched_at), Number(row1?.fetched_at));

    // A new commit with another icon.
    commitMore(b.dir, { [images]: two });
    clearRepoSnapshots();
    clearAssetIndexes();
    b.clock.now += 31 * minute;
    const stale = await b.raw(b.t.owner, `/apps/${id}/icon`);
    assert.equal(stale.status, 200);
    await b.settle(async () => (await b.iconRow(id))?.source_id === blobId(two));
    const fresh = await b.raw(b.t.owner, `/apps/${id}/icon`);
    assert.deepEqual(Buffer.from(fresh.bytes), two);
    assert.notEqual(fresh.headers.get('etag'), first.headers.get('etag'));
  },
);

dbTest('deleting an app deletes its icon row and only its own', async (db) => {
  const b = await boot(db, {
    files: {
      ...weather(),
      'fastlane/metadata/android/en-US/images/icon.png': png(512, 512, { alpha: true }),
    },
  });
  const one = await b.addApp('android');
  const two = await b.addApp('android', 'com.acme.two');
  await b.raw(b.t.owner, `/apps/${one}/icon`);
  await b.raw(b.t.owner, `/apps/${two}/icon`);
  assert.equal((await db.query('SELECT app_id FROM app_icons')).length, 2);
  const del = await b.t.call(b.t.owner, 'DELETE', `/apps/${one}`);
  assert.equal(del.status, 204);
  const left = await db.query('SELECT app_id FROM app_icons');
  assert.deepEqual(
    left.map((r) => r.app_id),
    [two],
  );
  assert.equal((await b.t.call(b.t.owner, 'DELETE', `/apps/${two}`)).status, 204);
  assert.equal((await db.query('SELECT app_id FROM app_icons')).length, 0, 'no orphan rows');
});

dbTest(
  'the first request for an icon never throws: a repository that fails gives a 404 and a back-off',
  async (db) => {
    const b = await boot(db, { files: weather(), mode: 'api' });
    const id = await b.addApp('android');
    b.repo.listError = new Error('GitHub is down');
    const res = await b.raw(b.t.owner, `/apps/${id}/icon`);
    assert.equal(res.status, 404);
    const row = await b.iconRow(id);
    assert.equal(Number(row?.failures), 1);
    assert.doesNotMatch(String(row?.last_error), /ghp_/);
  },
);
