import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExpoClient } from './client.ts';
import { ExpoError } from './errors.ts';
import { PROJECT_ID, TOKEN } from './expo.fixtures.ts';
import {
  expoSetUpdateRolloutPercentage,
  expoStoreBuilds,
  expoUpdateChannels,
  expoUpdateGroupInsights,
} from './queries.ts';
import type { ExpoStoreBuild, ExpoUpdateChannel } from './types.ts';
import {
  BRANCH_MAIN,
  BRANCH_NEXT,
  build,
  buildsBody,
  channel,
  channelsBody,
  GROUP_A,
  GROUP_B,
  group,
  insightsBody,
  rolloutMapping,
  setRolloutBody,
  standardMapping,
  UPDATE_IOS,
  update,
} from './updates.fixtures.ts';
import {
  checkRuntimeVersions,
  describeCondition,
  parseBranchMapping,
  storedUpdatesOf,
} from './updates.ts';

type Call = { query: string; variables: Record<string, unknown> };

function fake(...bodies: unknown[]) {
  const calls: Call[] = [];
  const queue = [...bodies];
  const fetchFn: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Call;
    calls.push({ query: body.query, variables: body.variables ?? {} });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { client: createExpoClient({ token: TOKEN, fetch: fetchFn }), calls };
}

async function kindOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ExpoError, String(error));
    return error.kind;
  }
  throw new Error('did not throw');
}

// ---------------------------------------------------------------------------------------------
// Branch mapping

test('a standard mapping is one branch for everyone', () => {
  const mapping = parseBranchMapping(standardMapping());
  assert.deepEqual(mapping, {
    kind: 'branch',
    version: 0,
    entries: [{ branchId: BRANCH_MAIN, logic: 'always', condition: null }],
  });
});

test('a mapping with two entries is a rollout between branches, with the condition as text and no percentage', () => {
  const mapping = parseBranchMapping(rolloutMapping());
  assert.equal(mapping.kind, 'rollout');
  assert.equal(mapping.entries[0]?.branchId, BRANCH_NEXT);
  assert.equal(mapping.entries[0]?.logic, 'conditional');
  assert.equal(mapping.entries[0]?.condition, 'rolloutToken hash_lt 0.25');
  assert.equal(mapping.entries[1]?.logic, 'always');
  assert.ok(!('percent' in mapping) && !('percentage' in (mapping.entries[0] ?? {})));
});

test('an empty mapping points at no branch; anything unreadable is unreadable and never throws', () => {
  assert.equal(parseBranchMapping(JSON.stringify({ version: 0, data: [] })).kind, 'none');
  for (const bad of [
    '',
    'not json',
    '[]',
    '{"data":"x"}',
    '{"version":0,"data":[{"branchId":1}]}',
    null,
    7,
  ]) {
    assert.equal(parseBranchMapping(bad).kind, 'unreadable', String(bad));
  }
});

test('conditions are described briefly, nested statements included, and unknown shapes become ?', () => {
  assert.equal(
    describeCondition([
      'and',
      { clientKey: 'a', branchMappingOperator: '==', operand: 'x' },
      ['not', 'true'],
    ]),
    'and(a == x, not(always))',
  );
  assert.equal(
    describeCondition({ clientKey: 'a', branchMappingOperator: 'in', operand: ['x', 'y'] }),
    'a in [2]',
  );
  assert.equal(describeCondition(42), '?');
});

// ---------------------------------------------------------------------------------------------
// Queries

