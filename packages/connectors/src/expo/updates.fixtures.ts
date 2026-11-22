/**
 * Response bodies shaped like Expo's EAS Update queries (docs/adr/0037-eas-update.md), trimmed to the fields queries.ts selects.
 * Written from eas-cli's query documents, not recorded from a live account. Not a test file.
 */

export const GROUP_A = '6f0c1b52-3a4e-4d7f-9b8a-1c2d3e4f5a61';
export const GROUP_B = '7a1d2c63-4b5f-4e80-8c9b-2d3e4f5a6b72';
export const GROUP_C = '8b2e3d74-5c60-4f91-9dac-3e4f5a6b7c83';
export const UPDATE_IOS = 'aa000000-0000-4000-8000-000000000001';
export const UPDATE_ANDROID = 'aa000000-0000-4000-8000-000000000002';
export const BRANCH_MAIN = 'bb000000-0000-4000-8000-000000000001';
export const BRANCH_NEXT = 'bb000000-0000-4000-8000-000000000002';

export const update = (overrides: Record<string, unknown> = {}) => ({
  id: UPDATE_IOS,
  group: GROUP_A,
  message: 'Fix the login button',
  createdAt: '2026-11-18T10:00:00.000Z',
  runtime: { version: '1.4.0' },
  platform: 'ios',
  gitCommitHash: '0123456789abcdef0123456789abcdef01234567',
  isRollBackToEmbedded: false,
  rolloutPercentage: null,
  rolloutControlUpdate: null,
  ...overrides,
});

/** One group: the same update for the platforms asked for. */
export const group = (
  id: string,
  platforms: string[] = ['ios', 'android'],
  overrides: Record<string, unknown> = {},
) =>
  platforms.map((platform, i) =>
    update({
      id: `aa${id.slice(2, 8)}-0000-4000-8000-00000000000${i + 1}`,
      group: id,
      platform,
      ...overrides,
    }),
  );

export const standardMapping = (branchId = BRANCH_MAIN) =>
  JSON.stringify({ version: 0, data: [{ branchId, branchMappingLogic: 'true' }] });

export const rolloutMapping = () =>
  JSON.stringify({
    version: 0,
    data: [
      {
        branchId: BRANCH_NEXT,
        branchMappingLogic: {
          clientKey: 'rolloutToken',
          branchMappingOperator: 'hash_lt',
          operand: 0.25,
        },
      },
      { branchId: BRANCH_MAIN, branchMappingLogic: 'true' },
    ],
  });

export const channel = (overrides: Record<string, unknown> = {}) => ({
  id: 'cc000000-0000-4000-8000-000000000001',
  name: 'production',
  isPaused: false,
  isProtected: false,
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-11-18T10:00:00.000Z',
  branchMapping: standardMapping(),
  updateBranches: [{ id: BRANCH_MAIN, name: 'main', updateGroups: [group(GROUP_A)] }],
  ...overrides,
});

export const channelsBody = (channels: unknown[] = [channel()]) => ({
  data: { app: { byId: { id: 'p', updateChannels: channels } } },
});

export const build = (overrides: Record<string, unknown> = {}) => ({
  id: 'dd000000-0000-4000-8000-000000000001',
  status: 'FINISHED',
  platform: 'IOS',
  distribution: 'STORE',
  appVersion: '1.4.0',
  appBuildVersion: '57',
  runtime: { version: '1.4.0' },
  updateChannel: { name: 'production' },
  createdAt: '2026-11-10T09:00:00.000Z',
  completedAt: '2026-11-10T09:20:00.000Z',
  ...overrides,
});

export const buildsBody = (builds: unknown[] = [build()]) => ({
  data: { app: { byId: { id: 'p', builds } } },
});

export const insightsBody = (platforms: string[] = ['ios', 'android']) => ({
  data: {
    updatesByGroup: platforms.map((platform, i) => ({
      id: `aa000000-0000-4000-8000-00000000000${i + 1}`,
      platform,
      insights: {
        totalUniqueUsers: 120 + i,
        cumulativeAverageMetrics: { launchAssetCount: 14.5, averageUpdatePayloadBytes: 482_113 },
        cumulativeMetrics: {
          metricsAtLastTimestamp: { totalInstalls: 380, totalFailedInstalls: 20 },
        },
      },
    })),
  },
});

export const setRolloutBody = (percentage = 50, id = UPDATE_IOS) => ({
  data: { update: { setRolloutPercentage: { id, group: GROUP_A, rolloutPercentage: percentage } } },
});
