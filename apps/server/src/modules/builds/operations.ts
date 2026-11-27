import { z } from 'zod';
import type { Operation } from '../../operations/openapi.ts';
import { internalShareApplyBody, internalSharePreviewBody } from './internal-sharing-routes.ts';

/**
 * The operations of "Builds to test" (docs/api/builds.md), in their own file and added to the registry in api-operations.ts.
 * Listing needs `builds.read`; downloading and handing a build to a phone need `builds.download` (explicit-only for tokens) and
 * `KILN_BUILDS_DOWNLOAD_ENABLED=true`. Sharing an Android build through Google Play internal app sharing (docs/api/internal-sharing.md) needs `builds.share`
 * (owner and admin; explicit-only for tokens), `KILN_PLAY_INTERNAL_SHARING_ENABLED=true` and, when the policy covers it, a step-up confirmation.
 */

const W = '/api/workspaces/{workspaceId}';
const platform = z.enum(['ios', 'macos', 'android']);
const kind = z.enum(['ipa', 'apk', 'aab', 'app', 'dmg', 'pkg', 'zip', 'other']);

const artifactBuild = z.object({
  number: z.string().describe('The Android versionCode or the iOS CFBundleVersion.'),
  version: z.string().nullable().describe('versionName or CFBundleShortVersionString.'),
  packageId: z.string().nullable(),
  format: z.enum(['apk', 'aab', 'ipa']),
});

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
  build: artifactBuild
    .nullable()
    .describe(
      'The real build number read from inside the file (`inspectBuildArtifact`); null until it was read, and when the file held none.',
    ),
  buildRead: z
    .enum(['read', 'unreadable'])
    .nullable()
    .describe(
      '`read`, `unreadable` (looked at, no build number found) or null (not looked at yet).',
    ),
  run: z.object({
    id: z.string(),
    number: z.number().int().nullable(),
    workflow: z.string(),
    title: z.string().nullable(),
    branch: z.string().nullable(),
    shortSha: z.string().nullable(),
    status: z.string(),
    conclusion: z.string().nullable(),
    url: z.string().nullable(),
  }),
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
  origin: z
    .object({
      version: z
        .string()
        .nullable()
        .describe('The version name: from the CI file read for this build, else the store row, else (Google Play) the name of the release holding the code.'),
      builtAt: z
        .number()
        .int()
        .nullable()
        .describe('When the build was made: the date GitHub made the CI artifact, else the store upload time. Null: not known (see `builtGap`).'),
      origin: z.enum(['ci', 'store', 'release']).nullable().describe('Where `version` came from, else where `builtAt` came from.'),
      builtFrom: z.enum(['ci', 'store']).nullable(),
      builtGap: z
        .enum(['not_read', 'reads_disabled', 'file_gone', 'github_unreachable', 'github_no_access', 'no_repository'])
        .nullable()
        .describe('Why `builtAt` is null: no CI file read yet (`not_read`), this server does not read builds (`reads_disabled`: KILN_BUILDS_DOWNLOAD_ENABLED), the file is gone from GitHub, GitHub cannot be reached or refuses, or no repository is linked.'),
      ciExpiredAt: z.number().int().nullable(),
      matchedBy: z.enum(['package', 'build_number_only']).nullable(),
      firstSeenAt: z.number().int().nullable().describe('When this server first saw the build. NOT a build date.'),
      ci: z
        .object({
          runNumber: z.number().int().nullable(),
          branch: z.string().nullable(),
          commit: z.string().nullable(),
          url: z.string().nullable(),
        })
        .nullable(),
    })
    .describe('Where the build came from, joined once on the server (the same join the release candidates use).'),
});

const list = z.object({
  app: z.object({ id: z.string(), name: z.string(), platform, identifier: z.string() }),
  repository: z.object({ id: z.string(), owner: z.string(), repo: z.string() }).nullable(),
  artifacts: z.array(artifact),
  hiddenArtifacts: z.number().int(),
  truncated: z.boolean(),
  store: z.array(storeBuild),
  problem: z
    .object({
      reason: z.enum(['no_access', 'rate_limited', 'unavailable', 'unsupported', 'no_repository']),
      needs: z
        .string()
        .nullable()
        .describe('`actions: read` when the GitHub credential lacks the permission.'),
    })
    .nullable(),
  downloadEnabled: z.boolean(),
  maxDownloadBytes: z.number().int(),
  canDownload: z.boolean(),
  readAt: z.number().int().nullable(),
  cached: z.boolean(),
});

