import { z } from 'zod';
import { type Draft, none, W } from '../../operations/shared.ts';
import { setLinkBody } from './link-routes.ts';

/**
 * The operations of the Expo project link of an app (docs/api/eas.md). Reading the link needs `apps.read`; saving, removing and
 * detecting need `apps.write` (owners and admins). Saving READS Expo with the chosen credential (audited as `credential.use`, purpose
 * `eas.link`) and changes nothing there.
 */

const timestamp = z.number().int().describe('Epoch milliseconds.');

const link = z.object({
  appId: z.string(),
  credentialId: z.string(),
  credentialLabel: z.string().nullable().describe('Null when the credential was deleted.'),
  credentialAvailable: z
    .boolean()
    .describe('False when the credential was deleted or is not an Expo credential: choose another and save again.'),
  projectId: z.string().describe('The EAS project id (a UUID).'),
  accountName: z.string(),
  slug: z.string(),
  fullName: z.string().describe('`@account/slug`.'),
  projectName: z.string(),
  verifiedAt: timestamp.describe('When Expo last confirmed the project with the credential.'),
  linkedBy: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const detection = z.object({
  detected: z
    .object({
      projectId: z.string().nullable(),
      owner: z.string().nullable(),
      slug: z.string().nullable(),
      fullName: z.string().nullable(),
      path: z.literal('app.json'),
    })
    .nullable(),
  reason: z
    .enum([
      'no_repository',
      'repository_unavailable',
      'dynamic_config',
      'no_app_json',
      'unreadable',
      'no_project_id',
      'read_failed',
    ])
    .nullable(),
  message: z.string().nullable(),
});

export const easLinkOperations: Draft[] = [
  {
    id: 'getExpoLink',
    method: 'get',
    path: `${W}/apps/{appId}/expo`,
    tags: ['eas'],
    summary: 'The Expo (EAS) project an app is linked to',
    description:
      'Answers `{ link }`, with `link` null when the app has none. Database only: Expo is not called. `credentialAvailable` is false when the credential was deleted. Needs `apps.read`.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: { '200': { description: 'The link, or null.', schema: z.object({ link: link.nullable() }) } },
  },
  {
    id: 'setExpoLink',
    method: 'put',
    path: `${W}/apps/{appId}/expo`,
    tags: ['eas'],
    summary: 'Link an app to an Expo (EAS) project, or change the link',
    description:
      'READS Expo with the chosen Expo credential (audited as `credential.use`, purpose `eas.link`) to confirm that the project exists and the token can see it; what Expo says (id, account, slug, name) is stored, not what was typed. `project` is the project id (a UUID, as in app.json under `extra.eas.projectId`) or `@account/slug`. Nothing at Expo is changed. Replaces an earlier link. `422` `credential_not_found` / `credential_kind` (not an Expo credential) / `expo_auth` (Expo did not accept the token) / `expo_forbidden` / `expo_not_found` / `invalid_project`; `429` (20 a minute per workspace, or Expo said to slow down); `502` `expo_unavailable`; `504` `timeout`. Needs `apps.write`. Audited as `eas.link_set`.',
    risk: 'write',
    access: { action: 'apps.write' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    body: setLinkBody,
    responses: { '200': { description: 'The saved link.', schema: z.object({ link }) } },
  },
  {
    id: 'removeExpoLink',
    method: 'delete',
    path: `${W}/apps/{appId}/expo`,
    tags: ['eas'],
    summary: 'Remove the link of an app to its Expo (EAS) project',
    description:
      'Removes the stored link only; nothing at Expo is changed and the credential stays. `404` when the app has no link. Needs `apps.write`. Audited as `eas.link_remove`.',
    risk: 'destructive',
    access: { action: 'apps.write' },
    appScope: { kind: 'param', name: 'appId' },
    responses: { '204': none },
  },
  {
    id: 'detectExpoProject',
    method: 'get',
    path: `${W}/apps/{appId}/expo/detect`,
    tags: ['eas'],
    summary: 'Read the Expo project id from the app.json of the repository of the app, to prefill the link',
    description:
      'READS the repository of the app (one file, `app.json` at the root, as JSON text; a dynamic `app.config.js` is never run), audited as `credential.use` with purpose `eas.detect` on the repository credential. Expo is not called and nothing is saved. `detected` is null with a `reason` and a `message` when nothing usable was found. Needs `apps.write`.',
    risk: 'read',
    access: { action: 'apps.write' },
    appScope: { kind: 'param', name: 'appId' },
    responses: { '200': { description: 'What app.json says.', schema: z.object({ detection }) } },
  },
];
