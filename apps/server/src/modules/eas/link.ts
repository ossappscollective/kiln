import {
  type AppJsonExpoProject,
  type ExpoProject,
  expoProjectByFullName,
  expoProjectById,
  isExpoProjectId,
  normalizeExpoFullName,
  readExpoProjectFromAppJson,
} from '@kiln/connectors';
import type { ActorType } from '@kiln/core';
import { type Database, nullableString, type Sql } from '@kiln/db';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { isCloneBacked } from '../../services/clone-reads.ts';
import {
  type Failure,
  failure,
  getDetection,
  getRepository,
  githubFailure,
  type Outcome,
  openConnectorForRepository,
  type RepoContext,
  withTimeout,
} from '../../services/repositories.ts';
import { expoClientFor, expoFailure } from './client.ts';
import type { EasDeps } from './index.ts';

import { coded } from '../../i18n/problem.ts';
/**
 * The link between an app record and its EAS project (docs/adr/0033-eas-integration.md, docs/api/eas.md): which Expo credential to use
 * and which project. Saving it asks Expo, with that credential, whether the project exists and is visible, and stores what Expo
 * said (project id, account, slug, name), never what the person typed. The token is read for that one call and never stored here.
 */

type Actor = { type: ActorType; id: string };

export const EXPO_LINK_PURPOSE = 'eas.link';
export const EXPO_DETECT_PURPOSE = 'eas.detect';

export type ExpoLinkView = {
  appId: string;
  credentialId: string;
  /** The credential's name, or null when it was deleted. */
  credentialLabel: string | null;
  /** The credential still exists and is an Expo credential. Without it nothing can be read from Expo until another is chosen. */
  credentialAvailable: boolean;
  /** The EAS project id (a UUID). */
  projectId: string;
  accountName: string;
  slug: string;
  /** `@account/slug`. */
  fullName: string;
  projectName: string;
  /** When Expo last confirmed the project with the credential (epoch ms). */
  verifiedAt: number;
  linkedBy: string;
  createdAt: number;
  updatedAt: number;
};

const SELECT = `SELECT l.app_id, l.credential_id, l.project_id, l.account_name, l.slug, l.project_name, l.verified_at,
                       l.linked_by, l.created_at, l.updated_at, c.label AS credential_label, c.kind AS credential_kind
                  FROM app_expo_links l
                  LEFT JOIN credentials c ON c.id = l.credential_id AND c.workspace_id = l.workspace_id`;

