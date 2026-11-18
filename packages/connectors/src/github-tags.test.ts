import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GithubError } from './errors.ts';
import { GithubRepoConnector } from './github.ts';

// Fixtures are hand-written from the GitHub REST documentation (tags, matching refs, git tags,
// commits, releases), never recorded from live GitHub.

type Call = { method: string; path: string; query: URLSearchParams; signal?: AbortSignal | null };

function fakeGithub(routes: Record<string, (query: URLSearchParams) => { status?: number; json?: unknown }>) {
  const calls: Call[] = [];
  const fetchFake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams, signal: init?.signal });
    const route = routes[url.pathname];
    if (!route) return new Response(JSON.stringify({ message: `no route ${url.pathname}` }), { status: 599 });
    const answer = route(url.searchParams);
    return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const connector = new GithubRepoConnector({
    owner: 'acme',
    repo: 'trail-notes',
    auth: { type: 'token', token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    fetch: fetchFake,
  });
  return { connector, calls };
}

const R = '/repos/acme/trail-notes';
const sha = (n: number) => n.toString(16).padStart(40, '0');

const tagItem = (name: string, n: number) => ({
  name,
  commit: { sha: sha(n), url: `https://api.github.com${R}/commits/${sha(n)}` },
  zipball_url: 'https://example.invalid/zip',
  tarball_url: 'https://example.invalid/tar',
  node_id: 'REF_x',
});

test('listTags maps names and commits, skips malformed entries, and sends only documented parameters', async () => {
  const { connector, calls } = fakeGithub({
    [`${R}/tags`]: () => ({
      json: [tagItem('ios/appstore/1.4.0/312', 1), tagItem('android/playstore/1.4.0/312', 2), { name: 'x' }, { commit: { sha: sha(3) } }, tagItem('bad', 0)].map((t) =>
        t.name === 'bad' ? { ...t, commit: { sha: 'nothex' } } : t,
      ),
    }),
  });
  const list = await connector.listTags();
  assert.deepEqual(list, {
    tags: [
      { name: 'ios/appstore/1.4.0/312', sha: sha(1) },
      { name: 'android/playstore/1.4.0/312', sha: sha(2) },
    ],
    truncated: false,
    pages: 1,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0]?.query.keys() ?? []].sort(), ['page', 'per_page']);
  assert.equal(calls[0]?.query.get('per_page'), '100');
});

test('listTags is bounded: it reads at most maxPages pages and says when there may be more', async () => {
  const { connector, calls } = fakeGithub({
    [`${R}/tags`]: (query) => {
      const page = Number(query.get('page'));
      return { json: Array.from({ length: 100 }, (_, i) => tagItem(`v1.${page}.${i}`, page * 1000 + i + 1)) };
    },
  });
  const list = await connector.listTags({ maxPages: 2 });
  assert.equal(list.tags.length, 200);
  assert.equal(list.truncated, true);
  assert.equal(list.pages, 2);
  assert.deepEqual(calls.map((c) => c.query.get('page')), ['1', '2']);
  // A page that is not full ends the read, whatever maxPages says; the limit itself is capped.
  const short = fakeGithub({ [`${R}/tags`]: () => ({ json: [tagItem('v1', 1)] }) });
  assert.equal((await short.connector.listTags({ maxPages: 99 })).truncated, false);
  const many = fakeGithub({ [`${R}/tags`]: () => ({ json: Array.from({ length: 100 }, (_, i) => tagItem(`t${i}`, i + 1)) }) });
  await many.connector.listTags({ maxPages: 99 });
  assert.equal(many.calls.length, 10, 'never more than 10 pages');
});

test('listTags passes the abort signal on and maps errors like the other reads', async () => {
  const { connector, calls } = fakeGithub({ [`${R}/tags`]: () => ({ json: [] }) });
  const controller = new AbortController();
  await connector.listTags({ signal: controller.signal });
  controller.abort();
  assert.equal(calls[0]?.signal?.aborted, true);
  await assert.rejects(connector.listTags({ signal: controller.signal }), (e: unknown) => e instanceof GithubError && e.kind === 'network');
  const denied = fakeGithub({ [`${R}/tags`]: () => ({ status: 403, json: { message: 'Resource not accessible' } }) });
  await assert.rejects(denied.connector.listTags(), (e: unknown) => e instanceof GithubError && e.kind === 'forbidden');
  const missing = fakeGithub({ [`${R}/tags`]: () => ({ status: 404, json: { message: 'Not Found' } }) });
  await assert.rejects(missing.connector.listTags(), (e: unknown) => e instanceof GithubError && e.kind === 'not_found');
});