test('update channels are read with their branches and update groups', async () => {
  const f = fake(
    channelsBody([
      channel({
        branchMapping: rolloutMapping(),
        updateBranches: [
          {
            id: BRANCH_NEXT,
            name: 'next',
            updateGroups: [group(GROUP_B, ['ios'], { rolloutPercentage: 20 })],
          },
          { id: BRANCH_MAIN, name: 'main', updateGroups: [group(GROUP_A)] },
        ],
      }),
    ]),
  );
  const read = await expoUpdateChannels(f.client, PROJECT_ID);
  assert.equal(read.truncated, false);
  const [one] = read.channels;
  assert.equal(one?.name, 'production');
  assert.equal(one?.mapping.kind, 'rollout');
  assert.equal(one?.branches.length, 2);
  const next = one?.branches[0]?.groups[0]?.updates[0];
  assert.equal(next?.rolloutPercentage, 20);
  assert.equal(next?.platform, 'ios');
  assert.equal(next?.runtimeVersion, '1.4.0');
  assert.equal(next?.createdAt, Date.parse('2026-11-18T10:00:00.000Z'));
  assert.equal(f.calls[0]?.variables.appId, PROJECT_ID);
  assert.match(f.calls[0]?.query ?? '', /updateChannels\(offset: 0, limit: \$channelLimit\)/);
  // Read only: no mutation in the request.
  assert.ok(!/mutation/.test(f.calls[0]?.query ?? ''));
});

test('a rollout percentage of 0 or 100 is not mid-rollout; odd entries are skipped, not fatal', async () => {
  const f = fake(
    channelsBody([
      channel({
        updateBranches: [
          {
            id: BRANCH_MAIN,
            name: 'main',
            updateGroups: [
              [update({ rolloutPercentage: 100 }), { nonsense: true }],
              [
                update({
                  id: 'aa000000-0000-4000-8000-0000000000ff',
                  group: GROUP_B,
                  rolloutPercentage: 0,
                }),
              ],
              [],
              'junk',
            ],
          },
          { id: 5, name: 'bad' },
        ],
      }),
      { id: 3 },
    ]),
  );
  const read = await expoUpdateChannels(f.client, PROJECT_ID);
  assert.equal(read.channels.length, 1);
  const groups = read.channels[0]?.branches[0]?.groups ?? [];
  assert.equal(read.channels[0]?.branches.length, 1);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((g) => g.updates[0]?.rolloutPercentage),
    [null, null],
  );
});

test('a full page of channels is marked truncated; a project Expo does not have is not_found; a bad id is refused unsent', async () => {
  const many = Array.from({ length: 25 }, (_, i) => channel({ id: `c${i}`, name: `ch${i}` }));
  const f = fake(channelsBody(many));
  assert.equal((await expoUpdateChannels(f.client, PROJECT_ID)).truncated, true);
  const none = fake({ data: { app: { byId: null } } });
  assert.equal(await kindOf(() => expoUpdateChannels(none.client, PROJECT_ID)), 'not_found');
  const unsent = fake({});
  assert.equal(await kindOf(() => expoUpdateChannels(unsent.client, 'nope')), 'invalid_input');
  assert.equal(unsent.calls.length, 0);
  const odd = fake({ data: { app: { byId: { updateChannels: 'x' } } } });
  assert.equal(await kindOf(() => expoUpdateChannels(odd.client, PROJECT_ID)), 'unexpected');
});

test('store builds are asked with the platform, FINISHED and STORE, and a build that is not both is dropped', async () => {
  const f = fake(
    buildsBody([
      build(),
      build({ id: 'dd000000-0000-4000-8000-000000000002', distribution: 'INTERNAL' }),
      build({ id: 'dd000000-0000-4000-8000-000000000003', status: 'ERRORED' }),
      build({ id: 'dd000000-0000-4000-8000-000000000004', runtime: null, updateChannel: null }),
    ]),
  );
  const builds = await expoStoreBuilds(f.client, PROJECT_ID, { platform: 'ios' });
  assert.deepEqual(f.calls[0]?.variables.filter, {
    platform: 'IOS',
    status: 'FINISHED',
    distribution: 'STORE',
  });
  assert.equal(builds.length, 2);
  assert.equal(builds[0]?.runtimeVersion, '1.4.0');
  assert.equal(builds[0]?.channel, 'production');
  assert.equal(builds[1]?.runtimeVersion, null);
  assert.equal(builds[1]?.channel, null);
  const android = fake(buildsBody([]));
  await expoStoreBuilds(android.client, PROJECT_ID, { platform: 'android', limit: 5 });
  assert.equal((android.calls[0]?.variables.filter as { platform: string }).platform, 'ANDROID');
  assert.equal(android.calls[0]?.variables.limit, 5);
});