const toView = (r: Record<string, unknown>): ExpoLinkView => {
  const accountName = String(r.account_name);
  const slug = String(r.slug);
  return {
    appId: String(r.app_id),
    credentialId: String(r.credential_id),
    credentialLabel: nullableString(r.credential_label),
    credentialAvailable: nullableString(r.credential_kind) === 'expo',
    projectId: String(r.project_id),
    accountName,
    slug,
    fullName: `@${accountName}/${slug}`,
    projectName: String(r.project_name),
    verifiedAt: Number(r.verified_at),
    linkedBy: String(r.linked_by),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
};

/** The link of an app record, or null when it has none. Database only: no call to Expo. */
export async function getExpoLink(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<ExpoLinkView | null> {
  const [row] = await sql.query(`${SELECT} WHERE l.app_id = ? AND l.workspace_id = ?`, [
    appId,
    workspaceId,
  ]);
  return row ? toView(row) : null;
}

/**
 * Deletes the cached EAS builds and submissions of an app record (docs/adr/0036-eas-build-submit-status.md): its link was removed or now
 * names another project, so the snapshot no longer belongs to it.
 */
export async function clearEasStatus(sql: Sql, workspaceId: string, appId: string): Promise<void> {
  for (const table of ['eas_builds', 'eas_submissions', 'eas_status_sync']) {
    await sql.execute(`DELETE FROM ${table} WHERE app_id = ? AND workspace_id = ?`, [
      appId,
      workspaceId,
    ]);
  }
}

/** Every link of the workspace (for a feature that walks the linked apps, such as a status sync). Database only. */
export async function listExpoLinks(sql: Sql, workspaceId: string): Promise<ExpoLinkView[]> {
  const rows = await sql.query(
    `${SELECT} WHERE l.workspace_id = ? ORDER BY l.created_at, l.app_id`,
    [workspaceId],
  );
  return rows.map(toView);
}

export type SetLinkInput = {
  workspaceId: string;
  appId: string;
  credentialId: string;
  /** A project id (a UUID) or `@account/slug` (the `@` may be left out). */
  project: string;
};

export type LinkContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  deps: EasDeps | undefined;
};

/** The project of a reference: a UUID is read by id, anything else must be `@account/slug`. */
export async function resolveProject(
  client: Parameters<typeof expoProjectById>[0],
  reference: string,
): Promise<{ ok: true; project: ExpoProject } | Failure> {
  const text = reference.trim();
  try {
    if (isExpoProjectId(text)) return { ok: true, project: await expoProjectById(client, text) };
    if (normalizeExpoFullName(text) === undefined) {
      return failure(
        422,
        'invalid_project',
        'Enter the project id (a UUID, as in app.json under extra.eas.projectId) or its name as @account/slug.',
        coded('eas.projectIdRequired'),
      );
    }
    return { ok: true, project: await expoProjectByFullName(client, text) };
  } catch (error) {
    return expoFailure(error);
  }
}

/**
 * Saves (or replaces) the link of an app. The project is confirmed with Expo first, with the chosen credential; a project the token
 * cannot see is not saved. Audited as `eas.link_set` (ids and names, never a token).
 */
export async function setExpoLink(
  ctx: LinkContext,
  input: SetLinkInput,
  actor: Actor,
): Promise<Outcome<{ link: ExpoLinkView }>> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const opened = await expoClientFor(
    ctx.db,
    ctx.masterKey,
    input.workspaceId,
    input.credentialId,
    ctx.deps,
    { actor, purpose: EXPO_LINK_PURPOSE, now: ctx.now() },
  );
  if (!opened.ok) return opened;
  const found = await resolveProject(opened.client, input.project);
  if (!found.ok) return found;
  const { project } = found;
  const at = ctx.now();
  await ctx.db.transaction(async (tx) => {
    const [before] = await tx.query(
      'SELECT project_id FROM app_expo_links WHERE app_id = ? AND workspace_id = ?',
      [app.id, input.workspaceId],
    );
    await tx.execute(
      `INSERT INTO app_expo_links
         (app_id, workspace_id, credential_id, project_id, account_name, slug, project_name, verified_at, linked_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (app_id) DO UPDATE SET
         credential_id = excluded.credential_id, project_id = excluded.project_id, account_name = excluded.account_name,
         slug = excluded.slug, project_name = excluded.project_name, verified_at = excluded.verified_at,
         linked_by = excluded.linked_by, updated_at = excluded.updated_at`,
      [
        app.id,
        input.workspaceId,
        input.credentialId,
        project.id,
        project.ownerAccount.name,
        project.slug,
        project.name,
        at,
        actor.id,
        at,
        at,
      ],
    );
    // Builds and submissions cached for another project are not this project's.
    if (before && String(before.project_id) !== project.id) {
      await clearEasStatus(tx, input.workspaceId, app.id);
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'eas.link_set',
      target: { type: 'app', id: app.id },
      detail: {
        appId: app.id,
        credentialId: input.credentialId,
        projectId: project.id,
        fullName: project.fullName,
        replaced: before !== undefined,
      },
      at,
    });
  });
  const link = await getExpoLink(ctx.db, input.workspaceId, app.id);
  if (!link) return failure(404, 'not_found');
  return { ok: true, link };
}

/** Removes the link. Nothing at Expo is changed. False when the app had none. Audited as `eas.link_remove`. */
export async function removeExpoLink(
  ctx: Pick<LinkContext, 'db' | 'now'>,
  input: { workspaceId: string; appId: string },
  actor: Actor,
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.query(
      'SELECT project_id, account_name, slug FROM app_expo_links WHERE app_id = ? AND workspace_id = ?',
      [input.appId, input.workspaceId],
    );
    if (!before) return false;
    await tx.execute('DELETE FROM app_expo_links WHERE app_id = ? AND workspace_id = ?', [
      input.appId,
      input.workspaceId,
    ]);
    await clearEasStatus(tx, input.workspaceId, input.appId);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'eas.link_remove',
      target: { type: 'app', id: input.appId },
      detail: {
        appId: input.appId,
        projectId: String(before.project_id),
        fullName: `@${String(before.account_name)}/${String(before.slug)}`,
      },
      at: ctx.now(),
    });
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Detecting the project from the repository

