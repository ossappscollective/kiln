import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ArtifactItem,
  type BuildsList,
  inspectSequentially,
  READ_FROM_CI_MAX,
  readRecentCiBuilds,
  stopStatus,
  unreadAndroidArtifacts,
} from './builds.ts';
import { readHintText, readOutcomeText, readProgressText } from './read-from-ci.ts';

const NOW = Date.UTC(2026, 10, 25, 12);
const DAY = 24 * 60 * 60_000;

const artifact = (id: string, over: Partial<ArtifactItem> = {}): ArtifactItem => ({
  id,
  name: 'android-release',
  kind: 'aab',
  guessed: true,
  platform: 'android',
  sizeBytes: 1000,
  expired: false,
  createdAt: NOW - Number(id) * DAY,
  expiresAt: NOW + 30 * DAY,
  downloadable: true,
  tooLarge: false,
  build: null,
  buildRead: null,
  sharedWith: null,
  run: {
    id: '1',
    number: 7,
    workflow: 'Android',
    title: null,
    branch: 'main',
    shortSha: 'abc1234',
    status: 'completed',
    conclusion: 'success',
    url: null,
  },
  ...over,
});

const list = (artifacts: ArtifactItem[], over: Partial<BuildsList> = {}): BuildsList => ({
  app: { id: 'a', name: 'Scanner', platform: 'android', identifier: 'com.acme.android' },
  repository: { id: 'r', owner: 'acme', repo: 'app' },
  artifacts,
  hiddenArtifacts: 0,
  truncated: false,
  store: [],
  testflight: null,
  problem: null,
  downloadEnabled: true,
  maxDownloadBytes: 500 * 1024 * 1024,
  canDownload: true,
  readAt: NOW,
  cached: false,
  ...over,
});

class Stop extends Error {
  status: number;
  constructor(status: number) {
    super(`status ${status}`);
    this.status = status;
  }
}

test('which CI files are opened: unread Android ones, newest first, at most the cap', () => {
  const many = Array.from({ length: 12 }, (_, i) => artifact(String(i + 1)));
  const picked = unreadAndroidArtifacts(list(many));
  assert.equal(picked.length, READ_FROM_CI_MAX);
  assert.deepEqual(
    picked.map((a) => a.id),
    ['1', '2', '3', '4', '5', '6', '7', '8'],
    'the newest (smallest age) first',
  );
  const mixed = list([
    artifact('1', { kind: 'ipa', platform: 'ios' }),
    artifact('2', { kind: 'dmg' }),
    artifact('3', { buildRead: 'unreadable' }),
    artifact('4', { expired: true, downloadable: false }),
    artifact('5', { kind: 'apk' }),
    artifact('6', { kind: 'zip', platform: null }),
  ]);
  assert.deepEqual(
    unreadAndroidArtifacts(mixed).map((a) => a.id),
    ['5', '6'],
  );
  assert.deepEqual(unreadAndroidArtifacts(list(many, { downloadEnabled: false })), []);
  assert.deepEqual(unreadAndroidArtifacts(list(many, { canDownload: false })), []);
  assert.equal(unreadAndroidArtifacts(list(many), 3).length, 3);
});

test('403, 409 and 429 are the statuses that end the reading; anything else skips the file', () => {
  for (const s of [403, 409, 429]) assert.equal(stopStatus(new Stop(s)), s);
  for (const s of [404, 410, 413, 500, 502]) assert.equal(stopStatus(new Stop(s)), null);
  assert.equal(stopStatus(new Error('network')), null);
  assert.equal(stopStatus(null), null);
});

test('the reader opens one file at a time, in order, and stops on a status that ends it', async () => {
  const queue = ['1', '2', '3', '4'].map((id) => artifact(id));
  let inFlight = 0;
  let peak = 0;
  const seen: string[] = [];
  const out = await inspectSequentially({
    next: () => queue.shift(),
    inspect: async (a) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      seen.push(a.id);
      if (a.id === '2') throw new Stop(500);
      if (a.id === '3') throw new Stop(429);
      return a;
    },
  });
  assert.equal(peak, 1, 'concurrency 1');
  assert.deepEqual(seen, ['1', '2', '3']);
  assert.deepEqual(out, { read: 1, failed: 1, stopped: 429 });
  assert.equal(queue.length, 1, 'the rest was not asked after the stop');
});

