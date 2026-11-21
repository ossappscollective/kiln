import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import type { ChangeSet } from '@kiln/core';
import {
  BranchExistsError,
  BranchMissingError,
  BranchMovedError,
  ChangeConflictError,
  DefaultBranchError,
  GithubError,
  GithubRateLimitError,
  PullRequestFailedError,
  redactSecrets,
} from '../errors.ts';
import * as fx from './github.fixtures.ts';
import {
  GithubRepoConnector,
  type GithubRepoConnectorOptions,
  githubAuthFromSecret,
} from './github.ts';

// ---------------------------------------------------------------------------------------------
// Harness: a fake `fetch` that answers from fixtures and records what it was asked.

type Call = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: request bodies are inspected loosely in tests
  body: any;
};
type Route = {
  method: string;
  path: string;
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
  /** Answer this many requests, then fall through to the next matching route. */
  times?: number;
  query?: Record<string, string>;
};

const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const TOKEN = 'ghs_16C7e42F292c6912E7710c838347Ae178B4a';

class Fake {
  readonly calls: Call[] = [];
  readonly unexpected: string[] = [];
  readonly routes: (Route & { used: number })[] = [];
  now = T0;
  mints = 0;

  constructor() {
    this.on({
      method: 'POST',
      path: '/app/installations/42/access_tokens',
      status: 201,
      json: fx.installationToken(TOKEN, iso(T0 + HOUR)),
    });
  }

  on(route: Route) {
    this.routes.push({ ...route, used: 0 });
    return this;
  }

  /** Replaces the routes for one method and path. */
  replace(route: Route) {
    const index = this.routes.findIndex((r) => r.method === route.method && r.path === route.path);
    if (index >= 0) this.routes.splice(index, 1);
    return this.on(route);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path: url.pathname, query: url.searchParams, headers, body });
    if (url.pathname.endsWith('/access_tokens')) this.mints++;
    const route = this.routes.find(
      (r) =>
        r.method === method &&
        r.path === url.pathname &&
        (r.times === undefined || r.used < r.times) &&
        Object.entries(r.query ?? {}).every(([k, v]) => url.searchParams.get(k) === v),
    );
    if (!route) {
      this.unexpected.push(`${method} ${url.pathname}${url.search}`);
      return new Response(JSON.stringify({ message: 'UNEXPECTED REQUEST' }), { status: 599 });
    }
    route.used++;
    const status = route.status ?? 200;
    const empty = status === 204 || route.json === undefined;
    return new Response(empty ? null : JSON.stringify(route.json), {
      status,
      headers: { 'content-type': 'application/json', ...route.headers },
    });
  };

  /** Requests of one kind, in order. */
  to(method: string, pathPart: string) {
    return this.calls.filter((c) => c.method === method && c.path.includes(pathPart));
  }

  /** Writes to the repository, not counting token requests. */
  get writes() {
    return this.calls.filter((c) => c.method === 'POST' && !c.path.includes('access_tokens'));
  }

  assertClean() {
    assert.deepEqual(this.unexpected, []);
  }
}

const { privateKey: PKCS8, publicKey: PUBLIC } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const make = (fake: Fake, extra: Partial<GithubRepoConnectorOptions> = {}) =>
  new GithubRepoConnector({
    owner: 'acme',
    repo: 'trail-notes',
    auth: { type: 'app', appId: '12345', installationId: '42', privateKey: PKCS8 },
    fetch: fake.fetch,
    now: () => fake.now,
    ...extra,
  });

const R = '/repos/acme/trail-notes';

/** The routes a connector needs to resolve the default branch to a commit. */
const withDefaultBranch = (fake: Fake, branch = 'main') =>
  fake
    .on({ method: 'GET', path: R, json: fx.repo(branch) })
    .on({
      method: 'GET',
      path: `${R}/git/ref/heads/${branch}`,
      json: fx.ref(`heads/${branch}`, fx.SHA_BASE),
    })
    .on({
      method: 'GET',
      path: `${R}/git/commits/${fx.SHA_BASE}`,
      json: fx.commit(fx.SHA_BASE, fx.SHA_TREE),
    });

const rejects = async (promise: Promise<unknown>, check: (error: any) => void) => {
  try {
    await promise;
  } catch (error) {
    check(error);
    return;
  }
  assert.fail('expected a rejection');
};

// ---------------------------------------------------------------------------------------------
// Authentication

test('the app JWT is RS256, signed with the key, issued a minute in the past', async () => {
  const fake = new Fake();
  withDefaultBranch(fake);
  await make(fake).defaultBranch();
  const mint = fake.to('POST', '/access_tokens')[0];
  assert.ok(mint);
  const jwt = (mint.headers.get('authorization') ?? '').replace('Bearer ', '');
  const [h, p, s] = jwt.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), {
    alg: 'RS256',
    typ: 'JWT',
  });
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.iss, '12345');
  assert.equal(claims.iat, T0 / 1000 - 60);
  assert.ok(claims.exp - T0 / 1000 <= 600, 'exp is at most 10 minutes ahead');
  const signed = Buffer.from(`${h}.${p}`);
  assert.ok(verify('RSA-SHA256', signed, createPublicKey(PUBLIC), Buffer.from(s, 'base64url')));
});

test('a PKCS#1 key (BEGIN RSA PRIVATE KEY) works too', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  assert.match(privateKey, /BEGIN RSA PRIVATE KEY/);
  const fake = new Fake();
  withDefaultBranch(fake);
  const auth = { type: 'app', appId: '1', installationId: '42', privateKey } as const;
  assert.equal(await make(fake, { auth }).defaultBranch(), 'main');
});

