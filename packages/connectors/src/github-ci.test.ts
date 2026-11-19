import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GithubError } from './errors.ts';
import { GithubRepoConnector } from './github.ts';

// Fixtures are hand-written from the GitHub REST documentation, never recorded from live GitHub.

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
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const workflowsFixture = {
  total_count: 3,
  workflows: [
    {
      id: 161335,
      name: 'iOS release',
      path: '.github/workflows/ios.yml',
      state: 'active',
      html_url: 'https://github.com/acme/trail-notes/blob/main/.github/workflows/ios.yml',
    },
    { id: 161336, name: 'Android release', path: '.github/workflows/android.yml', state: 'disabled_manually' },
    { id: 'x', path: '' },
  ],
};

const runFixture = {
  id: 30433642,
  name: 'iOS release',
  display_title: 'Release 2.4.0 (build 240)',
  path: '.github/workflows/ios.yml',
  workflow_id: 161335,
  head_branch: 'main',
  head_sha: SHA_A,
  event: 'workflow_dispatch',
  run_number: 562,
  run_attempt: 2,
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/acme/trail-notes/actions/runs/30433642',
  created_at: '2026-03-01T10:00:00Z',
  run_started_at: '2026-03-01T10:00:05Z',
  updated_at: '2026-03-01T10:12:30Z',
  actor: { login: 'ada' },
  head_commit: { id: SHA_A, message: 'Fix the crash on launch\n\nDetails.' },
};

test('listWorkflows maps names, paths and states, skips malformed entries and sorts by path', async () => {
  const { connector, calls } = fakeGithub({ [`${R}/actions/workflows`]: () => ({ json: workflowsFixture }) });
  assert.deepEqual(await connector.listWorkflows(), [
    { id: '161336', name: 'Android release', path: '.github/workflows/android.yml', state: 'disabled_manually' },
    {
      id: '161335',
      name: 'iOS release',
      path: '.github/workflows/ios.yml',
      state: 'active',
      url: 'https://github.com/acme/trail-notes/blob/main/.github/workflows/ios.yml',
    },
  ]);
  assert.equal(calls[0]?.query.get('per_page'), '100');
});

test('listCiRuns keeps the extra fields and sends the filters', async () => {
  const { connector, calls } = fakeGithub({
    [`${R}/actions/workflows/ios.yml/runs`]: () => ({
      json: { total_count: 2, workflow_runs: [runFixture, { id: 5, status: 'queued' }] },
    }),
  });
  const runs = await connector.listCiRuns({ workflow: 'ios.yml', branch: 'main', limit: 10 });
  assert.deepEqual(runs, [
    {
      id: '30433642',
      name: 'iOS release',
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/acme/trail-notes/actions/runs/30433642',
      branch: 'main',
      headSha: SHA_A,
      event: 'workflow_dispatch',
      runNumber: 562,
      createdAt: Date.UTC(2026, 2, 1, 10, 0, 0),
      updatedAt: Date.UTC(2026, 2, 1, 10, 12, 30),
      displayTitle: 'Release 2.4.0 (build 240)',
      path: '.github/workflows/ios.yml',
      workflowId: '161335',
      startedAt: Date.UTC(2026, 2, 1, 10, 0, 5),
      attempt: 2,
      actor: 'ada',
      commitMessage: 'Fix the crash on launch\n\nDetails.',
    },
  ]);
  assert.equal(calls[0]?.query.get('per_page'), '10');
  assert.equal(calls[0]?.query.get('branch'), 'main');
});

test('listCiRuns passes an abort signal on to the request', async () => {
  const { connector, calls } = fakeGithub({
    [`${R}/actions/runs`]: () => ({ json: { workflow_runs: [] } }),
  });
  const controller = new AbortController();
  await connector.listCiRuns({ signal: controller.signal });
  controller.abort();
  assert.equal(calls[0]?.signal?.aborted, true);
  await assert.rejects(connector.listCiRuns({ signal: controller.signal }), (e: unknown) => {
    return e instanceof GithubError && e.kind === 'network';
  });
});

test('getCiRun returns the run, undefined for 404, and refuses a bad id before any request', async () => {
  const { connector, calls } = fakeGithub({
    [`${R}/actions/runs/30433642`]: () => ({ json: runFixture }),
    [`${R}/actions/runs/1`]: () => ({ status: 404, json: { message: 'Not Found' } }),
  });
  assert.equal((await connector.getCiRun('30433642'))?.displayTitle, 'Release 2.4.0 (build 240)');
  assert.equal(await connector.getCiRun('1'), undefined);
  const before = calls.length;
  await assert.rejects(connector.getCiRun('../x'), (e: unknown) => e instanceof GithubError && e.kind === 'invalid_input');
  assert.equal(calls.length, before);
});

