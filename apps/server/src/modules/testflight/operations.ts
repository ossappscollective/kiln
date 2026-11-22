import { PLATFORMS } from '@kiln/core';
import { z } from 'zod';
import { type Draft, reviewStore, timestamp, W } from '../../operations/shared.ts';
import { TRIAGE_STATUSES } from './store.ts';

/** The operations of TestFlight feedback and crashes (docs/api/testflight-feedback.md). The registry (operations/registry.ts) lists them. */

const status = z.enum(TRIAGE_STATUSES);

const appViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(PLATFORMS),
  store: reviewStore,
});

const common = {
  id: z.string().describe('Kiln’s id of the stored submission.'),
  kind: z.enum(['feedback', 'crash']),
  createdAt: timestamp.describe('When the tester sent it, per Apple.'),
  buildNumber: z.string().nullable().describe('The build number (`builds.version`).'),
  version: z.string().nullable().describe('The marketing version, when it could be read.'),
  platform: z.string().nullable().describe('Apple’s `appPlatform` (`IOS`, `MAC_OS`).'),
  bundleId: z.string().nullable(),
  tester: z
    .string()
    .nullable()
    .describe('A six character pseudonym of the tester (stable per workspace and email); null for an anonymous tester. Use it to filter.'),
  testerEmail: z
    .string()
    .nullable()
    .describe('The tester’s email. Personal data: set only for a person who may change settings (administrators), null for everybody else.'),
  deviceModel: z.string().nullable(),
  deviceFamily: z.string().nullable(),
  osVersion: z.string().nullable(),
  locale: z.string().nullable(),
  timeZone: z.string().nullable(),
  architecture: z.string().nullable(),
  connectionType: z.string().nullable(),
  pairedWatch: z.string().nullable(),
  appUptimeMs: z.number().nullable(),
  diskFreeBytes: z.number().nullable(),
  diskTotalBytes: z.number().nullable(),
  batteryPercent: z.number().nullable(),
  screenWidth: z.number().nullable(),
  screenHeight: z.number().nullable(),
  crashLogState: z.enum(['none', 'stored', 'missing']).describe('`none`: not read yet (or not a crash); `stored`; `missing`: Apple had no log.'),
  crashLogTruncated: z.boolean(),
  signature: z
    .string()
    .nullable()
    .describe('Crashes: the grouping key derived from the log (exception and top frame); null when the log has none or was not read.'),
  symbolicated: z.boolean().nullable().describe('Whether the top frame has a symbol. Not a claim about the rest of the log.'),
  status,
  assigneeUserId: z.string().nullable(),
  statusChangedAt: timestamp.nullable(),
  statusChangedBy: z.string().nullable(),
  firstSeenAt: timestamp,
};

const listItemSchema = z.object({
  ...common,
  comment: z.string().describe('The start of the tester’s comment (300 characters). Plain text of a third party: show it as text, never as HTML.'),
  commentTruncated: z.boolean(),
  screenshotCount: z.number().int(),
  hasNote: z.boolean(),
});

const itemSchema = z.object({
  ...common,
  comment: z.string().describe('The tester’s comment. Plain text of a third party: show it as text, never as HTML. Never logged.'),
  screenshots: z.array(z.object({ width: z.number().nullable(), height: z.number().nullable() })).describe('Sizes only: the links expire and are read on demand.'),
  internalNote: z.string().nullable().describe('Internal. Never sent to Apple.'),
  crashLog: z.string().nullable().describe('Crashes: the log as Apple gave it, cut at 64 KiB. Not claimed to be symbolicated.'),
});

const syncStatusSchema = z.object({
  lastAttemptAt: timestamp.nullable(),
  lastSyncedAt: timestamp.nullable(),
  lastError: z.string().nullable(),
  failures: z.number().int(),
  complete: z.boolean(),
  warnings: z.array(z.string()),
});

const triageBody = z.object({
  status: status.optional(),
  assigneeUserId: z.string().min(1).max(100).nullable().optional().describe('A member of the workspace, or null to unassign.'),
  internalNote: z.string().max(2000).nullable().optional().describe('Internal; null or empty clears it.'),
});

