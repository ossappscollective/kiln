/**
 * Response bodies shaped like Expo's GraphQL answers for builds and submissions, trimmed to the fields the status queries select (see the
 * comment above EAS_BUILDS_QUERY in queries.ts for where each field was checked). Written from eas-cli's query documents and the enums of
 * its generated client, not recorded from a live account. The artifact addresses are fake and must never appear in anything the server returns.
 */

export const ARTIFACT_URL = 'https://artifacts.example.invalid/builds/secret-signed-path/app.ipa?X-Signature=abc123';

export const easBuild = (overrides: Record<string, unknown> = {}) => ({
  id: 'b0000000-0000-4000-8000-000000000001',
  status: 'FINISHED',
  platform: 'IOS',
  error: null,
  artifacts: { buildUrl: ARTIFACT_URL, applicationArchiveUrl: null },
  updateChannel: { name: 'production' },
  distribution: 'STORE',
  buildProfile: 'production',
  appIdentifier: 'com.acme.trail',
  sdkVersion: '52.0.0',
  appVersion: '1.4.0',
  appBuildVersion: '57',
  runtime: { version: '1.4.0' },
  gitCommitHash: '0123456789abcdef0123456789abcdef01234567',
  gitCommitMessage: 'Fix the trail map\n\nLong body that is not kept.',
  createdAt: '2026-11-18T10:00:00.000Z',
  updatedAt: '2026-11-18T10:20:00.000Z',
  completedAt: '2026-11-18T10:20:00.000Z',
  expirationDate: '2026-12-18T10:20:00.000Z',
  isForIosSimulator: false,
  ...overrides,
});

export const easSubmission = (overrides: Record<string, unknown> = {}) => ({
  id: 's0000000-0000-4000-8000-000000000001',
  status: 'FINISHED',
  platform: 'IOS',
  createdAt: '2026-11-18T11:00:00.000Z',
  completedAt: '2026-11-18T11:05:00.000Z',
  submittedBuild: { id: 'b0000000-0000-4000-8000-000000000001' },
  androidConfig: null,
  iosConfig: { ascAppIdentifier: '1234567890' },
  error: null,
  ...overrides,
});

export const buildsBody = (builds: unknown[]) => ({ data: { app: { byId: { id: 'p', builds } } } });
export const submissionsBody = (submissions: unknown[]) => ({
  data: { app: { byId: { id: 'p', submissions } } },
});
