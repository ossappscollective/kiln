import { type Action, can } from '@mrm/core';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { detectedSources } from '../services/listing-sources.ts';
import {
  createListingTarget,
  deleteListingTarget,
  type ListingSelection,
  listListingTargets,
  updateListingTarget,
} from '../services/listing-targets.ts';
import {
  attachLocalCheckout,
  checkLocalPath,
  connectLocalRepository,
  detachLocalCheckout,
  localConfigView,
  localOnlyApplyRefusal,
} from '../services/local-checkouts.ts';
import {
  type Failure,
  type RepoContext,
  connectRepository,
  disconnectRepository,
  getDetection,
  getRepository,
  getRepositoryListing,
  listRepositories,
  repositoryView,
  scanRepository,
} from '../services/repositories.ts';
import {
  approveChangeSet,
  applyChangeSet,
  createChangeSet,
  discardChangeSet,
  getChangeSet,
  listChangeSets,
} from '../services/change-sets.ts';

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

/** A failed outcome as a response, with its headers (Retry-After). */
const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const connectBody = z.object({
  credentialId: z.string().min(1).max(100),
  owner: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'Not a GitHub user or organization name.'),
  repo: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, 'Not a GitHub repository name.')
    .refine((v) => v !== '.' && v !== '..' && !v.endsWith('.git'), 'Not a GitHub repository name.'),
});

// A folder on the server and a branch name. The service checks them again (real path inside an
// allowed root, a branch that exists); these only bound the size of what is read.
const localPath = z.string().min(1).max(4096);
const localBranch = z.string().trim().min(1).max(200);
const localCheckBody = z.object({ path: localPath, branch: localBranch.optional() });
const localConnectBody = z.object({
  path: localPath,
  branch: localBranch.optional(),
  name: z.string().trim().max(100).optional(),
});
const localAttachBody = z.object({
  path: localPath.optional(),
  branch: localBranch.optional(),
  allowRemoteMismatch: z.boolean().optional(),
});

// A locale folder (`en-US`, `de`) or the fastlane `default` folder. No slashes, so a key can never
// point outside the metadata folder.
const localeKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/, 'Not a locale code.');
const text = z.string().max(100_000);

// Counts are capped as well as sizes: the stores have under 100 locales, a listing has a few dozen
// fields, and a Play release history is short. The whole body is also capped (see app.ts).
const MAX_LOCALES = 100;
const MAX_FIELDS_PER_LOCALE = 40;
const MAX_VERSIONS_PER_LOCALE = 50;
const atMost = (max: number) => (value: Record<string, unknown>) => Object.keys(value).length <= max;
const fields = z
  .record(
    localeKey,
    z
      .record(z.string().max(40), text)
      .refine(atMost(MAX_FIELDS_PER_LOCALE), `At most ${MAX_FIELDS_PER_LOCALE} fields per locale.`),
  )
  .refine(atMost(MAX_LOCALES), `At most ${MAX_LOCALES} locales.`);
const listingBody = z.object({
  appStore: z
    .object({ locales: fields, copyright: text.optional() })
    .strict()
    .optional(),
  googlePlay: z
    .object({
      locales: fields,
      changelogs: z
        .record(
          localeKey,
          z
            .record(z.string().regex(/^(\d{1,12}|default)$/, 'A version code or default.'), text)
            .refine(
              atMost(MAX_VERSIONS_PER_LOCALE),
              `At most ${MAX_VERSIONS_PER_LOCALE} version codes per locale.`,
            ),
        )
        .refine(atMost(MAX_LOCALES), `At most ${MAX_LOCALES} locales.`),
    })
    .strict()
    .optional(),
});
// Which target's folders to use: a saved target's id or `auto:<key>`, and/or folders, which win. An
// empty folder means "this store is not read". The path rules are checked by the service.
const targetId = z.string().min(1).max(200);
const rootText = z.string().max(400);
const selectionRoots = z
  .object({ appStore: rootText.optional(), googlePlay: rootText.optional() })
  .strict();
