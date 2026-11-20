import { randomUUID } from 'node:crypto';
import {
  type ActorType,
  DEFAULT_RELEASE_PATTERNS,
  DEFAULT_TAG_PATTERNS,
  MAX_PATTERN_LENGTH,
  MAX_PATTERNS,
  MAX_PREFIX_LENGTH,
  patternListProblems,
  prefixProblem,
} from '@mrm/core';
import type { Database, Row, Sql } from '@mrm/db';
import { z } from 'zod';
import { recordAudit } from './audit.ts';

/**
 * How a team names the tags and releases that carry a build number, stored per repository, with
 * an optional override per app (a monorepo with one prefix per app). The pattern language lives in
 * `@mrm/core` (build-patterns.ts); this file is the stored side and the request schema.
 *
 * Nothing stored here is a secret. An empty pattern list means "use the built-in defaults".
 */

export type BuildConventions = {
  /** Tag name patterns; empty means the defaults. */
  tagPatterns: string[];
  /** Release name patterns; empty means the defaults. */
  releasePatterns: string[];
  /** The literal that fills `{prefix}` (a monorepo's `TAG_PREFIX`). */
  prefix: string;
  /** The release workflow (file name or name) a tag is matched to by time; null to detect it. */
  workflow: string | null;
};

export type StoredConventions = BuildConventions & {
  /** The app this row is for, or null for the whole repository. */
  appId: string | null;
  updatedBy: string;
  updatedAt: number;
};

/** What matching really uses: the stored values with the defaults filled in. */
export type EffectiveConventions = BuildConventions & {
  usingDefaultTags: boolean;
  usingDefaultReleases: boolean;
  /** Which row decided: the app's own, the repository's, or the built-in defaults. */
  source: 'app' | 'repository' | 'defaults';
};

export const EMPTY_CONVENTIONS: BuildConventions = {
  tagPatterns: [],
  releasePatterns: [],
  prefix: '',
  workflow: null,
};

const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._/()-]{0,199}$/;

/** The body of `PUT .../build-conventions`. Unknown keys are refused. */
export const conventionsBody = z
  .object({
    /** Set to store an override for this app; leave out for the repository's convention. */
    appId: z.string().min(1).max(100).optional(),
    tagPatterns: z.array(z.string().max(MAX_PATTERN_LENGTH + 1)).max(MAX_PATTERNS + 1),
    releasePatterns: z.array(z.string().max(MAX_PATTERN_LENGTH + 1)).max(MAX_PATTERNS + 1),
    prefix: z
      .string()
      .max(MAX_PREFIX_LENGTH + 1)
      .default(''),
    workflow: z
      .string()
      .trim()
      .regex(WORKFLOW_NAME, 'A workflow file name or name.')
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const prefix = prefixProblem(body.prefix);
    if (prefix) ctx.addIssue({ code: 'custom', path: ['prefix'], message: prefix });
    for (const message of patternListProblems(body.tagPatterns, {
      kind: 'tag',
      prefix: prefix ? '' : body.prefix,
    })) {
      ctx.addIssue({ code: 'custom', path: ['tagPatterns'], message });
    }
    for (const message of patternListProblems(body.releasePatterns, {
      kind: 'release',
      prefix: prefix ? '' : body.prefix,
    })) {
      ctx.addIssue({ code: 'custom', path: ['releasePatterns'], message });
    }
  });

export type ConventionsBody = z.infer<typeof conventionsBody>;

function parseList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string').slice(0, MAX_PATTERNS)
      : [];
  } catch {
    return [];
  }
}

const toStored = (r: Row): StoredConventions => ({
  appId: String(r.app_id) === '' ? null : String(r.app_id),
  tagPatterns: parseList(r.tag_patterns_json),
  releasePatterns: parseList(r.release_patterns_json),
  prefix: String(r.tag_prefix ?? ''),
  workflow: r.workflow === null || r.workflow === undefined ? null : String(r.workflow),
  updatedBy: String(r.updated_by),
  updatedAt: Number(r.updated_at),
});