test('the installation token is scoped to the repository, used for calls, and cached', async () => {
  const fake = new Fake();
  withDefaultBranch(fake);
  const connector = make(fake);
  await connector.defaultBranch();
  assert.deepEqual(fake.to('POST', '/access_tokens')[0]?.body, { repositories: ['trail-notes'] });
  const api = fake.to('GET', R)[0];
  assert.equal(api?.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(api?.headers.get('x-github-api-version'), '2022-11-28');
  assert.equal(api?.headers.get('accept'), 'application/vnd.github+json');
  assert.ok(api?.headers.get('user-agent'));
  fake.now += 30 * 60_000;
  await connector.listFiles().catch(() => {});
  assert.equal(fake.mints, 1);
});

test('installationToken() hands out the cached token, mints once, and honours an aborted signal', async () => {
  const fake = new Fake();
  withDefaultBranch(fake);
  const connector = make(fake);
  const [a, b] = await Promise.all([connector.installationToken(), connector.installationToken()]);
  assert.equal(a, TOKEN);
  assert.equal(b, TOKEN);
  assert.equal(fake.mints, 1);
  // The same token the API calls use: no second mint.
  await connector.defaultBranch();
  assert.equal(await connector.installationToken(), TOKEN);
  assert.equal(fake.mints, 1);
  const stopped = new AbortController();
  stopped.abort();
  await rejects(connector.installationToken(stopped.signal), (e) =>
    assert.equal(e.kind, 'network'),
  );
  // A personal access token is returned as it is, with no request.
  const pat = new Fake();
  const withPat = make(pat, { auth: { type: 'token', token: 'ghp_personal_token_value' } });
  assert.equal(await withPat.installationToken(), 'ghp_personal_token_value');
  assert.equal(pat.calls.length, 0);
});

test('the token is renewed a minute before it expires, once for concurrent calls', async () => {
  const fake = new Fake();
  withDefaultBranch(fake);
  const connector = make(fake);
  await connector.defaultBranch();
  assert.equal(fake.mints, 1);
  fake.now = T0 + HOUR - 61_000; // 61 s left: still fine
  await connector.readFile('a.txt').catch(() => {});
  assert.equal(fake.mints, 1);
  fake.now = T0 + HOUR - 59_000; // inside the margin
  await Promise.all([connector.readFile('a.txt'), connector.readFile('b.txt')]).catch(() => {});
  assert.equal(fake.mints, 2);
});

test('a 401 on a call renews the token once and retries; a second 401 is an auth error', async () => {
  const fake = new Fake();
  fake.on({ method: 'GET', path: R, status: 401, json: { message: 'Bad credentials' }, times: 1 });
  fake.on({ method: 'GET', path: R, json: fx.repo() });
  assert.equal(await make(fake).defaultBranch(), 'main');
  assert.equal(fake.mints, 2);

  const denied = new Fake();
  denied.on({ method: 'GET', path: R, status: 401, json: { message: 'Bad credentials' } });
  await rejects(make(denied).defaultBranch(), (e) => {
    assert.equal(e.kind, 'auth');
    assert.equal(e.status, 401);
  });
  assert.equal(denied.mints, 2);
});

test('token exchange failures say what to check, without echoing credentials', async () => {
  const cases: [number, RegExp][] = [
    [401, /App ID, the private key and the server clock/],
    [404, /installation not found/],
    [422, /part of the installation/],
  ];
  for (const [status, expected] of cases) {
    const fake = new Fake();
    fake.replace({
      method: 'POST',
      path: '/app/installations/42/access_tokens',
      status,
      json: { message: 'x' },
    });
    await rejects(make(fake).defaultBranch(), (e) => {
      assert.equal(e.kind, 'auth');
      assert.match(e.message, expected);
      assert.doesNotMatch(e.message, /eyJ|BEGIN/);
    });
  }
});

test('a personal access token is sent as is and never exchanged', async () => {
  const fake = new Fake();
  fake.on({ method: 'GET', path: R, json: fx.repo() });
  const token = 'github_pat_11AAAAAAA0abcdefghijklmnop';
  await make(fake, { auth: { type: 'token', token } }).defaultBranch();
  assert.equal(fake.mints, 0);
  assert.equal(fake.calls[0]?.headers.get('authorization'), `Bearer ${token}`);
});

test('a private key that cannot be read fails early, without quoting the key', () => {
  const fake = new Fake();
  const secret =
    '-----BEGIN PRIVATE KEY-----\nTOPSECRETTOPSECRETTOPSECRET\n-----END PRIVATE KEY-----';
  const asApp = (privateKey: string) =>
    ({ type: 'app', appId: '1', installationId: '42', privateKey }) as const;
  assert.throws(
    () => make(fake, { auth: asApp(secret) }),
    (e: any) => e.kind === 'invalid_input' && !e.message.includes('TOPSECRET'),
  );
  const { privateKey: ec } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  assert.throws(() => make(fake, { auth: asApp(ec) }), /RSA key/);
});

test('githubAuthFromSecret reads the stored credential kinds', () => {
  const stored = JSON.stringify({ appId: ' 1 ', installationId: '2', privateKey: PKCS8 });
  assert.deepEqual(githubAuthFromSecret('github_app', stored), {
    type: 'app',
    appId: '1',
    installationId: '2',
    privateKey: PKCS8,
  });
  assert.deepEqual(githubAuthFromSecret('github_token', ' ghp_abc \n'), {
    type: 'token',
    token: 'ghp_abc',
  });
  assert.throws(() => githubAuthFromSecret('github_app', '{"appId":"1"}'), GithubError);
});

test('redactSecrets removes tokens, JWTs, private keys and known strings', () => {
  const text = [
    `token ${TOKEN}`,
    'github_pat_11AAAAAAA0abcdefghijklmnop',
    'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2lnbmF0dXJlc2lnbg',
    '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    'my-known-secret-value',
  ].join(' | ');
  const out = redactSecrets(text, ['my-known-secret-value']);
  for (const leaked of [TOKEN, 'github_pat', 'eyJhbGci', 'PRIVATE KEY', 'known-secret']) {
    assert.ok(!out.includes(leaked), leaked);
  }
});

test('error messages never carry a token, even when GitHub echoes one', async () => {
  const fake = new Fake();
  fake.on({
    method: 'GET',
    path: `${R}/contents/x.txt`,
    status: 403,
    json: { message: `Bad token ${TOKEN} for you` },
  });
  await rejects(make(fake).readFile('x.txt'), (e) => {
    assert.equal(e.kind, 'forbidden');
    assert.ok(!e.message.includes(TOKEN));
    assert.ok(!JSON.stringify(e).includes(TOKEN));
  });
});

// ---------------------------------------------------------------------------------------------
// listFiles

const listingTree = (sha = fx.SHA_TREE) => fx.tree(sha, [{ path: 'a.txt', sha: 's' }]);

test('listFiles resolves the default branch to a commit and lists blobs only, sorted', async () => {
  const fake = new Fake();
  withDefaultBranch(fake).on({
    method: 'GET',
    path: `${R}/git/trees/${fx.SHA_BASE}`,
    query: { recursive: '1' },
    json: fx.tree(fx.SHA_TREE, [
      { path: 'package.json', sha: 's1' },
      { path: 'fastlane', type: 'tree', mode: '040000', sha: 's2' },
      { path: 'fastlane/metadata/en-US/name.txt', sha: 's3' },
      { path: 'fastlane/Fastfile', sha: 's4' },
      { path: 'vendor/lib', type: 'commit', mode: '160000', sha: 's5' },
    ]),
  });
  assert.deepEqual(await make(fake).listFiles(), [
    'fastlane/Fastfile',
    'fastlane/metadata/en-US/name.txt',
    'package.json',
  ]);
  fake.assertClean();
});

test('listFiles walks folder by folder when GitHub truncates the recursive listing', async () => {
  const fake = new Fake();
  const dir = (path: string, sha: string) => ({ path, type: 'tree' as const, mode: '040000', sha });
  withDefaultBranch(fake)
    .on({
      method: 'GET',
      path: `${R}/git/trees/${fx.SHA_BASE}`,
      query: { recursive: '1' },
      json: fx.tree(fx.SHA_TREE, [{ path: 'package.json', sha: 's1' }], true),
    })
    .on({
      method: 'GET',
      path: `${R}/git/trees/${fx.SHA_BASE}`,
      json: fx.tree(fx.SHA_TREE, [{ path: 'package.json', sha: 's1' }, dir('fastlane', 'tf')]),
    })
    .on({
      method: 'GET',
      path: `${R}/git/trees/tf`,
      json: fx.tree('tf', [{ path: 'Fastfile', sha: 's4' }, dir('metadata', 'tm')]),
    })
    .on({
      method: 'GET',
      path: `${R}/git/trees/tm`,
      json: fx.tree('tm', [{ path: 'copyright.txt', sha: 's6' }]),
    });
  assert.deepEqual(await make(fake).listFiles(), [
    'fastlane/Fastfile',
    'fastlane/metadata/copyright.txt',
    'package.json',
  ]);
  fake.assertClean();
});

test('listFiles accepts a branch with a slash, a tag, an annotated tag and a sha', async () => {
  const fake = new Fake();
  const notFound = { message: 'Not Found' };
  fake
    .on({
      method: 'GET',
      path: `${R}/git/ref/heads/release/1.2`,
      json: fx.ref('heads/release/1.2', fx.SHA_BASE),
    })
    .on({ method: 'GET', path: `${R}/git/ref/heads/v1`, status: 404, json: notFound })
    .on({ method: 'GET', path: `${R}/git/ref/tags/v1`, json: fx.ref('tags/v1', 'tagobj', 'tag') })
    .on({
      method: 'GET',
      path: `${R}/git/tags/tagobj`,
      json: { object: { type: 'commit', sha: fx.SHA_NEW_COMMIT } },
    })
    .on({ method: 'GET', path: `${R}/git/trees/${fx.SHA_BASE}`, json: listingTree() })
    .on({ method: 'GET', path: `${R}/git/trees/${fx.SHA_NEW_COMMIT}`, json: listingTree() })
    .on({ method: 'GET', path: `${R}/git/trees/${fx.SHA_TREE}`, json: listingTree() });
  const connector = make(fake);
  assert.deepEqual(await connector.listFiles('release/1.2'), ['a.txt']);
  assert.deepEqual(await connector.listFiles('v1'), ['a.txt']);
  assert.deepEqual(await connector.listFiles('refs/heads/release/1.2'), ['a.txt']);
  assert.deepEqual(await connector.listFiles(fx.SHA_TREE), ['a.txt']);
  fake.assertClean();
});

test('listFiles on a ref that does not exist is a not_found error', async () => {
  const fake = new Fake();
  const notFound = { message: 'Not Found' };
  fake
    .on({ method: 'GET', path: `${R}/git/ref/heads/nope`, status: 404, json: notFound })
    .on({ method: 'GET', path: `${R}/git/ref/tags/nope`, status: 404, json: notFound });
  await rejects(make(fake).listFiles('nope'), (e) => {
    assert.equal(e.kind, 'not_found');
    assert.match(e.message, /nope/);
  });
});

// ---------------------------------------------------------------------------------------------
// readFile

test('readFile decodes base64 that GitHub wrapped across lines', async () => {
  const fake = new Fake();
  const path = 'fastlane/metadata/en-US/description.txt';
  const content = `${'Line of the description. '.repeat(10)}\nSecond line: café, 日本語.\n`;
  fake.on({
    method: 'GET',
    path: `${R}/contents/${path}`,
    query: { ref: 'main' },
    json: fx.file(path, content, 's1'),
  });
  assert.equal(await make(fake).readFile(path, 'main'), content);
});

test('readFile returns undefined for a missing file, a folder and a symlink', async () => {
  const fake = new Fake();
  fake
    .on({
      method: 'GET',
      path: `${R}/contents/missing.txt`,
      status: 404,
      json: { message: 'Not Found' },
    })
    .on({
      method: 'GET',
      path: `${R}/contents/fastlane`,
      json: [{ type: 'file', name: 'Fastfile' }],
    })
    .on({ method: 'GET', path: `${R}/contents/link`, json: { type: 'symlink', target: 'x' } });
  const connector = make(fake);
  assert.equal(await connector.readFile('missing.txt'), undefined);
  assert.equal(await connector.readFile('fastlane'), undefined);
  assert.equal(await connector.readFile('link'), undefined);
});

test('readFile on a ref that does not exist is an error, not "no such file"', async () => {
  const fake = new Fake();
  fake.on({
    method: 'GET',
    path: `${R}/contents/a.txt`,
    status: 404,
    json: { message: 'No commit found for the ref nope' },
  });
  await rejects(make(fake).readFile('a.txt', 'nope'), (e) => assert.equal(e.kind, 'not_found'));
});

test('readFile uses the blob API when the contents API leaves content empty (over 1 MB)', async () => {
  const fake = new Fake();
  const big = `${'x'.repeat(1_200_000)}\n`;
  fake
    .on({
      method: 'GET',
      path: `${R}/contents/big.txt`,
      json: fx.largeFile('big.txt', big.length, 'bigsha'),
    })
    .on({ method: 'GET', path: `${R}/git/blobs/bigsha`, json: fx.blob(big) });
  assert.equal(await make(fake).readFile('big.txt'), big);
  fake.assertClean();
});

test('readFile refuses files over the size limit and files that are not UTF-8', async () => {
  const fake = new Fake();
  fake
    .on({
      method: 'GET',
      path: `${R}/contents/huge.bin`,
      json: fx.largeFile('huge.bin', 50_000_000, 'h'),
    })
    .on({
      method: 'GET',
      path: `${R}/contents/icon.png`,
      json: {
        ...fx.file('icon.png', 'x', 'p'),
        content: Buffer.from([0x89, 0x50, 0xff, 0xfe]).toString('base64'),
      },
    });
  const connector = make(fake);
  await rejects(connector.readFile('huge.bin'), (e) => assert.equal(e.kind, 'too_large'));
  await rejects(connector.readFile('icon.png'), (e) => assert.equal(e.kind, 'not_text'));
});

test('readFile keeps a leading BOM, and encodes spaces and unicode in the path', async () => {
  const fake = new Fake();
  fake.on({
    method: 'GET',
    path: `${R}/contents/fastlane/metadata/ja/caf%C3%A9%20notes.txt`,
    json: { ...fx.file('x', 'x', 's'), content: Buffer.from('﻿hello').toString('base64') },
  });
  assert.equal(await make(fake).readFile('fastlane/metadata/ja/café notes.txt'), '﻿hello');
  fake.assertClean();
});

test('readFile rejects paths that escape or are malformed', async () => {
  const connector = make(new Fake());
  const bad = ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', '.git/config', 'a/.git/x'];
  for (const path of bad) {
    await rejects(connector.readFile(path), (e) => assert.equal(e.kind, 'invalid_input'));
  }
});

// ---------------------------------------------------------------------------------------------
// propose

const changeSet = (files: ChangeSet['files'], extra: Partial<ChangeSet> = {}): ChangeSet => ({
  id: 'cs_1',
  workspaceId: 'ws_1',
  summary: 'Update the en-US listing',
  target: 'repo',
  status: 'approved',
  createdBy: { type: 'user', id: 'u_1' },
  files,
  ...extra,
});

/** What git would call a blob: the sha the tree API reports for this content. */
const gitBlob = (content: string) => {
  const bytes = Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};

const NAME = 'fastlane/metadata/en-US/name.txt';
const KEYWORDS = 'fastlane/metadata/en-US/keywords.txt';
const OLD = 'fastlane/metadata/en-US/subtitle.txt';
const BRANCH = 'listing/en-US';

/** A repository with two listing files, an executable script and a symlink. */
const baseTree = () =>
  fx.tree(fx.SHA_TREE, [
    { path: NAME, sha: gitBlob('Trail Notes\n') },
    { path: OLD, sha: gitBlob('Hike, log, share\n') },
    { path: 'bin/release.sh', mode: '100755', sha: gitBlob('#!/bin/sh\n') },
    { path: 'docs/link', mode: '120000', sha: 'linksha' },
  ]);

const proposeRoutes = (fake: Fake) =>
  withDefaultBranch(fake)
    .on({
      method: 'GET',
      path: `${R}/git/ref/heads/${BRANCH}`,
      status: 404,
      json: { message: 'Not Found' },
    })
    .on({
      method: 'GET',
      path: `${R}/git/trees/${fx.SHA_TREE}`,
      query: { recursive: '1' },
      json: baseTree(),
    })
    .on({ method: 'POST', path: `${R}/git/blobs`, status: 201, json: { sha: 'newblob' } })
    .on({ method: 'POST', path: `${R}/git/trees`, status: 201, json: fx.tree(fx.SHA_NEW_TREE, []) })
    .on({
      method: 'POST',
      path: `${R}/git/commits`,
      status: 201,
      json: fx.commit(fx.SHA_NEW_COMMIT, fx.SHA_NEW_TREE),
    })
    .on({
      method: 'POST',
      path: `${R}/git/refs`,
      status: 201,
      json: fx.ref(`heads/${BRANCH}`, fx.SHA_NEW_COMMIT),
    })
    .on({ method: 'POST', path: `${R}/pulls`, status: 201, json: fx.pullRequest(17, BRANCH) });

const proposeName = (connector: GithubRepoConnector, after = 'x\n') =>
  connector.propose(changeSet([{ path: NAME, before: 'Trail Notes\n', after }]), {
    branch: BRANCH,
    title: 'T',
  });

test('propose commits through blobs, tree, commit and ref, then opens a pull request', async () => {
  const fake = new Fake();
  proposeRoutes(fake);
  const result = await make(fake).propose(
    changeSet([
      { path: NAME, before: 'Trail Notes\n', after: 'Trail Notes Pro\n' },
      { path: KEYWORDS, after: 'hiking,trail\n' },
      { path: OLD, before: 'Hike, log, share\n' },
    ]),
    { branch: BRANCH, title: 'Update the listing' },
  );
  assert.deepEqual(result, {
    branch: BRANCH,
    url: 'https://github.com/acme/trail-notes/pull/17',
    number: 17,
    commitSha: fx.SHA_NEW_COMMIT,
  });
  fake.assertClean();

  // The order of the writes is the git data API order.
  const writes = fake.writes;
  assert.deepEqual(
    writes.map((c) => c.path.replace(R, '')),
    ['/git/blobs', '/git/blobs', '/git/trees', '/git/commits', '/git/refs', '/pulls'],
  );
  const blobs = writes.slice(0, 2).map((c) => c.body.content);
  assert.deepEqual(blobs.sort(), ['Trail Notes Pro\n', 'hiking,trail\n']);
  assert.equal(writes[0]?.body.encoding, 'utf-8');

  const treeBody = writes[2]?.body;
  assert.equal(treeBody.base_tree, fx.SHA_TREE);
  assert.deepEqual(treeBody.tree, [
    { path: KEYWORDS, mode: '100644', type: 'blob', sha: 'newblob' },
    { path: NAME, mode: '100644', type: 'blob', sha: 'newblob' },
    { path: OLD, mode: '100644', type: 'blob', sha: null }, // a deletion
  ]);
  assert.deepEqual(writes[3]?.body, {
    message: 'Update the listing\n\nUpdate the en-US listing',
    tree: fx.SHA_NEW_TREE,
    parents: [fx.SHA_BASE],
  });
  assert.deepEqual(writes[4]?.body, { ref: `refs/heads/${BRANCH}`, sha: fx.SHA_NEW_COMMIT });
  const pr = writes[5]?.body;
  assert.equal(pr.head, BRANCH);
  assert.equal(pr.base, 'main');
  assert.equal(pr.title, 'Update the listing');
  assert.match(pr.body, /Update the en-US listing/);
  assert.match(pr.body, new RegExp(`\`${NAME}\``));
  assert.match(pr.body, /cs_1/);
  assert.equal(pr.draft, undefined);
});

test('propose keeps the mode of an executable file and honours body and draft', async () => {
  const fake = new Fake();
  proposeRoutes(fake);
  await make(fake).propose(
    changeSet([{ path: 'bin/release.sh', before: '#!/bin/sh\n', after: '#!/bin/sh\nset -e\n' }]),
    { branch: BRANCH, title: 'T', body: 'Custom body', draft: true },
  );
  assert.equal(fake.to('POST', '/git/trees')[0]?.body.tree[0].mode, '100755');
  const pr = fake.to('POST', '/pulls')[0]?.body;
  assert.equal(pr.body, 'Custom body');
  assert.equal(pr.draft, true);
});

test('propose writes an image as a base64 blob, and holds the old bytes to the blob id in the tree', async () => {
  const oldBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
  const newBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
  const IMG = 'fastlane/metadata/android/en-US/images/icon.png';
  const blobOf = (b: Buffer) =>
    createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
  const tree = () => fx.tree(fx.SHA_TREE, [{ path: IMG, sha: blobOf(oldBytes) }]);
  const routes = (fake: Fake) =>
    withDefaultBranch(fake)
      .on({
        method: 'GET',
        path: `${R}/git/ref/heads/${BRANCH}`,
        status: 404,
        json: { message: 'Not Found' },
      })
      .on({
        method: 'GET',
        path: `${R}/git/trees/${fx.SHA_TREE}`,
        query: { recursive: '1' },
        json: tree(),
      })
      .on({ method: 'POST', path: `${R}/git/blobs`, status: 201, json: { sha: 'newblob' } })
      .on({
        method: 'POST',
        path: `${R}/git/trees`,
        status: 201,
        json: fx.tree(fx.SHA_NEW_TREE, []),
      })
      .on({
        method: 'POST',
        path: `${R}/git/commits`,
        status: 201,
        json: fx.commit(fx.SHA_NEW_COMMIT, fx.SHA_NEW_TREE),
      })
      .on({
        method: 'POST',
        path: `${R}/git/refs`,
        status: 201,
        json: fx.ref(`heads/${BRANCH}`, fx.SHA_NEW_COMMIT),
      })
      .on({ method: 'POST', path: `${R}/pulls`, status: 201, json: fx.pullRequest(18, BRANCH) });
  const fake = new Fake();
  routes(fake);
  await make(fake).propose(
    changeSet([
      {
        path: IMG,
        before: oldBytes.toString('base64'),
        after: newBytes.toString('base64'),
        encoding: 'base64',
      },
    ]),
    { branch: BRANCH, title: 'T' },
  );
  const blob = fake.to('POST', '/git/blobs')[0]?.body;
  assert.equal(blob.encoding, 'base64');
  assert.equal(blob.content, newBytes.toString('base64'));
  // Another file than the one that was read: a conflict, and nothing is written.
  const stale = new Fake();
  routes(stale);
  await rejects(
    make(stale).propose(
      changeSet([
        {
          path: IMG,
          before: Buffer.from('other').toString('base64'),
          after: newBytes.toString('base64'),
          encoding: 'base64',
        },
      ]),
      { branch: BRANCH, title: 'T' },
    ),
    (e) => assert.ok(e instanceof ChangeConflictError),
  );
  assert.equal(stale.to('POST', '/git/blobs').length, 0);
});

test('propose refuses the default branch before writing anything, whatever its case', async () => {
  for (const branch of ['main', 'Main']) {
    const fake = new Fake();
    withDefaultBranch(fake);
    await rejects(
      make(fake).propose(changeSet([{ path: NAME, after: 'x' }]), { branch, title: 'T' }),
      (e) => {
        assert.ok(e instanceof DefaultBranchError);
        assert.equal(e.kind, 'default_branch');
      },
    );
    assert.equal(fake.writes.length, 0);
  }
});

test('propose refuses a branch that already exists, before creating any objects', async () => {
  const fake = new Fake();
  withDefaultBranch(fake).on({
    method: 'GET',
    path: `${R}/git/ref/heads/${BRANCH}`,
    json: fx.ref(`heads/${BRANCH}`, 'someone-elses-commit'),
  });
  await rejects(proposeName(make(fake)), (e) => {
    assert.ok(e instanceof BranchExistsError);
    assert.equal(e.branch, BRANCH);
    assert.equal(e.status, 422);
  });
  assert.equal(fake.writes.length, 0);
  fake.assertClean();
});

test('propose reports a branch taken between the check and the ref creation', async () => {
  const fake = new Fake();
  proposeRoutes(fake).replace({
    method: 'POST',
    path: `${R}/git/refs`,
    status: 422,
    json: { message: 'Reference already exists', documentation_url: 'https://docs.github.com' },
  });
  await rejects(proposeName(make(fake)), (e) => assert.ok(e instanceof BranchExistsError));
  assert.equal(fake.to('POST', '/pulls').length, 0);
});

test('propose refuses a change set made against older content', async () => {
  const fake = new Fake();
  proposeRoutes(fake);
  await rejects(
    make(fake).propose(
      changeSet([
        { path: NAME, before: 'An older name\n', after: 'x\n' }, // changed since
        { path: KEYWORDS, before: 'gone\n', after: 'y\n' }, // deleted since
        { path: OLD, after: 'z\n' }, // created since (it exists)
        { path: 'fine.txt', after: 'ok\n' },
      ]),
      { branch: BRANCH, title: 'T' },
    ),
    (e) => {
      assert.ok(e instanceof ChangeConflictError);
      assert.deepEqual(e.paths, [KEYWORDS, NAME, OLD].sort());
      assert.ok(!e.message.includes('older name'), 'file contents are not in the message');
    },
  );
  assert.equal(fake.writes.length, 0);
});

test('propose skips changes the repository already has, and fails when nothing is left', async () => {
  const fake = new Fake();
  proposeRoutes(fake);
  await rejects(
    make(fake).propose(
      changeSet([
        { path: NAME, before: 'Older\n', after: 'Trail Notes\n' }, // already applied
        { path: 'gone.txt', before: 'x\n' }, // already deleted
      ]),
      { branch: BRANCH, title: 'T' },
    ),
    (e) => assert.equal(e.kind, 'no_changes'),
  );
  assert.equal(fake.writes.length, 0);
});

test('propose validates the change set and the branch name before any request', async () => {
  const fake = new Fake();
  const connector = make(fake);
  const ok = changeSet([{ path: NAME, after: 'x' }]);
  const bad = (cs: ChangeSet, branch: string, kind: string) =>
    rejects(connector.propose(cs, { branch, title: 'T' }), (e) =>
      assert.equal(e.kind, kind, branch),
    );
  await bad(changeSet([{ path: NAME, after: 'x' }], { target: 'store' }), 'b', 'invalid_input');
  await bad(changeSet([{ path: '../x', after: 'x' }]), 'b', 'invalid_input');
  const twice = changeSet([
    { path: NAME, after: 'x' },
    { path: NAME, after: 'y' },
  ]);
  await bad(twice, 'b', 'invalid_input');
  const workflow = changeSet([{ path: '.github/workflows/ci.yml', after: 'x' }]);
  await bad(workflow, 'b', 'blocked_path');
  const names = [
    '',
    'refs/heads/x',
    'a b',
    'a..b',
    '-x',
    'x.lock',
    'x/',
    'a//b',
    'a~b',
    'a:b',
    '@',
  ];
  for (const name of names) await bad(ok, name, 'invalid_input');
  assert.equal(fake.calls.length, 0);
});

test('the blocked path prefixes can be changed', async () => {
  const fake = new Fake();
  proposeRoutes(fake);
  const connector = make(fake, { blockedPathPrefixes: ['secrets/'] });
  await rejects(
    connector.propose(changeSet([{ path: 'secrets/a', after: 'x' }]), {
      branch: BRANCH,
      title: 'T',
    }),
    (e) => assert.equal(e.kind, 'blocked_path'),
  );
});

test('propose will not rewrite a symlink', async () => {
  const fake = new Fake();
  proposeRoutes(fake);
  await rejects(
    make(fake).propose(changeSet([{ path: 'docs/link', before: 'x', after: 'y' }]), {
      branch: BRANCH,
      title: 'T',
    }),
    (e) => assert.equal(e.kind, 'invalid_input'),
  );
});

test('propose keeps the branch and says so when the pull request cannot be opened', async () => {
  const fake = new Fake();
  proposeRoutes(fake).replace({
    method: 'POST',
    path: `${R}/pulls`,
    status: 422,
    json: {
      message: 'Validation Failed',
      errors: [{ resource: 'PullRequest', code: 'custom', message: 'No commits between' }],
    },
  });
  await rejects(proposeName(make(fake)), (e) => {
    assert.ok(e instanceof PullRequestFailedError);
    assert.equal(e.branch, BRANCH);
    assert.equal(e.commitSha, fx.SHA_NEW_COMMIT);
    assert.ok(e.cause instanceof GithubError);
    assert.match(e.message, /PullRequest\.custom/);
  });
});

test('propose works on another default branch, and walks a truncated tree', async () => {
  const fake = new Fake();
  const dir = (path: string, sha: string) => ({ path, type: 'tree' as const, mode: '040000', sha });
  fake
    .on({ method: 'GET', path: R, json: fx.repo('develop') })
    .on({
      method: 'GET',
      path: `${R}/git/ref/heads/develop`,
      json: fx.ref('heads/develop', fx.SHA_BASE),
    })
    .on({ method: 'GET', path: `${R}/git/ref/heads/listing/x`, status: 404, json: {} })
    .on({
      method: 'GET',
      path: `${R}/git/commits/${fx.SHA_BASE}`,
      json: fx.commit(fx.SHA_BASE, fx.SHA_TREE),
    })
    .on({
      method: 'GET',
      path: `${R}/git/trees/${fx.SHA_TREE}`,
      query: { recursive: '1' },
      json: fx.tree(fx.SHA_TREE, [], true),
    })
    .on({
      method: 'GET',
      path: `${R}/git/trees/${fx.SHA_TREE}`,
      json: fx.tree(fx.SHA_TREE, [dir('fastlane', 'tf')]),
    })
    .on({ method: 'GET', path: `${R}/git/trees/tf`, json: fx.tree('tf', [dir('metadata', 'tm')]) })
    .on({
      method: 'GET',
      path: `${R}/git/trees/tm`,
      json: fx.tree('tm', [{ path: 'copyright.txt', sha: gitBlob('c\n') }]),
    })
    .on({ method: 'POST', path: `${R}/git/blobs`, status: 201, json: { sha: 'nb' } })
    .on({ method: 'POST', path: `${R}/git/trees`, status: 201, json: { sha: fx.SHA_NEW_TREE } })
    .on({ method: 'POST', path: `${R}/git/commits`, status: 201, json: { sha: fx.SHA_NEW_COMMIT } })
    .on({ method: 'POST', path: `${R}/git/refs`, status: 201, json: {} })
    .on({ method: 'POST', path: `${R}/pulls`, status: 201, json: fx.pullRequest(3, 'listing/x') });
  const result = await make(fake).propose(
    changeSet([{ path: 'fastlane/metadata/copyright.txt', before: 'c\n', after: 'd\n' }]),
    { branch: 'listing/x', title: 'T' },
  );
  assert.equal(result.number, 3);
  assert.equal(fake.to('POST', '/pulls')[0]?.body.base, 'develop');
  fake.assertClean();
});

// ---------------------------------------------------------------------------------------------
// dispatchWorkflow and listWorkflowRuns

test('dispatchWorkflow answers 204 with no run id', async () => {
  const fake = new Fake();
  fake.on({ method: 'POST', path: `${R}/actions/workflows/release.yml/dispatches`, status: 204 });
  const result = await make(fake).dispatchWorkflow('release.yml', 'main', { track: 'internal' });
  assert.deepEqual(result, {});
  assert.deepEqual(fake.to('POST', '/dispatches')[0]?.body, {
    ref: 'main',
    inputs: { track: 'internal' },
    return_run_details: true,
  });
});

test('dispatchWorkflow returns the run id when GitHub names the run (200)', async () => {
  const fake = new Fake();
  fake.on({
    method: 'POST',
    path: `${R}/actions/workflows/1234/dispatches`,
    status: 200,
    json: fx.dispatchWithRun(30433642),
  });
  assert.deepEqual(await make(fake).dispatchWorkflow('1234', 'v1.2.0'), {
    runId: '30433642',
    runUrl: 'https://github.com/acme/trail-notes/actions/runs/30433642',
  });
  // No inputs: the key is left out rather than sent empty.
  assert.equal('inputs' in (fake.to('POST', '/dispatches')[0]?.body ?? {}), false);
});

test('dispatchWorkflow can skip the run details request (older Enterprise Server)', async () => {
  const fake = new Fake();
  fake.on({ method: 'POST', path: `${R}/actions/workflows/release.yml/dispatches`, status: 204 });
  await make(fake, { dispatchRunDetails: false }).dispatchWorkflow('release.yml', 'main');
  assert.deepEqual(fake.to('POST', '/dispatches')[0]?.body, { ref: 'main' });
});

test('dispatchWorkflow encodes the workflow name and reports GitHub errors', async () => {
  const fake = new Fake();
  fake
    .on({
      method: 'POST',
      path: `${R}/actions/workflows/missing.yml/dispatches`,
      status: 404,
      json: { message: 'Not Found' },
    })
    .on({
      method: 'POST',
      path: `${R}/actions/workflows/release.yml/dispatches`,
      status: 422,
      json: { message: "Workflow does not have 'workflow_dispatch' trigger" },
    })
    .on({
      method: 'POST',
      path: `${R}/actions/workflows/My%20Release.yml/dispatches`,
      status: 204,
    });
  const connector = make(fake);
  await rejects(connector.dispatchWorkflow('missing.yml', 'main'), (e) =>
    assert.equal(e.kind, 'not_found'),
  );
  await rejects(connector.dispatchWorkflow('release.yml', 'main'), (e) => {
    assert.equal(e.kind, 'validation');
    assert.match(e.message, /workflow_dispatch/);
  });
  await connector.dispatchWorkflow('My Release.yml', 'main');
  fake.assertClean();
});

test('dispatchWorkflow checks its arguments locally', async () => {
  const connector = make(new Fake());
  const many = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`k${i}`, 'v']));
  await rejects(connector.dispatchWorkflow('release.yml', 'main', many), (e) =>
    assert.equal(e.kind, 'invalid_input'),
  );
  await rejects(connector.dispatchWorkflow('', 'main'), (e) =>
    assert.equal(e.kind, 'invalid_input'),
  );
});

