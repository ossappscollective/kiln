import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExpoClient } from './client.ts';
import { ExpoError, type ExpoErrorKind } from './errors.ts';
import { TOKEN, PROJECT_ID } from './expo.fixtures.ts';
import { dispatchAnswer, RUN_ID, runAnswer, runJob } from './workflows.fixtures.ts';
import {
  ciStatusOfExpoRun,
  dispatchExpoWorkflow,
  EXPO_RUN_STATUSES,
  expoWorkflowRun,
  normalizeGitRef,
  normalizeWorkflowFileName,
  workflowPathOf,
} from './workflows.ts';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; redirect: unknown };
type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(...answers: (Answer | Error)[]) {
  const calls: Call[] = [];
  const queue = [...answers];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: String(init?.method),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      redirect: init?.redirect,
    });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    const a = next ?? {};
    return new Response(JSON.stringify(a.body ?? {}), {
      status: a.status ?? 200,
      headers: { 'content-type': 'application/json', ...(a.headers ?? {}) },
    });
  };
  return { fetch: fetchFn, calls };
}

const clientFor = (f: ReturnType<typeof fakeFetch>, apiOrigin?: string) =>
  createExpoClient({ token: TOKEN, fetch: f.fetch, apiOrigin });

async function failing(run: () => Promise<unknown>): Promise<ExpoError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ExpoError, String(error));
    return error;
  }
  assert.fail('expected an ExpoError');
}

const dispatch = { projectId: PROJECT_ID, fileName: 'build.yml', gitRef: 'main' };

test('workflow file names: the path or the name, one file in .eas/workflows', () => {
  assert.equal(normalizeWorkflowFileName('.eas/workflows/build.yml'), 'build.yml');
  assert.equal(normalizeWorkflowFileName('./.eas/workflows/build.yml'), 'build.yml');
  assert.equal(normalizeWorkflowFileName(' deploy-prod.yaml '), 'deploy-prod.yaml');
  assert.equal(normalizeWorkflowFileName('build.yml'), 'build.yml');
  for (const bad of ['', 'build', 'build.json', '.eas/workflows/sub/build.yml', '../build.yml', 'a b.yml', '/etc/x.yml', '.hidden.yml'])
    assert.equal(normalizeWorkflowFileName(bad), undefined, bad);
  assert.equal(workflowPathOf('build.yml'), '.eas/workflows/build.yml');
});

test('git refs: branch, tag, SHA or a full ref; nothing odd', () => {
  for (const ok of ['main', 'release/1.2', 'v1.2.3', 'refs/heads/main', '8c1f0a9d2e3b4c5d6e7f8091a2b3c4d5e6f70812'])
    assert.equal(normalizeGitRef(ok), ok);
  for (const bad of ['', ' ', 'a..b', 'x/', 'x.lock', 'a b', '-rf', 'a\nb', 'a'.repeat(201)])
    assert.equal(normalizeGitRef(bad), undefined, JSON.stringify(bad));
});

test('run statuses map onto the CI words; an unknown one maps to nothing', () => {
  assert.deepEqual(ciStatusOfExpoRun('new'), { status: 'queued' });
  assert.deepEqual(ciStatusOfExpoRun('waiting'), { status: 'waiting' });
  assert.deepEqual(ciStatusOfExpoRun('queued'), { status: 'waiting' });
  assert.deepEqual(ciStatusOfExpoRun('action-required'), { status: 'waiting' });
  assert.deepEqual(ciStatusOfExpoRun('in-progress'), { status: 'in_progress' });
  assert.deepEqual(ciStatusOfExpoRun('success'), { status: 'completed', conclusion: 'success' });
  assert.deepEqual(ciStatusOfExpoRun('failure'), { status: 'completed', conclusion: 'failure' });
  assert.deepEqual(ciStatusOfExpoRun('canceled'), { status: 'completed', conclusion: 'cancelled' });
  assert.equal(ciStatusOfExpoRun('exploded'), undefined);
  for (const s of EXPO_RUN_STATUSES) assert.ok(ciStatusOfExpoRun(s), s);
});

