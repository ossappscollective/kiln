import {
  getRevenueCatApp,
  listRevenueCatApps,
  listRevenueCatProjects,
  type RevenueCatApp,
  type RevenueCatProject,
} from '@kiln/connectors';
import { type ActorType, revenueCatAppTypes, supports } from '@kiln/core';
import { type Database, nullableString, type Sql } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import { getApp, listApps, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure, type Outcome } from '../../services/repositories.ts';
import {
  REVENUECAT_DETECT_PURPOSE,
  REVENUECAT_LINK_PURPOSE,
  revenueCatClientFor,
  revenueCatFailure,
} from './client.ts';
import type { RevenueCatDeps } from './index.ts';
import { clearRevenueCatCache } from './snapshot.ts';

/**
 * The link between an app record and a RevenueCat project and app (docs/adr/0039-revenuecat.md, docs/api/revenuecat.md): which RevenueCat
 * credential to use, which project, which RevenueCat app. Saving it asks RevenueCat, with that credential, whether the project and app
 * exist and are visible, and stores what RevenueCat said (names, type, bundle id or package name), never what was typed. The key is read
 * for that one call and never stored here. The model is the Expo link (modules/eas/link.ts).
 *
 * Which RevenueCat app types an app record may use comes from the platform's capabilities (`revenueCatAppTypes` in packages/core): an
 * iOS app uses an `app_store` app, an Android app a `play_store` app, a macOS app a `mac_app_store` app (a legacy Mac app) or the shared
 * `app_store` app (a universal purchase). Every other RevenueCat store is "not mapped": listed with a note, never an error, never linkable.
 */

type Actor = { type: ActorType; id: string };

export type RevenueCatLinkView = {
  appId: string;
  credentialId: string;
  /** The credential's name, or null when it was deleted. */
  credentialLabel: string | null;
  /** The credential still exists and is a RevenueCat credential. Without it nothing can be read until another is chosen. */
  credentialAvailable: boolean;
  projectId: string;
  projectName: string;
  revenueCatAppId: string;
  revenueCatAppName: string;
  /** `app_store`, `mac_app_store` or `play_store`. */
  revenueCatAppType: string;
  /** The bundle id or package name RevenueCat holds for the app; null when it did not say. */
  revenueCatIdentifier: string | null;
  /** Whether that identifier is this app's own: true, false, or null when RevenueCat did not say. Not a blocker (a universal purchase may differ). */
  identifierMatches: boolean | null;
  /** When RevenueCat last confirmed the project and app with the credential (epoch ms). */
  verifiedAt: number;
  linkedBy: string;
  createdAt: number;
  updatedAt: number;
};

const SELECT = `SELECT l.app_id, l.credential_id, l.project_id, l.project_name, l.rc_app_id, l.rc_app_name, l.rc_app_type, l.rc_identifier,
                       l.verified_at, l.linked_by, l.created_at, l.updated_at, c.label AS credential_label, c.kind AS credential_kind,
                       a.identifier AS app_identifier, a.platform AS app_platform
                  FROM app_revenuecat_links l
                  LEFT JOIN credentials c ON c.id = l.credential_id AND c.workspace_id = l.workspace_id
                  LEFT JOIN apps a ON a.id = l.app_id AND a.workspace_id = l.workspace_id`;