test('listWorkflowRuns maps runs, sends filters, and drops runs it cannot link to', async () => {
  const fake = new Fake();
  fake.on({
    method: 'GET',
    path: `${R}/actions/workflows/release.yml/runs`,
    json: fx.workflowRuns(),
  });
  const runs = await make(fake).listWorkflowRuns({
    workflow: 'release.yml',
    branch: 'main',
    event: 'workflow_dispatch',
    status: 'completed',
    headSha: fx.SHA_BASE,
    limit: 500,
  });
  const query = fake.to('GET', '/runs')[0]?.query;
  assert.equal(query?.get('per_page'), '100');
  assert.equal(query?.get('branch'), 'main');
  assert.equal(query?.get('event'), 'workflow_dispatch');
  assert.equal(query?.get('status'), 'completed');
  assert.equal(query?.get('head_sha'), fx.SHA_BASE);
  assert.deepEqual(runs, [
    {
      id: '30433642',
      name: 'Release',
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/acme/trail-notes/actions/runs/30433642',
      branch: 'main',
      headSha: fx.SHA_BASE,
      event: 'workflow_dispatch',
      runNumber: 562,
      createdAt: Date.UTC(2026, 2, 1, 10, 0, 0),
      updatedAt: Date.UTC(2026, 2, 1, 10, 12, 30),
    },
    {
      id: '30433643',
      name: 'Release',
      status: 'in_progress',
      url: 'https://github.com/acme/trail-notes/actions/runs/30433643',
      branch: 'release/1.2',
      headSha: fx.SHA_NEW_COMMIT,
      event: 'workflow_dispatch',
      runNumber: 563,
      createdAt: Date.UTC(2026, 2, 2, 9, 0, 0),
      updatedAt: Date.UTC(2026, 2, 2, 9, 1, 0),
    },
  ]);
});

