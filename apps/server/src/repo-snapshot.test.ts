import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectProject, loadListing, type RepoConnector } from '@mrm/connectors';
import {
  mapsApp,
  scannerMonorepo,
  weatherApp,
} from '../../../packages/connectors/src/fastlane.fixtures.ts';
import { readListings } from './services/listing-sources.ts';
import {
  clearRepoSnapshots,
  openRepoSnapshot,
  SNAPSHOT_MAX_ENTRIES,
  SNAPSHOT_TTL_MS,
} from './services/repo-snapshot.ts';

/**
 * Where the time went: every listing opened the repository again (tree, detection files) and read
 * one file per release note, hundreds of them. These tests count the requests a fake GitHub
 * receives and make each of them take time, so a regression in the call count is also slow.
 */

type Files = Record<string, string>;

/** A GitHub stand-in: counts requests by kind, delays each, and tracks how many run at once. */
class CountingRepo {
  readonly kind = 'github' as const;
  refs = 0;
  trees = 0;
  reads = 0;
  readPaths: string[] = [];
  inFlight = 0;
  peak = 0;
  sha = 'a'.repeat(40);
  files: Files;
  readonly delayMs: number;
  constructor(files: Files, delayMs = 3, pinned = true) {
    this.files = files;
    this.delayMs = delayMs;
    if (!pinned) delete (this as { resolveCommit?: unknown }).resolveCommit;
  }
  get requests() {
    return this.refs + this.trees + this.reads;
  }
  async #wait() {
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.inFlight--;
  }
  resolveCommit = async (_ref?: string): Promise<string> => {
    this.refs++;
    await this.#wait();
    return this.sha;
  };
  async listFiles(): Promise<string[]> {
    this.trees++;
    await this.#wait();
    return Object.keys(this.files).sort();
  }
  async readFile(path: string): Promise<string | undefined> {
    this.reads++;
    this.readPaths.push(path);
    await this.#wait();
    return this.files[path];
  }
  async propose(): Promise<never> {
    throw new Error('not used');
  }
  async dispatchWorkflow(): Promise<never> {
    throw new Error('not used');
  }
  async listWorkflowRuns(): Promise<never> {
    throw new Error('not used');
  }
}

const asConnector = (r: CountingRepo) => r as unknown as RepoConnector;
const opened = (repo: CountingRepo, id = 'repo-1') =>
  openRepoSnapshot({
    repositoryId: id,
    connector: asConnector(repo),
    branch: 'main',
    now: Date.now,
  });

/** The listing request: open the snapshot, then read the listings from it. */
async function listing(repo: CountingRepo, options = {}) {
  const snap = await opened(repo);
  return readListings(snap.files, snap.read, options);
}

/** What the code did before: list the tree and read through the connector, every request. */
async function listingBefore(repo: CountingRepo) {
  const files = await repo.listFiles();
  const detection = await detectProject(files, (p) => repo.readFile(p));
  // It read each detection file once (cached) and then every release note file of the store.
  const snapshot = await loadListing(files, (p) => repo.readFile(p), { maxChangelogs: 100_000 });
  return { detection, snapshot };
}

test('a) the listing of the weather app: requests before and after', async () => {
  const files = weatherApp();
  const before = new CountingRepo(files);
  await listingBefore(before);
  clearRepoSnapshots();
  const after = new CountingRepo(files);
  const result = await listing(after);
  assert.equal(result.fastlane.found.appStore, true);
  assert.equal(result.fastlane.found.googlePlay, true);
  // The old path read all 286 release notes; the new one reads the newest 10 of each locale.
  assert.ok(before.reads > 280, `before: ${before.reads} reads`);
  assert.ok(after.reads < 60, `after: ${after.reads} reads`);
  assert.equal(after.trees, 1);
  assert.equal(after.refs, 1);
  assert.ok(after.requests * 5 < before.requests, `${after.requests} vs ${before.requests}`);
  assert.ok(after.peak <= 8, `at most 8 requests at once, saw ${after.peak}`);
  // Only metadata text files of the chosen folders, and none twice.
  assert.equal(new Set(after.readPaths).size, after.readPaths.length);
  const listed = after.readPaths.filter((p) => p.startsWith('fastlane/metadata/'));
  assert.ok(
    listed.every(
      (p) =>
        p.endsWith('.txt') && !p.includes('review_information') && !p.includes('/screenshots/'),
    ),
  );
});

test('a repeated listing and the change set made from it do not list or read again', async () => {
  clearRepoSnapshots();
  const repo = new CountingRepo(weatherApp());
  await listing(repo);
  const afterFirst = { refs: repo.refs, trees: repo.trees, reads: repo.reads };
  await listing(repo);
  await listing(repo);
  assert.equal(repo.trees, afterFirst.trees, 'the tree is cached by commit');
  assert.equal(repo.reads, afterFirst.reads, 'the file texts are cached by commit');
  assert.equal(repo.refs, afterFirst.refs + 2, 'only the commit is asked each time');
});

