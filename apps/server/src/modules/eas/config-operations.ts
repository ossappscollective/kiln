import { z } from 'zod';
import { type Draft, platform, timestamp, W } from '../../operations/shared.ts';

/**
 * The operation of the `eas.json` read of an app (docs/api/eas-config.md). It reads the repository (GitHub or a local folder) with
 * the repository's credential and never calls Expo, so no Expo credential is needed. Needs `repositories.scan` (member and above).
 */

const severity = z.enum(['error', 'warning', 'info']);

const finding = z.object({
  code: z.string().describe('A stable code such as `extends_cycle` or `env_secret_like`.'),
  severity,
  scope: z.enum(['file', 'cli', 'build', 'submit', 'app']),
  message: z
    .string()
    .describe(
      'One sentence. Names keys and profiles, never a value of `env` or of an unknown key.',
    ),
  profile: z.string().optional(),
  key: z.string().optional().describe('The key concerned. Never a value.'),
});

const target = z.object({
  distribution: z.string().nullable().describe('`store` or `internal`.'),
  channel: z.string().nullable().describe('The Expo Updates channel the build checks.'),
  developmentClient: z.boolean().nullable(),
  autoIncrement: z.union([z.boolean(), z.string()]).nullable(),
  resourceClass: z.string().nullable(),
  image: z.string().nullable(),
  buildType: z.string().nullable(),
  gradleCommand: z.string().nullable(),
  simulator: z.boolean().nullable(),
  buildConfiguration: z.string().nullable(),
  scheme: z.string().nullable(),
});

const buildProfile = target.extend({
  name: z.string(),
  extends: z.string().nullable(),
  extendsChain: z
    .array(z.string())
    .describe('This profile, then each profile it extends. Stops at a cycle or a missing profile.'),
  node: z.string().nullable(),
  environment: z.string().nullable(),
  credentialsSource: z.string().nullable(),
  releaseChannel: z.string().nullable().describe('The deprecated Classic Updates field.'),
  envNames: z.array(z.string()).describe('Names of `env` variables. Never their values.'),
  ios: target
    .nullable()
    .describe('The values for iOS when a profile of the chain has an `ios` section.'),
  android: target.nullable(),
  unknownKeys: z
    .array(z.string())
    .describe('Keys the Expo reference does not list. Values are not kept.'),
});

const submitIos = z.object({
  ascAppId: z.string().nullable(),
  appleTeamId: z.string().nullable(),
  sku: z.string().nullable(),
  language: z.string().nullable(),
  companyName: z.string().nullable(),
  appName: z.string().nullable(),
  bundleIdentifier: z.string().nullable(),
  ascApiKeyPath: z.string().nullable().describe('A path as written, never the key.'),
  ascApiKeyId: z.string().nullable(),
  ascApiKeyIssuerId: z.string().nullable(),
  hasAppleId: z
    .boolean()
    .describe('Whether `appleId` is set. The Apple ID itself is not returned.'),
  metadataPath: z.string().nullable(),
  groups: z.array(z.string()),
});

const submitAndroid = z.object({
  track: z.string().nullable(),
  releaseStatus: z.string().nullable(),
  rollout: z.number().nullable(),
  changesNotSentForReview: z.boolean().nullable(),
  serviceAccountKeyPath: z.string().nullable().describe('A path as written, never the key.'),
  applicationId: z.string().nullable(),
});

const submitProfile = z.object({
  name: z.string(),
  extends: z.string().nullable(),
  extendsChain: z.array(z.string()),
  ios: submitIos.nullable(),
  android: submitAndroid.nullable(),
  unknownKeys: z.array(z.string()),
});

const config = z.object({
  cli: z.object({
    version: z.string().nullable(),
    requireCommit: z.boolean().nullable(),
    appVersionSource: z.enum(['local', 'remote']).nullable(),
    appVersionSourceEffective: z
      .enum(['local', 'remote'])
      .describe('`local` when the field is absent (the documented default).'),
  }),
  build: z.array(buildProfile),
  submit: z.array(submitProfile),
  unknownKeys: z.array(z.string()),
  truncated: z.boolean().describe('More than 100 profiles: the rest were not read.'),
});

const runtimeVersion = z
  .union([
    z.object({ kind: z.literal('string'), value: z.string() }),
    z.object({ kind: z.literal('policy'), policy: z.string() }),
  ])
  .nullable();

const expoApp = z.object({
  path: z.string().nullable().describe('`app.config.json` or `app.json`.'),
  dynamicPath: z
    .string()
    .nullable()
    .describe('A dynamic config (`app.config.js`, ...): never run.'),
  unreadable: z.boolean(),
  version: z.string().nullable(),
  runtimeVersion,
  iosRuntimeVersion: runtimeVersion,
  androidRuntimeVersion: runtimeVersion,
  updatesUrl: z.string().nullable(),
  updatesEnabled: z.boolean().nullable(),
  easProjectId: z.string().nullable().describe('`expo.extra.eas.projectId`.'),
  iosBundleIdentifier: z.string().nullable(),
  androidPackage: z.string().nullable(),
  iosBuildNumber: z.string().nullable(),
  androidVersionCode: z.number().nullable(),
  updatesConfigured: z
    .boolean()
    .nullable()
    .describe(
      'Whether expo-updates is configured as far as the JSON says. Null when it cannot be told.',
    ),
});

const view = z.object({
  app: z.object({ id: z.string(), name: z.string(), platform, identifier: z.string() }),
  repository: z
    .object({ id: z.string(), owner: z.string(), repo: z.string(), localOnly: z.boolean() })
    .nullable(),
  branch: z.string().nullable().describe("The repository's default branch."),
  commit: z
    .string()
    .nullable()
    .describe(
      'The commit that was read. Null when it could not be named and the branch was read as it was.',
    ),
  readAt: timestamp,
  found: z.boolean(),
  reason: z
    .object({
      code: z.enum(['no_repository', 'no_eas_json', 'unreadable']),
      message: z.string(),
    })
    .nullable()
    .describe('Why there is no model (`found` is false). Not an error.'),
  nested: z
    .array(z.string())
    .describe('`eas.json` files in subfolders. Only the repository root is read.'),
  path: z.string().nullable(),
  config: config
    .nullable()
    .describe('Null when there is no `eas.json` or it is not valid JSON (see `findings`).'),
  expoApp: expoApp.nullable(),
  findings: z.array(finding),
});

export const easConfigOperations: Draft[] = [
  {
    id: 'getEasConfig',
    method: 'get',
    path: `${W}/apps/{appId}/eas-config`,
    tags: ['eas'],
    summary: 'The EAS configuration (eas.json) of the repository of an app',
    description:
      'READS the repository (GitHub, or its local folder) at the default branch with the repository credential (audited as `credential.use`, purpose `eas.config`) and parses `eas.json` and the JSON app config (`app.json` / `app.config.json`) at the repository root. Never calls Expo, needs no Expo credential, never runs code (a dynamic `app.config.js` is only named). Build profiles come with `extends` resolved; `env` is returned as names only, and values that look like secrets are reported by key. `found: false` with a `reason` (no repository, no `eas.json` at the root, not readable as text) is an answer, not an error. Needs `repositories.scan` (member and above); 30 reads a minute per workspace.',
    risk: 'read',
    access: { action: 'repositories.scan' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    responses: { '200': { description: 'The configuration and its findings.', schema: view } },
  },
];