test('insights: launches, failed launches, the crash rate, unique users and payload size per platform', async () => {
  const f = fake(insightsBody());
  const start = Date.parse('2026-11-13T00:00:00Z');
  const end = Date.parse('2026-11-20T00:00:00Z');
  const found = await expoUpdateGroupInsights(f.client, GROUP_A, { start, end });
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], {
    updateId: 'aa000000-0000-4000-8000-000000000001',
    platform: 'ios',
    launches: 380,
    failedLaunches: 20,
    crashRatePercent: 5,
    uniqueUsers: 120,
    launchAssetCount: 14.5,
    averagePayloadBytes: 482_113,
  });
  assert.deepEqual(f.calls[0]?.variables.timespan, {
    start: '2026-11-13T00:00:00.000Z',
    end: '2026-11-20T00:00:00.000Z',
  });
  assert.equal(f.calls[0]?.variables.groupId, GROUP_A);
});

test('insights: no launches gives no crash rate (not 0), a missing group is not_found, bad input is refused unsent', async () => {
  const empty = fake({
    data: {
      updatesByGroup: [
        {
          id: UPDATE_IOS,
          platform: 'ios',
          insights: {
            totalUniqueUsers: 0,
            cumulativeMetrics: {
              metricsAtLastTimestamp: { totalInstalls: 0, totalFailedInstalls: 0 },
            },
          },
        },
      ],
    },
  });
  const [one] = await expoUpdateGroupInsights(empty.client, GROUP_A, { start: 1, end: 2 });
  assert.equal(one?.crashRatePercent, null);
  assert.equal(one?.launches, 0);
  assert.equal(one?.averagePayloadBytes, null);
  assert.equal(
    await kindOf(() =>
      expoUpdateGroupInsights(fake({ data: { updatesByGroup: [] } }).client, GROUP_A, {
        start: 1,
        end: 2,
      }),
    ),
    'not_found',
  );
  const unsent = fake({});
  assert.equal(
    await kindOf(() => expoUpdateGroupInsights(unsent.client, 'x; drop', { start: 1, end: 2 })),
    'invalid_input',
  );
  assert.equal(
    await kindOf(() => expoUpdateGroupInsights(unsent.client, GROUP_A, { start: 5, end: 5 })),
    'invalid_input',
  );
  assert.equal(unsent.calls.length, 0);
});

test('the rollout mutation sends the update id and the percentage as variables and reads the result back', async () => {
  const f = fake(setRolloutBody(50));
  const done = await expoSetUpdateRolloutPercentage(f.client, UPDATE_IOS, 50);
  assert.deepEqual(done, { updateId: UPDATE_IOS, group: GROUP_A, rolloutPercentage: 50 });
  assert.deepEqual(f.calls[0]?.variables, { updateId: UPDATE_IOS, rolloutPercentage: 50 });
  assert.match(
    f.calls[0]?.query ?? '',
    /setRolloutPercentage\(updateId: \$updateId, percentage: \$rolloutPercentage\)/,
  );
  const unsent = fake({});
  for (const [id, pct] of [
    [UPDATE_IOS, 0],
    [UPDATE_IOS, 101],
    [UPDATE_IOS, 12.5],
    ['x', 50],
  ] as const) {
    assert.equal(
      await kindOf(() => expoSetUpdateRolloutPercentage(unsent.client, id, pct)),
      'invalid_input',
    );
  }
  assert.equal(unsent.calls.length, 0);
  assert.equal(
    await kindOf(() =>
      expoSetUpdateRolloutPercentage(fake({ data: { update: null } }).client, UPDATE_IOS, 50),
    ),
    'unexpected',
  );
});

// ---------------------------------------------------------------------------------------------
// Runtime version mismatch

