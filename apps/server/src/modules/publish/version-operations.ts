import { PLATFORMS } from '@kiln/core';
import { z } from 'zod';
import type { Operation } from '../../operations/openapi.ts';
import { versionApplyBody, versionPreviewBody } from './version-routes.ts';

/**
 * The operations that create the next App Store version (docs/api/store-version.md, docs/adr/0031-create-app-store-version.md),
 * kept in their own file and added to the registry in api-operations.ts. Both need `store.push_draft` and the draft-write switch.
 */

const W = '/api/workspaces/{workspaceId}';
const check = z.object({ code: z.string(), message: z.string() });

const previewSchema = z.object({
  app: z.object({
    id: z.string(),
    name: z.string(),
    platform: z.enum(PLATFORMS),
    store: z.string(),
  }),
  request: z.object({ versionString: z.string(), releaseType: z.string().nullable() }),
  live: z.string().nullable().describe('The newest version the store lists that cannot be edited.'),
  suggested: z.string().describe('The next patch of `live` (empty when it cannot be told).'),
  versions: z.array(
    z.object({ versionString: z.string().nullable(), state: z.string(), editable: z.boolean() }),
  ),
  checks: z.object({
    blocking: z.array(check),
    warnings: z.array(check),
    canCreate: z.boolean(),
  }),
  confirmHash: z.string().nullable().describe('Null while a check blocks.'),
  reversible: z.literal(true),
  note: z.string(),
});

const resultSchema = z.object({
  app: z.object({
    id: z.string(),
    name: z.string(),
    platform: z.enum(PLATFORMS),
    store: z.string(),
  }),
  version: z.object({ id: z.string().nullable(), versionString: z.string(), state: z.string() }),
  reversible: z.literal(true),
  confirmedByReread: z.boolean(),
  warnings: z.array(check),
  createdAt: z.number().int().describe('Epoch milliseconds.'),
  note: z.string(),
});

export const storeVersionOperations: Operation[] = [
  {
    id: 'previewStoreVersion',
    method: 'post',
    path: `${W}/apps/{id}/store-version/preview`,
    tags: ['staged-changes'],
    summary:
      'Preview creating the next App Store version: the versions that exist, checks and a confirmHash',
    description:
      'Needs `store.push_draft` and `MRM_STORE_DRAFT_WRITE_ENABLED=true` (`409 store_draft_disabled`). READS the versions of the app’s platform from App Store Connect (iOS or macOS), writes nothing, and settles an earlier unknown outcome of a create. `checks.blocking` stops a create: a version string that is not one to three dotted numbers, one that is not higher than every version that cannot be edited, one that already exists, an editable version that already exists. While anything blocks, `confirmHash` is null. `422 not_supported` for Google Play (a version there is a release).',
    risk: 'read',
    access: { action: 'store.push_draft' },
    appScope: { kind: 'param', name: 'id' },
    body: versionPreviewBody,
    responses: {
      '200': { description: 'The preview.', schema: z.object({ preview: previewSchema }) },
    },
  },
  {
    id: 'createStoreVersion',
    method: 'post',
    path: `${W}/apps/{id}/store-version`,
    tags: ['staged-changes'],
    summary: 'CREATE the next App Store version as an editable draft (nothing is submitted)',
    description:
      'A STORE WRITE, reversible: a version in Prepare for Submission can be deleted in App Store Connect. Needs `store.push_draft` (owner and admin; a token only when its actions name it) and `MRM_STORE_DRAFT_WRITE_ENABLED=true`; a workspace that covers `store.push_draft` with a step-up asks for the person’s confirmation. `confirmHash` must come from a preview of the same request. The versions are READ AGAIN right before the write: if they are not the ones previewed nothing is written (`409 state_changed`, with a new `preview`); if a check blocks, nothing is written (`409 blocked`, with `checks`). No typed phrase. One write per app and platform at a time, shared with the draft push (`409 write_in_progress`). `POST /v1/appStoreVersions` with the platform of the app record; never retried: after a timeout or a 5xx the versions are read back: `200` with `confirmedByReread: true`, or `409 outcome_unknown` (look in App Store Connect, then preview again). Apple’s refusals are `422 store_rejected` with `details` (Apple’s own reasons). Audited as `store.version_created` / `store.version_create_failed` (ids and the version string, never a credential or a store response body).',
    risk: 'destructive',
    access: { action: 'store.push_draft' },
    appScope: { kind: 'param', name: 'id' },
    body: versionApplyBody,
    responses: {
      '200': {
        description: 'The version that was created.',
        schema: z.object({ result: resultSchema }),
      },
    },
  },
];
