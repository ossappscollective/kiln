/**
 * Response bodies shaped like Expo's Workflows REST API, written from https://docs.expo.dev/eas/workflows/rest-api/ (read 2026-11-20),
 * not recorded from a live account. The ids are made up; `url` follows the example in the docs.
 */

export const RUN_ID = '019d9d17-013a-7e05-89aa-4aa83ff68c32';

export const dispatchAnswer = (id: string = RUN_ID) => ({
  data: { id, url: `https://expo.dev/accounts/acme/projects/trail-notes/workflows/${id}` },
});

export const runJob = (overrides: Record<string, unknown> = {}) => ({
  id: '019d9d17-0200-7a00-8000-000000000001',
  key: 'build_ios',
  name: 'Build iOS',
  type: 'build',
  status: 'in-progress',
  requiredJobKeys: [],
  environment: 'production',
  outputs: { token: '${{ secrets.SECRET }}' },
  errors: [],
  buildId: '5b1c1d3e-9d5b-4f0e-9b1e-111111111111',
  submissionId: null,
  createdAt: '2026-05-22T15:04:12.000Z',
  updatedAt: '2026-05-22T15:05:00.000Z',
  ...overrides,
});

export const runAnswer = (overrides: Record<string, unknown> = {}) => ({
  data: {
    id: RUN_ID,
    status: 'in-progress',
    url: `https://expo.dev/accounts/acme/projects/trail-notes/workflows/${RUN_ID}`,
    gitCommitHash: '8c1f0a9d2e3b4c5d6e7f8091a2b3c4d5e6f70812',
    gitCommitMessage: 'Bump build number\n\nLong body that is never kept.',
    requestedGitRef: 'refs/heads/main',
    triggerEventType: 'WORKFLOW_DISPATCH',
    createdAt: '2026-05-22T15:04:11.000Z',
    updatedAt: '2026-05-22T15:05:00.000Z',
    jobs: [
      runJob(),
      runJob({
        id: '019d9d17-0200-7a00-8000-000000000002',
        key: 'submit_ios',
        name: 'Submit iOS',
        type: 'submission',
        status: 'new',
        buildId: null,
        submissionId: null,
      }),
    ],
    ...overrides,
  },
});