const ch = (
  name: string,
  runtimes: { rv: string | null; at: string; branch?: string }[],
): ExpoUpdateChannel => ({
  id: name,
  name,
  isPaused: false,
  isProtected: false,
  createdAt: null,
  updatedAt: null,
  mapping: parseBranchMapping(standardMapping()),
  branches: [
    {
      id: 'b',
      name: 'main',
      groups: runtimes.map((r, i) => ({
        group: `g${i}`,
        updates: [
          {
            id: `u${i}`,
            group: `g${i}`,
            message: null,
            createdAt: Date.parse(r.at),
            platform: 'ios',
            runtimeVersion: r.rv,
            gitCommitHash: null,
            isRollBackToEmbedded: false,
            rolloutPercentage: null,
            rolloutControlGroup: null,
          },
        ],
      })),
    },
  ],
});

const bld = (
  id: string,
  rv: string | null,
  channelName: string | null,
  at: string,
): ExpoStoreBuild => ({
  id,
  platform: 'ios',
  runtimeVersion: rv,
  appVersion: null,
  appBuildVersion: null,
  channel: channelName,
  createdAt: Date.parse(at),
  completedAt: null,
});

test('runtime check: matching the newest store build is ok', () => {
  const [r] = checkRuntimeVersions({
    channels: [ch('production', [{ rv: '1.4.0', at: '2026-11-18T00:00:00Z' }])],
    builds: [bld('b1', '1.4.0', 'production', '2026-11-10T00:00:00Z')],
  });
  assert.equal(r?.status, 'ok');
  assert.equal(r?.severity, 'none');
  assert.deepEqual(r?.shippedRuntimeVersions, ['1.4.0']);
});

test('runtime check: an update whose runtime no store build has is a mismatch (error) that names both sides', () => {
  const [r] = checkRuntimeVersions({
    channels: [
      ch('production', [
        { rv: '1.5.0', at: '2026-11-18T00:00:00Z' },
        { rv: '1.4.0', at: '2026-11-01T00:00:00Z' },
      ]),
    ],
    builds: [
      bld('b1', '1.4.0', 'production', '2026-11-10T00:00:00Z'),
      bld('b0', '1.3.0', 'production', '2026-10-01T00:00:00Z'),
    ],
  });
  assert.equal(r?.status, 'mismatch');
  assert.equal(r?.severity, 'error');
  assert.match(r?.message ?? '', /1\.5\.0/);
  assert.match(r?.message ?? '', /1\.4\.0, 1\.3\.0/);
  assert.equal(r?.latestUpdate?.runtimeVersion, '1.5.0');
  assert.equal(r?.latestBuild?.id, 'b1');
});

test('runtime check: updates that reach only an older build leave the newest build unreached (warning)', () => {
  const [r] = checkRuntimeVersions({
    channels: [ch('production', [{ rv: '1.3.0', at: '2026-11-18T00:00:00Z' }])],
    builds: [
      bld('b1', '1.4.0', 'production', '2026-11-10T00:00:00Z'),
      bld('b0', '1.3.0', 'production', '2026-10-01T00:00:00Z'),
    ],
  });
  assert.equal(r?.status, 'newest_build_unreached');
  assert.equal(r?.severity, 'warning');
});

test('runtime check: only builds that bake in the channel count, and what cannot be compared is info, never an error', () => {
  const rows = checkRuntimeVersions({
    channels: [
      ch('production', [{ rv: '2.0.0', at: '2026-11-18T00:00:00Z' }]),
      ch('staging', []),
      ch('preview', [{ rv: null, at: '2026-11-18T00:00:00Z' }]),
    ],
    builds: [
      bld('b1', '1.4.0', 'staging', '2026-11-10T00:00:00Z'),
      bld('b2', '1.4.0', 'preview', '2026-11-10T00:00:00Z'),
      bld('b3', '1.4.0', null, '2026-11-10T00:00:00Z'),
    ],
  });
  assert.deepEqual(
    rows.map((r) => [r.channel, r.status, r.severity]),
    [
      ['production', 'no_builds', 'info'],
      ['staging', 'no_updates', 'info'],
      ['preview', 'unknown', 'info'],
    ],
  );
});