export type ExpoDetectionReason =
  /** The app has no repository. */
  | 'no_repository'
  /** The repository could not be opened (its credential is gone, or it is local only and local reads are off). */
  | 'repository_unavailable'
  /** There is no app.json at the root; a dynamic config (app.config.js) is not read, because code is never run. */
  | 'dynamic_config'
  | 'no_app_json'
  /** app.json is not JSON, or has no Expo config. */
  | 'unreadable'
  /** app.json is fine but names no project (`eas init` writes `extra.eas.projectId`) and no owner and slug. */
  | 'no_project_id'
  /** The repository answered with an error (timeout, rate limit, access). */
  | 'read_failed';

export type ExpoDetection = {
  /** What app.json says; null when it says nothing usable (see `reason`). */
  detected: {
    projectId: string | null;
    owner: string | null;
    slug: string | null;
    /** `@owner/slug` when app.json names both. */
    fullName: string | null;
    path: 'app.json';
  } | null;
  reason: ExpoDetectionReason | null;
  /** A sentence for a person, always set when `reason` is. */
  message: string | null;
};

const MESSAGES: Record<ExpoDetectionReason, string> = {
  no_repository:
    'This app has no repository, so there is no app.json to read. Enter the project by hand.',
  repository_unavailable:
    'The repository of this app could not be opened. Check it under Repositories, or enter the project by hand.',
  dynamic_config:
    'This project has a dynamic config (app.config.js or app.config.ts) and no app.json. It is never run here, so enter the project by hand.',
  no_app_json: 'There is no app.json at the root of the repository. Enter the project by hand.',
  unreadable: 'app.json could not be read as an Expo config. Enter the project by hand.',
  no_project_id:
    'app.json does not name an EAS project (extra.eas.projectId). Running eas init in the project adds it; or enter the project by hand.',
  read_failed: 'The repository could not be read right now. Try again in a moment.',
};

const none = (reason: ExpoDetectionReason): ExpoDetection => ({
  detected: null,
  reason,
  message: MESSAGES[reason],
});

/**
 * Reads `expo.extra.eas.projectId` (and owner and slug) from the `app.json` at the root of the app's repository, to prefill the link.
 * The file is read as JSON text only; a dynamic `app.config.*` is never run. A read of the repository, audited like any other use of
 * its credential (`credential.use`, purpose `eas.detect`); nothing is saved and Expo is not called.
 */
export async function detectExpoProject(
  repo: RepoContext,
  input: { workspaceId: string; app: ManagedApp },
  actor: Actor,
): Promise<Outcome<{ detection: ExpoDetection }>> {
  const { app, workspaceId } = input;
  const done = (detection: ExpoDetection) => ({ ok: true as const, detection });
  if (!app.repositoryId) return done(none('no_repository'));
  const repository = await getRepository(repo.db, workspaceId, app.repositoryId);
  if (!repository) return done(none('no_repository'));
  const opened = await openConnectorForRepository(
    repo,
    workspaceId,
    repository,
    actor,
    EXPO_DETECT_PURPOSE,
  );
  if (!opened.ok) {
    // A rate limit or a timeout is worth saying as it is; the rest is "could not be opened".
    return opened.status === 429 || opened.status === 504
      ? opened
      : done(none('repository_unavailable'));
  }
  const { connector, secret } = opened;
  const abort = new AbortController();
  if (isCloneBacked(connector)) connector.useSignal(abort.signal);
  let text: string | undefined;
  try {
    text = await withTimeout(connector.readFile('app.json'), repo.timeoutMs, () => abort.abort());
  } catch (error) {
    try {
      const failed = githubFailure(error, secret);
      return failed.status === 429 || failed.status === 504 ? failed : done(none('read_failed'));
    } catch {
      return done(none('read_failed'));
    }
  }
  if (text === undefined) {
    const detection = await getDetection(repo.db, workspaceId, repository.id).catch(() => null);
    return done(none(detection?.paths.appConfig ? 'dynamic_config' : 'no_app_json'));
  }
  const read: AppJsonExpoProject | undefined = readExpoProjectFromAppJson(text);
  if (!read) return done(none('unreadable'));
  const fullName = read.owner && read.slug ? `@${read.owner}/${read.slug}` : null;
  if (read.projectId === null && fullName === null) return done(none('no_project_id'));
  return done({
    detected: {
      projectId: read.projectId,
      owner: read.owner,
      slug: read.slug,
      fullName,
      path: 'app.json',
    },
    reason: null,
    message: null,
  });
}