test('listWorkflowRuns without a workflow lists the repository runs, 30 by default', async () => {
  const fake = new Fake();
  fake.on({
    method: 'GET',
    path: `${R}/actions/runs`,
    json: { total_count: 0, workflow_runs: [] },
  });
  assert.deepEqual(await make(fake).listWorkflowRuns(), []);
  assert.equal(fake.to('GET', '/runs')[0]?.query.get('per_page'), '30');
});

// ---------------------------------------------------------------------------------------------
// Rate limits and other failures

test('a primary rate limit (403, remaining 0) says when the window resets', async () => {
  const fake = new Fake();
  const reset = Math.floor(T0 / 1000) + 90;
  fake.on({
    method: 'GET',
    path: R,
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    json: { message: 'API rate limit exceeded for installation ID 42.' },
  });
  await rejects(make(fake).defaultBranch(), (e) => {
    assert.ok(e instanceof GithubRateLimitError);
    assert.equal(e.kind, 'rate_limited');
    assert.equal(e.limit, 'primary');
    assert.equal(e.retryAfterSeconds, 90);
    assert.equal(e.resetAt, reset * 1000);
    assert.equal(e.status, 403);
  });
});

test('a secondary rate limit honours Retry-After, and 429 is a rate limit too', async () => {
  const fake = new Fake();
  fake
    .on({
      method: 'GET',
      path: R,
      status: 403,
      headers: { 'retry-after': '37', 'x-ratelimit-remaining': '4000' },
      json: { message: 'You have exceeded a secondary rate limit.' },
      times: 1,
    })
    .on({ method: 'GET', path: R, status: 429, json: { message: 'Slow down' }, times: 1 })
    .on({
      method: 'GET',
      path: R,
      status: 403,
      json: { message: 'You have exceeded a secondary rate limit' },
    });
  const connector = make(fake);
  await rejects(connector.defaultBranch(), (e) => {
    assert.ok(e instanceof GithubRateLimitError);
    assert.equal(e.limit, 'secondary');
    assert.equal(e.retryAfterSeconds, 37);
  });
  await rejects(connector.defaultBranch(), (e) => {
    assert.ok(e instanceof GithubRateLimitError);
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterSeconds, 60); // GitHub asks for a minute when it gives no hint
  });
  await rejects(connector.defaultBranch(), (e) => {
    assert.ok(e instanceof GithubRateLimitError);
    assert.equal(e.retryAfterSeconds, 60);
  });
  assert.equal(fake.to('GET', R).length, 3, 'none of them was retried');
});

