import { z } from 'zod';
import type { Operation } from './openapi.ts';

/**
 * The operations of "Builds to test" (docs/api/builds.md), in their own file and added to the registry in api-operations.ts.
 * Listing needs `builds.read`; downloading and handing a build to a phone need `builds.download` (explicit-only for tokens) and
 * `MRM_BUILDS_DOWNLOAD_ENABLED=true`.
 */

const W = '/api/workspaces/{workspaceId}';
const platform = z.enum(['ios', 'macos', 'android']);
const kind = z.enum(['ipa', 'apk', 'aab', 'app', 'dmg', 'pkg', 'zip', 'other']);

const artifact = z.object({
  id: z.string(),
  name: z.string(),
  kind: kind.describe('A guess from the artifact name: a workflow artifact is always a zip.'),
  guessed: z.boolean(),
  platform: platform.nullable(),
  sizeBytes: z.number().int(),
  expired: z.boolean(),
  createdAt: z.number().int().nullable(),
  expiresAt: z.number().int().nullable(),
  downloadable: z.boolean(),
  tooLarge: z.boolean(),
  run: z.object({ id: z.string(), number: z.number().int().nullable(), workflow: z.string(), title: z.string().nullable(), branch: z.string().nullable(), shortSha: z.string().nullable(), status: z.string(), conclusion: z.string().nullable(), url: z.string().nullable() }),
});

const storeBuild = z.object({
  platform,
  buildNumber: z.string(),
  version: z.string().nullable(),
  state: z.enum(['processing', 'processed', 'invalid', 'unknown']),
  rawState: z.string().nullable(),
  expired: z.boolean().nullable(),
  uploadedAt: z.number().int().nullable(),
  expiresAt: z.number().int().nullable(),
  expiresAtEstimated: z.boolean(),
  channel: z.enum(['testflight', 'play']),
  tracks: z.array(z.string()),
  releaseStatus: z.string().nullable(),
  optInUrl: z.string().nullable(),
  runId: z.string().nullable(),
});

const list = z.object({
  app: z.object({ id: z.string(), name: z.string(), platform, identifier: z.string() }),
  repository: z.object({ id: z.string(), owner: z.string(), repo: z.string() }).nullable(),
  artifacts: z.array(artifact),
  hiddenArtifacts: z.number().int(),
  truncated: z.boolean(),
  store: z.array(storeBuild),
  problem: z.object({ reason: z.enum(['no_access', 'rate_limited', 'unavailable', 'unsupported', 'no_repository']), needs: z.string().nullable().describe('`actions: read` when the GitHub credential lacks the permission.') }).nullable(),
  downloadEnabled: z.boolean(),
  maxDownloadBytes: z.number().int(),
  canDownload: z.boolean(),
  readAt: z.number().int().nullable(),
  cached: z.boolean(),
});

export const buildsOperations: Operation[] = [
  {
    id: 'listBuildArtifacts', method: 'get', path: `${W}/apps/{id}/builds/artifacts`, tags: ['builds'],
    summary: 'Builds to test: CI artifacts of the runs of an app, and the builds of the last store sync',
    description: 'READS GitHub (the artifact list of the repository: names, sizes, times; never an address) with the credential of the repository (audited as `credential.use`, purpose `builds.list`), kept 30 seconds and shared between callers; the store builds come from the last sync, no store call. Only artifacts of runs that count for this app (see `appIds` of a run) are listed; `kind` and `platform` are guesses from the name. When GitHub refuses, the answer is still `200` with `problem` (`no_access`: the credential needs `Actions: read`). Needs `builds.read` (member and above).',
    risk: 'read', access: { action: 'builds.read' }, appScope: { kind: 'param', name: 'id' }, partial: true,
    responses: { '200': { description: 'The builds.', schema: list } },
  },
  {
    id: 'downloadBuildArtifact', method: 'get', path: `${W}/apps/{id}/builds/artifacts/{artifactId}/download`, tags: ['builds'],
    summary: 'Download the zip of a CI artifact through the server',
    description: 'Streams the artifact (a zip) from GitHub through this server: the GitHub credential and the short-lived storage address never reach the caller. Needs `builds.download` (explicit-only for tokens) and `MRM_BUILDS_DOWNLOAD_ENABLED=true` (`409 builds_download_disabled`). `404` for an artifact that is not one of this app\'s, `410 artifact_expired`, `413 artifact_too_large` (limit `MRM_BUILDS_DOWNLOAD_MAX_MB`), `429` (20 a minute per workspace, 3 at a time). Audited as `build.download` with ids and a size.',
    risk: 'read', access: { action: 'builds.download' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true,
    responses: { '200': { description: 'The zip.', contentType: 'application/zip' } },
  },
  {
    id: 'createBuildDownloadLink', method: 'post', path: `${W}/apps/{id}/builds/artifacts/{artifactId}/link`, tags: ['builds'],
    summary: 'A signed link that hands one artifact to a phone (QR code)',
    description: 'Answers `{ path, expiresAt, filename }`: a path under this server (`/api/builds/dl/<token>`) that works without signing in, once, for 10 minutes, for this artifact only. The token holds ids and the person who made it, never a GitHub address; it is checked again on use (the person must still have `builds.download`). Same switch, limits and errors as the download. Audited as `build.link_created`.',
    risk: 'write', access: { action: 'builds.download' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, partial: true,
    responses: { '200': { description: 'The link.', schema: z.object({ path: z.string(), expiresAt: z.number().int(), filename: z.string() }) } },
  },
  {
    id: 'openBuildDownloadLink', method: 'get', path: '/api/builds/dl/{token}', tags: ['builds'],
    summary: 'Open a signed download link (no sign-in)',
    description: 'Public: the signed single use token is the permission. `404` for a token that is not ours, `410 link_expired` / `link_used`, `409 builds_download_disabled`. Same streaming, limits and audit as the signed-in download.',
    risk: 'read', access: 'public',
    responses: { '200': { description: 'The zip.', contentType: 'application/zip' } },
  },
];
