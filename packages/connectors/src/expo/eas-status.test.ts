import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExpoClient } from './client.ts';
import {
  ARTIFACT_URL,
  buildsBody,
  easBuild,
  easSubmission,
  submissionsBody,
} from './eas-status.fixtures.ts';
import { ExpoError } from './errors.ts';
import { PROJECT_ID, TOKEN } from './expo.fixtures.ts';
import { expoBuilds, expoSubmissions } from './queries.ts';

type Call = { query: string; variables: Record<string, unknown> };

function clientFor(...bodies: unknown[]) {
  const calls: Call[] = [];
  const queue = [...bodies];
  const fetchFn: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    calls.push({ query: body.query, variables: body.variables ?? {} });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { client: createExpoClient({ token: TOKEN, fetch: fetchFn }), calls };
}

test('builds: the query asks for one platform of the project and maps every field', async () => {
  const f = clientFor(buildsBody([easBuild()]));
  const page = await expoBuilds(f.client, PROJECT_ID.toUpperCase(), { platform: 'ios' });
  assert.deepEqual(f.calls[0]?.variables, {
    appId: PROJECT_ID,
    offset: 0,
    limit: 30,
    filter: { platform: 'IOS' },
  });
  assert.match(
    f.calls[0]?.query ?? '',
    /builds\(offset: \$offset, limit: \$limit, filter: \$filter\)/,
  );
  assert.equal(page.full, false);
  assert.deepEqual(page.items, [
    {
      id: 'b0000000-0000-4000-8000-000000000001',
      status: 'finished',
      rawStatus: 'FINISHED',
      platform: 'ios',
      buildProfile: 'production',
      channel: 'production',
      appVersion: '1.4.0',
      appBuildVersion: '57',
      sdkVersion: '52.0.0',
      runtimeVersion: '1.4.0',
      distribution: 'store',
      simulator: false,
      appIdentifier: 'com.acme.trail',
      gitCommitHash: '0123456789abcdef0123456789abcdef01234567',
      gitCommitMessage: 'Fix the trail map',
      error: null,
      hasArtifact: true,
      artifactUrl: ARTIFACT_URL,
      createdAt: Date.parse('2026-11-18T10:00:00.000Z'),
      updatedAt: Date.parse('2026-11-18T10:20:00.000Z'),
      completedAt: Date.parse('2026-11-18T10:20:00.000Z'),
      expiresAt: Date.parse('2026-12-18T10:20:00.000Z'),
    },
  ]);
  // The address of the build file is kept as `artifactUrl` (https only, ADR 0061).
});

test('builds: internal distribution, a simulator build, an Android build, statuses and errors', async () => {
  const f = clientFor(
    buildsBody([
      easBuild({
        id: 'old',
        createdAt: '2026-11-01T00:00:00.000Z',
        status: 'IN_QUEUE',
        completedAt: null,
        artifacts: null,
      }),
      easBuild({
        id: 'new',
        createdAt: '2026-11-19T00:00:00.000Z',
        status: 'ERRORED',
        platform: 'ANDROID',
        distribution: 'INTERNAL',
        error: {
          errorCode: 'EAS_BUILD_UNKNOWN_GRADLE_ERROR',
          message: 'x'.repeat(900),
          docsUrl: 'https://docs.example.invalid',
        },
        artifacts: { buildUrl: null, applicationArchiveUrl: null },
        isForIosSimulator: null,
        updateChannel: null,
        runtime: null,
      }),
      easBuild({
        id: 'sim',
        createdAt: '2026-11-10T00:00:00.000Z',
        distribution: 'SIMULATOR',
        isForIosSimulator: true,
        status: 'weird',
      }),
    ]),
  );
  const { items } = await expoBuilds(f.client, PROJECT_ID, { platform: 'android' });
  assert.deepEqual(
    items.map((b) => b.id),
    ['new', 'sim', 'old'],
    'newest first, whatever order Expo used',
  );
  const [errored, sim, queued] = items;
  assert.equal(errored?.status, 'errored');
  assert.equal(errored?.platform, 'android');
  assert.equal(errored?.distribution, 'internal');
  assert.equal(errored?.hasArtifact, false);
  assert.equal(errored?.channel, null);
  assert.equal(errored?.runtimeVersion, null);
  assert.equal(errored?.simulator, null);
  assert.equal(errored?.error?.code, 'EAS_BUILD_UNKNOWN_GRADLE_ERROR');
  assert.equal(errored?.error?.message?.length, 500, 'Expo text is cut');
  assert.equal(sim?.status, 'unknown');
  assert.equal(sim?.rawStatus, 'weird');
  assert.equal(sim?.distribution, 'simulator');
  assert.equal(sim?.simulator, true);
  assert.equal(queued?.status, 'in_queue');
  assert.equal(queued?.completedAt, null);
  assert.equal(queued?.hasArtifact, false);
});