test('a 403 that is not a rate limit is a permission error that names what was missing', async () => {
  const fake = new Fake();
  fake.on({
    method: 'POST',
    path: `${R}/actions/workflows/release.yml/dispatches`,
    status: 403,
    headers: { 'x-accepted-github-permissions': 'actions=write', 'x-ratelimit-remaining': '4999' },
    json: { message: 'Resource not accessible by integration' },
  });
  await rejects(make(fake).dispatchWorkflow('release.yml', 'main'), (e) => {
    assert.equal(e.kind, 'forbidden');
    assert.match(e.message, /Resource not accessible by integration/);
    assert.match(e.message, /actions=write/);
  });
});

test('a rate limit while writing during propose surfaces as the typed error', async () => {
  const fake = new Fake();
  proposeRoutes(fake).replace({
    method: 'POST',
    path: `${R}/git/blobs`,
    status: 429,
    headers: { 'retry-after': '5' },
    json: { message: 'x' },
  });
  await rejects(
    make(fake).propose(changeSet([{ path: 'new.txt', after: 'x' }]), {
      branch: BRANCH,
      title: 'T',
    }),
    (e) => {
      assert.ok(e instanceof GithubRateLimitError);
      assert.equal(e.retryAfterSeconds, 5);
    },
  );
  assert.equal(fake.to('POST', '/git/refs').length, 0, 'nothing was published');
});