test('runtime check: the newest update across all branches of the channel is the one compared', () => {
  const channelWithTwo = ch('production', [{ rv: '1.4.0', at: '2026-11-01T00:00:00Z' }]);
  channelWithTwo.branches.push({
    id: 'b2',
    name: 'next',
    groups: [
      {
        group: 'gx',
        updates: [
          {
            id: 'ux',
            group: 'gx',
            message: null,
            createdAt: Date.parse('2026-11-19T00:00:00Z'),
            platform: 'ios',
            runtimeVersion: '9.9.9',
            gitCommitHash: null,
            isRollBackToEmbedded: false,
            rolloutPercentage: null,
            rolloutControlGroup: null,
          },
        ],
      },
    ],
  });
  const [r] = checkRuntimeVersions({
    channels: [channelWithTwo],
    builds: [bld('b1', '1.4.0', 'production', '2026-11-10T00:00:00Z')],
  });
  assert.equal(r?.status, 'mismatch');
  assert.equal(r?.latestUpdate?.branch, 'next');
});

test('store builds of another platform than asked are dropped even when Expo ignores the filter', async () => {
  const f = fake(
    buildsBody([
      build({ platform: 'ANDROID' }),
      build({ id: 'dd000000-0000-4000-8000-000000000005' }),
    ]),
  );
  const builds = await expoStoreBuilds(f.client, PROJECT_ID, { platform: 'ios' });
  assert.deepEqual(
    builds.map((b) => b.id),
    ['dd000000-0000-4000-8000-000000000005'],
  );
});

test('storedUpdatesOf keeps the current update of each channel and the mid-rollout ones, for one platform', async () => {
  const groups = (id: string, platforms: string[], overrides: Record<string, unknown>) =>
    group(id, platforms, { message: 'Line one\nline two', ...overrides });
  const f = fake(
    channelsBody([
      channel({
        // The mapping names main only: next is not served, so its newer update is not "current", but its rollout is kept.
        updateBranches: [
          {
            id: BRANCH_MAIN,
            name: 'main',
            updateGroups: [
              groups(GROUP_A, ['ios', 'android'], { createdAt: '2026-11-18T10:00:00.000Z' }),
            ],
          },
          {
            id: BRANCH_NEXT,
            name: 'next',
            updateGroups: [
              groups(GROUP_B, ['ios'], {
                createdAt: '2026-11-20T10:00:00.000Z',
                rolloutPercentage: 100,
              }),
            ],
          },
        ],
      }),
      channel({
        id: 'cc000000-0000-4000-8000-000000000002',
        name: 'staging',
        branchMapping: rolloutMapping(),
        updateBranches: [
          {
            id: BRANCH_NEXT,
            name: 'next',
            updateGroups: [
              groups(GROUP_B, ['ios', 'android'], {
                createdAt: '2026-11-20T10:00:00.000Z',
                rolloutPercentage: 25,
              }),
            ],
          },
          {
            id: BRANCH_MAIN,
            name: 'main',
            updateGroups: [
              groups(GROUP_A, ['ios', 'android'], { createdAt: '2026-11-18T10:00:00.000Z' }),
            ],
          },
        ],
      }),
    ]),
  );
  const read = await expoUpdateChannels(f.client, PROJECT_ID);
  const rows = storedUpdatesOf(read.channels, 'ios');
  const view = rows.map((r) => [r.channel, r.group, r.isCurrent, r.rolloutPercentage]);
  assert.deepEqual(view, [
    ['production', GROUP_A, true, null],
    ['staging', GROUP_B, true, 25],
  ]);
  assert.equal(rows[0]?.message, 'Line one', 'the first line of the message only');
  assert.ok(rows.every((r) => r.platform === 'ios'));
  assert.deepEqual(
    storedUpdatesOf(read.channels, 'android').map((r) => r.channel),
    ['production', 'staging'],
  );
  assert.deepEqual(storedUpdatesOf([], 'ios'), []);
});