const shareView = z.object({
  id: z.string(),
  appId: z.string(),
  artifactId: z.string(),
  runId: z.string().nullable(),
  packageName: z.string(),
  kind: z.enum(['bundle', 'apk']),
  fileName: z.string().nullable(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  certificateFingerprint: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  hasLink: z
    .boolean()
    .describe(
      'True while this server still holds the link (24 hours). The link itself is never in a list.',
    ),
});
const shareCheck = z.object({
  code: z.string(),
  severity: z.enum(['blocking', 'warning']),
  message: z.string(),
});
const sharePreview = z.object({
  app: z.object({ id: z.string(), name: z.string(), platform, identifier: z.string() }),
  artifact: z.object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    sizeBytes: z.number().int(),
    zipSha256: z.string().nullable(),
    runId: z.string().nullable(),
    headSha: z.string().nullable(),
    createdAt: z.number().int().nullable(),
    expiresAt: z.number().int().nullable(),
  }),
  upload: z.object({
    packageName: z.string(),
    kind: z.enum(['bundle', 'apk']).nullable(),
    fileName: z.string().nullable(),
    entry: z.string().nullable(),
    versionCode: z.null(),
    sha256: z.null(),
    maxSizeBytes: z.number().int(),
  }),
  effects: z.array(z.string()),
  linkRetentionHours: z.number().int(),
  checks: z.object({
    blocking: z.array(shareCheck),
    warnings: z.array(shareCheck),
    canShare: z.boolean(),
  }),
  confirmHash: z.string().nullable(),
  confirmation: z.object({ phrase: z.string(), instruction: z.string() }).nullable(),
  readAt: z.number().int(),
});
const shareConfig = z.object({
  enabled: z
    .boolean()
    .describe(
      'KILN_PLAY_INTERNAL_SHARING_ENABLED (default false). While false every sharing route but this one answers `409 internal_sharing_disabled`.',
    ),
  envName: z.string(),
  action: z.literal('builds.share'),
  minimumRole: z.literal('admin'),
  stepUpClass: z.literal('internal_sharing'),
  linkRetentionHours: z.number().int(),
  maxBytes: z.number().int(),
  canShare: z.boolean().describe("Whether the caller's role may share."),
  note: z.string(),
});