test('server errors and network failures are typed, and name no secret', async () => {
  const fake = new Fake();
  fake.on({ method: 'GET', path: R, status: 502, json: { message: 'Server Error' } });
  await rejects(make(fake).defaultBranch(), (e) => {
    assert.equal(e.kind, 'server');
    assert.equal(e.status, 502);
  });
  const down = make(new Fake(), {
    fetch: async () => {
      throw new TypeError(`fetch failed: Bearer ${TOKEN}`);
    },
  });
  await rejects(down.defaultBranch(), (e) => {
    assert.equal(e.kind, 'network');
    assert.ok(!e.message.includes(TOKEN));
  });
});

test('apiBase supports GitHub Enterprise Server', async () => {
  const fake = new Fake();
  fake.on({ method: 'GET', path: '/api/v3/repos/acme/trail-notes', json: fx.repo() });
  fake.on({
    method: 'POST',
    path: '/api/v3/app/installations/42/access_tokens',
    status: 201,
    json: fx.installationToken(TOKEN, iso(T0 + HOUR)),
  });
  const connector = make(fake, { apiBase: 'https://ghe.example.com/api/v3/' });
  assert.equal(await connector.defaultBranch(), 'main');
  fake.assertClean();
});

test('propose with an already aborted signal sends nothing and writes nothing', async () => {
  const fake = new Fake();
  proposeRoutes(fake);
  const controller = new AbortController();
  controller.abort();
  await rejects(
    make(fake).propose(changeSet([{ path: NAME, before: 'Trail Notes\n', after: 'x\n' }]), {
      branch: BRANCH,
      title: 'T',
      signal: controller.signal,
    }),
    (e) => assert.ok(e instanceof GithubError && e.kind === 'network', String(e)),
  );
  assert.deepEqual(fake.writes, []);
  assert.deepEqual(
    fake.calls.filter((c) => !c.path.includes('access_tokens')),
    [],
  );
});

