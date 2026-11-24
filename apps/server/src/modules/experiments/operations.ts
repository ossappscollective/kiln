import { PLATFORMS } from '@kiln/core';
import { z } from 'zod';
import { type Draft, reviewStore, timestamp, W } from '../../operations/shared.ts';
import { NOTE_KINDS, NOTE_STATUSES } from './notes.ts';

/** The operations of store experiments and custom product pages (docs/api/experiments.md). The registry (operations/registry.ts) lists them. */

const state = z.enum([
  'draft',
  'in_review',
  'approved',
  'rejected',
  'completed',
  'stopped',
  'replaced',
  'unknown',
]);

const appViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(PLATFORMS),
  store: reviewStore,
});

const localeSchema = z.object({
  locale: z.string(),
  ref: z.string().describe('Apple’s id of the localization.'),
  assets: z.object({
    screenshots: z.number().int(),
    previews: z.number().int(),
    other: z.number().int(),
    screenshotSets: z.number().int(),
  }),
  hasPromotionalText: z
    .boolean()
    .nullable()
    .describe('Custom product pages: promotional text is set in this locale. Treatments: null.'),
});

const treatmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  iconName: z.string().nullable(),
  promotedAt: timestamp.nullable(),
  locales: z.array(localeSchema),
});

const experimentSchema = z.object({
  id: z.string().describe('Apple’s id of the experiment.'),
  name: z.string(),
  platform: z
    .string()
    .nullable()
    .describe('Apple’s `platform` of the experiment (`IOS`, `MAC_OS`).'),
  state,
  rawState: z.string().nullable().describe('Apple’s own state word, verbatim.'),
  trafficProportion: z
    .number()
    .nullable()
    .describe('The share of visitors that sees a treatment (a percentage; unverified).'),
  reviewRequired: z.boolean().nullable(),
  startsAt: timestamp.nullable(),
  endsAt: timestamp.nullable(),
  treatments: z.array(treatmentSchema),
  syncedAt: timestamp,
});

const versionSchema = z.object({
  id: z.string(),
  version: z.string().nullable(),
  state,
  rawState: z.string().nullable(),
  deepLink: z.string().nullable(),
});

const pageSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: state.describe(
    'The state of the version that counts: work in progress, else the approved one.',
  ),
  rawState: z.string().nullable(),
  url: z.string().nullable().describe('The address to share, as Apple gives it.'),
  visible: z.boolean().nullable(),
  deepLink: z.string().nullable().describe('iOS 18 and later.'),
  versions: z.array(versionSchema),
  locales: z.array(localeSchema),
  syncedAt: timestamp,
});

const syncStatusSchema = z.object({
  lastAttemptAt: timestamp.nullable(),
  lastSyncedAt: timestamp.nullable(),
  lastError: z.string().nullable(),
  failures: z.number().int(),
  experimentCount: z.number().int(),
  pageCount: z.number().int(),
  complete: z.boolean(),
  warnings: z.array(z.string()),
});

