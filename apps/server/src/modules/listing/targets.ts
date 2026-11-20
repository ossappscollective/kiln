import { randomUUID } from 'node:crypto';
import { checkListingRoot, normalizeRoot } from '@mrm/connectors';
import type { ActorType } from '@mrm/core';
import type { Database, Row, Sql } from '@mrm/db';
import { recordAudit } from '../../services/audit.ts';

/**
 * Listing targets: the places a repository's store listing lives, named. A repository with several
 * apps has one per app (the scan finds them, `auto:` targets), and the person can add their own
 * with explicit folders (stored here). An explicit folder always wins over detection.
 *
 * Stored in a table of their own rather than a JSON column on `repositories`: each target has an
 * id that a request can name, the name is unique per repository (the database decides when two
 * people save at once), edits and deletes are single rows with their own audit event, and nothing
 * reads and rewrites a list.
 */

type Actor = { type: ActorType; id: string };

export const MAX_TARGETS_PER_REPOSITORY = 20;
export const MAX_TARGET_NAME = 60;

export type ListingTarget = {
  id: string;
  repositoryId: string;
  name: string;
  /** The app id, when the target is one app of several. Informational. */
  appId: string | null;
  /** Repository relative folder of the App Store locale folders, or null: no App Store folder. */
  appStoreRoot: string | null;
  googlePlayRoot: string | null;
  createdAt: number;
  updatedAt: number;
};

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

const toTarget = (r: Row): ListingTarget => ({
  id: String(r.id),
  repositoryId: String(r.repository_id),
  name: String(r.name),
  appId: text(r.app_id),
  appStoreRoot: text(r.app_store_root),
  googlePlayRoot: text(r.google_play_root),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const COLUMNS =
  'id, repository_id, name, app_id, app_store_root, google_play_root, created_at, updated_at';

export async function listListingTargets(
  sql: Sql,
  workspaceId: string,
  repositoryId: string,
): Promise<ListingTarget[]> {
  const rows = await sql.query(
    `SELECT ${COLUMNS} FROM repository_listing_targets
      WHERE workspace_id = ? AND repository_id = ? ORDER BY lower(name), id`,
    [workspaceId, repositoryId],
  );
  return rows.map(toTarget);
}

export async function getListingTarget(
  sql: Sql,
  workspaceId: string,
  repositoryId: string,
  id: string,
): Promise<ListingTarget | undefined> {
  const [row] = await sql.query(
    `SELECT ${COLUMNS} FROM repository_listing_targets
      WHERE id = ? AND workspace_id = ? AND repository_id = ?`,
    [id, workspaceId, repositoryId],
  );
  return row ? toTarget(row) : undefined;
}

export type TargetInput = {
  name: string;
  appId?: string | null;
  appStoreRoot?: string | null;
  googlePlayRoot?: string | null;
};

export type TargetProblem = {
  field: 'name' | 'appId' | 'appStoreRoot' | 'googlePlayRoot' | 'roots';
  message: string;
};

/** A root as stored (see `normalizeRoot`), or null for none. A bad path is a problem. */
function cleanRoot(
  value: string | null | undefined,
  field: 'appStoreRoot' | 'googlePlayRoot',
  problems: TargetProblem[],
): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const message = checkListingRoot(value);
  if (message) {
    problems.push({ field, message });
    return null;
  }
  return normalizeRoot(value);
}

/** The cleaned values of a target, or what is wrong with them. */
export function validateTarget(
  input: TargetInput,
): { ok: true; value: Required<TargetInput> } | { ok: false; problems: TargetProblem[] } {
  const problems: TargetProblem[] = [];
  const name = input.name.trim();
  if (name === '') problems.push({ field: 'name', message: 'Give the target a name.' });
  else if (name.length > MAX_TARGET_NAME || /[\r\n]/.test(name)) {
    problems.push({
      field: 'name',
      message: `Use one line of at most ${MAX_TARGET_NAME} characters.`,
    });
  }
  const appId = input.appId?.trim() || null;
  if (appId !== null && (appId.length > 200 || /[\r\n]/.test(appId))) {
    problems.push({
      field: 'appId',
      message: 'The app id must be one line of at most 200 characters.',
    });
  }
  const appStoreRoot = cleanRoot(input.appStoreRoot, 'appStoreRoot', problems);
  const googlePlayRoot = cleanRoot(input.googlePlayRoot, 'googlePlayRoot', problems);
  if (
    appStoreRoot === null &&
    googlePlayRoot === null &&
    !problems.some((p) => p.field !== 'name' && p.field !== 'appId')
  ) {
    problems.push({
      field: 'roots',
      message: 'Give an App Store folder, a Google Play folder or both.',
    });
  }
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, value: { name, appId, appStoreRoot, googlePlayRoot } };
}