test('the reader stops when the view is gone', async () => {
  const queue = [artifact('1'), artifact('2')];
  let alive = true;
  const out = await inspectSequentially({
    alive: () => alive,
    next: () => queue.shift(),
    inspect: async (a) => {
      alive = false;
      return a;
    },
  });
  assert.equal(out.read, 1);
});

test('Read build info from CI: lists, reads the newest unread ones with progress, reports how many', async () => {
  const progress: string[] = [];
  const asked: string[] = [];
  const out = await readRecentCiBuilds({
    list: async () => list(['1', '2', '3'].map((id) => artifact(id))),
    inspect: async (id) => {
      asked.push(id);
      return { artifact: artifact(id, { buildRead: 'read' }) };
    },
    onProgress: (p) => progress.push(readProgressText(p)),
  });
  assert.deepEqual(asked, ['1', '2', '3']);
  assert.deepEqual(progress, ['Reading 1 of 3…', 'Reading 2 of 3…', 'Reading 3 of 3…']);
  assert.deepEqual(out, { read: 3, total: 3, failed: 0, stopped: null, problem: null });
  assert.equal(readOutcomeText(out).text, 'Read 3 of 3 CI builds.');
  assert.equal(readOutcomeText(out).tone, 'ok');
});

test('Read build info from CI: a 409 or 403 stops it and says why; nothing unread says so', async () => {
  for (const [status, text] of [
    [403, /Your role may not read CI builds/],
    [409, /switched off on this server \(KILN_BUILDS_DOWNLOAD_ENABLED\)/],
    [429, /Try again in a minute/],
  ] as const) {
    const asked: string[] = [];
    const out = await readRecentCiBuilds({
      list: async () => list(['1', '2', '3'].map((id) => artifact(id))),
      inspect: async (id) => {
        asked.push(id);
        throw new Stop(status);
      },
    });
    assert.deepEqual(asked, ['1'], 'the first refusal ends it');
    assert.equal(out.stopped, status);
    assert.match(readOutcomeText(out).text, text);
    assert.equal(readOutcomeText(out).tone, 'warn');
  }
  const none = await readRecentCiBuilds({
    list: async () => list([artifact('1', { buildRead: 'read' })]),
    inspect: async () => assert.fail('nothing to read'),
  });
  assert.equal(none.total, 0);
  assert.match(readOutcomeText(none).text, /no unread CI builds/i);
});

test('Read build info from CI: a list that cannot be read, a problem, downloads off', async () => {
  const failed = await readRecentCiBuilds({
    list: async () => {
      throw new Stop(502);
    },
    inspect: async () => assert.fail('no list, nothing to read'),
  });
  assert.equal(failed.problem, 'list');
  assert.match(readOutcomeText(failed).text, /could not be listed/);
  const trouble = await readRecentCiBuilds({
    list: async () =>
      list([artifact('1')], { problem: { reason: 'no_access', needs: 'actions: read' } }),
    inspect: async () => assert.fail('a problem'),
  });
  assert.equal(trouble.problem, 'list');
  const unlinked = await readRecentCiBuilds({
    list: async () => list([], { repository: null }),
    inspect: async () => assert.fail('no repository'),
  });
  assert.equal(unlinked.problem, 'list');
  const off = await readRecentCiBuilds({
    list: async () => list([artifact('1')], { downloadEnabled: false }),
    inspect: async () => assert.fail('switched off'),
  });
  assert.equal(off.problem, 'off');
  assert.match(readOutcomeText(off).text, /switched off on this server or not allowed/);
});

test('a file that fails to read is skipped and counted, and said', async () => {
  const out = await readRecentCiBuilds({
    list: async () => list(['1', '2'].map((id) => artifact(id))),
    inspect: async (id) => {
      if (id === '1') throw new Stop(502);
      return { artifact: artifact(id, { buildRead: 'read' }) };
    },
  });
  assert.deepEqual(out, { read: 1, total: 2, failed: 1, stopped: null, problem: null });
  const said = readOutcomeText(out);
  assert.equal(said.tone, 'warn');
  assert.equal(said.text, 'Read 1 of 2 CI builds. 1 could not be read.');
  assert.match(readHintText(), /up to 8/);
});