test('dispatch posts the documented body with the bearer token and returns the run id and address', async () => {
  const f = fakeFetch({ body: dispatchAnswer() });
  const started = await dispatchExpoWorkflow(clientFor(f), {
    ...dispatch,
    projectId: PROJECT_ID.toUpperCase(),
    inputs: { platform: 'ios', dry_run: true, count: 2 },
  });
  assert.deepEqual(started, {
    id: RUN_ID,
    url: `https://expo.dev/accounts/acme/projects/trail-notes/workflows/${RUN_ID}`,
  });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0] as Call;
  assert.equal(call.url, 'https://api.expo.dev/v2/workflows/dispatch');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(call.redirect, 'manual');
  assert.deepEqual(call.body, {
    appId: PROJECT_ID,
    gitRef: 'main',
    fileName: 'build.yml',
    inputs: { platform: 'ios', dry_run: true, count: 2 },
  });
});

test('dispatch leaves `inputs` out when there are none, and goes through a proxy origin', async () => {
  const f = fakeFetch({ body: dispatchAnswer() });
  await dispatchExpoWorkflow(clientFor(f, 'https://expo-proxy.example.com/api'), { ...dispatch, inputs: {} });
  assert.equal(f.calls[0]?.url, 'https://expo-proxy.example.com/api/v2/workflows/dispatch');
  assert.ok(!('inputs' in (f.calls[0]?.body as object)));
});

test('dispatch errors: fixed sentences by kind, no token, not retried', async () => {
  const cases: [number, ExpoErrorKind][] = [
    [400, 'invalid_input'],
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'server'],
  ];
  for (const [status, kind] of cases) {
    const f = fakeFetch({ status, body: { error: `boom ${TOKEN}` }, headers: { 'retry-after': '7' } });
    const error = await failing(() => dispatchExpoWorkflow(clientFor(f), dispatch));
    assert.equal(error.kind, kind, String(status));
    assert.equal(f.calls.length, 1, 'a write is never retried');
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!error.message.includes('boom'));
    if (kind === 'rate_limited') assert.equal(error.retryAfterSeconds, 7);
  }
  const f404 = fakeFetch({ status: 404 });
  assert.match((await failing(() => dispatchExpoWorkflow(clientFor(f404), dispatch))).message, /Git ref or workflow file/);
  const f400 = fakeFetch({ status: 400 });
  assert.match((await failing(() => dispatchExpoWorkflow(clientFor(f400), dispatch))).message, /inputs/);
});

test('dispatch: a network failure or an unreadable answer is an ExpoError', async () => {
  const net = await failing(() => dispatchExpoWorkflow(clientFor(fakeFetch(new Error(`down ${TOKEN}`))), dispatch));
  assert.equal(net.kind, 'network');
  assert.ok(!net.message.includes(TOKEN));
  for (const body of [{}, { data: {} }, { data: { id: 'not-a-uuid' } }, { data: { id: '../x' } }, []]) {
    const error = await failing(() => dispatchExpoWorkflow(clientFor(fakeFetch({ body })), dispatch));
    assert.equal(error.kind, 'unexpected', JSON.stringify(body));
  }
});

test('dispatch keeps the run address only when it is https', async () => {
  const http = await dispatchExpoWorkflow(
    clientFor(fakeFetch({ body: { data: { id: RUN_ID, url: 'http://expo.dev/x' } } })),
    dispatch,
  );
  assert.equal(http.url, null);
  const none = await dispatchExpoWorkflow(clientFor(fakeFetch({ body: { data: { id: RUN_ID } } })), dispatch);
  assert.equal(none.url, null);
});

