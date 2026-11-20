import { PLATFORMS } from '@mrm/core';
import { z } from 'zod';
import type { Operation } from './openapi.ts';

export type Draft = Omit<Operation, 'tags'> & { tags?: string[] };
export const W = '/api/workspaces/{workspaceId}';

export const id = z.string().min(1).max(100);

export const timestamp = z.number().int().describe('Epoch milliseconds.');

// ----- resources ---------------------------------------------------------------------------------

export const changeSetSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  summary: z.string(),
  status: z.string(),
  createdBy: z.object({ type: z.enum(['user', 'token', 'assistant', 'system']), id: z.string() }),
  branch: z.string().nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  commitSha: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  approvedBy: z.string().nullable(),
  approvedAt: timestamp.nullable(),
  appliedAt: timestamp.nullable(),
  filesChanged: z.number().int(),
  files: z.array(z.object({ path: z.string(), change: z.enum(['added', 'modified', 'deleted']) })),
  outcome: z
    .object({
      mode: z.literal('local_branch'),
      base: z
        .object({ branch: z.string(), commit: z.string() })
        .describe('The local branch the commit was made on, and its tip then.'),
      commit: z.object({ branch: z.string(), sha: z.string(), at: timestamp }),
      requested: z.object({ push: z.boolean(), openPr: z.boolean() }),
      signature: z
        .object({ status: z.literal('signed'), format: z.enum(['ssh', 'gpg']) })
        .optional()
        .describe(
          "Present when the commit was signed with the server's key (MRM_GIT_SIGN): the commit object holds a signature header of that format. It means signed, not verified; GitHub shows Verified only when the public key is a signing key on the committer's account.",
        ),
      push: z
        .object({
          status: z.enum(['not_requested', 'pushed', 'failed', 'behind']),
          at: timestamp.optional(),
          code: z.string().optional(),
          error: z.string().optional(),
        })
        .describe(
          '`behind`: a fix-up commit was added after the push and the branch on GitHub is behind the local one.',
        ),
      pr: z.object({
        status: z.enum(['not_requested', 'opened', 'failed', 'skipped']),
        at: timestamp.optional(),
        url: z.string().optional(),
        number: z.number().int().optional(),
        code: z.string().optional(),
        error: z.string().optional(),
      }),
    })
    .nullable()
    .describe(
      'Step by step result of a commit on a new branch of a local clone (commit, push, pull request). Null for a change set applied as a pull request through GitHub. A failed push or pull request does not undo the commit. After a fix-up `commit` is the latest commit and `base` is unchanged.',
    ),
  fixups: z
    .array(
      z.object({
        at: timestamp,
        commit: z.string(),
        parent: z.string().describe('The branch tip the commit was added on.'),
        files: z.number().int(),
        pushed: z.boolean(),
        signature: z
          .object({ status: z.literal('signed'), format: z.enum(['ssh', 'gpg']) })
          .optional(),
      }),
    )
    .describe(
      'Fix-up commits added on top of the branch, oldest first (local commit or pull request through GitHub).',
    ),
  origin: z
    .object({ source: z.string(), appId: z.string().optional(), channel: z.string().optional() })
    .nullable()
    .describe(
      'Where the change set came from when it can be recomputed (`store_pull`); null otherwise.',
    ),
});

export const object = z.record(z.unknown());

export const none = { description: 'Done. No body.' };

export const platform = z.enum(PLATFORMS);

export const listingQuery = z.object({
  target: z.string().max(200).optional(),
  appStoreRoot: z.string().max(400).optional(),
  googlePlayRoot: z.string().max(400).optional(),
});

// ----- customer reviews (read-only inbox, internal triage; docs/api/reviews.md) ----------------------

export const reviewStore = z.enum(['appstoreconnect', 'googleplay']);

// ----- workspace settings and review translation ----------------------------------------------------
export const translationLang = z
  .string()
  .regex(/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/)
  .max(35)
  .describe('A BCP-47 language tag such as en, pt-BR or zh-Hant.');

export const stagedAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(PLATFORMS),
  store: reviewStore,
});