const COLUMNS =
  'app_id, tag_patterns_json, release_patterns_json, tag_prefix, workflow, updated_by, updated_at';

/** The repository's row and the rows of its apps. */
export async function listConventions(
  sql: Sql,
  workspaceId: string,
  repositoryId: string,
): Promise<StoredConventions[]> {
  const rows = await sql.query(
    `SELECT ${COLUMNS} FROM build_conventions WHERE workspace_id = ? AND repository_id = ?`,
    [workspaceId, repositoryId],
  );
  return rows.map(toStored);
}

/** The convention in force for an app: its own row, else the repository's, else the defaults. */
export function effectiveConventions(
  rows: readonly StoredConventions[],
  appId: string | null,
): EffectiveConventions {
  const own = appId === null ? undefined : rows.find((r) => r.appId === appId);
  const repo = rows.find((r) => r.appId === null);
  const row = own ?? repo;
  const base = row ?? { ...EMPTY_CONVENTIONS };
  return {
    tagPatterns: base.tagPatterns.length > 0 ? [...base.tagPatterns] : [...DEFAULT_TAG_PATTERNS],
    releasePatterns:
      base.releasePatterns.length > 0 ? [...base.releasePatterns] : [...DEFAULT_RELEASE_PATTERNS],
    prefix: base.prefix,
    workflow: base.workflow,
    usingDefaultTags: base.tagPatterns.length === 0,
    usingDefaultReleases: base.releasePatterns.length === 0,
    source: own ? 'app' : repo ? 'repository' : 'defaults',
  };
}

export async function saveConventions(
  sql: Database,
  input: {
    workspaceId: string;
    repositoryId: string;
    appId: string | null;
    conventions: BuildConventions;
    actor: { type: ActorType; id: string };
    now: number;
  },
): Promise<StoredConventions> {
  const { conventions: c } = input;
  const scope = input.appId ?? '';
  const values = [
    JSON.stringify(c.tagPatterns),
    JSON.stringify(c.releasePatterns),
    c.prefix,
    c.workflow,
    input.actor.id,
    input.now,
  ];
  await sql.transaction(async (tx) => {
    const changed = await tx.execute(
      `UPDATE build_conventions
          SET tag_patterns_json = ?, release_patterns_json = ?, tag_prefix = ?, workflow = ?,
              updated_by = ?, updated_at = ?
        WHERE workspace_id = ? AND repository_id = ? AND app_id = ?`,
      [...values, input.workspaceId, input.repositoryId, scope],
    );
    if (changed === 0) {
      await tx.execute(
        `INSERT INTO build_conventions
           (id, workspace_id, repository_id, app_id, tag_patterns_json, release_patterns_json,
            tag_prefix, workflow, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), input.workspaceId, input.repositoryId, scope, ...values],
      );
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'build.conventions',
      target: { type: 'repository', id: input.repositoryId },
      detail: {
        ...(input.appId ? { appId: input.appId } : {}),
        tagPatterns: c.tagPatterns,
        releasePatterns: c.releasePatterns,
        prefix: c.prefix,
        workflow: c.workflow,
      },
      at: input.now,
    });
  });
  return {
    appId: input.appId,
    ...c,
    updatedBy: input.actor.id,
    updatedAt: input.now,
  };
}

/** Deletes the rows of repositories that were disconnected and of apps that were deleted. */
export async function purgeConventionOrphans(sql: Sql): Promise<number> {
  const a = await sql.execute(
    'DELETE FROM build_conventions WHERE repository_id NOT IN (SELECT id FROM repositories)',
  );
  const b = await sql.execute(
    'DELETE FROM build_scans WHERE repository_id NOT IN (SELECT id FROM repositories)',
  );
  const c = await sql.execute(
    "DELETE FROM build_conventions WHERE app_id <> '' AND app_id NOT IN (SELECT id FROM apps)",
  );
  return a + b + c;
}