test('reading a run: status in CI words, commit, ref, times and jobs (no outputs)', async () => {
  const f = fakeFetch({ body: runAnswer() });
  const run = await expoWorkflowRun(clientFor(f), RUN_ID.toUpperCase());
  assert.equal(f.calls[0]?.url, `https://api.expo.dev/v2/workflows/runs/${RUN_ID}`);
  assert.equal(f.calls[0]?.method, 'GET');
  assert.equal(f.calls[0]?.body, undefined);
  assert.equal(run.id, RUN_ID);
  assert.equal(run.status, 'in-progress');
  assert.deepEqual(run.ci, { status: 'in_progress' });
  assert.equal(run.gitCommitHash, '8c1f0a9d2e3b4c5d6e7f8091a2b3c4d5e6f70812');
  assert.equal(run.gitCommitMessage, 'Bump build number');
  assert.equal(run.requestedGitRef, 'refs/heads/main');
  assert.equal(run.triggerEventType, 'WORKFLOW_DISPATCH');
  assert.equal(run.createdAt, Date.parse('2026-05-22T15:04:11.000Z'));
  assert.equal(run.updatedAt, Date.parse('2026-05-22T15:05:00.000Z'));
  assert.deepEqual(
    run.jobs.map((j) => [j.key, j.type, j.status, j.buildId, j.submissionId]),
    [
      ['build_ios', 'build', 'in-progress', '5b1c1d3e-9d5b-4f0e-9b1e-111111111111', null],
      ['submit_ios', 'submission', 'new', null, null],
    ],
  );
  assert.ok(!JSON.stringify(run).includes('secrets'), 'job outputs are not read');
});

test('reading a run: terminal statuses give a conclusion; a run without jobs is fine', async () => {
  for (const [status, conclusion] of [
    ['success', 'success'],
    ['failure', 'failure'],
    ['canceled', 'cancelled'],
  ] as const) {
    const run = await expoWorkflowRun(clientFor(fakeFetch({ body: runAnswer({ status, jobs: undefined }) })), RUN_ID);
    assert.deepEqual(run.ci, { status: 'completed', conclusion });
    assert.deepEqual(run.jobs, []);
  }
});

test('reading a run: an unknown status, a bad id and bad answers are refused; 404 has its own sentence', async () => {
  const unknown = await failing(() => expoWorkflowRun(clientFor(fakeFetch({ body: runAnswer({ status: 'exploded' }) })), RUN_ID));
  assert.equal(unknown.kind, 'unexpected');
  const badId = await failing(() => expoWorkflowRun(clientFor(fakeFetch({ body: runAnswer() })), '../graphql'));
  assert.equal(badId.kind, 'invalid_input');
  const f = fakeFetch({ body: runAnswer() });
  await failing(() => expoWorkflowRun(clientFor(f), 'abc'));
  assert.equal(f.calls.length, 0, 'a bad id never reaches the network');
  const bad = await failing(() => expoWorkflowRun(clientFor(fakeFetch({ body: { data: { jobs: [runJob()] } } })), RUN_ID));
  assert.equal(bad.kind, 'unexpected');
  const missing = await failing(() => expoWorkflowRun(clientFor(fakeFetch({ status: 404 })), RUN_ID));
  assert.equal(missing.kind, 'not_found');
  assert.match(missing.message, /workflow run/);
  const forbidden = await failing(() => expoWorkflowRun(clientFor(fakeFetch({ status: 403 })), RUN_ID));
  assert.equal(forbidden.kind, 'forbidden');
});

test('the REST path cannot point the token anywhere else', async () => {
  const f = fakeFetch({ body: {} });
  const client = clientFor(f);
  for (const path of ['//evil.example.com/x', '/a/../b', '/a?b=1', 'v2/x', '/a b', '/a#b']) {
    const error = await failing(() => client.rest({ method: 'GET', path }));
    assert.equal(error.kind, 'invalid_input', path);
  }
  assert.equal(f.calls.length, 0);
});
