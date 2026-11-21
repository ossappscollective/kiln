import { type Action, can } from '@kiln/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../http.ts';
import { detectedSources } from '../modules/listing/sources.ts';
import {
  createListingTarget,
  deleteListingTarget,
  type ListingSelection,
  listListingTargets,
  updateListingTarget,
} from '../modules/listing/targets.ts';
import { memberRole } from '../services/accounts.ts';
import { applyChangeSetLocally, publishLocalCommit } from '../services/change-set-local.ts';
import { changeSetStaleness, refreshChangeSet } from '../services/change-set-refresh.ts';
import {
  applyChangeSet,
  approveChangeSet,
  createChangeSet,
  discardChangeSet,
  getChangeSet,
  listChangeSets,
} from '../services/change-sets.ts';
import type { CloneUpkeep } from '../services/clone-upkeep.ts';
import {
  attachLocalCheckout,
  checkLocalPath,
  connectLocalRepository,
  detachLocalCheckout,
  localConfigView,
  localOnlyApplyRefusal,
} from '../services/local-checkouts.ts';
import {
  connectRepository,
  disconnectRepository,
  type Failure,
  getDetection,
  getRepository,
  getRepositoryListing,
  listRepositories,
  type RepoContext,
  repositoryView,
  scanRepository,
} from '../services/repositories.ts';

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

// How to apply a change set. No body, or `{}`, is `github_pr`, as before. `local_branch` commits on a
// new branch of the repository's local clone; `push` and `openPr` go with it only
// (docs/adr/0005-local-clone-reads.md). The branch name is checked again by the service.
const applyBody = z.object({
  mode: z.enum(['github_pr', 'local_branch']).optional(),
  branch: z.string().trim().min(1).max(200).optional(),
  push: z.boolean().optional(),
  openPr: z.boolean().optional(),
});
const publishBody = z.object({ openPr: z.boolean().optional() });