test('builds: a full page is reported, entries without an id are dropped, odd dates become null', async () => {
  const f = clientFor(
    buildsBody([easBuild({ id: 'a', createdAt: 'not a date' }), { status: 'FINISHED' }, null]),
  );
  const page = await expoBuilds(f.client, PROJECT_ID, { platform: 'ios', limit: 3 });
  assert.equal(page.full, true, 'three entries came back for a limit of three');
  assert.deepEqual(
    page.items.map((b) => b.id),
    ['a'],
  );
  assert.equal(page.items[0]?.createdAt, null);
});

test('builds: a project Expo does not show is not_found, a bad id is refused before any request, a bad shape is unexpected', async () => {
  const none = clientFor({ data: { app: { byId: null } } });
  await assert.rejects(
    () => expoBuilds(none.client, PROJECT_ID, { platform: 'ios' }),
    (e: unknown) => e instanceof ExpoError && e.kind === 'not_found',
  );
  await assert.rejects(
    () => expoBuilds(none.client, 'nope', { platform: 'ios' }),
    (e: unknown) => e instanceof ExpoError && e.kind === 'invalid_input',
  );
  assert.equal(none.calls.length, 1);
  const odd = clientFor({ data: { app: { byId: { id: 'p', builds: 'no' } } } });
  await assert.rejects(
    () => expoBuilds(odd.client, PROJECT_ID, { platform: 'ios' }),
    (e: unknown) => e instanceof ExpoError && e.kind === 'unexpected',
  );
});

test('submissions: the query filters by platform; iOS and Android configs map to one target', async () => {
  const f = clientFor(
    submissionsBody([
      easSubmission(),
      easSubmission({
        id: 's2',
        platform: 'ANDROID',
        status: 'ERRORED',
        createdAt: '2026-11-19T11:00:00.000Z',
        completedAt: null,
        submittedBuild: null,
        iosConfig: null,
        androidConfig: {
          applicationIdentifier: 'com.acme.trail',
          track: 'INTERNAL',
          releaseStatus: 'DRAFT',
          rollout: null,
        },
        error: { errorCode: 'SUBMISSION_FAILED', message: 'The upload was refused.' },
      }),
      easSubmission({ id: 's3', status: 'AWAITING_BUILD', createdAt: '2026-11-17T00:00:00.000Z' }),
    ]),
  );
  const page = await expoSubmissions(f.client, PROJECT_ID, { platform: 'android' });
  assert.deepEqual(f.calls[0]?.variables, {
    appId: PROJECT_ID,
    offset: 0,
    limit: 30,
    platform: 'ANDROID',
  });
  assert.match(
    f.calls[0]?.query ?? '',
    /submissions\(filter: \{ platform: \$platform \}, offset: \$offset, limit: \$limit\)/,
  );
  assert.deepEqual(
    page.items.map((s) => s.id),
    ['s2', 's0000000-0000-4000-8000-000000000001', 's3'],
  );
  const [android, ios, waiting] = page.items;
  assert.equal(android?.status, 'errored');
  assert.equal(android?.platform, 'android');
  assert.equal(android?.targetIdentifier, 'com.acme.trail');
  assert.equal(android?.track, 'INTERNAL');
  assert.equal(android?.releaseStatus, 'DRAFT');
  assert.equal(android?.buildId, null);
  assert.deepEqual(android?.error, {
    code: 'SUBMISSION_FAILED',
    message: 'The upload was refused.',
  });
  assert.equal(ios?.status, 'finished');
  assert.equal(ios?.targetIdentifier, '1234567890');
  assert.equal(ios?.buildId, 'b0000000-0000-4000-8000-000000000001');
  assert.equal(waiting?.status, 'awaiting_build');
});

test('submissions: not_found, invalid project and unreadable answers', async () => {
  const none = clientFor({ data: { app: { byId: null } } });
  await assert.rejects(
    () => expoSubmissions(none.client, PROJECT_ID, { platform: 'ios' }),
    (e: unknown) => e instanceof ExpoError && e.kind === 'not_found',
  );
  await assert.rejects(
    () => expoSubmissions(none.client, 'x', { platform: 'ios' }),
    (e: unknown) => e instanceof ExpoError && e.kind === 'invalid_input',
  );
  const odd = clientFor({ data: { app: null } });
  await assert.rejects(
    () => expoSubmissions(odd.client, PROJECT_ID, { platform: 'ios' }),
    (e: unknown) => e instanceof ExpoError && e.kind === 'unexpected',
  );
});