/** Bundle ids are compared without regard to letter case, package names exactly (the platform's `bundleIdentifier` capability). */
export function sameIdentifier(platform: ManagedApp['platform'], a: string, b: string): boolean {
  return supports(platform, 'bundleIdentifier') ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const toView = (r: Record<string, unknown>): RevenueCatLinkView => {
  const identifier = nullableString(r.rc_identifier);
  const own = nullableString(r.app_identifier);
  const platform = nullableString(r.app_platform) as ManagedApp['platform'] | null;
  return {
    appId: String(r.app_id),
    credentialId: String(r.credential_id),
    credentialLabel: nullableString(r.credential_label),
    credentialAvailable: nullableString(r.credential_kind) === 'revenuecat',
    projectId: String(r.project_id),
    projectName: String(r.project_name),
    revenueCatAppId: String(r.rc_app_id),
    revenueCatAppName: String(r.rc_app_name),
    revenueCatAppType: String(r.rc_app_type),
    revenueCatIdentifier: identifier,
    identifierMatches:
      identifier === null || own === null || platform === null
        ? null
        : sameIdentifier(platform, identifier, own),
    verifiedAt: Number(r.verified_at),
    linkedBy: String(r.linked_by),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
};

/** The link of an app record, or null when it has none. Database only: no call to RevenueCat. */
export async function getRevenueCatLink(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<RevenueCatLinkView | null> {
  const [row] = await sql.query(`${SELECT} WHERE l.app_id = ? AND l.workspace_id = ?`, [
    appId,
    workspaceId,
  ]);
  return row ? toView(row) : null;
}

export type LinkContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  deps: RevenueCatDeps | undefined;
};

export const notSupportedFailure = (): Failure =>
  failure(
    422,
    'revenuecat_not_supported',
    'RevenueCat is not available for the store of this app.',
    coded('revenuecat.unavailable'),
  );

// ---------------------------------------------------------------------------------------------
// What a person can pick from

export type RevenueCatAppChoice = {
  id: string;
  name: string;
  /** RevenueCat's own app type, verbatim. */
  type: string;
  /** True for the stores this tool reads (App Store, Mac App Store, Play Store); false for every other, which is ignored. */
  mapped: boolean;
  /** Mapped, and a type this app record's platform may use. Only these can be linked. */
  linkable: boolean;
  identifier: string | null;
  /** The identifier is this app's own. */
  matches: boolean;
  /** The one to offer first: linkable and the identifier matches (the most specific type for the platform wins). */
  suggested: boolean;
  /** A sentence when the app cannot be linked ("not mapped"...), else null. */
  note: string | null;
};

export type RevenueCatOptions = {
  projects: RevenueCatProject[];
  /** The project the apps are of: the one asked for, or the only one the key sees; null when there are several and none was chosen. */
  projectId: string | null;
  apps: RevenueCatAppChoice[] | null;
  /** False when a list stopped at a cap. */
  complete: boolean;
};

const NOT_MAPPED =
  'Not mapped: this tool reads App Store, Mac App Store and Google Play apps of RevenueCat only. This app is ignored.';

export function choicesFor(
  app: Pick<ManagedApp, 'platform' | 'identifier'>,
  found: readonly RevenueCatApp[],
): RevenueCatAppChoice[] {
  const order = revenueCatAppTypes(app.platform);
  const rows = found.map((a) => {
    const mapped = a.store !== null;
    const fits = a.store !== null && order.includes(a.store);
    const choice: RevenueCatAppChoice = {
      id: a.id,
      name: a.name,
      type: a.type,
      mapped,
      linkable: fits,
      identifier: a.identifier,
      matches: a.identifier !== null && sameIdentifier(app.platform, a.identifier, app.identifier),
      suggested: false,
      note: !mapped
        ? NOT_MAPPED
        : fits
          ? null
          : `This is a ${a.type} app of RevenueCat; it does not fit the store of this app.`,
    };
    // The position in the platform's preference list: a macOS app prefers `mac_app_store`, then the shared `app_store` app.
    return { choice, rank: a.store === null ? order.length : order.indexOf(a.store) };
  });
  const best = rows
    .filter((r) => r.choice.linkable && r.choice.matches)
    .sort((x, y) => x.rank - y.rank)[0];
  if (best) best.choice.suggested = true;
  return rows
    .map((r) => r.choice)
    .sort(
      (a, b) =>
        Number(b.suggested) - Number(a.suggested) ||
        Number(b.linkable) - Number(a.linkable) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * The projects the credential sees and, for one project, its apps, so the form can offer them (the identifier equal to this app's is
 * suggested). READS RevenueCat with the chosen credential (audited, purpose `revenuecat.detect`); nothing is saved.
 */
export async function detectRevenueCat(
  ctx: LinkContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    credentialId: string;
    projectId?: string | undefined;
  },
  actor: Actor,
): Promise<Outcome<{ options: RevenueCatOptions }>> {
  if (!supports(input.app.platform, 'revenueCat')) return notSupportedFailure();
  const opened = await revenueCatClientFor(
    ctx.db,
    ctx.masterKey,
    input.workspaceId,
    input.credentialId,
    ctx.deps,
    {
      actor,
      purpose: REVENUECAT_DETECT_PURPOSE,
      now: ctx.now(),
    },
  );
  if (!opened.ok) return opened;
  try {
    const { projects, complete } = await listRevenueCatProjects(opened.client);
    const projectId = input.projectId ?? (projects.length === 1 ? (projects[0]?.id ?? null) : null);
    if (projectId === null)
      return { ok: true, options: { projects, projectId: null, apps: null, complete } };
    const listed = await listRevenueCatApps(opened.client, projectId);
    return {
      ok: true,
      options: {
        projects,
        projectId,
        apps: choicesFor(input.app, listed.apps),
        complete: complete && listed.complete,
      },
    };
  } catch (error) {
    return revenueCatFailure(error, opened.secret);
  }
}

// ---------------------------------------------------------------------------------------------
// The plan: every app record against what the key sees (the "Connect your apps" flow)

/** At most this many projects are read for a plan (one list of apps each): a key that sees more is cut and says so (`complete` false). */
export const PLAN_MAX_PROJECTS = 10;

export type PlanCandidate = {
  projectId: string;
  projectName: string;
  revenueCatAppId: string;
  revenueCatAppName: string;
  type: string;
  identifier: string | null;
  /** This RevenueCat app has the identifier of the record and a store type that fits it (the best one of its project). */
  suggested: boolean;
};

export type PlanRow = {
  appId: string;
  name: string;
  platform: ManagedApp['platform'];
  identifier: string;
  /** The record already has a link: it is left alone (no candidates, no proposal). */
  linked: boolean;
  /** Every RevenueCat app of every project that fits the store of the record, the suggested ones first. */
  candidates: PlanCandidate[];
  /** The one match to propose; null when there is none or when it is ambiguous. Never a guess. */
  proposal: { projectId: string; revenueCatAppId: string } | null;
  /** Several RevenueCat apps (in one or several projects) match the record: the person chooses. */
  ambiguous: boolean;
};

export type RevenueCatPlan = {
  projects: RevenueCatProject[];
  rows: PlanRow[];
  /** False when a list of the key stopped at a cap: a match may be missing. */
  complete: boolean;
};

/**
 * What to propose for ONE app record, from the apps of each project the key sees. A proposal is made only when exactly one RevenueCat app
 * across all projects has the record's identifier and a store type that fits its platform (`choicesFor` decides both, and picks the most
 * specific type inside a project); two such apps, in one project or two, are "ambiguous" and nothing is proposed. Pure.
 */
export function planRow(
  app: Pick<ManagedApp, 'id' | 'name' | 'platform' | 'identifier'>,
  perProject: readonly { project: RevenueCatProject; apps: readonly RevenueCatApp[] }[],
  linked = false,
): PlanRow {
  const base = {
    appId: app.id,
    name: app.name,
    platform: app.platform,
    identifier: app.identifier,
    linked,
  };
  if (linked) return { ...base, candidates: [], proposal: null, ambiguous: false };
  const candidates: PlanCandidate[] = [];
  for (const { project, apps } of perProject) {
    for (const c of choicesFor(app, apps)) {
      if (!c.linkable) continue;
      candidates.push({
        projectId: project.id,
        projectName: project.name,
        revenueCatAppId: c.id,
        revenueCatAppName: c.name,
        type: c.type,
        identifier: c.identifier,
        suggested: c.suggested,
      });
    }
  }
  candidates.sort(
    (a, b) =>
      Number(b.suggested) - Number(a.suggested) ||
      a.projectName.localeCompare(b.projectName) ||
      a.revenueCatAppName.localeCompare(b.revenueCatAppName),
  );
  const suggested = candidates.filter((c) => c.suggested);
  const only = suggested.length === 1 ? suggested[0] : undefined;
  return {
    ...base,
    candidates,
    proposal: only ? { projectId: only.projectId, revenueCatAppId: only.revenueCatAppId } : null,
    ambiguous: suggested.length > 1,
  };
}

/**
 * A proposal for every app record of the workspace whose store RevenueCat serves, from ONE read of RevenueCat with the chosen credential
 * (the projects, then the apps of each project): the same read as `detectRevenueCat` once per record would make, in one go. Saves nothing;
 * the link of a record is saved with `setRevenueCatLink`. Audited as `credential.use`, purpose `revenuecat.detect`.
 */
export async function planRevenueCat(
  ctx: LinkContext,
  input: { workspaceId: string; credentialId: string },
  actor: Actor,
): Promise<Outcome<{ plan: RevenueCatPlan }>> {
  const opened = await revenueCatClientFor(
    ctx.db,
    ctx.masterKey,
    input.workspaceId,
    input.credentialId,
    ctx.deps,
    { actor, purpose: REVENUECAT_DETECT_PURPOSE, now: ctx.now() },
  );
  if (!opened.ok) return opened;
  try {
    const records = (await listApps(ctx.db, input.workspaceId)).filter((a) =>
      supports(a.platform, 'revenueCat'),
    );
    const linkedIds = new Set(
      (
        await ctx.db.query('SELECT app_id FROM app_revenuecat_links WHERE workspace_id = ?', [
          input.workspaceId,
        ])
      ).map((r) => String(r.app_id)),
    );
    const listed = await listRevenueCatProjects(opened.client);
    const perProject: { project: RevenueCatProject; apps: RevenueCatApp[] }[] = [];
    let complete = listed.complete && listed.projects.length <= PLAN_MAX_PROJECTS;
    // Nothing to match: do not read the apps at all.
    const needed = records.some((r) => !linkedIds.has(r.id));
    for (const project of needed ? listed.projects.slice(0, PLAN_MAX_PROJECTS) : []) {
      const read = await listRevenueCatApps(opened.client, project.id);
      complete = complete && read.complete;
      perProject.push({ project, apps: read.apps });
    }
    return {
      ok: true,
      plan: {
        projects: listed.projects,
        rows: records.map((r) => planRow(r, perProject, linkedIds.has(r.id))),
        complete,
      },
    };
  } catch (error) {
    return revenueCatFailure(error, opened.secret);
  }
}

// ---------------------------------------------------------------------------------------------
// Saving and removing the link

export type SetLinkInput = {
  workspaceId: string;
  appId: string;
  credentialId: string;
  projectId: string;
  revenueCatAppId: string;
};

/**
 * Saves (or replaces) the link of an app. The project and the app are confirmed with RevenueCat first, with the chosen credential; an
 * app that is not a store this tool reads, or not one this platform may use, is refused (`422 revenuecat_app_not_mapped`). A changed
 * project or app clears the cached configuration. Audited as `revenuecat.link_set` (ids and names, never a key).
 */
export async function setRevenueCatLink(
  ctx: LinkContext,
  input: SetLinkInput,
  actor: Actor,
): Promise<Outcome<{ link: RevenueCatLinkView }>> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!supports(app.platform, 'revenueCat')) return notSupportedFailure();
  const opened = await revenueCatClientFor(
    ctx.db,
    ctx.masterKey,
    input.workspaceId,
    input.credentialId,
    ctx.deps,
    {
      actor,
      purpose: REVENUECAT_LINK_PURPOSE,
      now: ctx.now(),
    },
  );
  if (!opened.ok) return opened;
  let project: RevenueCatProject | undefined;
  let found: RevenueCatApp | undefined;
  try {
    project = (await listRevenueCatProjects(opened.client)).projects.find(
      (p) => p.id === input.projectId,
    );
    if (!project) {
      return failure(
        422,
        'revenuecat_not_found',
        'RevenueCat has no such project, or the key cannot see it.',
        coded('revenuecat.noProject'),
      );
    }
    found = await getRevenueCatApp(opened.client, project.id, input.revenueCatAppId);
  } catch (error) {
    return revenueCatFailure(error, opened.secret);
  }
  if (!found) {
    return failure(
      422,
      'revenuecat_not_found',
      'RevenueCat has no such app in that project, or the key cannot see it.',
      coded('revenuecat.noApp'),
    );
  }
  if (found.store === null) return failure(422, 'revenuecat_app_not_mapped', NOT_MAPPED);
  if (!revenueCatAppTypes(app.platform).includes(found.store)) {
    return failure(
      422,
      'revenuecat_app_not_mapped',
      `A RevenueCat app of the type ${found.type} does not fit the store of this app. Choose one of the same store.`,
      coded('revenuecat.typeMismatch', { type: found.type }),
    );
  }
  const at = ctx.now();
  await ctx.db.transaction(async (tx) => {
    const [before] = await tx.query(
      'SELECT project_id, rc_app_id FROM app_revenuecat_links WHERE app_id = ? AND workspace_id = ?',
      [app.id, input.workspaceId],
    );
    await tx.execute(
      `INSERT INTO app_revenuecat_links
         (app_id, workspace_id, credential_id, project_id, project_name, rc_app_id, rc_app_name, rc_app_type, rc_identifier,
          verified_at, linked_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (app_id) DO UPDATE SET
         credential_id = excluded.credential_id, project_id = excluded.project_id, project_name = excluded.project_name,
         rc_app_id = excluded.rc_app_id, rc_app_name = excluded.rc_app_name, rc_app_type = excluded.rc_app_type,
         rc_identifier = excluded.rc_identifier, verified_at = excluded.verified_at, linked_by = excluded.linked_by,
         updated_at = excluded.updated_at`,
      [
        app.id,
        input.workspaceId,
        input.credentialId,
        project?.id ?? input.projectId,
        project?.name ?? '',
        found.id,
        found.name,
        found.store,
        found.identifier,
        at,
        actor.id,
        at,
        at,
      ],
    );
    // A copy read for another project or app is not this one's.
    if (
      before &&
      (String(before.project_id) !== input.projectId || String(before.rc_app_id) !== found.id)
    ) {
      await clearRevenueCatCache(tx, input.workspaceId, app.id);
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'revenuecat.link_set',
      target: { type: 'app', id: app.id },
      detail: {
        appId: app.id,
        credentialId: input.credentialId,
        projectId: input.projectId,
        revenueCatAppId: found.id,
        revenueCatAppType: found.store,
        replaced: before !== undefined,
      },
      at,
    });
  });
  const link = await getRevenueCatLink(ctx.db, input.workspaceId, app.id);
  if (!link) return failure(404, 'not_found');
  return { ok: true, link };
}

/** Removes the link and the cached configuration. Nothing at RevenueCat is changed. False when the app had no link. Audited as `revenuecat.link_remove`. */
export async function removeRevenueCatLink(
  ctx: Pick<LinkContext, 'db' | 'now'>,
  input: { workspaceId: string; appId: string },
  actor: Actor,
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.query(
      'SELECT project_id, rc_app_id FROM app_revenuecat_links WHERE app_id = ? AND workspace_id = ?',
      [input.appId, input.workspaceId],
    );
    if (!before) return false;
    await tx.execute('DELETE FROM app_revenuecat_links WHERE app_id = ? AND workspace_id = ?', [
      input.appId,
      input.workspaceId,
    ]);
    await clearRevenueCatCache(tx, input.workspaceId, input.appId);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'revenuecat.link_remove',
      target: { type: 'app', id: input.appId },
      detail: {
        appId: input.appId,
        projectId: String(before.project_id),
        revenueCatAppId: String(before.rc_app_id),
      },
      at: ctx.now(),
    });
    return true;
  });
}