export const testflightOperations: Draft[] = [
  {
    id: 'listTestflightFeedback',
    method: 'get',
    path: `${W}/apps/{appId}/testflight`,
    tags: ['testflight'],
    summary: 'TestFlight feedback or crashes of an app, as of the last sync, with counts and builds',
    description:
      'Reads the stored copy; asks Apple nothing. `api` is false for Google Play (no TestFlight): everything is then empty. `kind` picks the list (default `feedback`). Filters: `build` (the build number), `version`, `status` (comma separated), `tester` (the six character code), `signature` (crashes). Newest first, with a cursor. `counts` and `builds` are for the whole app, whatever the filter.',
    risk: 'read',
    access: { action: 'reviews.read' },
    appScope: { kind: 'param', name: 'appId' },
    query: z.object({
      kind: z.enum(['feedback', 'crash']).optional(),
      build: z.string().max(100).optional(),
      version: z.string().max(100).optional(),
      status: z.string().optional().describe('One or more of new, seen, in_progress, resolved, ignored, comma separated.'),
      tester: z.string().optional().describe('The six character code of a tester.'),
      signature: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    }),
    responses: {
      '200': {
        description: 'A page of submissions, the cursor of the next page or null, counts, the builds, and the state of the last sync.',
        schema: z.object({
          app: appViewSchema,
          api: z.boolean(),
          counts: z.object({
            feedback: z.number().int(),
            crashes: z.number().int(),
            openFeedback: z.number().int(),
            openCrashes: z.number().int(),
            byStatus: z.object({ new: z.number().int(), seen: z.number().int(), in_progress: z.number().int(), resolved: z.number().int(), ignored: z.number().int() }),
          }),
          builds: z.array(
            z.object({ buildNumber: z.string().nullable(), version: z.string().nullable(), feedback: z.number().int(), crashes: z.number().int(), lastAt: timestamp }),
          ),
          items: z.array(listItemSchema),
          nextCursor: z.string().nullable(),
          sync: syncStatusSchema.nullable(),
        }),
      },
    },
  },
  {
    id: 'getTestflightCrashGroups',
    method: 'get',
    path: `${W}/apps/{appId}/testflight/crash-groups`,
    tags: ['testflight'],
    summary: 'TestFlight crashes grouped by build and by signature',
    description:
      'From the stored crashes. The signature is derived from the crash log by a fixed rule (the exception type and the first frame of the crashed thread; docs/api/testflight-feedback.md#crash-grouping). A crash whose log was not read or has another layout is one group with a null signature.',
    risk: 'read',
    access: { action: 'reviews.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: {
      '200': {
        description: 'The groups.',
        schema: z.object({
          byBuild: z.array(z.object({ buildNumber: z.string().nullable(), version: z.string().nullable(), count: z.number().int(), lastAt: timestamp })),
          bySignature: z.array(
            z.object({
              signature: z.string().nullable(),
              count: z.number().int(),
              builds: z.array(z.string().nullable()).describe('At most six build numbers.'),
              symbolicated: z.boolean().nullable(),
              lastAt: timestamp,
              open: z.number().int().describe('Not yet resolved or ignored.'),
            }),
          ),
        }),
      },
    },
  },
  {
    id: 'getTestflightItem',
    method: 'get',
    path: `${W}/apps/{appId}/testflight/{id}`,
    tags: ['testflight'],
    summary: 'One TestFlight feedback or crash, with the full comment and the crash log',
    description: '`404 not_found` for an unknown id. The tester’s email is shown to administrators only.',
    risk: 'read',
    access: { action: 'reviews.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: { '200': { description: 'The submission.', schema: z.object({ item: itemSchema }) } },
  },
  {
    id: 'getTestflightScreenshots',
    method: 'get',
    path: `${W}/apps/{appId}/testflight/{id}/screenshots`,
    tags: ['testflight'],
    summary: 'Fresh links to the screenshots of one TestFlight feedback, read from App Store Connect now',
    description:
      'Reads Apple (one request, counted against the per-workspace sync budget): the links expire (`expiresAt`), are never stored or logged, and the response is `no-store`. The web app does not load them in an image (its content security policy forbids other hosts) but offers them as links. Empty for a crash or a feedback with no screenshot.',
    risk: 'read',
    access: { action: 'reviews.read' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    responses: {
      '200': {
        description: 'The links.',
        schema: z.object({
          screenshots: z.array(z.object({ url: z.string(), width: z.number().nullable(), height: z.number().nullable(), expiresAt: timestamp.nullable() })),
        }),
      },
    },
  },
  {
    id: 'syncTestflightFeedback',
    method: 'post',
    path: `${W}/apps/{appId}/testflight/sync`,
    tags: ['testflight'],
    summary: 'Read the TestFlight feedback and crashes from App Store Connect and add them to the stored copy',
    description:
      'Read-only toward Apple: lists the newest feedback and crash submissions (two pages of 200 each at most), the version of each build and the crash logs of new crashes (40 at most), and changes nothing there. Adds and refreshes; nothing is removed, and triage is kept. A list Apple refuses (the key’s role, an app without TestFlight builds) is a warning; any other failure fails the sync and the stored copy stays (`lastError`). New submissions after the first sync raise the alerts `testflight.feedback` and `testflight.crash`. Rate limited per workspace, with the budget of the app sync. `422 testflight_not_supported` for Google Play, `422 app_not_synced` before an App Store app has its store id.',
    risk: 'write',
    access: { action: 'reviews.sync' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    responses: {
      '200': {
        description: 'What the sync read.',
        schema: z.object({
          sync: z.object({
            app: appViewSchema,
            feedback: z.number().int().describe('Stored feedback of the app after the sync.'),
            crashes: z.number().int(),
            added: z.object({ feedback: z.number().int(), crashes: z.number().int() }),
            crashLogs: z.number().int().describe('Crash logs read by this sync.'),
            complete: z.boolean(),
            warnings: z.array(z.string()),
            syncedAt: timestamp,
          }),
        }),
      },
    },
  },
  {
    id: 'triageTestflightItem',
    method: 'patch',
    path: `${W}/apps/{appId}/testflight/{id}`,
    tags: ['testflight'],
    summary: 'Change the triage of a TestFlight feedback or crash (status, assignee, note)',
    description:
      'Kiln’s own data: nothing is sent to Apple. Send at least one field. `422 assignee_not_member`. Audited as `testflight.triage` (which fields changed, the status and the assignee; never the note, the comment or the log).',
    risk: 'write',
    access: { action: 'reviews.triage' },
    appScope: { kind: 'param', name: 'appId' },
    body: triageBody,
    responses: { '200': { description: 'The submission.', schema: z.object({ item: itemSchema.omit({ crashLog: true }) }) } },
  },
];
