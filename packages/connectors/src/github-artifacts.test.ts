import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GithubError } from './errors.ts';
import { GithubRepoConnector, isSafeRedirectTarget } from './github.ts';

// Fixtures are hand-written from the GitHub REST documentation ("Artifacts"), never recorded from live GitHub.

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
type Seen = { url: string; authorization: string | null; redirect: string | undefined };

function connector(answer: (url: URL, seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetchFake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const entry = {
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      redirect: init?.redirect,
    };
    seen.push(entry);
    return answer(url, entry);
  };
  return {
    seen,
    c: new GithubRepoConnector({
      owner: 'acme',
      repo: 'app',
      auth: { type: 'token', token: TOKEN },
      fetch: fetchFake,
    }),
  };
}

const artifactJson = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  node_id: 'x',
  name: `build-${id}`,
  size_in_bytes: 1234,
  url: 'https://api.github.com/x',
  archive_download_url: `https://api.github.com/repos/acme/app/actions/artifacts/${id}/zip`,
  expired: false,
  created_at: '2026-11-01T10:00:00Z',
  expires_at: '2027-01-30T10:00:00Z',
  digest: 'sha256:abc',
  workflow_run: { id: 77, head_branch: 'main', head_sha: 'a'.repeat(40) },
  ...extra,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

test('listArtifacts maps the fields, drops the download address and reads the ETag', async () => {
  const { c, seen } = connector(() =>
    json(
      {
        total_count: 2,
        artifacts: [artifactJson(1), artifactJson(2, { expired: true }), { name: 'no id' }],
      },
      200,
      { etag: 'W/"e1"' },
    ),
  );
  const list = await c.listArtifacts();
  assert.equal(list.artifacts.length, 2);
  assert.deepEqual(list.artifacts[0], {
    id: '1',
    name: 'build-1',
    sizeInBytes: 1234,
    expired: false,
    createdAt: Date.parse('2026-11-01T10:00:00Z'),
    expiresAt: Date.parse('2027-01-30T10:00:00Z'),
    runId: '77',
    headBranch: 'main',
    headSha: 'a'.repeat(40),
    digest: 'sha256:abc',
  });
  assert.equal(list.artifacts[1]?.expired, true);
  assert.equal(list.etag, 'W/"e1"');
  assert.ok(!JSON.stringify(list).includes('archive_download_url'));
  assert.match(seen[0]?.url ?? '', /\/repos\/acme\/app\/actions\/artifacts\?per_page=100&page=1$/);
});

test('listArtifacts of one run uses the run path, rejects an id that is not a number, and answers 304', async () => {
  const { c, seen } = connector((_u, s) =>
    s.url.includes('/runs/') ? new Response(null, { status: 304 }) : json({}),
  );
  assert.deepEqual((await c.listArtifacts({ runId: '77', etag: 'W/"e1"' })).notModified, true);
  assert.match(seen[0]?.url ?? '', /\/actions\/runs\/77\/artifacts/);
  await assert.rejects(
    () => c.listArtifacts({ runId: '../x' }),
    (e: unknown) => e instanceof GithubError && e.kind === 'invalid_input',
  );
});

test('listArtifacts pages up to maxPages and says when it stopped early', async () => {
  const page = (n: number) => Array.from({ length: 100 }, (_, i) => artifactJson(n * 1000 + i));
  const { c, seen } = connector((u) =>
    json({ total_count: 450, artifacts: page(Number(u.searchParams.get('page'))) }),
  );
  const list = await c.listArtifacts({ maxPages: 2 });
  assert.equal(list.artifacts.length, 200);
  assert.equal(list.truncated, true);
  assert.equal(seen.length, 2);
});

test('download: the 302 is followed WITHOUT the credential, and the body is returned unread', async () => {
  const { c, seen } = connector((u) =>
    u.hostname === 'api.github.com'
      ? new Response(null, {
          status: 302,
          headers: { location: 'https://pipelines.example-blob.net/a/b.zip?sig=short-lived' },
        })
      : new Response('ZIPDATA', { status: 200, headers: { 'content-length': '7' } }),
  );
  const got = await c.openArtifactDownload('9');
  assert.equal(got.status, 'ok');
  if (got.status !== 'ok') return;
  assert.equal(got.contentLength, 7);
  assert.equal(await new Response(got.body).text(), 'ZIPDATA');
  assert.equal(seen[0]?.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0]?.redirect, 'manual');
  assert.equal(
    seen[1]?.authorization,
    null,
    'the storage address is fetched without the GitHub token',
  );
  assert.match(seen[0]?.url ?? '', /\/repos\/acme\/app\/actions\/artifacts\/9\/zip$/);
});

test('download: 410 is gone, 404 is missing, storage 404/410 is gone', async () => {
  assert.deepEqual(
    await connector(() => new Response(null, { status: 410 })).c.openArtifactDownload('1'),
    { status: 'gone' },
  );
  assert.deepEqual(
    await connector(() => json({ message: 'Not Found' }, 404)).c.openArtifactDownload('1'),
    { status: 'missing' },
  );
  const expired = connector((u) =>
    u.hostname === 'api.github.com'
      ? new Response(null, { status: 302, headers: { location: 'https://blob.example.net/x' } })
      : new Response('gone', { status: 404 }),
  );
  assert.deepEqual(await expired.c.openArtifactDownload('1'), { status: 'gone' });
});

test('download: a redirect to a private, plain http or address target is refused and never fetched; hops are capped', async () => {
  for (const location of [
    'http://blob.example.net/x',
    'https://169.254.169.254/latest',
    'https://localhost/x',
    'https://intranet/x',
    'https://[::1]/x',
    'https://svc.internal/x',
  ]) {
    const { c, seen } = connector(() => new Response(null, { status: 302, headers: { location } }));
    await assert.rejects(
      () => c.openArtifactDownload('1'),
      (e: unknown) => e instanceof GithubError,
      location,
    );
    assert.equal(seen.length, 1, `${location} was not fetched`);
  }
  const loop = connector(
    (u) =>
      new Response(null, {
        status: 302,
        headers: { location: `https://blob.example.net/${u.pathname.length + 1}` },
      }),
  );
  await assert.rejects(() => loop.c.openArtifactDownload('1'), /too many times/);
  assert.equal(loop.seen.length, 4, 'the API call plus three hops');
  await assert.rejects(
    () => connector(() => json({})).c.openArtifactDownload('../1'),
    (e: unknown) => e instanceof GithubError && e.kind === 'invalid_input',
  );
});

test("download: a refusal names GitHub's permission without leaking the token", async () => {
  const { c } = connector(() =>
    json({ message: 'Resource not accessible by integration' }, 403, {
      'x-accepted-github-permissions': 'actions=read',
    }),
  );
  await assert.rejects(
    () => c.openArtifactDownload('1'),
    (e: unknown) =>
      e instanceof GithubError &&
      e.kind === 'forbidden' &&
      /actions=read/.test(e.message) &&
      !e.message.includes(TOKEN),
  );
});

test('isSafeRedirectTarget', () => {
  assert.equal(
    isSafeRedirectTarget(new URL('https://productionresultssa1.blob.core.windows.net/x?sig=1')),
    true,
  );
  assert.equal(isSafeRedirectTarget(new URL('http://blob.example.net/x')), false);
  assert.equal(isSafeRedirectTarget(new URL('http://blob.example.net/x'), true), true);
  assert.equal(isSafeRedirectTarget(new URL('https://10.0.0.1/x')), false);
});