test('aborting during propose stops it before the next request: no tree, commit, branch or pull request', async () => {
  const fake = new Fake();
  proposeRoutes(fake);
  const controller = new AbortController();
  const connector = make(fake, {
    fetch: async (input, init) => {
      const reply = await fake.fetch(input, init);
      // The timeout fires while the blob is being stored.
      if (String(input).endsWith('/git/blobs')) controller.abort();
      return reply;
    },
  });
  await rejects(
    connector.propose(changeSet([{ path: NAME, before: 'Trail Notes\n', after: 'x\n' }]), {
      branch: BRANCH,
      title: 'T',
      signal: controller.signal,
    }),
    (e) => assert.ok(e instanceof GithubError && e.kind === 'network', String(e)),
  );
  assert.deepEqual(
    fake.writes.map((c) => c.path.replace(R, '')),
    ['/git/blobs'],
  );
});

test('propose without a signal behaves as before', async () => {
  const fake = new Fake();
  proposeRoutes(fake);
  const result = await proposeName(make(fake));
  assert.equal(result.number, 17);
});

test('openPullRequest opens a pull request for a branch that is already on GitHub', async () => {
  const fake = new Fake();
  fake.on({
    method: 'POST',
    path: `${R}/pulls`,
    status: 201,
    json: fx.pullRequest(5, 'kiln/local-1'),
  });
  const result = await make(fake).openPullRequest({
    branch: 'kiln/local-1',
    base: 'main',
    title: 'Update the subtitle',
    body: 'Body',
  });
  assert.equal(result.number, 5);
  assert.ok(result.url?.startsWith('https://'));
  const sent = fake.to('POST', '/pulls')[0]?.body;
  assert.equal(sent?.head, 'kiln/local-1');
  assert.equal(sent?.base, 'main');
  assert.equal(sent?.title, 'Update the subtitle');
  assert.equal(fake.to('POST', '/git/refs').length, 0, 'no branch is made');
  fake.assertClean();
});

test('openPullRequest refuses branch names that are not valid, and reports a refusal by GitHub', async () => {
  const fake = new Fake();
  await rejects(
    make(fake).openPullRequest({ branch: '--upload-pack=x', base: 'main', title: 'T' }),
    (e) => assert.equal(e.kind, 'invalid_input'),
  );
  await rejects(make(fake).openPullRequest({ branch: 'a', base: 'x..y', title: 'T' }), (e) =>
    assert.equal(e.kind, 'invalid_input'),
  );
  fake.on({
    method: 'POST',
    path: `${R}/pulls`,
    status: 422,
    json: {
      message: 'Validation Failed',
      errors: [
        { resource: 'PullRequest', code: 'custom', message: 'A pull request already exists' },
      ],
    },
  });
  await rejects(make(fake).openPullRequest({ branch: 'a', base: 'main', title: 'T' }), (e) =>
    assert.match(e.message, /PullRequest\.custom/),
  );
});

// ---------------------------------------------------------------------------------------------
// fix-up: one more commit on an existing branch

const FIX_BRANCH = 'kiln/update-listing';
const FIX_TIP = 'e5f60718293a4b5c6d7e8f9012345678901234ab';
const FIX_TREE = 'f60718293a4b5c6d7e8f9012345678901234abcd';

const fixupRoutes = (fake: Fake) =>
  withDefaultBranch(fake)
    .on({
      method: 'GET',
      path: `${R}/git/ref/heads/${FIX_BRANCH}`,
      json: fx.ref(`heads/${FIX_BRANCH}`, FIX_TIP),
    })
    .on({ method: 'GET', path: `${R}/git/commits/${FIX_TIP}`, json: fx.commit(FIX_TIP, FIX_TREE) })
    .on({
      method: 'GET',
      path: `${R}/git/trees/${FIX_TREE}`,
      query: { recursive: '1' },
      json: fx.tree(FIX_TREE, [
        { path: NAME, sha: gitBlob('Trail Notes Pro\n') },
        { path: OLD, sha: gitBlob('Hike, log, share\n') },
        { path: 'bin/release.sh', mode: '100755', sha: gitBlob('#!/bin/sh\n') },
        { path: 'docs/link', mode: '120000', sha: 'linksha' },
      ]),
    })
    .on({ method: 'POST', path: `${R}/git/blobs`, status: 201, json: { sha: 'newblob' } })
    .on({ method: 'POST', path: `${R}/git/trees`, status: 201, json: fx.tree(fx.SHA_NEW_TREE, []) })
    .on({
      method: 'POST',
      path: `${R}/git/commits`,
      status: 201,
      json: fx.commit(fx.SHA_NEW_COMMIT, fx.SHA_NEW_TREE),
    })
    .on({
      method: 'PATCH',
      path: `${R}/git/refs/heads/${FIX_BRANCH}`,
      json: fx.ref(`heads/${FIX_BRANCH}`, fx.SHA_NEW_COMMIT),
    });