test('a new commit is read afresh, and a different repository never shares a cache entry', async () => {
  clearRepoSnapshots();
  const repo = new CountingRepo(mapsApp());
  await listing(repo);
  const first = repo.trees;
  repo.sha = 'b'.repeat(40);
  repo.files = { ...repo.files, 'fastlane/metadata/android/en-US/title.txt': 'New title\n' };
  const next = await listing(repo);
  assert.equal(repo.trees, first + 1);
  assert.equal(next.fastlane.listing.googlePlay?.locales['en-US']?.title, 'New title');
  await openRepoSnapshot({
    repositoryId: 'other',
    connector: asConnector(repo),
    branch: 'main',
    now: Date.now,
  });
  assert.equal(repo.trees, first + 2);
});

test('the cache is bounded and expires', async () => {
  clearRepoSnapshots();
  const repo = new CountingRepo({ 'a.txt': 'x' }, 0);
  let clock = 1_000;
  const open = (id: string) =>
    openRepoSnapshot({
      repositoryId: id,
      connector: asConnector(repo),
      branch: 'main',
      now: () => clock,
    });
  await open('r1');
  await open('r1');
  assert.equal(repo.trees, 1);
  clock += SNAPSHOT_TTL_MS + 1;
  await open('r1');
  assert.equal(repo.trees, 2, 'expired');
  for (let i = 0; i < SNAPSHOT_MAX_ENTRIES + 2; i++) await open(`many-${i}`);
  const before = repo.trees;
  await open('many-0');
  assert.equal(repo.trees, before + 1, 'the oldest entry was dropped');
  await open(`many-${SNAPSHOT_MAX_ENTRIES + 1}`);
  assert.equal(repo.trees, before + 1, 'the newest is still there');
});

test('b) the monorepo: only the files of the default app are read, and choosing another reads only its own', async () => {
  clearRepoSnapshots();
  const files = scannerMonorepo();
  const first = new CountingRepo(files);
  const view = await listing(first);
  assert.equal(view.fastlane.found.appStore, true);
  assert.ok(
    first.readPaths.every(
      (p) => !p.includes('com.example.documentscanner') || p.includes('/Fastfile'),
    ),
  );
  const metaReads = first.readPaths.filter((p) => p.startsWith('fastlane/metadata/'));
  assert.ok(metaReads.every((p) => p.startsWith('fastlane/metadata/com.example.cardwallet/')));
  assert.ok(first.reads < 40, `${first.reads} reads`);

  clearRepoSnapshots();
  const second = new CountingRepo(files);
  const other = await listing(second, { autoTarget: 'app:com.example.documentscanner' });
  assert.equal(other.fastlane.roots.appStore, 'fastlane/metadata/com.example.documentscanner/ios');
  const reads = second.readPaths.filter((p) => p.startsWith('fastlane/metadata/'));
  assert.ok(reads.length > 0);
  assert.ok(reads.every((p) => p.startsWith('fastlane/metadata/com.example.documentscanner/')));
});

test('a request that timed out sends no further requests', async () => {
  clearRepoSnapshots();
  const repo = new CountingRepo(weatherApp(), 5);
  const controller = new AbortController();
  const snap = await openRepoSnapshot({
    repositoryId: 'r',
    connector: asConnector(repo),
    branch: 'main',
    now: Date.now,
    signal: controller.signal,
  });
  controller.abort();
  const before = repo.reads;
  await assert.rejects(() => snap.read('package.json'));
  assert.equal(repo.reads, before);
});

test('a connector that cannot name the commit still works, without a cache across requests', async () => {
  clearRepoSnapshots();
  const repo = new CountingRepo(mapsApp({ enChangelogs: 2, frChangelogs: 2 }), 0, false);
  const one = await listing(repo);
  const two = await listing(repo);
  assert.equal(one.fastlane.found.googlePlay, true);
  assert.equal(two.fastlane.found.googlePlay, true);
  assert.equal(repo.refs, 0);
  assert.equal(repo.trees, 2);
});

test('wall time drops with the request count (delayed fake, counts asserted)', async () => {
  const files = weatherApp();
  const t0 = Date.now();
  const before = new CountingRepo(files, 4);
  await listingBefore(before);
  const slow = Date.now() - t0;
  clearRepoSnapshots();
  const t1 = Date.now();
  const after = new CountingRepo(files, 4);
  await listing(after);
  const fast = Date.now() - t1;
  assert.ok(after.requests < before.requests / 5);
  // Not asserted tightly (timers vary); it only has to be faster, which the counts already say.
  assert.ok(fast < slow, `${fast} ms vs ${slow} ms`);
});