const refItem = (name: string, n: number, type: 'commit' | 'tag' = 'commit') => ({
  ref: `refs/tags/${name}`,
  node_id: 'REF_y',
  url: `https://api.github.com${R}/git/refs/tags/${name}`,
  object: { type, sha: sha(n), url: `https://api.github.com${R}/git/${type}s/${sha(n)}` },
});

test('listMatchingTags lists refs under a prefix and follows annotated tags to their commit', async () => {
  const { connector, calls } = fakeGithub({
    [`${R}/git/matching-refs/tags/ios/appstore/`]: () => ({
      json: [refItem('ios/appstore/1.4.0/311', 1), refItem('ios/appstore/1.4.0/312', 900, 'tag')],
    }),
    [`${R}/git/tags/${sha(900)}`]: () => ({ json: { tag: 'x', sha: sha(900), object: { type: 'commit', sha: sha(2) } } }),
  });
  const list = await connector.listMatchingTags('ios/appstore/');
  assert.deepEqual(list, {
    tags: [
      { name: 'ios/appstore/1.4.0/311', sha: sha(1) },
      { name: 'ios/appstore/1.4.0/312', sha: sha(2), annotated: true },
    ],
    truncated: false,
    pages: 1,
    unresolved: 0,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.query.size, 0, 'no undocumented parameter is sent');
});

test('listMatchingTags: nested annotated tags, a resolve budget, a result limit, a tag that points at a tree', async () => {
  const { connector } = fakeGithub({
    [`${R}/git/matching-refs/tags/v`]: () => ({
      json: [refItem('v1', 10, 'tag'), refItem('v2', 20, 'tag'), refItem('v3', 3), refItem('v4', 40, 'tag')],
    }),
    // v1 is a tag of a tag of a commit.
    [`${R}/git/tags/${sha(10)}`]: () => ({ json: { object: { type: 'tag', sha: sha(11) } } }),
    [`${R}/git/tags/${sha(11)}`]: () => ({ json: { object: { type: 'commit', sha: sha(1) } } }),
    [`${R}/git/tags/${sha(20)}`]: () => ({ json: { object: { type: 'tree', sha: sha(2) } } }),
    [`${R}/git/tags/${sha(40)}`]: () => ({ json: { object: { type: 'commit', sha: sha(4) } } }),
  });
  const list = await connector.listMatchingTags('v', { resolveLimit: 3 });
  assert.deepEqual(
    list.tags.map((t) => [t.name, t.sha]),
    [['v1', sha(1)], ['v3', sha(3)]],
  );
  assert.equal(list.unresolved, 2, 'v2 points at a tree and v4 is past the budget');
  const limited = await connector.listMatchingTags('v', { limit: 1, resolveLimit: 10 });
  assert.equal(limited.tags.length, 1);
  assert.equal(limited.truncated, true);
});

test('listMatchingTags refuses a bad prefix before any request', async () => {
  const { connector, calls } = fakeGithub({});
  for (const prefix of ['a/../b', 'x'.repeat(201), 'a\u0000b', 'a\\b']) {
    await assert.rejects(connector.listMatchingTags(prefix), (e: unknown) => e instanceof GithubError && e.kind === 'invalid_input', prefix);
  }
  assert.equal(calls.length, 0);
});

const commitFixture = (n: number, parents: number[]) => ({
  sha: sha(n),
  html_url: `https://github.com/acme/trail-notes/commit/${sha(n)}`,
  parents: parents.map((p) => ({ sha: sha(p), url: 'u', html_url: 'h' })),
  commit: {
    message: 'chore: new build\n\nbody',
    author: { name: 'github-actions', date: '2026-03-01T10:05:00Z' },
    committer: { name: 'GitHub', date: '2026-03-01T10:05:07Z' },
  },
  files: [],
});

test('getCommit maps date, parents, message and author; 404 and 422 are "no such commit"', async () => {
  const { connector, calls } = fakeGithub({
    [`${R}/commits/${sha(5)}`]: () => ({ json: commitFixture(5, [4, 3]) }),
    [`${R}/commits/${sha(6)}`]: () => ({ status: 404, json: { message: 'Not Found' } }),
    [`${R}/commits/${sha(7)}`]: () => ({ status: 422, json: { message: 'No commit found for SHA' } }),
    [`${R}/commits/tags/ios/appstore/1.4.0/312`]: () => ({ json: commitFixture(8, [5]) }),
  });
  const commit = await connector.getCommit(sha(5));
  assert.deepEqual(commit, {
    sha: sha(5),
    message: 'chore: new build\n\nbody',
    author: 'github-actions',
    date: Date.UTC(2026, 2, 1, 10, 5, 0),
    url: `https://github.com/acme/trail-notes/commit/${sha(5)}`,
    parents: [sha(4), sha(3)],
    committedAt: Date.UTC(2026, 2, 1, 10, 5, 7),
  });
  assert.equal(calls[0]?.query.get('per_page'), '1');
  assert.equal(await connector.getCommit(sha(6)), undefined);
  assert.equal(await connector.getCommit(sha(7)), undefined);
  assert.equal((await connector.getCommit('tags/ios/appstore/1.4.0/312'))?.sha, sha(8));
  await assert.rejects(connector.getCommit('a..b'), (e: unknown) => e instanceof GithubError && e.kind === 'invalid_input');
  await assert.rejects(connector.getCommit(''), (e: unknown) => e instanceof GithubError && e.kind === 'invalid_input');
});

test('getCommit reports other errors, with the token redacted', async () => {
  const { connector } = fakeGithub({
    [`${R}/commits/${sha(9)}`]: () => ({ status: 500, json: { message: 'boom ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }),
  });
  await assert.rejects(connector.getCommit(sha(9)), (e: unknown) => {
    return e instanceof GithubError && e.kind === 'server' && !e.message.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

const releaseItem = (id: number, tag: string, name: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  tag_name: tag,
  name,
  target_commitish: 'main',
  draft: false,
  prerelease: false,
  created_at: '2026-03-01T10:00:00Z',
  published_at: '2026-03-01T10:20:00Z',
  html_url: `https://github.com/acme/trail-notes/releases/tag/${tag}`,
  ...extra,
});

test('listReleases maps name, tag, target, times and flags; entries without a tag are skipped', async () => {
  const { connector, calls } = fakeGithub({
    [`${R}/releases`]: () => ({
      json: [
        releaseItem(1, 'ios/appstore/1.4.0/312', 'Trail Notes(ios): v1.4.0 Build 312'),
        releaseItem(2, 'android/github/1.4.0/312', null, { draft: true, prerelease: true, published_at: null, target_commitish: sha(5) }),
        { id: 3, name: 'no tag' },
      ],
    }),
  });
  const list = await connector.listReleases();
  assert.equal(list.releases.length, 2);
  assert.deepEqual(list.releases[0], {
    id: '1',
    tagName: 'ios/appstore/1.4.0/312',
    name: 'Trail Notes(ios): v1.4.0 Build 312',
    targetCommitish: 'main',
    draft: false,
    prerelease: false,
    createdAt: Date.UTC(2026, 2, 1, 10, 0, 0),
    publishedAt: Date.UTC(2026, 2, 1, 10, 20, 0),
    url: 'https://github.com/acme/trail-notes/releases/tag/ios/appstore/1.4.0/312',
  });
  assert.equal(list.releases[1]?.name, undefined);
  assert.equal(list.releases[1]?.draft, true);
  assert.equal(list.releases[1]?.publishedAt, undefined);
  assert.equal(list.releases[1]?.targetCommitish, sha(5));
  assert.equal(list.truncated, false);
  assert.deepEqual([...calls[0]?.query.keys() ?? []].sort(), ['page', 'per_page']);
});

test('listReleases is bounded by maxPages', async () => {
  const { connector, calls } = fakeGithub({
    [`${R}/releases`]: (query) =>
      ({ json: Array.from({ length: 100 }, (_, i) => releaseItem(Number(query.get('page')) * 1000 + i, `v${i}`, null)) }),
  });
  const list = await connector.listReleases({ maxPages: 2 });
  assert.equal(list.releases.length, 200);
  assert.equal(list.truncated, true);
  assert.equal(calls.length, 2);
});
