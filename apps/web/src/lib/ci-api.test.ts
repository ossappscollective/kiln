import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createApi, messageFor } from './api.ts';

type Call = { path: string; method: string | undefined; body: unknown };

function fake(answer: unknown = {}, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      path: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(answer), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, api: createApi({ fetch: fetchImpl }) };
}

const base = '/api/workspaces/w1/repositories/r1';

test('the CI reads go to the documented paths', async () => {
  const { calls, api } = fake();
  await api.workflows('w1', 'r1');
  await api.workflowInputs('w1', 'r1', 'ios.yml');
  await api.workflowInputs('w1', 'r1', 'ios.yml', 'release/2.4');
  await api.workflowRuns('w1', 'r1');
  await api.workflowRuns('w1', 'r1', {
    refresh: true,
    limit: 20,
    workflow: 'ios.yml',
    appId: 'a 1',
  });
  await api.workflowRun('w1', 'r1', '123');
  assert.deepEqual(
    calls.map((c) => [c.method, c.path]),
    [
      ['GET', `${base}/workflows`],
      ['GET', `${base}/workflows/ios.yml/inputs`],
      ['GET', `${base}/workflows/ios.yml/inputs?ref=release%2F2.4`],
      ['GET', `${base}/workflows/runs`],
      ['GET', `${base}/workflows/runs?refresh=true&limit=20&workflow=ios.yml&appId=a+1`],
      ['GET', `${base}/workflows/runs/123`],
    ],
  );
});

test('dispatching posts the ref, the inputs and the app, and escapes the workflow', async () => {
  const { calls, api } = fake({ dispatched: true, runKnown: false, run: {} }, 202);
  const done = await api.dispatchWorkflow('w1', 'r1', 'ios release.yml', {
    ref: 'main',
    inputs: { build_number: '241' },
    appId: 'app1',
  });
  assert.equal(done.dispatched, true);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, `${base}/workflows/ios%20release.yml/dispatches`);
  assert.deepEqual(calls[0]?.body, { ref: 'main', inputs: { build_number: '241' }, appId: 'app1' });
});

test('dispatching for several apps posts appIds, and for none posts no app at all', async () => {
  const { calls, api } = fake({ dispatched: true, runKnown: false, run: {} }, 202);
  await api.dispatchWorkflow('w1', 'r1', 'release.yml', {
    ref: 'main',
    inputs: {},
    appIds: ['a1', 'a2'],
  });
  assert.deepEqual(calls[0]?.body, { ref: 'main', inputs: {}, appIds: ['a1', 'a2'] });
  await api.dispatchWorkflow('w1', 'r1', 'release.yml', { ref: 'main', inputs: {} });
  assert.deepEqual(calls[1]?.body, { ref: 'main', inputs: {} });
});

test('the release calls use the app routes and send the request once', async () => {
  const { calls, api } = fake({});
  await api.releaseCandidates('w1', 'a1', { track: 'beta' });
  await api.releaseCandidates('w1', 'a1');
  await api.releaseEditable('w1', 'a1', 'production');
  await api.releaseNotesHistory('w1', 'a1', { platform: 'android', locale: 'en-US', limit: 10 });
  await api.stageReleaseField('w1', 'a1', { field: 'track', value: 'production' });
  await api.releasePipeline('w1', 'a1');
  await api.releasePipelineSummary('w1');
  await api.previewStoreRelease('w1', 'a1', { track: 'production', userFraction: 0.1 });
  await api.checkPlayRelease('w1', 'a1', { track: 'production', versionCodes: ['241'], status: 'draft' });
  assert.deepEqual(
    calls.map((c) => [c.method, c.path.replace(`${base.replace('/repositories/r1', '')}`, '')]),
    [
      ['GET', '/apps/a1/release/candidates?track=beta'],
      ['GET', '/apps/a1/release/candidates'],
      ['GET', '/apps/a1/release/editable?track=production'],
      ['GET', '/apps/a1/release/notes-history?platform=android&locale=en-US&limit=10'],
      ['PUT', '/apps/a1/staged/release-fields'],
      ['GET', '/apps/a1/release/pipeline'],
      ['GET', '/release/pipeline/summary'],
      ['POST', '/apps/a1/store-release/preview'],
      ['POST', '/apps/a1/release/play-check'],
    ],
  );
  assert.deepEqual(calls[4]?.body, { field: 'track', value: 'production' });
  assert.deepEqual(calls[7]?.body, { track: 'production', userFraction: 0.1 });
  assert.deepEqual(calls[8]?.body, { track: 'production', versionCodes: ['241'], status: 'draft' });
});

test('the build calls use the app routes', async () => {
  const { calls, api } = fake({ build: null });
  await api.appBuilds('w1', 'a1');
  await api.buildChanges('w1', 'a1', { platform: 'ios', buildNumber: '240' });
  await api.buildChanges('w1', 'a1', { platform: 'android', buildNumber: '241', base: '239' });
  await api.linkBuild('w1', 'a1', { platform: 'ios', buildNumber: '240' }, '777');
  await api.unlinkBuild('w1', 'a1', { platform: 'ios', buildNumber: '240' });
  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.body]),
    [
      ['GET', '/api/workspaces/w1/apps/a1/builds', undefined],
      ['GET', '/api/workspaces/w1/apps/a1/builds/changes?platform=ios&build=240', undefined],
      [
        'GET',
        '/api/workspaces/w1/apps/a1/builds/changes?platform=android&build=241&base=239',
        undefined,
      ],
      ['PUT', '/api/workspaces/w1/apps/a1/builds/ios/240/link', { runId: '777' }],
      ['DELETE', '/api/workspaces/w1/apps/a1/builds/ios/240/link', undefined],
    ],
  );
});

test('the CI error codes read as sentences, and the server message wins where it says more', async () => {
  for (const code of [
    'ci_unsupported',
    'workflow_not_found',
    'app_not_found',
    'app_repository_mismatch',
    'build_not_found',
    'build_not_linked',
    'no_base_build',
    'run_not_found',
    'run_without_commit',
  ]) {
    const text = messageFor(422, { error: code });
    assert.ok(text.length > 20 && !text.includes('request failed'), code);
  }
  assert.equal(
    messageFor(422, { error: 'build_not_found', message: 'No ios build 9.' }),
    'No ios build 9.',
  );
  assert.match(messageFor(429, { error: 'rate_limited' }, 20), /20 seconds/);
});

test('a refused dispatch becomes an ApiError that keeps the body', async () => {
  const { api } = fake(
    { error: 'github_invalid', message: "Workflow does not have 'workflow_dispatch' trigger" },
    422,
  );
  await assert.rejects(
    () => api.dispatchWorkflow('w1', 'r1', 'ios.yml', {}),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === 'github_invalid' &&
      error.status === 422 &&
      error.message.includes('workflow_dispatch'),
  );
});