const targetBody = z.object({
  name: z.string().max(200),
  appId: z.string().max(400).nullable().optional(),
  appStoreRoot: rootText.nullable().optional(),
  googlePlayRoot: rootText.nullable().optional(),
});
const targetPatch = targetBody.partial();

/** The selection of a GET: `?target=&appStoreRoot=&googlePlayRoot=` (an empty value is kept). */
function querySelection(c: Context<AppEnv>): ListingSelection | { error: string } {
  const target = c.req.query('target');
  const appStore = c.req.query('appStoreRoot');
  const googlePlay = c.req.query('googlePlayRoot');
  if (target !== undefined && target.length > 200) return { error: 'target' };
  if ((appStore?.length ?? 0) > 400 || (googlePlay?.length ?? 0) > 400) return { error: 'root' };
  return {
    ...(target ? { target } : {}),
    ...(appStore !== undefined || googlePlay !== undefined
      ? {
          roots: {
            ...(appStore === undefined ? {} : { appStore }),
            ...(googlePlay === undefined ? {} : { googlePlay }),
          },
        }
      : {}),
  };
}

const createBodySchema = z.object({
  target: targetId.optional(),
  roots: selectionRoots.optional(),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/, 'One line, please.'),
  listing: listingBody,
});

/** Repository and change set routes. Mounted under /api/workspaces. */
export function repositoryRoutes(ctx: RepoContext) {
  const { db } = ctx;
  const app = new Hono<AppEnv>();

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const notFound = (c: Context<AppEnv>) => c.json({ error: 'not_found' }, 404);

  // ----- repositories ---------------------------------------------------------------------

  app.get('/:workspaceId/repositories', needs('repositories.read'), async (c) => {
    const repositories = await listRepositories(db, ws(c));
    return c.json({ repositories: await Promise.all(repositories.map((r) => repositoryView(ctx, r))) });
  });

  app.post('/:workspaceId/repositories', needs('repositories.write'), async (c) => {
    const body = await parseBody(c, connectBody);
    if (!body.ok) return body.response;
    const done = await connectRepository(ctx, { workspaceId: ws(c), ...body.data }, actor(c));
    return done.ok ? c.json({ repository: await repositoryView(ctx, done.repository) }, 201) : respond(c, done);
  });

  // ----- local clones (docs/adr/0005-local-clone-reads.md) ---------------------------------
  // Registered before `/repositories/:id`. All of them need the right to change repositories
  // (admin and owner), and refuse with 409 unless MRM_LOCAL_REPO_ROOTS is set.

  // Whether the feature is on. Anyone who may look sees that; only who may attach sees the folders.
  app.get('/:workspaceId/repositories/local/config', needs('repositories.read'), async (c) =>
    c.json({ local: localConfigView(ctx, can(c.get('role'), 'repositories.write')) }),
  );

  app.post('/:workspaceId/repositories/local/check', needs('repositories.write'), async (c) => {
    const body = await parseBody(c, localCheckBody);
    if (!body.ok) return body.response;
    const done = await checkLocalPath(
      ctx,
      { workspaceId: ws(c), path: body.data.path, branch: body.data.branch },
      actor(c),
    );
    return done.ok ? c.json({ check: done.check }) : respond(c, done);
  });

  app.post('/:workspaceId/repositories/local', needs('repositories.write'), async (c) => {
    const body = await parseBody(c, localConnectBody);
    if (!body.ok) return body.response;
    const done = await connectLocalRepository(
      ctx,
      { workspaceId: ws(c), path: body.data.path, branch: body.data.branch, name: body.data.name },
      actor(c),
    );
    return done.ok ? c.json({ repository: await repositoryView(ctx, done.repository) }, 201) : respond(c, done);
  });

  app.put('/:workspaceId/repositories/:id/local', needs('repositories.write'), async (c) => {
    const body = await parseBody(c, localAttachBody);
    if (!body.ok) return body.response;
    const done = await attachLocalCheckout(
      ctx,
      {
        workspaceId: ws(c),
        repositoryId: param(c, 'id'),
        path: body.data.path,
        branch: body.data.branch,
        allowRemoteMismatch: body.data.allowRemoteMismatch,
      },
      actor(c),
    );
    return done.ok ? c.json({ repository: await repositoryView(ctx, done.repository) }) : respond(c, done);
  });

  app.delete('/:workspaceId/repositories/:id/local', needs('repositories.write'), async (c) => {
    const done = await detachLocalCheckout(ctx, { workspaceId: ws(c), repositoryId: param(c, 'id') }, actor(c));
    return done.ok ? c.json({ repository: await repositoryView(ctx, done.repository) }) : respond(c, done);
  });

  app.get('/:workspaceId/repositories/:id', needs('repositories.read'), async (c) => {
    const repository = await getRepository(db, ws(c), param(c, 'id'));
    if (!repository) return notFound(c);
    const detection = await getDetection(db, ws(c), repository.id);
    return c.json({
      repository: await repositoryView(ctx, repository),
      detection,
      ...(detection ? { listingSources: detectedSources(detection) } : {}),
    });
  });

  app.delete('/:workspaceId/repositories/:id', needs('repositories.write'), async (c) => {
    const done = await disconnectRepository(ctx, { workspaceId: ws(c), id: param(c, 'id') }, actor(c));
    return done.ok ? c.body(null, 204) : respond(c, done);
  });

  app.post('/:workspaceId/repositories/:id/scan', needs('repositories.scan'), async (c) => {
    const done = await scanRepository(ctx, { workspaceId: ws(c), id: param(c, 'id') }, actor(c));
    if (!done.ok) return respond(c, done);
    return c.json({
      repository: await repositoryView(ctx, done.repository),
      detection: done.detection,
      listingSources: done.listingSources,
    });
  });

  // Reading the listing uses the stored GitHub credential and sends traffic to GitHub, so it needs
  // the same right as a scan, not the right to merely look.
  app.get('/:workspaceId/repositories/:id/listing', needs('repositories.scan'), async (c) => {
    const selection = querySelection(c);
    if ('error' in selection) {
      return c.json({ error: 'invalid_request', message: 'The target or folder is too long.' }, 400);
    }
    const done = await getRepositoryListing(
      ctx,
      { workspaceId: ws(c), id: param(c, 'id'), selection },
      actor(c),
    );
    if (!done.ok) return respond(c, done);
    const { ok: _ok, ...view } = done;
    return c.json(view);
  });

  // ----- listing targets ------------------------------------------------------------------

  // The saved places a repository's listing lives (the detected ones are in the listing and scan
  // responses). Reading them is a read; changing them is a repository setting (admin and owner).
  app.get('/:workspaceId/repositories/:id/listing-targets', needs('repositories.read'), async (c) => {
    const repository = await getRepository(db, ws(c), param(c, 'id'));
    if (!repository) return notFound(c);
    return c.json({ targets: await listListingTargets(db, ws(c), repository.id) });
  });

  const targetFailure = (c: Context<AppEnv>, f: { status: 404 | 409 | 422; error: string; message: string; problems?: unknown }) =>
    c.json({ error: f.error, message: f.message, ...(f.problems ? { problems: f.problems } : {}) }, f.status);

  app.post('/:workspaceId/repositories/:id/listing-targets', needs('repositories.write'), async (c) => {
    const body = await parseBody(c, targetBody);
    if (!body.ok) return body.response;
    const done = await createListingTarget(
      db,
      { workspaceId: ws(c), repositoryId: param(c, 'id'), target: body.data, now: ctx.now() },
      actor(c),
    );
    return done.ok ? c.json({ target: done.target }, 201) : targetFailure(c, done);
  });

  app.patch('/:workspaceId/repositories/:id/listing-targets/:targetId', needs('repositories.write'), async (c) => {
    const body = await parseBody(c, targetPatch);
    if (!body.ok) return body.response;
    const done = await updateListingTarget(
      db,
      {
        workspaceId: ws(c),
        repositoryId: param(c, 'id'),
        id: param(c, 'targetId'),
        changes: body.data,
        now: ctx.now(),
      },
      actor(c),
    );
    return done.ok ? c.json({ target: done.target }) : targetFailure(c, done);
  });

  app.delete('/:workspaceId/repositories/:id/listing-targets/:targetId', needs('repositories.write'), async (c) => {
    const done = await deleteListingTarget(
      db,
      { workspaceId: ws(c), repositoryId: param(c, 'id'), id: param(c, 'targetId'), now: ctx.now() },
      actor(c),
    );
    return done.ok ? c.body(null, 204) : targetFailure(c, done);
  });

  // ----- change sets ----------------------------------------------------------------------

  app.post('/:workspaceId/repositories/:id/change-sets', needs('changesets.write'), async (c) => {
    const body = await parseBody(c, createBodySchema);
    if (!body.ok) return body.response;
    const done = await createChangeSet(
      ctx,
      {
        workspaceId: ws(c),
        repositoryId: param(c, 'id'),
        summary: body.data.summary,
        listing: body.data.listing as never,
        selection: {
          ...(body.data.target ? { target: body.data.target } : {}),
          ...(body.data.roots ? { roots: body.data.roots } : {}),
        },
      },
      actor(c),
    );
    if (!done.ok) return respond(c, done);
    return c.json(
      { changeSet: done.changeSet, problems: done.problems, warnings: done.warnings },
      201,
    );
  });

  app.get('/:workspaceId/change-sets', needs('repositories.read'), async (c) => {
    const status = c.req.query('status');
    const repositoryId = c.req.query('repositoryId');
    return c.json({
      changeSets: await listChangeSets(db, ws(c), {
        ...(status ? { status } : {}),
        ...(repositoryId ? { repositoryId } : {}),
      }),
    });
  });

  app.get('/:workspaceId/change-sets/:id', needs('repositories.read'), async (c) => {
    const changeSet = await getChangeSet(db, ws(c), param(c, 'id'));
    return changeSet ? c.json({ changeSet }) : notFound(c);
  });

  app.post('/:workspaceId/change-sets/:id/approve', needs('changesets.approve'), async (c) => {
    const done = await approveChangeSet(ctx, { workspaceId: ws(c), id: param(c, 'id') }, actor(c));
    return done.ok ? c.json({ changeSet: done.changeSet }) : respond(c, done);
  });

  app.post('/:workspaceId/change-sets/:id/apply', needs('changesets.approve'), async (c) => {
    // Before the change set is claimed: it stays approved. Local-only repositories cannot be applied yet.
    const refused = await localOnlyApplyRefusal(ctx, { workspaceId: ws(c), changeSetId: param(c, 'id') });
    if (refused) return respond(c, refused);
    const done = await applyChangeSet(ctx, { workspaceId: ws(c), id: param(c, 'id') }, actor(c));
    if (!done.ok) return respond(c, done);
    return c.json(
      done.alreadyApplied
        ? { changeSet: done.changeSet, alreadyApplied: true }
        : { changeSet: done.changeSet },
    );
  });

  app.post('/:workspaceId/change-sets/:id/discard', needs('changesets.write'), async (c) => {
    const done = await discardChangeSet(
      ctx,
      {
        workspaceId: ws(c),
        id: param(c, 'id'),
        mayDiscardAny: can(c.get('role'), 'changesets.approve'),
      },
      actor(c),
    );
    return done.ok ? c.json({ changeSet: done.changeSet }) : respond(c, done);
  });

  return app;
}