export type TargetResult =
  | { ok: true; target: ListingTarget }
  | {
      ok: false;
      status: 404 | 409 | 422;
      error: string;
      message: string;
      problems?: TargetProblem[];
    };

const isUnique = (error: unknown) =>
  error instanceof Error && /unique|duplicate/i.test(error.message);

const duplicateName = (name: string): TargetResult => ({
  ok: false,
  status: 409,
  error: 'duplicate_name',
  message: `This repository already has a listing target named "${name}".`,
});

export async function createListingTarget(
  sql: Database,
  input: { workspaceId: string; repositoryId: string; target: TargetInput; now: number },
  actor: Actor,
): Promise<TargetResult> {
  const checked = validateTarget(input.target);
  if (!checked.ok) {
    return {
      ok: false,
      status: 422,
      error: 'invalid_target',
      message: checked.problems[0]?.message ?? 'Invalid target.',
      problems: checked.problems,
    };
  }
  const v = checked.value;
  const id = randomUUID();
  try {
    return await sql.transaction(async (tx): Promise<TargetResult> => {
      const [repo] = await tx.query(
        'SELECT id FROM repositories WHERE id = ? AND workspace_id = ?',
        [input.repositoryId, input.workspaceId],
      );
      if (!repo)
        return { ok: false, status: 404, error: 'not_found', message: 'No such repository.' };
      const [count] = await tx.query(
        'SELECT COUNT(*) AS n FROM repository_listing_targets WHERE repository_id = ?',
        [input.repositoryId],
      );
      if (Number(count?.n ?? 0) >= MAX_TARGETS_PER_REPOSITORY) {
        return {
          ok: false,
          status: 422,
          error: 'too_many_targets',
          message: `A repository can have at most ${MAX_TARGETS_PER_REPOSITORY} listing targets.`,
        };
      }
      const [same] = await tx.query(
        'SELECT id FROM repository_listing_targets WHERE repository_id = ? AND lower(name) = ?',
        [input.repositoryId, v.name.toLowerCase()],
      );
      if (same) return duplicateName(v.name);
      await tx.execute(
        `INSERT INTO repository_listing_targets
           (id, workspace_id, repository_id, name, app_id, app_store_root, google_play_root, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.workspaceId,
          input.repositoryId,
          v.name,
          v.appId,
          v.appStoreRoot,
          v.googlePlayRoot,
          input.now,
          input.now,
        ],
      );
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor,
        action: 'repository.listing_target_create',
        target: { type: 'repository', id: input.repositoryId },
        detail: {
          targetId: id,
          name: v.name,
          appStoreRoot: v.appStoreRoot,
          googlePlayRoot: v.googlePlayRoot,
        },
        at: input.now,
      });
      return {
        ok: true,
        target: {
          id,
          repositoryId: input.repositoryId,
          ...v,
          createdAt: input.now,
          updatedAt: input.now,
        },
      };
    });
  } catch (error) {
    if (isUnique(error)) return duplicateName(v.name);
    throw error;
  }
}

export async function updateListingTarget(
  sql: Database,
  input: {
    workspaceId: string;
    repositoryId: string;
    id: string;
    /** Only the keys that are present are changed. */
    changes: Partial<TargetInput>;
    now: number;
  },
  actor: Actor,
): Promise<TargetResult> {
  const current = await getListingTarget(sql, input.workspaceId, input.repositoryId, input.id);
  if (!current)
    return { ok: false, status: 404, error: 'not_found', message: 'No such listing target.' };
  const merged: TargetInput = {
    name: input.changes.name ?? current.name,
    appId: 'appId' in input.changes ? input.changes.appId : current.appId,
    appStoreRoot:
      'appStoreRoot' in input.changes ? input.changes.appStoreRoot : current.appStoreRoot,
    googlePlayRoot:
      'googlePlayRoot' in input.changes ? input.changes.googlePlayRoot : current.googlePlayRoot,
  };
  const checked = validateTarget(merged);
  if (!checked.ok) {
    return {
      ok: false,
      status: 422,
      error: 'invalid_target',
      message: checked.problems[0]?.message ?? 'Invalid target.',
      problems: checked.problems,
    };
  }
  const v = checked.value;
  try {
    return await sql.transaction(async (tx): Promise<TargetResult> => {
      const [same] = await tx.query(
        'SELECT id FROM repository_listing_targets WHERE repository_id = ? AND lower(name) = ? AND id <> ?',
        [input.repositoryId, v.name.toLowerCase(), input.id],
      );
      if (same) return duplicateName(v.name);
      await tx.execute(
        `UPDATE repository_listing_targets
            SET name = ?, app_id = ?, app_store_root = ?, google_play_root = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND repository_id = ?`,
        [
          v.name,
          v.appId,
          v.appStoreRoot,
          v.googlePlayRoot,
          input.now,
          input.id,
          input.workspaceId,
          input.repositoryId,
        ],
      );
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor,
        action: 'repository.listing_target_update',
        target: { type: 'repository', id: input.repositoryId },
        detail: {
          targetId: input.id,
          name: v.name,
          appStoreRoot: v.appStoreRoot,
          googlePlayRoot: v.googlePlayRoot,
        },
        at: input.now,
      });
      return { ok: true, target: { ...current, ...v, updatedAt: input.now } };
    });
  } catch (error) {
    if (isUnique(error)) return duplicateName(v.name);
    throw error;
  }
}

export async function deleteListingTarget(
  sql: Database,
  input: { workspaceId: string; repositoryId: string; id: string; now: number },
  actor: Actor,
): Promise<{ ok: true } | { ok: false; status: 404; error: 'not_found'; message: string }> {
  return sql.transaction(async (tx) => {
    const current = await getListingTarget(tx, input.workspaceId, input.repositoryId, input.id);
    if (!current)
      return {
        ok: false,
        status: 404,
        error: 'not_found',
        message: 'No such listing target.',
      } as const;
    await tx.execute('DELETE FROM repository_listing_targets WHERE id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'repository.listing_target_delete',
      target: { type: 'repository', id: input.repositoryId },
      detail: { targetId: input.id, name: current.name },
      at: input.now,
    });
    return { ok: true } as const;
  });
}

// ---------------------------------------------------------------------------------------------
// Choosing one for a request

/** What a request says about where to read: a target, and/or folders. Folders win over a target. */
export type ListingSelection = {
  /** A saved target's id, or `auto:<key>` for a detected one (see `DetectedTarget.key`). */
  target?: string;
  roots?: { appStore?: string; googlePlay?: string };
};

export type ResolvedSelection =
  | {
      ok: true;
      roots?: { appStore?: string; googlePlay?: string };
      /** A detected target, resolved once the files are listed. */
      autoKey?: string;
      /** The saved target, when one was named. */
      custom?: ListingTarget;
      /** The person named the App Store folder (or none): an Expo store config is not used. */
      ignoreExpoConfig: boolean;
    }
  | { ok: false; status: 404 | 422; error: string; message: string };

export async function resolveSelection(
  sql: Sql,
  workspaceId: string,
  repositoryId: string,
  selection: ListingSelection | undefined,
): Promise<ResolvedSelection> {
  const roots: { appStore?: string; googlePlay?: string } = {};
  let autoKey: string | undefined;
  let custom: ListingTarget | undefined;
  const target = selection?.target;
  if (target !== undefined && target !== '') {
    if (target.startsWith('auto:')) autoKey = target.slice(5);
    else {
      custom = await getListingTarget(sql, workspaceId, repositoryId, target);
      if (!custom) {
        return {
          ok: false,
          status: 404,
          error: 'target_not_found',
          message: 'That listing target does not exist (it may have been deleted).',
        };
      }
      roots.appStore = custom.appStoreRoot ?? '';
      roots.googlePlay = custom.googlePlayRoot ?? '';
    }
  }
  for (const key of ['appStore', 'googlePlay'] as const) {
    const given = selection?.roots?.[key];
    if (given === undefined) continue;
    if (given.trim() !== '') {
      const message = checkListingRoot(given);
      if (message)
        return {
          ok: false,
          status: 422,
          error: 'invalid_root',
          message: `${key === 'appStore' ? 'App Store' : 'Google Play'} folder: ${message}`,
        };
    }
    roots[key] = given.trim() === '' ? '' : normalizeRoot(given);
  }
  return {
    ok: true,
    ...(Object.keys(roots).length > 0 ? { roots } : {}),
    ...(autoKey === undefined ? {} : { autoKey }),
    ...(custom ? { custom } : {}),
    ignoreExpoConfig: roots.appStore !== undefined,
  };
}