const commitFixture = (n: number) => ({
  sha: n.toString(16).padStart(40, '0'),
  html_url: `https://github.com/acme/trail-notes/commit/${n}`,
  commit: { message: `Commit ${n}\n\nbody`, author: { name: 'Ada', date: '2026-03-01T10:00:00Z' } },
});

test('compareCommits maps one page of commits, oldest first', async () => {
  const { connector, calls } = fakeGithub({
    [`${R}/compare/${SHA_A}...${SHA_B}`]: () => ({
      json: {
        status: 'ahead',
        ahead_by: 2,
        behind_by: 0,
        total_commits: 2,
        html_url: `https://github.com/acme/trail-notes/compare/${SHA_A}...${SHA_B}`,
        commits: [commitFixture(1), commitFixture(2)],
      },
    }),
  });
  const result = await connector.compareCommits(SHA_A, SHA_B);
  assert.equal(result.status, 'ahead');
  assert.equal(result.aheadBy, 2);
  assert.equal(result.totalCommits, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.commits.map((c) => c.message.split('\n')[0]),
    ['Commit 1', 'Commit 2'],
  );
  assert.equal(result.commits[0]?.author, 'Ada');
  assert.equal(result.commits[0]?.date, Date.UTC(2026, 2, 1, 10, 0, 0));
  assert.equal(result.url, `https://github.com/acme/trail-notes/compare/${SHA_A}...${SHA_B}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.query.get('per_page'), '100');
});

test('compareCommits reads the last pages when there are more commits than the limit', async () => {
  // 230 commits: pages of 100, 100 and 30. The newest 50 are the last 30 and 20 of page 2.
  const all = Array.from({ length: 230 }, (_, i) => commitFixture(i + 1));
  const { connector, calls } = fakeGithub({
    [`${R}/compare/main...release/1.2`]: (query) => {
      const page = Number(query.get('page'));
      return {
        json: {
          status: 'ahead',
          ahead_by: 230,
          behind_by: 0,
          total_commits: 230,
          commits: all.slice((page - 1) * 100, page * 100),
        },
      };
    },
  });
  const result = await connector.compareCommits('main', 'release/1.2', { limit: 50 });
  assert.equal(result.totalCommits, 230);
  assert.equal(result.commits.length, 50);
  assert.equal(result.truncated, true);
  assert.equal(result.commits[0]?.message.startsWith('Commit 181'), true);
  assert.equal(result.commits[49]?.message.startsWith('Commit 230'), true);
  assert.deepEqual(
    calls.map((c) => c.query.get('page')),
    ['1', '3', '2'],
  );
});

test('compareCommits does not read more pages than needed', async () => {
  const all = Array.from({ length: 130 }, (_, i) => commitFixture(i + 1));
  const { connector, calls } = fakeGithub({
    [`${R}/compare/${SHA_A}...${SHA_B}`]: (query) => {
      const page = Number(query.get('page'));
      return { json: { status: 'ahead', total_commits: 130, commits: all.slice((page - 1) * 100, page * 100) } };
    },
  });
  const result = await connector.compareCommits(SHA_A, SHA_B, { limit: 20 });
  assert.equal(result.commits.length, 20);
  assert.equal(result.commits[19]?.message.startsWith('Commit 130'), true);
  assert.equal(result.truncated, true);
  // Page 2 holds 30 commits, enough for 20: no third read.
  assert.deepEqual(
    calls.map((c) => c.query.get('page')),
    ['1', '2'],
  );
});

test('compareCommits refuses bad refs locally and reports a missing commit', async () => {
  const { connector, calls } = fakeGithub({
    [`${R}/compare/${SHA_A}...${SHA_B}`]: () => ({ status: 404, json: { message: 'Not Found' } }),
  });
  await assert.rejects(connector.compareCommits('a..b', SHA_B), (e: unknown) => e instanceof GithubError && e.kind === 'invalid_input');
  await assert.rejects(connector.compareCommits('', SHA_B), (e: unknown) => e instanceof GithubError && e.kind === 'invalid_input');
  assert.equal(calls.length, 0);
  await assert.rejects(connector.compareCommits(SHA_A, SHA_B), (e: unknown) => e instanceof GithubError && e.kind === 'not_found');
});

// ---------------------------------------------------------------------------------------------
// Conditional reads and jobs

type Seen = { path: string; query: URLSearchParams; ifNoneMatch: string | null };

function etagGithub(answer: (seen: Seen) => { status?: number; json?: unknown; etag?: string }) {
  const seen: Seen[] = [];
  const fetchFake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const request = { path: url.pathname, query: url.searchParams, ifNoneMatch: headers.get('if-none-match') };
    seen.push(request);
    const reply = answer(request);
    return new Response(reply.status === 304 || reply.json === undefined ? null : JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...(reply.etag ? { etag: reply.etag } : {}) },
    });
  };
  const connector = new GithubRepoConnector({
    owner: 'acme',
    repo: 'trail-notes',
    auth: { type: 'token', token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    fetch: fetchFake,
  });
  return { connector, seen };
}

test('listCiRunsPage sends If-None-Match and reports 304 as notModified', async () => {
  const { connector, seen } = etagGithub((s) =>
    s.ifNoneMatch === 'W/"abc"' ? { status: 304 } : { json: { workflow_runs: [runFixture] }, etag: 'W/"abc"' },
  );
  const first = await connector.listCiRunsPage({ limit: 50 });
  assert.equal(first.notModified, false);
  assert.equal(first.runs.length, 1);
  assert.equal(first.etag, 'W/"abc"');
  assert.equal(seen[0]?.ifNoneMatch, null, 'the first read is not conditional');
  const second = await connector.listCiRunsPage({ limit: 50, etag: first.etag });
  assert.deepEqual(second, { runs: [], notModified: true, etag: 'W/"abc"' });
  assert.equal(seen[1]?.ifNoneMatch, 'W/"abc"');
  // listCiRuns keeps its old shape.
  assert.equal((await connector.listCiRuns()).length, 1);
});

const jobsFixture = {
  total_count: 2,
  jobs: [
    {
      id: 399444496,
      name: 'build',
      status: 'in_progress',
      conclusion: null,
      started_at: '2024-11-18T10:00:00Z',
      completed_at: null,
      html_url: 'https://github.com/acme/trail-notes/actions/runs/30433642/job/399444496',
      runner_name: 'runner-7',
      steps: [
        { name: 'Run tests', status: 'in_progress', conclusion: null, number: 2, started_at: '2024-11-18T10:01:00Z', completed_at: null },
        { name: 'Set up job', status: 'completed', conclusion: 'success', number: 1, started_at: '2024-11-18T10:00:00Z', completed_at: '2024-11-18T10:01:00Z' },
        { name: 'no number' },
      ],
    },
    { id: 399444497, name: 'upload', status: 'queued', conclusion: null, started_at: null, completed_at: null, steps: [] },
    { name: 'no id' },
  ],
};

test('listRunJobs keeps names, states and times only, steps in order', async () => {
  const { connector, seen } = etagGithub(() => ({ json: jobsFixture, etag: 'W/"j1"' }));
  const list = await connector.listRunJobs('30433642');
  assert.equal(seen[0]?.path, `${R}/actions/runs/30433642/jobs`);
  assert.equal(seen[0]?.query.get('filter'), 'latest');
  assert.equal(list.etag, 'W/"j1"');
  assert.equal(list.truncated, false);
  assert.deepEqual(list.jobs.map((j) => j.name), ['build', 'upload']);
  const build = list.jobs[0];
  assert.deepEqual(build?.steps.map((s) => [s.number, s.name, s.status]), [
    [1, 'Set up job', 'completed'],
    [2, 'Run tests', 'in_progress'],
  ]);
  assert.equal(build?.startedAt, Date.parse('2024-11-18T10:00:00Z'));
  assert.equal(build?.completedAt, null);
  assert.equal(build?.url, 'https://github.com/acme/trail-notes/actions/runs/30433642/job/399444496');
  assert.ok(!JSON.stringify(list).includes('runner-7'), 'no runner details');
});

test('listRunJobs: 304 is notModified, 404 is missing, a bad id is refused before any request', async () => {
  const { connector, seen } = etagGithub((s) => {
    if (s.path.includes('/runs/404/')) return { status: 404, json: { message: 'Not Found' } };
    return s.ifNoneMatch ? { status: 304 } : { json: { total_count: 0, jobs: [] } };
  });
  assert.deepEqual(await connector.listRunJobs('1', { etag: 'W/"x"' }), { jobs: [], notModified: true, truncated: false, etag: 'W/"x"' });
  const missing = await connector.listRunJobs('404');
  assert.equal(missing.missing, true);
  await assert.rejects(connector.listRunJobs('../x'), (e: unknown) => e instanceof GithubError && e.kind === 'invalid_input');
  assert.equal(seen.length, 2);
});