export const buildsOperations: Operation[] = [
  {
    id: 'listBuildArtifacts',
    method: 'get',
    path: `${W}/apps/{id}/builds/artifacts`,
    tags: ['builds'],
    summary:
      'Builds to test: CI artifacts of the runs of an app, and the builds of the last store sync',
    description:
      'READS GitHub (the artifact list of the repository: names, sizes, times; never an address) with the credential of the repository (audited as `credential.use`, purpose `builds.list`), kept 30 seconds and shared between callers; the store builds come from the last sync. For an iOS or macOS app it also READS the external TestFlight groups with a public link from App Store Connect (GET only, cached 30 seconds, audited as `credential.use`, purpose `builds.testflight`); nothing is ever created, enabled or changed in the store. Only artifacts of runs that count for this app (see `appIds` of a run) are listed; `kind` and `platform` are guesses from the name. When GitHub refuses, the answer is still `200` with `problem` (`no_access`: the credential needs `Actions: read`). Needs `builds.read` (member and above).',
    risk: 'read',
    access: { action: 'builds.read' },
    appScope: { kind: 'param', name: 'id' },
    partial: true,
    responses: { '200': { description: 'The builds.', schema: list } },
  },
  {
    id: 'downloadBuildArtifact',
    method: 'get',
    path: `${W}/apps/{id}/builds/artifacts/{artifactId}/download`,
    tags: ['builds'],
    summary: 'Download the zip of a CI artifact through the server',
    description:
      "Streams the artifact (a zip) from GitHub through this server: the GitHub credential and the short-lived storage address never reach the caller. Needs `builds.download` (explicit-only for tokens) and `KILN_BUILDS_DOWNLOAD_ENABLED=true` (`409 builds_download_disabled`). `404` for an artifact that is not one of this app's, `410 artifact_expired`, `413 artifact_too_large` (limit `KILN_BUILDS_DOWNLOAD_MAX_MB`), `429` (20 a minute per workspace, 3 at a time). Audited as `build.download` with ids and a size.",
    risk: 'read',
    access: { action: 'builds.download' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    responses: { '200': { description: 'The zip.', contentType: 'application/zip' } },
  },
  {
    id: 'inspectBuildArtifact',
    method: 'post',
    path: `${W}/apps/{id}/builds/artifacts/{artifactId}/inspect`,
    tags: ['builds'],
    summary: 'Read the real build number (versionCode, CFBundleVersion) from inside a CI artifact',
    description:
      "Downloads the artifact ONCE through this server (the same guarded path as a download: the GitHub credential never leaves the server, audited as `credential.use`, purpose `builds.download`; no `build.download` audit row, nothing is handed to the caller) into a temporary file that is deleted before the answer, looks for an .apk, .aab or .ipa in it (or an unpacked app), reads its manifest or `Info.plist` and keeps the result per app and artifact. Answers `{ artifact }`: the same item as the list, with `build` ({ number, version, packageId, format }) and `buildRead` (`read`, or `unreadable` when the file held no build number: kept, so it is not downloaded again). An artifact already read answers from the store with no download. One read at a time per app. Needs `builds.download` (explicit-only for tokens) and `KILN_BUILDS_DOWNLOAD_ENABLED=true` (`409 builds_download_disabled`). `404` for an artifact that is not one of this app's, `410 artifact_expired`, `413 artifact_too_large` (limit `KILN_BUILDS_DOWNLOAD_MAX_MB`), `429` (shares the download limits), `502 download_failed` (not kept: it may work next time). Parsing is written from the documented file layouts and has not been run against real store files.",
    risk: 'read',
    access: { action: 'builds.download' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    responses: {
      '200': {
        description: 'The artifact, with its build number.',
        schema: z.object({ artifact }),
      },
    },
  },
  {
    id: 'createBuildDownloadLink',
    method: 'post',
    path: `${W}/apps/{id}/builds/artifacts/{artifactId}/link`,
    tags: ['builds'],
    summary: 'A signed link that hands one artifact to a phone (QR code)',
    description:
      'Answers `{ path, expiresAt, filename }`: a path under this server (`/api/builds/dl/<token>`) that works without signing in, once, for 10 minutes, for this artifact only. The token holds ids and the person who made it, never a GitHub address; it is checked again on use (the person must still have `builds.download`). Same switch, limits and errors as the download. Audited as `build.link_created`.',
    risk: 'write',
    access: { action: 'builds.download' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    partial: true,
    responses: {
      '200': {
        description: 'The link.',
        schema: z.object({ path: z.string(), expiresAt: z.number().int(), filename: z.string() }),
      },
    },
  },
  {
    id: 'openBuildDownloadLink',
    method: 'get',
    path: '/api/builds/dl/{token}',
    tags: ['builds'],
    summary: 'Open a signed download link (no sign-in)',
    description:
      'Public: the signed single use token is the permission. `404` for a token that is not ours, `410 link_expired` / `link_used`, `409 builds_download_disabled`. Same streaming, limits and audit as the signed-in download.',
    risk: 'read',
    access: 'public',
    responses: { '200': { description: 'The zip.', contentType: 'application/zip' } },
  },
  {
    id: 'getInternalSharingConfig',
    method: 'get',
    path: `${W}/builds/internal-sharing/config`,
    tags: ['builds'],
    summary:
      'Whether Google Play internal app sharing is switched on, and whether the caller may share',
    description: 'Needs `builds.read`. Reads nothing from Google.',
    risk: 'read',
    access: { action: 'builds.read' },
    responses: {
      '200': {
        description: 'The switch, the action, the lowest role and the step-up class.',
        schema: shareConfig,
      },
    },
  },
  {
    id: 'listInternalShares',
    method: 'get',
    path: `${W}/apps/{id}/builds/internal-shares`,
    tags: ['builds'],
    summary:
      'Builds shared through Google Play internal app sharing for an app, newest first, WITHOUT links',
    description:
      'Needs `builds.share` and `KILN_PLAY_INTERNAL_SHARING_ENABLED=true` (`409 internal_sharing_disabled`). Database only: no Google call. `hasLink` says whether this server still holds the link (24 hours); the link is not in the list, read it with `getInternalShareLink`. `inFlight` is an upload running now; `unknownOutcome` an upload whose result is not known (a preview clears it).',
    risk: 'read',
    access: { action: 'builds.share' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The shares.',
        schema: z.object({
          enabled: z.boolean(),
          inFlight: z.boolean(),
          unknownOutcome: z.boolean(),
          shares: z.array(shareView),
        }),
      },
    },
  },
  {
    id: 'getInternalShareLink',
    method: 'get',
    path: `${W}/apps/{id}/builds/internal-shares/{shareId}/link`,
    tags: ['builds'],
    summary: 'The install link of one shared build (a secret)',
    description:
      'Needs `builds.share`. The link is stored ENCRYPTED and cleared 24 hours after the upload (`410 link_expired`). `Cache-Control: no-store`. Audited as `build.share_link_read` (ids only: the link is never in an audit row, an event or a log). Whoever holds the link, and is allowed by Google for this account, can install the build.',
    risk: 'read',
    access: { action: 'builds.share' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The link.',
        schema: z.object({ downloadUrl: z.string(), expiresAt: z.number().int() }),
      },
    },
  },
  {
    id: 'previewInternalShare',
    method: 'post',
    path: `${W}/apps/{id}/builds/artifacts/{artifactId}/internal-share/preview`,
    tags: ['builds'],
    summary:
      'Preview sharing a build through Google Play internal app sharing: what is uploaded, checks, confirmHash',
    description:
      'Needs `builds.share` and `KILN_PLAY_INTERNAL_SHARING_ENABLED=true`. Android apps only (`422 not_android`). READS the artifact LIST of the repository (cached 30 seconds; nothing is downloaded and Google is not contacted) and writes nothing; it clears an earlier unknown outcome. The file inside the zip is read only when you confirm, so `upload.fileName` and `kind` are known only when the artifact name or `entry` says; `versionCode` and `sha256` are null (not known before upload). `checks.blocking` stops the share (an Apple build, an upload in flight); while anything blocks `confirmHash` and `confirmation` are null. `entry` names the .aab or .apk inside a zip that holds several.',
    risk: 'read',
    access: { action: 'builds.share' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    body: internalSharePreviewBody,
    bodyOptional: true,
    responses: {
      '200': { description: 'The preview.', schema: z.object({ preview: sharePreview }) },
    },
  },
  {
    id: 'applyInternalShare',
    method: 'post',
    path: `${W}/apps/{id}/builds/artifacts/{artifactId}/internal-share`,
    tags: ['builds'],
    summary:
      'UPLOAD a build to Google Play internal app sharing, get an install link (cannot be taken back)',
    description:
      "A STORE WRITE that publishes nothing to users but puts a binary on Google under the developer account, which this server cannot delete. Needs `builds.share` (owner and admin; a token only when its actions name it; `403` otherwise), `KILN_PLAY_INTERNAL_SHARING_ENABLED=true` (`409 internal_sharing_disabled`) and, when the workspace's step-up policy covers the class `internal_sharing`, a fresh confirmation (`X-Step-Up-Grant`, target = the app id and the `confirmHash`; `403 step_up_required`, `step_up_not_enrolled`, `step_up_required_human` for a token). `confirmHash` must come from a preview of the same artifact (`409 state_changed` with a new `preview` otherwise) and `confirmation` must be its phrase `SHARE <package>` (`422 confirmation_mismatch`). Reads the zip THROUGH this server under the download limit (`KILN_BUILDS_DOWNLOAD_MAX_MB`, `413 artifact_too_large`; it does not need `KILN_BUILDS_DOWNLOAD_ENABLED`), picks the .aab or .apk (`422 entry_required` with the names when there are several, `422 no_android_build`, `422 bad_zip`), uses the Google credential of the app (audited as `credential.use`, purpose `builds.share`) and uploads ONCE. One upload per app at a time (`409 write_in_progress`). Never retried: a lost answer or a Google 5xx is `409 outcome_unknown` (Google cannot be asked what it stored; preview again to clear it). Google refusals: `422 store_auth`, `store_forbidden`, `store_not_found`, `artifact_rejected` (400), `413 artifact_too_large`, `429 rate_limited`. The answer carries the install link (`downloadUrl`: a secret). Audited as `build.shared` / `build.share_failed` with ids, sizes and hashes: never the link, a file name or a credential. No event is sent.",
    risk: 'destructive',
    access: { action: 'builds.share' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    body: internalShareApplyBody,
    responses: {
      '200': {
        description: 'The share and the link.',
        schema: z.object({
          result: z.object({
            share: shareView,
            downloadUrl: z.string(),
            checksumMatches: z.boolean().nullable(),
            note: z.string(),
          }),
        }),
      },
    },
  },
];