// Refreshing a stale change set: the person's choice per conflicting file, by path. No body is "no
// choices yet" (a conflict is then reported, not resolved). Paths are checked against the set.
const MAX_RESOLUTIONS = 500;
const refreshBody = z.object({
  resolutions: z
    .record(z.string().min(1).max(1000), z.enum(['mine', 'theirs']))
    .refine(
      (value) => Object.keys(value).length <= MAX_RESOLUTIONS,
      `At most ${MAX_RESOLUTIONS} choices.`,
    )
    .optional(),
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
const atMost = (max: number) => (value: Record<string, unknown>) =>
  Object.keys(value).length <= max;
const fields = z
  .record(
    localeKey,
    z
      .record(z.string().max(40), text)
      .refine(atMost(MAX_FIELDS_PER_LOCALE), `At most ${MAX_FIELDS_PER_LOCALE} fields per locale.`),
  )
  .refine(atMost(MAX_LOCALES), `At most ${MAX_LOCALES} locales.`);
const listingBody = z.object({
  appStore: z.object({ locales: fields, copyright: text.optional() }).strict().optional(),
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
export function repositoryRoutes(ctx: RepoContext, upkeep?: CloneUpkeep) {
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
    return c.json({
      repositories: await Promise.all(repositories.map((r) => repositoryView(ctx, r))),
    });
  });

  app.post('/:workspaceId/repositories', needs('repositories.write'), async (c) => {
    const body = await parseBody(c, connectBody);
    if (!body.ok) return body.response;
    const done = await connectRepository(ctx, { workspaceId: ws(c), ...body.data }, actor(c));
    return done.ok
      ? c.json({ repository: await repositoryView(ctx, done.repository) }, 201)
      : respond(c, done);
  });

  // ----- local clones (docs/adr/0005-local-clone-reads.md) ---------------------------------
  // Registered before `/repositories/:id`. All of them need the right to change repositories
  // (admin and owner), and refuse with 409 unless KILN_LOCAL_REPO_ROOTS is set.

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
    return done.ok
      ? c.json({ repository: await repositoryView(ctx, done.repository) }, 201)
      : respond(c, done);
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
    return done.ok
      ? c.json({ repository: await repositoryView(ctx, done.repository) })
      : respond(c, done);
  });

  app.delete('/:workspaceId/repositories/:id/local', needs('repositories.write'), async (c) => {
    const done = await detachLocalCheckout(
      ctx,
      { workspaceId: ws(c), repositoryId: param(c, 'id') },
      actor(c),
    );
    return done.ok
      ? c.json({ repository: await repositoryView(ctx, done.repository) })
      : respond(c, done);
  });

  // ----- the managed clones (docs/adr/0005-local-clone-reads.md, "Clone upkeep") -----------------
  // Admin and owner see the clones of THEIR workspace only: size and last use per repository. No path
  // of the server is part of an answer. The sweep that prunes them runs on its own (scheduler).

  app.get('/:workspaceId/clones', needs('repositories.write'), async (c) =>
    c.json(
      upkeep
        ? await upkeep.report(ws(c))
        : { enabled: false, clones: [], totalBytes: 0, limits: { maxBytes: 0, idleDays: 0 } },
    ),
  );

  app.get('/:workspaceId/repositories/:id/clone', needs('repositories.read'), async (c) => {
    const repository = await getRepository(db, ws(c), param(c, 'id'));
    if (!repository) return notFound(c);
    return c.json({
      enabled: ctx.reads?.active === true,
      clone: (await upkeep?.forRepository(ws(c), repository.id)) ?? null,
      limits: upkeep?.config ?? { maxBytes: 0, idleDays: 0 },
    });
  });

  // Drops the clones of one repository now. They are a cache: the next read fetches again. 409
  // clone_busy while a read is running.
  app.post('/:workspaceId/repositories/:id/clone/purge', needs('repositories.write'), async (c) => {
    const repository = await getRepository(db, ws(c), param(c, 'id'));
    if (!repository) return notFound(c);
    if (!upkeep) return c.json({ removed: 0, freedBytes: 0 });
    const done = await upkeep.purge(ws(c), repository.id, actor(c));
    if (!done.ok) {
      return c.json(
        {
          error: 'clone_busy',
          message: 'The repository is being read right now. Try again in a moment.',
        },
        409,
      );
    }
    return c.json({ removed: done.removed, freedBytes: done.freedBytes });
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
    const done = await disconnectRepository(
      ctx,
      { workspaceId: ws(c), id: param(c, 'id') },
      actor(c),
    );
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
      return c.json(
        { error: 'invalid_request', message: 'The target or folder is too long.' },
        400,
      );
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
  app.get(
    '/:workspaceId/repositories/:id/listing-targets',
    needs('repositories.read'),
    async (c) => {
      const repository = await getRepository(db, ws(c), param(c, 'id'));
      if (!repository) return notFound(c);
      return c.json({ targets: await listListingTargets(db, ws(c), repository.id) });
    },
  );

  const targetFailure = (
    c: Context<AppEnv>,
    f: { status: 404 | 409 | 422; error: string; message: string; problems?: unknown },
  ) =>
    c.json(
      { error: f.error, message: f.message, ...(f.problems ? { problems: f.problems } : {}) },
      f.status,
    );

  app.post(
    '/:workspaceId/repositories/:id/listing-targets',
    needs('repositories.write'),
    async (c) => {
      const body = await parseBody(c, targetBody);
      if (!body.ok) return body.response;
      const done = await createListingTarget(
        db,
        { workspaceId: ws(c), repositoryId: param(c, 'id'), target: body.data, now: ctx.now() },
        actor(c),
      );
      return done.ok ? c.json({ target: done.target }, 201) : targetFailure(c, done);
    },
  );

  app.patch(
    '/:workspaceId/repositories/:id/listing-targets/:targetId',
    needs('repositories.write'),
    async (c) => {
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
    },
  );

  app.delete(
    '/:workspaceId/repositories/:id/listing-targets/:targetId',
    needs('repositories.write'),
    async (c) => {
      const done = await deleteListingTarget(
        db,
        {
          workspaceId: ws(c),
          repositoryId: param(c, 'id'),
          id: param(c, 'targetId'),
          now: ctx.now(),
        },
        actor(c),
      );
      return done.ok ? c.body(null, 204) : targetFailure(c, done);
    },
  );

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
    // The body is optional: none (or an empty one) is the GitHub pull request, as it always was.
    const raw = await c.req.text();
    let parsed: z.infer<typeof applyBody> = {};
    if (raw.trim() !== '') {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return c.json(
          { error: 'invalid_request', issues: [{ path: '', message: 'The body is not JSON.' }] },
          400,
        );
      }
      const result = applyBody.safeParse(json);
      if (!result.success) {
        return c.json(
          {
            error: 'invalid_request',
            issues: result.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
          400,
        );
      }
      parsed = result.data;
    }
    const answer = (done: Awaited<ReturnType<typeof applyChangeSet>>) => {
      if (!done.ok) return respond(c, done);
      return c.json(
        done.alreadyApplied
          ? { changeSet: done.changeSet, alreadyApplied: true }
          : { changeSet: done.changeSet },
      );
    };

    if (parsed.mode === 'local_branch') {
      return answer(
        await applyChangeSetLocally(
          ctx,
          {
            workspaceId: ws(c),
            id: param(c, 'id'),
            branch: parsed.branch,
            push: parsed.push === true,
            openPr: parsed.openPr === true,
          },
          actor(c),
        ),
      );
    }
    if (parsed.branch !== undefined || parsed.push !== undefined || parsed.openPr !== undefined) {
      return c.json(
        {
          error: 'invalid_request',
          message: '"branch", "push" and "openPr" apply to mode local_branch only.',
        },
        400,
      );
    }
    // Before the change set is claimed: it stays approved. A local-only repository has no GitHub to open a pull request on.
    const refused = await localOnlyApplyRefusal(ctx, {
      workspaceId: ws(c),
      changeSetId: param(c, 'id'),
    });
    if (refused) return respond(c, refused);
    return answer(await applyChangeSet(ctx, { workspaceId: ws(c), id: param(c, 'id') }, actor(c)));
  });

  // Pushes the branch of a change set that was applied as a local commit, and optionally opens the
  // pull request. Repeating it is safe: finished steps are skipped. Needs the same right as apply.
  app.post('/:workspaceId/change-sets/:id/push', needs('changesets.approve'), async (c) => {
    const raw = await c.req.text();
    let openPr = false;
    if (raw.trim() !== '') {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        json = undefined;
      }
      const body = publishBody.safeParse(json);
      if (!body.success) return c.json({ error: 'invalid_request' }, 400);
      openPr = body.data.openPr === true;
    }
    const done = await publishLocalCommit(
      ctx,
      { workspaceId: ws(c), id: param(c, 'id'), openPr },
      actor(c),
    );
    if (!done.ok) return respond(c, done);
    return c.json(
      done.alreadyDone
        ? { changeSet: done.changeSet, alreadyDone: true }
        : { changeSet: done.changeSet },
    );
  });

  // Re-bases a stale change set onto the repository as it is now (change-set-refresh.ts). A conflict
  // is 409 refresh_conflicts with the three texts per file and changes nothing; the same request with
  // `resolutions` settles it. A refresh that changes the text returns the set to draft: no approval carries over.
  app.post('/:workspaceId/change-sets/:id/refresh', needs('changesets.write'), async (c) => {
    const raw = await c.req.text();
    let resolutions: Record<string, 'mine' | 'theirs'> | undefined;
    if (raw.trim() !== '') {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return c.json(
          { error: 'invalid_request', issues: [{ path: '', message: 'The body is not JSON.' }] },
          400,
        );
      }
      const result = refreshBody.safeParse(json);
      if (!result.success) {
        return c.json(
          {
            error: 'invalid_request',
            issues: result.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
          400,
        );
      }
      resolutions = result.data.resolutions;
    }
    const done = await refreshChangeSet(
      ctx,
      { workspaceId: ws(c), id: param(c, 'id'), ...(resolutions ? { resolutions } : {}) },
      actor(c),
    );
    if (!done.ok) return respond(c, done);
    const { ok: _ok, ...view } = done;
    return c.json(view);
  });

  // Read-only: is the change set still what the repository holds? Reads with the stored credential
  // (or the local clone), so it needs the right a scan needs, and it writes nothing.
  app.get('/:workspaceId/change-sets/:id/staleness', needs('repositories.scan'), async (c) => {
    const done = await changeSetStaleness(
      ctx,
      { workspaceId: ws(c), id: param(c, 'id') },
      actor(c),
    );
    if (!done.ok) return respond(c, done);
    const { ok: _ok, ...view } = done;
    return c.json(view);
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