const noteSchema = z.object({
  id: z.string(),
  kind: z.enum(NOTE_KINDS),
  name: z.string(),
  status: z.enum(NOTE_STATUSES),
  startedOn: z.string().nullable().describe('YYYY-MM-DD.'),
  endedOn: z.string().nullable().describe('YYYY-MM-DD.'),
  url: z.string().nullable(),
  listing: z
    .string()
    .nullable()
    .describe('The Google Play custom store listing parameter (`listing=` of its address).'),
  note: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const noteFields = {
  name: z.string().min(1).max(120).describe('One line, 1 to 120 characters.'),
  status: z.enum(NOTE_STATUSES),
  startedOn: z.string().nullable().describe('YYYY-MM-DD, or null.'),
  endedOn: z.string().nullable().describe('YYYY-MM-DD, or null; not before `startedOn`.'),
  url: z.string().max(500).nullable().describe('An http or https address, or null.'),
  listing: z
    .string()
    .nullable()
    .describe(
      'Lowercase letters, digits and . - _ ~ (Google Play’s rule), 1 to 100 characters, or null.',
    ),
  note: z.string().max(2000).describe('What was tested and what was learned.'),
};

export const experimentsOperations: Draft[] = [
  {
    id: 'listAppExperiments',
    method: 'get',
    path: `${W}/apps/{appId}/experiments`,
    tags: ['experiments'],
    summary:
      'Product Page Optimization experiments, custom product pages and tracker notes of an app, as of the last sync',
    description:
      'Reads the stored copy; asks no store. `api` is false for Google Play, whose API has no store listing experiments or custom store listings: `experiments` and `customPages` are then empty and only `notes` (the manual tracker) is used. Apple: experiments with their treatments, and custom product pages with versions, locales and media counts. Results (impressions, conversion, confidence) are NOT available: Apple’s API has none; they are in App Store Connect.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: {
      '200': {
        description: 'The stored experiments, custom pages and notes.',
        schema: z.object({
          app: appViewSchema,
          api: z.boolean(),
          experiments: z.array(experimentSchema),
          customPages: z.array(pageSchema),
          sync: syncStatusSchema.nullable(),
          notes: z.array(noteSchema),
          limits: z.object({ notes: z.number().int() }),
        }),
      },
    },
  },
  {
    id: 'syncAppExperiments',
    method: 'post',
    path: `${W}/apps/{appId}/experiments/sync`,
    tags: ['experiments'],
    summary:
      'Read the experiments and custom product pages from App Store Connect and replace the stored copy',
    description:
      'Read-only toward the store: lists experiments (v2), their treatments and locales, custom product pages, their versions and locales, and changes nothing there. A part Apple refuses (the key’s role, an app that is not live) is a warning and is left as it was; any other failure fails the whole sync and the last good copy stays (`lastError` on the list). Rate limited per workspace, with the budget of the app sync. `422 experiments_not_supported` for Google Play, `422 app_not_synced` before an App Store app has its store id.',
    risk: 'write',
    access: { action: 'apps.sync' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    responses: {
      '200': {
        description: 'What the sync read.',
        schema: z.object({
          sync: z.object({
            app: appViewSchema,
            experiments: z.number().int(),
            customPages: z.number().int(),
            complete: z.boolean(),
            warnings: z.array(z.string()),
            syncedAt: timestamp,
          }),
        }),
      },
    },
  },
  {
    id: 'createExperimentNote',
    method: 'post',
    path: `${W}/apps/{appId}/experiments/notes`,
    tags: ['experiments'],
    summary: 'Add a note to the manual tracker of an app',
    description:
      'The manual tracker keeps what a person writes down about an experiment or a custom page (for Google Play, the only record, since its API has none). Kiln’s own data: nothing is sent to a store. At most 200 notes per app (`409 too_many_notes`). `422 invalid_dates` when the end is before the start. Audited as `experiments.note_created` (ids, never the text).',
    risk: 'write',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'appId' },
    body: z.object({
      kind: z.enum(NOTE_KINDS),
      name: noteFields.name,
      status: noteFields.status.optional().describe('Default `planned`.'),
      startedOn: noteFields.startedOn.optional(),
      endedOn: noteFields.endedOn.optional(),
      url: noteFields.url.optional(),
      listing: noteFields.listing.optional(),
      note: noteFields.note.optional(),
    }),
    responses: { '201': { description: 'The note.', schema: z.object({ note: noteSchema }) } },
  },
  {
    id: 'updateExperimentNote',
    method: 'patch',
    path: `${W}/apps/{appId}/experiments/notes/{noteId}`,
    tags: ['experiments'],
    summary: 'Change a note of the manual tracker',
    description:
      'Only the fields sent change; `null` clears a date, the link or the listing parameter. `404 note_not_found`. Audited as `experiments.note_updated`.',
    risk: 'write',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'appId' },
    body: z.object({
      name: noteFields.name.optional(),
      status: noteFields.status.optional(),
      startedOn: noteFields.startedOn.optional(),
      endedOn: noteFields.endedOn.optional(),
      url: noteFields.url.optional(),
      listing: noteFields.listing.optional(),
      note: noteFields.note.optional(),
    }),
    responses: { '200': { description: 'The note.', schema: z.object({ note: noteSchema }) } },
  },
  {
    id: 'deleteExperimentNote',
    method: 'delete',
    path: `${W}/apps/{appId}/experiments/notes/{noteId}`,
    tags: ['experiments'],
    summary: 'Delete a note of the manual tracker',
    description: '`404 note_not_found`. Audited as `experiments.note_deleted`.',
    risk: 'destructive',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'appId' },
    responses: { '200': { description: 'Deleted.', schema: z.object({ ok: z.literal(true) }) } },
  },
];