test('commitOnBranch adds one commit on the tip and fast-forwards the ref with force false', async () => {
  const fake = new Fake();
  fixupRoutes(fake);
  const result = await make(fake).commitOnBranch({
    branch: FIX_BRANCH,
    expectedTip: FIX_TIP,
    message: 'Fix up',
    changes: [
      { path: NAME, content: 'Trail Notes Max\n' },
      { path: OLD }, // a deletion
      { path: 'bin/release.sh', content: '#!/bin/sh\nset -e\n' },
    ],
  });
  assert.deepEqual(result, {
    commit: fx.SHA_NEW_COMMIT,
    parent: FIX_TIP,
    tree: fx.SHA_NEW_TREE,
    changed: 3,
  });
  fake.assertClean();
  const writes = fake.calls.filter((c) => c.method !== 'GET' && !c.path.includes('access_tokens'));
  assert.deepEqual(
    writes.map((c) => `${c.method} ${c.path.replace(R, '')}`),
    [
      'POST /git/blobs',
      'POST /git/blobs',
      'POST /git/trees',
      'POST /git/commits',
      `PATCH /git/refs/heads/${FIX_BRANCH}`,
    ],
  );
  const tree = writes[2]?.body;
  assert.equal(tree.base_tree, FIX_TREE);
  assert.deepEqual(
    tree.tree.map((e: { path: string; mode: string; sha: string | null }) => [
      e.path,
      e.mode,
      e.sha === null,
    ]),
    [
      [NAME, '100644', false],
      [OLD, '100644', true],
      ['bin/release.sh', '100755', false],
    ].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
  );
  assert.deepEqual(writes[3]?.body, {
    message: 'Fix up',
    tree: fx.SHA_NEW_TREE,
    parents: [FIX_TIP],
  });
  assert.deepEqual(writes[4]?.body, { sha: fx.SHA_NEW_COMMIT, force: false });
  // No other ref is created, moved or deleted.
  assert.equal(
    fake.calls.some((c) => c.path.endsWith('/git/refs') || c.method === 'DELETE'),
    false,
  );
});

test('commitOnBranch: a tip that is not the expected one, or a ref update GitHub refuses, is branch_moved', async () => {
  const fake = new Fake();
  fixupRoutes(fake);
  await rejects(
    make(fake).commitOnBranch({
      branch: FIX_BRANCH,
      expectedTip: SHA_OTHER,
      message: 'm',
      changes: [{ path: NAME, content: 'x\n' }],
    }),
    (e) => {
      assert.ok(e instanceof BranchMovedError);
      assert.equal(e.kind, 'branch_moved');
    },
  );
  assert.equal(fake.writes.length, 0, 'nothing is written when the tip is not the expected one');

  const racing = new Fake();
  fixupRoutes(racing);
  racing.replace({
    method: 'PATCH',
    path: `${R}/git/refs/heads/${FIX_BRANCH}`,
    status: 422,
    json: { message: 'Update is not a fast forward' },
  });
  await rejects(
    make(racing).commitOnBranch({
      branch: FIX_BRANCH,
      expectedTip: FIX_TIP,
      message: 'm',
      changes: [{ path: NAME, content: 'x\n' }],
    }),
    (e) => assert.ok(e instanceof BranchMovedError),
  );
});

const SHA_OTHER = '0123456789abcdef0123456789abcdef01234567';

test('commitOnBranch refuses the default branch, a missing branch, bad paths, blocked paths and symlinks', async () => {
  const fake = new Fake();
  fixupRoutes(fake).on({
    method: 'GET',
    path: `${R}/git/ref/heads/gone`,
    status: 404,
    json: { message: 'Not Found' },
  });
  const change = [{ path: NAME, content: 'x\n' }];
  for (const branch of ['main', 'Main']) {
    await rejects(
      make(fake).commitOnBranch({ branch, expectedTip: FIX_TIP, message: 'm', changes: change }),
      (e) => assert.ok(e instanceof DefaultBranchError),
    );
  }
  await rejects(
    make(fake).commitOnBranch({
      branch: 'gone',
      expectedTip: FIX_TIP,
      message: 'm',
      changes: change,
    }),
    (e) => assert.ok(e instanceof BranchMissingError),
  );
  for (const [changes, kind] of [
    [[{ path: '../x', content: 'x' }], 'invalid_input'],
    [
      [
        { path: NAME, content: 'a' },
        { path: NAME, content: 'b' },
      ],
      'invalid_input',
    ],
    [[{ path: '.github/workflows/x.yml', content: 'x' }], 'blocked_path'],
    [[{ path: 'docs/link', content: 'x' }], 'invalid_input'],
  ] as const) {
    await rejects(
      make(fake).commitOnBranch({
        branch: FIX_BRANCH,
        expectedTip: FIX_TIP,
        message: 'm',
        changes: [...changes],
      }),
      (e) => assert.equal(e.kind, kind),
    );
  }
  await rejects(
    make(fake).commitOnBranch({
      branch: '--bad',
      expectedTip: FIX_TIP,
      message: 'm',
      changes: change,
    }),
    (e) => assert.equal(e.kind, 'invalid_input'),
  );
  assert.equal(fake.writes.length, 0);
});

test('commitOnBranch skips files that already have the text and says no_changes when nothing is left', async () => {
  const fake = new Fake();
  fixupRoutes(fake);
  await rejects(
    make(fake).commitOnBranch({
      branch: FIX_BRANCH,
      expectedTip: FIX_TIP,
      message: 'm',
      changes: [{ path: NAME, content: 'Trail Notes Pro\n' }, { path: 'not/there.txt' }],
    }),
    (e) => assert.equal(e.kind, 'no_changes'),
  );
  assert.equal(fake.writes.length, 0);
});

test('branchTip and findPullRequest', async () => {
  const fake = new Fake();
  withDefaultBranch(fake)
    .on({
      method: 'GET',
      path: `${R}/git/ref/heads/${FIX_BRANCH}`,
      json: fx.ref(`heads/${FIX_BRANCH}`, FIX_TIP),
    })
    .on({
      method: 'GET',
      path: `${R}/git/ref/heads/gone`,
      status: 404,
      json: { message: 'Not Found' },
    })
    .on({
      method: 'GET',
      path: `${R}/pulls/17`,
      json: {
        ...fx.pullRequest(17, FIX_BRANCH),
        state: 'closed',
        merged: true,
        base: { ref: 'main' },
      },
    })
    .on({ method: 'GET', path: `${R}/pulls/18`, status: 404, json: { message: 'Not Found' } })
    .on({
      method: 'GET',
      path: `${R}/pulls`,
      query: { head: `acme:${FIX_BRANCH}` },
      json: [
        { ...fx.pullRequest(20, FIX_BRANCH), state: 'closed' },
        fx.pullRequest(19, FIX_BRANCH),
      ],
    });
  const connector = make(fake);
  assert.equal(await connector.branchTip(FIX_BRANCH), FIX_TIP);
  assert.equal(await connector.branchTip('gone'), undefined);
  assert.deepEqual(await connector.findPullRequest({ number: 17 }), {
    number: 17,
    state: 'merged',
    url: 'https://github.com/acme/trail-notes/pull/17',
    branch: FIX_BRANCH,
    base: 'main',
  });
  assert.equal(await connector.findPullRequest({ number: 18 }), undefined);
  // By branch: an open pull request wins over a newer closed one.
  assert.equal((await connector.findPullRequest({ branch: FIX_BRANCH }))?.number, 19);
  assert.equal((await connector.findPullRequest({ branch: FIX_BRANCH }))?.state, 'open');
  fake.assertClean();
});
