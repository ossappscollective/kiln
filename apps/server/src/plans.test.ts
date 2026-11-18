import assert from 'node:assert/strict';
import type { Database } from '@mrm/db';
import { dbTest } from '@mrm/db/testing';
import { purgePlansOfApp } from './services/plans.ts';
import { addMember, auditActions, boot, registerOwner, seedWorkspace } from './testkit.ts';

/** 2027-01-10 12:00 UTC. */
const NOW = Date.UTC(2027, 0, 10, 12, 0, 0);

// biome-ignore lint/suspicious/noExplicitAny: responses are inspected loosely
type Json = Record<string, any>;

async function setup(db: Database) {
  const t = await boot(db);
  t.clock.now = NOW;
  const owner = await registerOwner(t.app);
  const call = async (
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
    workspace = owner.workspaceId,
  ) => {
    const res = await t.app.request(`/api/workspaces/${workspace}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, body: (text ? JSON.parse(text) : null) as Json };
  };
  const seedApp = async (
    workspaceId: string,
    input: { platform?: 'ios' | 'android'; identifier?: string; name?: string } = {},
  ): Promise<string> => {
    const id: string = crypto.randomUUID();
    await db.execute(
      `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'cred', 0)`,
      [id, workspaceId, input.name ?? 'Acme', input.platform ?? 'ios', input.identifier ?? 'com.acme.app'],
    );
    return id;
  };
  const appId = await seedApp(owner.workspaceId);
  const viewer = await addMember(t.app, owner, 'viewer@example.com', 'viewer');
  const member = await addMember(t.app, owner, 'member@example.com', 'member');
  const admin = await addMember(t.app, owner, 'admin@example.com', 'admin');
  const create = async (body: Json = { version: '2.0.0' }, id = appId, cookie = owner.cookie) =>
    call(cookie, 'POST', `/apps/${id}/plans`, body);
  return { ...t, owner, viewer, member, admin, call, seedApp, appId, create };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const planPath = (t: Setup, planId: string, tail = '') => `/apps/${t.appId}/plans/${planId}${tail}`;

// ---------------------------------------------------------------------------------------------
// Rights and isolation

dbTest('rights: viewers read plans and templates, members and above write', async (db) => {
  const t = await setup(db);
  const made = await t.create();
  assert.equal(made.status, 201);
  const planId = made.body.plan.id as string;

  for (const cookie of [t.viewer.cookie, t.member.cookie, t.admin.cookie, t.owner.cookie]) {
    assert.equal((await t.call(cookie, 'GET', '/plans')).status, 200);
    assert.equal((await t.call(cookie, 'GET', `/apps/${t.appId}/plans`)).status, 200);
    assert.equal((await t.call(cookie, 'GET', planPath(t, planId))).status, 200);
    assert.equal((await t.call(cookie, 'GET', '/checklist-templates')).status, 200);
  }

  const writes: [string, string, unknown][] = [
    ['POST', `/apps/${t.appId}/plans`, { version: '3.0.0' }],
    ['PATCH', planPath(t, planId), { targetDate: '2027-02-01' }],
    ['POST', planPath(t, planId, '/items'), { text: 'x' }],
    ['PUT', planPath(t, planId, '/items/order'), { order: [] }],
    ['PATCH', planPath(t, planId, '/items/nope'), { done: true }],
    ['DELETE', planPath(t, planId, '/items/nope'), undefined],
    ['POST', planPath(t, planId, '/apply-template'), { templateId: 'builtin:routine-update' }],
    ['PUT', planPath(t, planId, '/notes/en-US'), { text: 'hi' }],
    ['DELETE', planPath(t, planId, '/notes/en-US'), undefined],
    ['POST', '/checklist-templates', { name: 'T', items: [{ text: 'a' }] }],
    ['PATCH', '/checklist-templates/nope', { name: 'U' }],
    ['DELETE', '/checklist-templates/nope', undefined],
    ['DELETE', planPath(t, planId), undefined],
  ];
  for (const [method, path, body] of writes) {
    const res = await t.call(t.viewer.cookie, method, path, body);
    assert.equal(res.status, 403, `viewer ${method} ${path}`);
  }
  // The plan is untouched by the refused writes.
  assert.equal((await t.call(t.owner.cookie, 'GET', planPath(t, planId))).body.plan.items.length, 0);

  assert.equal((await t.call(t.member.cookie, 'POST', `/apps/${t.appId}/plans`, { version: '3.1.0' })).status, 201);
  assert.equal((await t.call(t.admin.cookie, 'POST', `/apps/${t.appId}/plans`, { version: '3.2.0' })).status, 201);
  assert.equal((await t.call(t.member.cookie, 'DELETE', planPath(t, planId))).status, 204);
});

dbTest('a non-member and an unknown workspace get 404 on every route and see nothing', async (db) => {
  const t = await setup(db);
  const planId = (await t.create()).body.plan.id as string;
  const other = await seedWorkspace(db, 'Other', 'other@example.com', NOW);
  const calls: [string, string, unknown][] = [
    ['GET', '/plans', undefined],
    ['GET', `/apps/${t.appId}/plans`, undefined],
    ['POST', `/apps/${t.appId}/plans`, { version: '9.9.9' }],
    ['GET', planPath(t, planId), undefined],
    ['PATCH', planPath(t, planId), { blocked: false }],
    ['DELETE', planPath(t, planId), undefined],
    ['POST', planPath(t, planId, '/items'), { text: 'x' }],
    ['PUT', planPath(t, planId, '/items/order'), { order: [] }],
    ['PATCH', planPath(t, planId, '/items/x'), { done: true }],
    ['DELETE', planPath(t, planId, '/items/x'), undefined],
    ['POST', planPath(t, planId, '/apply-template'), { templateId: 'builtin:routine-update' }],
    ['PUT', planPath(t, planId, '/notes/en-US'), { text: 'x' }],
    ['DELETE', planPath(t, planId, '/notes/en-US'), undefined],
    ['GET', '/checklist-templates', undefined],
    ['POST', '/checklist-templates', { name: 'T', items: [{ text: 'a' }] }],
    ['PATCH', '/checklist-templates/x', { name: 'T' }],
    ['DELETE', '/checklist-templates/x', undefined],
  ];
  for (const [method, path, body] of calls) {
    const outsider = await t.call(other.cookie, method, path, body);
    assert.equal(outsider.status, 404, `outsider ${method} ${path}`);
    assert.deepEqual(outsider.body, { error: 'not_found' });
    const unknown = await t.call(t.owner.cookie, method, path, body, 'no-such-workspace');
    assert.equal(unknown.status, 404, `unknown ${method} ${path}`);
  }
  assert.equal((await t.call(t.owner.cookie, 'GET', planPath(t, planId))).status, 200);
});

dbTest('workspaces are isolated: plans, apps and templates never cross', async (db) => {
  const t = await setup(db);
  const other = await seedWorkspace(db, 'Other', 'other@example.com', NOW);
  const theirApp = await t.seedApp(other.workspaceId);
  const mine = (await t.create({ version: '1.0.0' })).body.plan;
  const theirs = await t.call(other.cookie, 'POST', `/apps/${theirApp}/plans`, { version: '1.0.0' }, other.workspaceId);
  assert.equal(theirs.status, 201);
  const theirPlan = theirs.body.plan.id as string;

  // Each workspace lists only its own plans.
  assert.deepEqual((await t.call(t.owner.cookie, 'GET', '/plans')).body.plans.map((p: Json) => p.id), [mine.id]);
  assert.deepEqual(
    (await t.call(other.cookie, 'GET', '/plans', undefined, other.workspaceId)).body.plans.map((p: Json) => p.id),
    [theirPlan],
  );
  // An app of the other workspace is not found, and neither is a plan reached through the wrong app.
  assert.equal((await t.call(t.owner.cookie, 'POST', `/apps/${theirApp}/plans`, { version: '5.0.0' })).status, 404);
  assert.equal((await t.call(t.owner.cookie, 'GET', `/apps/${theirApp}/plans`)).status, 404);
  assert.equal((await t.call(t.owner.cookie, 'GET', `/apps/${theirApp}/plans/${theirPlan}`)).status, 404);
  assert.equal((await t.call(t.owner.cookie, 'GET', `/apps/${t.appId}/plans/${theirPlan}`)).status, 404);
  assert.equal(
    (await t.call(other.cookie, 'GET', `/apps/${t.appId}/plans/${mine.id}`, undefined, other.workspaceId)).status,
    404,
  );
  // Writes through the wrong workspace change nothing.
  const sneaky = await t.call(t.owner.cookie, 'PATCH', `/apps/${theirApp}/plans/${theirPlan}`, { blocked: true, blockedReason: 'x' });
  assert.equal(sneaky.status, 404);
  const theirsAfter = await t.call(other.cookie, 'GET', `/apps/${theirApp}/plans/${theirPlan}`, undefined, other.workspaceId);
  assert.equal(theirsAfter.body.plan.blocked, false);
  assert.equal((await t.call(t.owner.cookie, 'DELETE', `/apps/${theirApp}/plans/${theirPlan}`)).status, 404);
  // The same version on the same-named app of two workspaces is two plans.
  assert.notEqual(mine.id, theirPlan);

  // Templates: a template of one workspace is not found in, or usable from, the other.
  const template = await t.call(t.owner.cookie, 'POST', '/checklist-templates', { name: 'Mine', items: [{ text: 'a', required: true }] });
  assert.equal(template.status, 201);
  const tid = template.body.template.id as string;
  const theirList = await t.call(other.cookie, 'GET', '/checklist-templates', undefined, other.workspaceId);
  assert.ok(!theirList.body.templates.some((x: Json) => x.id === tid));
  const apply = await t.call(other.cookie, 'POST', `/apps/${theirApp}/plans/${theirPlan}/apply-template`, { templateId: tid }, other.workspaceId);
  assert.equal(apply.status, 404);
  assert.equal(apply.body.error, 'template_not_found');
  assert.equal((await t.call(other.cookie, 'DELETE', `/checklist-templates/${tid}`, undefined, other.workspaceId)).status, 404);
  assert.equal((await t.call(other.cookie, 'PATCH', `/checklist-templates/${tid}`, { name: 'X' }, other.workspaceId)).status, 404);
  // Template names are unique per workspace, not across them.
  const same = await t.call(other.cookie, 'POST', '/checklist-templates', { name: 'Mine', items: [{ text: 'a' }] }, other.workspaceId);
  assert.equal(same.status, 201);
});

// ---------------------------------------------------------------------------------------------
// Plans

dbTest('creating a plan: shape, defaults, template items, and the checks', async (db) => {
  const t = await setup(db);
  const res = await t.create({ version: '2.0.0', targetDate: '2027-01-12', notes: 'Holiday launch', templateId: 'builtin:first-ios' });
  assert.equal(res.status, 201);
  const plan = res.body.plan;
  assert.equal(plan.appId, t.appId);
  assert.equal(plan.appName, 'Acme');
  assert.equal(plan.appPlatform, 'ios');
  assert.equal(plan.version, '2.0.0');
  assert.equal(plan.platform, null);
  assert.equal(plan.targetDate, '2027-01-12');
  assert.equal(plan.blocked, false);
  assert.equal(plan.blockedReason, null);
  assert.equal(plan.notes, 'Holiday launch');
  assert.equal(plan.createdBy, t.owner.userId);
  assert.equal(plan.createdAt, NOW);
  assert.ok(plan.items.length >= 8);
  assert.deepEqual(plan.items.map((i: Json) => i.position), plan.items.map((_: Json, i: number) => i));
  assert.ok(plan.items.every((i: Json) => i.done === false && i.doneBy === null && i.doneAt === null));
  assert.ok(plan.items.some((i: Json) => /privacy policy/i.test(i.text) && i.required));
  assert.deepEqual(plan.releaseNotes, []);
  assert.equal(plan.readiness.ready, false);
  assert.equal(plan.readiness.required.total, plan.items.filter((i: Json) => i.required).length);
  assert.deepEqual(plan.due, { dueSoon: true, overdue: false, daysLeft: 2 });
  assert.deepEqual(plan.checklist, { total: plan.items.length, done: 0 });

  // Defaults: nothing but a version gives an empty plan for both platforms.
  const bare = await t.create({ version: '2.1.0' });
  assert.equal(bare.body.plan.platform, null);
  assert.deepEqual(bare.body.plan.items, []);
  assert.equal(bare.body.plan.targetDate, null);
  assert.deepEqual(bare.body.plan.due, { dueSoon: false, overdue: false, daysLeft: null });

  // The app's own platform is fine.
  assert.equal((await t.create({ version: '2.2.0', platform: 'ios' })).body.plan.platform, 'ios');

  const bad = async (body: Json, status: number, error?: string) => {
    const r = await t.create(body);
    assert.equal(r.status, status, JSON.stringify(body));
    if (error) assert.equal(r.body.error, error);
    return r;
  };
  await bad({}, 400, 'invalid_request');
  await bad({ version: '' }, 400);
  await bad({ version: 'a b' }, 400);
  await bad({ version: '1/2' }, 400);
  await bad({ version: 'x'.repeat(65) }, 400);
  await bad({ version: '3.0.0', targetDate: '2027-02-30' }, 400);
  await bad({ version: '3.0.0', targetDate: '01/02/2027' }, 400);
  await bad({ version: '3.0.0', platform: 'windows' }, 400);
  await bad({ version: '3.0.0', surprise: true }, 400);
  await bad({ version: '3.0.0', notes: 'x'.repeat(4001) }, 400);
  await bad({ version: '3.0.0', platform: 'android' }, 422, 'platform_mismatch');
  const dupe = await bad({ version: '2.0.0' }, 409, 'already_exists');
  assert.equal(dupe.body.planId, plan.id);
  await bad({ version: '3.0.0', templateId: 'nope' }, 404, 'template_not_found');
  await bad({ version: '3.0.0', templateId: 'builtin:nope' }, 404, 'template_not_found');
  assert.equal((await t.create({ version: '3.0.0' }, 'no-such-app')).status, 404);
  // A failed create leaves nothing behind.
  const list = (await t.call(t.owner.cookie, 'GET', `/apps/${t.appId}/plans`)).body.plans;
  assert.deepEqual(list.map((p: Json) => p.version).sort(), ['2.0.0', '2.1.0', '2.2.0']);
});

dbTest('the same version on the two platforms of a product is two plans, one per app', async (db) => {
  const t = await setup(db);
  const android = await t.seedApp(t.owner.workspaceId, { platform: 'android', name: 'Acme' });
  assert.equal((await t.create({ version: '2.0.0' })).status, 201);
  assert.equal((await t.create({ version: '2.0.0' }, android)).status, 201);
  assert.equal((await t.create({ version: '2.0.0', platform: 'android' }, android)).status, 409);
  const all = (await t.call(t.owner.cookie, 'GET', '/plans')).body.plans;
  assert.deepEqual(all.map((p: Json) => p.appPlatform).sort(), ['android', 'ios']);
});

dbTest('deadline flags use the injected clock and stop once the release is live', async (db) => {
  const t = await setup(db);
  const id = (await t.create({ version: '2.0.0', targetDate: '2027-01-15' })).body.plan.id as string;
  const flags = async () => (await t.call(t.owner.cookie, 'GET', planPath(t, id))).body.plan.due;

  assert.deepEqual(await flags(), { dueSoon: false, overdue: false, daysLeft: 5 });
  t.clock.now = Date.UTC(2027, 0, 12, 0, 0, 0);
  assert.deepEqual(await flags(), { dueSoon: true, overdue: false, daysLeft: 3 });
  t.clock.now = Date.UTC(2027, 0, 15, 23, 59, 59);
  assert.deepEqual(await flags(), { dueSoon: true, overdue: false, daysLeft: 0 });
  t.clock.now = Date.UTC(2027, 0, 16, 0, 0, 0);
  assert.deepEqual(await flags(), { dueSoon: false, overdue: true, daysLeft: -1 });
  // The workspace list computes the same flags.
  assert.equal((await t.call(t.owner.cookie, 'GET', '/plans')).body.plans[0].due.overdue, true);

  // Once a sync has seen this version live, the deadline no longer counts.
  await db.execute(
    `INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, status, raw_state, synced_at)
     VALUES ('r1', ?, ?, 'ios', '2.0.0', '', 'live', 'READY_FOR_SALE', 0)`,
    [t.appId, t.owner.workspaceId],
  );
  const after = (await t.call(t.owner.cookie, 'GET', planPath(t, id))).body.plan;
  assert.equal(after.released, true);
  assert.deepEqual(after.due, { dueSoon: false, overdue: false, daysLeft: -1 });
  // A release in another state does not count as released.
  await db.execute("UPDATE app_releases SET status = 'in_review' WHERE id = 'r1'");
  assert.equal((await t.call(t.owner.cookie, 'GET', planPath(t, id))).body.plan.due.overdue, true);
});

dbTest('updating a plan: date, blocked flag with a reason, notes', async (db) => {
  const t = await setup(db);
  const id = (await t.create({ version: '2.0.0' })).body.plan.id as string;
  const patch = (body: unknown, cookie = t.member.cookie) => t.call(cookie, 'PATCH', planPath(t, id), body);

  assert.equal((await patch({})).status, 400);
  assert.equal((await patch({ version: '9.9.9' })).status, 400);
  assert.equal((await patch({ targetDate: 'tomorrow' })).status, 400);
  assert.equal((await patch({ blockedReason: 'x'.repeat(501) })).status, 400);

  const dated = await patch({ targetDate: '2027-03-01' });
  assert.equal(dated.status, 200);
  assert.equal(dated.body.plan.targetDate, '2027-03-01');
  assert.equal((await patch({ targetDate: null })).body.plan.targetDate, null);

  // Blocking needs a reason.
  const noReason = await patch({ blocked: true });
  assert.equal(noReason.status, 422);
  assert.equal(noReason.body.error, 'reason_required');
  assert.equal((await patch({ blocked: true, blockedReason: '   ' })).status, 422);
  const blocked = await patch({ blocked: true, blockedReason: '  Waiting for legal  ' });
  assert.equal(blocked.body.plan.blocked, true);
  assert.equal(blocked.body.plan.blockedReason, 'Waiting for legal');
  // The reason can change while it stays blocked, and the flag keeps it without being resent.
  assert.equal((await patch({ blockedReason: 'Waiting for the privacy review' })).body.plan.blockedReason, 'Waiting for the privacy review');
  assert.equal((await patch({ notes: 'ping Sam' })).body.plan.blockedReason, 'Waiting for the privacy review');
  const cleared = await patch({ blocked: false, blockedReason: 'ignored' });
  assert.equal(cleared.body.plan.blocked, false);
  assert.equal(cleared.body.plan.blockedReason, null);
  assert.equal(cleared.body.plan.notes, 'ping Sam');
  assert.equal((await patch({ targetDate: '2027-03-01' }, t.owner.cookie)).status, 200);
  assert.equal((await t.call(t.owner.cookie, 'PATCH', planPath(t, 'no-such'), { notes: 'x' })).status, 404);
});

// ---------------------------------------------------------------------------------------------
// Checklist

dbTest('checklist items: add, tick with who and when, edit, reorder, remove', async (db) => {
  const t = await setup(db);
  const id = (await t.create({ version: '2.0.0' })).body.plan.id as string;
  const items = (tail = '') => planPath(t, id, `/items${tail}`);

  const a = await t.call(t.member.cookie, 'POST', items(), { text: '  Privacy policy URL  ', required: true });
  assert.equal(a.status, 201);
  const aId = a.body.itemId as string;
  const b = await t.call(t.member.cookie, 'POST', items(), { text: 'Screenshots' });
  const c = await t.call(t.member.cookie, 'POST', items(), { text: 'Test account', required: true });
  const bId = b.body.itemId as string;
  const cId = c.body.itemId as string;
  assert.deepEqual(c.body.plan.items.map((i: Json) => [i.text, i.required, i.position]), [
    ['Privacy policy URL', true, 0],
    ['Screenshots', false, 1],
    ['Test account', true, 2],
  ]);
  for (const body of [{}, { text: '' }, { text: 'two\nlines' }, { text: 'x'.repeat(301) }, { text: 'x', extra: 1 }, { text: 'x', required: 'yes' }]) {
    assert.equal((await t.call(t.member.cookie, 'POST', items(), body)).status, 400, JSON.stringify(body));
  }

  // Ticking records who and when, from the clock.
  t.clock.now = NOW + 5 * 60_000;
  const ticked = await t.call(t.member.cookie, 'PATCH', items(`/${aId}`), { done: true });
  const item = ticked.body.plan.items.find((i: Json) => i.id === aId);
  assert.equal(item.done, true);
  assert.equal(item.doneAt, NOW + 5 * 60_000);
  assert.deepEqual(item.doneBy, { id: t.member.userId, name: 'member' });
  assert.deepEqual(ticked.body.plan.readiness.required, { total: 2, done: 1, open: 1 });
  // Ticking again, by someone else later, keeps the first person and time.
  t.clock.now = NOW + 60 * 60_000;
  const again = await t.call(t.admin.cookie, 'PATCH', items(`/${aId}`), { done: true });
  const kept = again.body.plan.items.find((i: Json) => i.id === aId);
  assert.equal(kept.doneBy.id, t.member.userId);
  assert.equal(kept.doneAt, NOW + 5 * 60_000);
  // Unticking clears them.
  const unticked = await t.call(t.admin.cookie, 'PATCH', items(`/${aId}`), { done: false });
  const open = unticked.body.plan.items.find((i: Json) => i.id === aId);
  assert.deepEqual([open.done, open.doneBy, open.doneAt], [false, null, null]);

  // Edit text and the required marker; both change the readiness.
  const edited = await t.call(t.member.cookie, 'PATCH', items(`/${bId}`), { text: 'Screenshots, all sizes', required: true });
  const editedItem = edited.body.plan.items.find((i: Json) => i.id === bId);
  assert.equal(editedItem.required, true);
  assert.equal(editedItem.text, 'Screenshots, all sizes');
  assert.equal(edited.body.plan.readiness.required.total, 3);
  assert.equal((await t.call(t.member.cookie, 'PATCH', items(`/${bId}`), {})).status, 400);
  assert.equal((await t.call(t.member.cookie, 'PATCH', items('/no-such'), { done: true })).status, 404);

  // Reorder: must name every item exactly once.
  const order = [cId, aId, bId];
  const moved = await t.call(t.member.cookie, 'PUT', items('/order'), { order });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.plan.items.map((i: Json) => i.id), order);
  assert.deepEqual(moved.body.plan.items.map((i: Json) => i.position), [0, 1, 2]);
  for (const bad of [[aId, bId], [aId, aId, bId], [aId, bId, cId, 'x'], [aId, bId, 'x']]) {
    const r = await t.call(t.member.cookie, 'PUT', items('/order'), { order: bad });
    assert.equal(r.status, 422, JSON.stringify(bad));
    assert.equal(r.body.error, 'order_mismatch');
  }
  assert.equal((await t.call(t.member.cookie, 'PUT', items('/order'), { order: 'abc' })).status, 400);
  // The order survived the refused attempts.
  const now = (await t.call(t.owner.cookie, 'GET', planPath(t, id))).body.plan;
  assert.deepEqual(now.items.map((i: Json) => i.id), order);

  // Remove: the rest keep their order, and a new item goes last.
  const removed = await t.call(t.member.cookie, 'DELETE', items(`/${aId}`));
  assert.deepEqual(removed.body.plan.items.map((i: Json) => i.id), [cId, bId]);
  assert.equal((await t.call(t.member.cookie, 'DELETE', items(`/${aId}`))).status, 404);
  const last = await t.call(t.member.cookie, 'POST', items(), { text: 'Last' });
  assert.equal(last.body.plan.items.at(-1).text, 'Last');
  assert.equal(last.body.plan.items.at(-1).position, 3);
});

dbTest('an item of another plan cannot be reached through this one', async (db) => {
  const t = await setup(db);
  const p1 = (await t.create({ version: '1.0.0' })).body.plan.id as string;
  const p2 = (await t.create({ version: '1.1.0' })).body.plan.id as string;
  const item = (await t.call(t.owner.cookie, 'POST', planPath(t, p2, '/items'), { text: 'Only in p2' })).body.itemId as string;
  assert.equal((await t.call(t.owner.cookie, 'PATCH', planPath(t, p1, `/items/${item}`), { done: true })).status, 404);
  assert.equal((await t.call(t.owner.cookie, 'DELETE', planPath(t, p1, `/items/${item}`))).status, 404);
  const still = (await t.call(t.owner.cookie, 'GET', planPath(t, p2))).body.plan.items[0];
  assert.equal(still.done, false);
  // Reordering p1 with p2's item is a mismatch.
  const r = await t.call(t.owner.cookie, 'PUT', planPath(t, p1, '/items/order'), { order: [item] });
  assert.equal(r.status, 422);
});

dbTest('a checklist holds at most 100 items', async (db) => {
  const t = await setup(db);
  const id = (await t.create({ version: '2.0.0' })).body.plan.id as string;
  for (let i = 0; i < 100; i++) {
    await db.execute(
      "INSERT INTO checklist_items (id, workspace_id, plan_id, position, text, required, done) VALUES (?, ?, ?, ?, 'x', 0, 0)",
      [`i${i}`, t.owner.workspaceId, id, i],
    );
  }
  const r = await t.call(t.owner.cookie, 'POST', planPath(t, id, '/items'), { text: 'one more' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'too_many_items');
  const apply = await t.call(t.owner.cookie, 'POST', planPath(t, id, '/apply-template'), { templateId: 'builtin:first-ios' });
  assert.equal(apply.status, 422);
});

// ---------------------------------------------------------------------------------------------
// Templates

dbTest('templates: the shipped ones, saving your own, applying without repeats', async (db) => {
  const t = await setup(db);
  const list = (await t.call(t.viewer.cookie, 'GET', '/checklist-templates')).body.templates as Json[];
  assert.deepEqual(list.filter((x) => x.builtin).map((x) => x.id), ['builtin:first-ios', 'builtin:first-android', 'builtin:routine-update']);
  assert.ok(list.every((x) => x.builtin));
  const ios = list.find((x) => x.id === 'builtin:first-ios') as Json;
  const android = list.find((x) => x.id === 'builtin:first-android') as Json;
  const lower = (x: Json) => x.items.map((i: Json) => i.text.toLowerCase()).join('|');
  for (const needle of ['privacy policy', 'screenshots', 'export compliance', 'age rating', 'test account', 'release notes', 'what’s new']) assert.match(lower(ios), new RegExp(needle));
  for (const needle of ['privacy policy', 'screenshots', 'content rating', 'data safety', 'test account', 'release notes', 'what’s new']) assert.match(lower(android), new RegExp(needle));

  const created = await t.call(t.member.cookie, 'POST', '/checklist-templates', {
    name: 'Hotfix',
    items: [{ text: 'Smoke test', required: true }, { text: 'Tell support' }],
  });
  assert.equal(created.status, 201);
  const tid = created.body.template.id as string;
  assert.deepEqual(created.body.template.items, [{ text: 'Smoke test', required: true }, { text: 'Tell support', required: false }]);
  assert.equal(created.body.template.builtin, false);
  assert.equal((await t.call(t.member.cookie, 'POST', '/checklist-templates', { name: 'Hotfix', items: [{ text: 'a' }] })).status, 409);
  const badBodies: unknown[] = [
    {},
    { name: '', items: [{ text: 'a' }] },
    { name: 'N', items: [] },
    { name: 'N', items: [{ text: '' }] },
    { name: 'N', items: [{ text: 'a', required: 1 }] },
    { name: 'a\nb', items: [{ text: 'a' }] },
    { name: 'N', items: Array.from({ length: 101 }, () => ({ text: 'a' })) },
  ];
  for (const body of badBodies) {
    assert.equal((await t.call(t.member.cookie, 'POST', '/checklist-templates', body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  const stored = (await t.call(t.viewer.cookie, 'GET', '/checklist-templates')).body.templates as Json[];
  assert.deepEqual(stored.filter((x) => !x.builtin).map((x) => x.name), ['Hotfix']);

  const renamed = await t.call(t.member.cookie, 'PATCH', `/checklist-templates/${tid}`, { name: 'Hotfix v2', items: [{ text: 'Smoke test', required: true }] });
  assert.equal(renamed.body.template.name, 'Hotfix v2');
  assert.equal(renamed.body.template.items.length, 1);
  assert.equal((await t.call(t.member.cookie, 'PATCH', `/checklist-templates/${tid}`, {})).status, 400);
  await t.call(t.member.cookie, 'POST', '/checklist-templates', { name: 'Other', items: [{ text: 'a' }] });
  assert.equal((await t.call(t.member.cookie, 'PATCH', `/checklist-templates/${tid}`, { name: 'Other' })).status, 409);

  // Shipped templates cannot be changed or deleted.
  for (const [method, body] of [['PATCH', { name: 'X' }], ['DELETE', undefined]] as const) {
    const r = await t.call(t.member.cookie, method, '/checklist-templates/builtin:first-ios', body);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'builtin_template');
  }

  // Apply: an item already there is skipped, and applying twice adds nothing the second time.
  const planId = (await t.create({ version: '2.0.0' })).body.plan.id as string;
  await t.call(t.member.cookie, 'POST', planPath(t, planId, '/items'), { text: 'Smoke test' });
  const first = await t.call(t.member.cookie, 'POST', planPath(t, planId, '/apply-template'), { templateId: tid });
  assert.deepEqual([first.body.added, first.body.skipped], [0, 1]);
  const routine = await t.call(t.member.cookie, 'POST', planPath(t, planId, '/apply-template'), { templateId: 'builtin:routine-update' });
  assert.equal(routine.body.added, routine.body.plan.items.length - 1);
  const twice = await t.call(t.member.cookie, 'POST', planPath(t, planId, '/apply-template'), { templateId: 'builtin:routine-update' });
  assert.deepEqual([twice.body.added, twice.body.skipped], [0, routine.body.added]);
  assert.equal(twice.body.plan.items.length, routine.body.plan.items.length);
  assert.equal((await t.call(t.member.cookie, 'POST', planPath(t, planId, '/apply-template'), { templateId: 'nope' })).status, 404);

  // Deleting a template leaves the plans that used it alone.
  assert.equal((await t.call(t.member.cookie, 'DELETE', `/checklist-templates/${tid}`)).status, 204);
  assert.equal((await t.call(t.member.cookie, 'DELETE', `/checklist-templates/${tid}`)).status, 404);
  assert.equal((await t.call(t.owner.cookie, 'GET', planPath(t, planId))).body.plan.items.length, twice.body.plan.items.length);
});

dbTest('a workspace can save at most 50 templates', async (db) => {
  const t = await setup(db);
  for (let i = 0; i < 50; i++) {
    await db.execute(
      "INSERT INTO checklist_templates (id, workspace_id, name, items_json, created_by, created_at, updated_at) VALUES (?, ?, ?, '[]', 'u', 0, 0)",
      [`t${i}`, t.owner.workspaceId, `T${i}`],
    );
  }
  const r = await t.call(t.owner.cookie, 'POST', '/checklist-templates', { name: 'One more', items: [{ text: 'a' }] });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'too_many_templates');
});

// ---------------------------------------------------------------------------------------------
// Release notes

dbTest('release notes: per locale, with the store limit of the plan platform', async (db) => {
  const t = await setup(db);
  const both = (await t.create({ version: '2.0.0' })).body.plan.id as string;
  const ios = (await t.create({ version: '2.1.0', platform: 'ios' })).body.plan.id as string;
  const notes = (id: string, locale: string) => planPath(t, id, `/notes/${locale}`);
  const put = (id: string, locale: string, text: string) => t.call(t.member.cookie, 'PUT', notes(id, locale), { text });

  const first = await put(both, 'en-US', 'Bug fixes.');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.plan.releaseNotes.map((n: Json) => [n.locale, n.text, n.length]), [['en-US', 'Bug fixes.', 10]]);
  assert.equal(first.body.plan.releaseNotes[0].updatedAt, NOW);
  // Replace, add a second locale and a blank one (an expected locale, not written yet).
  await put(both, 'en-US', 'Fixes.');
  await put(both, 'de-DE', 'Fehler behoben.');
  const blank = await put(both, 'fr-FR', '');
  assert.deepEqual(blank.body.plan.releaseNotes.map((n: Json) => n.locale), ['de-DE', 'en-US', 'fr-FR']);
  assert.equal(blank.body.plan.releaseNotes.find((n: Json) => n.locale === 'en-US').text, 'Fixes.');
  assert.deepEqual(blank.body.plan.readiness.notes.missing, ['fr-FR']);
  assert.equal(blank.body.plan.readiness.notes.complete, false);
  assert.equal(blank.body.plan.readiness.ready, false);
  const filled = await put(both, 'fr-FR', 'Correctifs.');
  assert.equal(filled.body.plan.readiness.notes.complete, true);
  assert.equal(filled.body.plan.readiness.ready, true);

  // 500 characters for a plan on both platforms; code points, not UTF-16 units.
  assert.equal((await put(both, 'en-US', 'x'.repeat(500))).status, 200);
  assert.equal((await put(both, 'en-US', '😀'.repeat(500))).status, 200);
  const over = await put(both, 'en-US', 'x'.repeat(501));
  assert.equal(over.status, 422);
  assert.equal(over.body.error, 'notes_too_long');
  assert.deepEqual([over.body.locale, over.body.limit, over.body.actual], ['en-US', 500, 501]);
  assert.match(over.body.message, /501 characters/);
  assert.equal((await put(both, 'en-US', '😀'.repeat(501))).status, 422);
  // The refused write changed nothing.
  const after = (await t.call(t.owner.cookie, 'GET', planPath(t, both))).body.plan.releaseNotes;
  assert.equal(after.find((n: Json) => n.locale === 'en-US').text, '😀'.repeat(500));

  // An iOS plan allows 4000.
  assert.equal((await put(ios, 'en-US', 'x'.repeat(4000))).status, 200);
  const iosOver = await put(ios, 'en-US', 'x'.repeat(4001));
  assert.equal(iosOver.status, 422);
  assert.equal(iosOver.body.limit, 4000);
  assert.equal((await t.call(t.owner.cookie, 'GET', planPath(t, ios))).body.plan.readiness.notes.limit, 4000);

  // Locale and body checks.
  for (const locale of ['english', 'e', 'en-', '%20', 'en%20US']) {
    assert.equal((await put(both, locale, 'x')).status, 400, locale);
  }
  assert.equal((await put(both, 'default', 'fallback')).status, 200);
  assert.equal((await t.call(t.member.cookie, 'PUT', notes(both, 'ja'), {})).status, 400);
  assert.equal((await t.call(t.member.cookie, 'PUT', notes(both, 'ja'), { text: 5 })).status, 400);
  assert.equal((await t.call(t.member.cookie, 'PUT', notes(both, 'ja'), { text: 'x', extra: 1 })).status, 400);

  // Delete a locale.
  const gone = await t.call(t.member.cookie, 'DELETE', notes(both, 'fr-FR'));
  assert.ok(!gone.body.plan.releaseNotes.some((n: Json) => n.locale === 'fr-FR'));
  assert.equal((await t.call(t.member.cookie, 'DELETE', notes(both, 'fr-FR'))).status, 404);
  assert.equal((await t.call(t.member.cookie, 'DELETE', notes(both, 'nope!'))).status, 400);
  // Notes of one plan are not visible on another.
  assert.deepEqual((await t.call(t.owner.cookie, 'GET', planPath(t, ios))).body.plan.releaseNotes.map((n: Json) => n.locale), ['en-US']);
});

dbTest('a plan holds release notes for at most 80 locales', async (db) => {
  const t = await setup(db);
  const id = (await t.create({ version: '2.0.0' })).body.plan.id as string;
  for (let i = 0; i < 80; i++) {
    await db.execute(
      "INSERT INTO release_notes (id, workspace_id, plan_id, locale, text, updated_at) VALUES (?, ?, ?, ?, 'x', 0)",
      [`n${i}`, t.owner.workspaceId, id, String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26))],
    );
  }
  const r = await t.call(t.owner.cookie, 'PUT', planPath(t, id, '/notes/en-US'), { text: 'x' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'too_many_locales');
  // Changing one that exists is still fine.
  assert.equal((await t.call(t.owner.cookie, 'PUT', planPath(t, id, '/notes/ab'), { text: 'y' })).status, 200);
});

// ---------------------------------------------------------------------------------------------
// Lists, deletes, audit, limits

dbTest('the workspace list and the app list carry the summary, soonest deadline first', async (db) => {
  const t = await setup(db);
  const android = await t.seedApp(t.owner.workspaceId, { platform: 'android', name: 'Acme Android', identifier: 'com.acme.android' });
  await t.create({ version: '1.0.0' });
  await t.create({ version: '1.1.0', targetDate: '2027-02-01' });
  await t.create({ version: '1.2.0', targetDate: '2027-01-20' });
  await t.create({ version: '4.0.0' }, android);
  const all = (await t.call(t.viewer.cookie, 'GET', '/plans')).body.plans as Json[];
  assert.deepEqual(all.slice(0, 2).map((p) => p.version), ['1.2.0', '1.1.0']);
  assert.equal(all.length, 4);
  assert.ok(all.every((p) => 'readiness' in p && 'due' in p && 'checklist' in p && !('items' in p) && !('releaseNotes' in p)));
  assert.equal(all.find((p) => p.version === '4.0.0')?.appName, 'Acme Android');
  const mine = (await t.call(t.viewer.cookie, 'GET', `/apps/${t.appId}/plans`)).body.plans as Json[];
  assert.equal(mine.length, 3);
  assert.ok(mine.every((p) => p.appId === t.appId));
});

dbTest('deleting a plan removes its items and notes; a plan of a deleted app is not shown', async (db) => {
  const t = await setup(db);
  const id = (await t.create({ version: '2.0.0', templateId: 'builtin:routine-update' })).body.plan.id as string;
  await t.call(t.owner.cookie, 'PUT', planPath(t, id, '/notes/en-US'), { text: 'x' });
  const count = async (table: string) => Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n);
  assert.ok((await count('checklist_items')) > 0);
  assert.equal(await count('release_notes'), 1);
  assert.equal((await t.call(t.owner.cookie, 'DELETE', planPath(t, id))).status, 204);
  assert.equal(await count('checklist_items'), 0);
  assert.equal(await count('release_notes'), 0);
  assert.equal(await count('release_plans'), 0);
  assert.equal((await t.call(t.owner.cookie, 'DELETE', planPath(t, id))).status, 404);

  // Deleting an app (the apps service does not know about plans) must keep working, and hides its plans.
  const other = await t.seedApp(t.owner.workspaceId, { identifier: 'com.acme.two' });
  const planId = (await t.create({ version: '1.0.0' }, other)).body.plan.id as string;
  assert.equal((await t.call(t.owner.cookie, 'DELETE', `/apps/${other}`)).status, 204);
  assert.equal((await t.call(t.owner.cookie, 'GET', `/apps/${other}/plans/${planId}`)).status, 404);
  assert.deepEqual((await t.call(t.owner.cookie, 'GET', '/plans')).body.plans, []);

  // The tidy-up helper removes the rows the app deletion leaves behind.
  assert.equal(await count('release_plans'), 1);
  await purgePlansOfApp(db, t.owner.workspaceId, other);
  assert.equal(await count('release_plans'), 0);
});

dbTest('every change is audited with who did it, and reads are not', async (db) => {
  const t = await setup(db);
  // Audit rows are ordered by time; a clock that moves keeps the order of the steps.
  const tick = () => {
    t.clock.now += 1000;
  };
  tick();
  const before = (await auditActions(db, t.owner.workspaceId)).length;
  await t.call(t.viewer.cookie, 'GET', '/plans');
  assert.equal((await auditActions(db, t.owner.workspaceId)).length, before);

  tick();
  const created = await t.create({ version: '2.0.0', templateId: 'builtin:routine-update' });
  const id = created.body.plan.id as string;
  const itemId = created.body.plan.items[0].id as string;
  const reverse = async () => {
    const current = (await t.call(t.owner.cookie, 'GET', planPath(t, id))).body.plan.items as Json[];
    return { order: current.map((i) => i.id).reverse() };
  };
  const steps: [string, string, string, unknown][] = [
    ['plan.update', 'PATCH', planPath(t, id), { blocked: true, blockedReason: 'Waiting for legal' }],
    ['checklist.item_add', 'POST', planPath(t, id, '/items'), { text: 'Extra item' }],
    ['checklist.item_update', 'PATCH', planPath(t, id, `/items/${itemId}`), { done: true }],
    ['checklist.reorder', 'PUT', planPath(t, id, '/items/order'), undefined],
    ['plan.apply_template', 'POST', planPath(t, id, '/apply-template'), { templateId: 'builtin:first-ios' }],
    ['plan.notes_set', 'PUT', planPath(t, id, '/notes/en-US'), { text: 'Secret roadmap text' }],
    ['plan.notes_delete', 'DELETE', planPath(t, id, '/notes/en-US'), undefined],
    ['checklist.item_delete', 'DELETE', planPath(t, id, `/items/${itemId}`), undefined],
    ['checklist_template.create', 'POST', '/checklist-templates', { name: 'Mine', items: [{ text: 'a' }] }],
  ];
  for (const [action, method, path, body] of steps) {
    // A reorder must list every item at that moment.
    const payload = action === 'checklist.reorder' ? await reverse() : body;
    tick();
    const res = await t.call(t.member.cookie, method, path, payload);
    assert.ok(res.status < 300, `${action} ${res.status} ${res.text}`);
  }
  const templateId = (await db.query('SELECT id FROM checklist_templates'))[0]?.id as string;
  const more: [string, string, string, unknown][] = [
    ['checklist_template.update', 'PATCH', `/checklist-templates/${templateId}`, { name: 'Mine v2' }],
    ['checklist_template.delete', 'DELETE', `/checklist-templates/${templateId}`, undefined],
    ['plan.delete', 'DELETE', planPath(t, id), undefined],
  ];
  for (const [, method, path, body] of more) {
    tick();
    assert.ok((await t.call(t.admin.cookie, method, path, body)).status < 300, path);
  }
  const events = (await auditActions(db, t.owner.workspaceId)).slice(before);
  assert.deepEqual(events.map((e) => e.action), ['plan.create', ...steps.map(([a]) => a), ...more.map(([a]) => a)]);
  const actor = (a: string) => events.find((e) => e.action === a)?.actorId;
  assert.equal(actor('plan.create'), t.owner.userId);
  assert.equal(actor('plan.update'), t.member.userId);
  assert.equal(actor('plan.delete'), t.admin.userId);
  assert.equal(events.find((e) => e.action === 'plan.create')?.targetId, id);
  assert.deepEqual(events.find((e) => e.action === 'plan.update')?.detail, {
    appId: t.appId,
    version: '2.0.0',
    changed: ['blocked'],
    blocked: true,
    reason: 'Waiting for legal',
  });
  // Release notes text stays out of the audit log: only the locale and the length.
  assert.deepEqual(events.find((e) => e.action === 'plan.notes_set')?.detail, {
    version: '2.0.0',
    locale: 'en-US',
    length: 19,
    added: true,
  });
  assert.ok(!JSON.stringify(events).includes('Secret roadmap text'));

  // A refused or failed request writes nothing.
  const count = (await auditActions(db, t.owner.workspaceId)).length;
  await t.call(t.viewer.cookie, 'POST', `/apps/${t.appId}/plans`, { version: '7.0.0' });
  await t.create({ version: 'bad version' });
  await t.call(t.owner.cookie, 'PUT', planPath(t, 'missing', '/notes/en-US'), { text: 'x' });
  assert.equal((await auditActions(db, t.owner.workspaceId)).length, count);
});

dbTest('a change that changes nothing is not audited', async (db) => {
  const t = await setup(db);
  const created = await t.create({ version: '2.0.0', targetDate: '2027-02-01', templateId: 'builtin:routine-update' });
  const id = created.body.plan.id as string;
  const itemId = created.body.plan.items[0].id as string;
  await t.call(t.owner.cookie, 'PATCH', planPath(t, id, `/items/${itemId}`), { done: true });
  const count = (await auditActions(db, t.owner.workspaceId)).length;
  await t.call(t.owner.cookie, 'PATCH', planPath(t, id), { targetDate: '2027-02-01' });
  await t.call(t.owner.cookie, 'PATCH', planPath(t, id, `/items/${itemId}`), { done: true });
  assert.equal((await auditActions(db, t.owner.workspaceId)).length, count);
});

dbTest('request bodies are limited like the other routes', async (db) => {
  const t = await setup(db);
  const id = (await t.create({ version: '2.0.0' })).body.plan.id as string;
  const huge = JSON.stringify({ text: 'x'.repeat(40 * 1024) });
  const small = await t.call(t.owner.cookie, 'PUT', planPath(t, id, '/notes/en-US'), huge);
  assert.equal(small.status, 413);
  assert.equal(small.body.error, 'payload_too_large');
  assert.equal((await t.call(t.owner.cookie, 'POST', planPath(t, id, '/items'), huge)).status, 413);
  assert.equal((await t.call(t.owner.cookie, 'POST', `/apps/${t.appId}/plans`, huge)).status, 413);
  const bigTemplate = JSON.stringify({ name: 'Big', items: [{ text: 'x'.repeat(70 * 1024) }] });
  assert.equal((await t.call(t.owner.cookie, 'POST', '/checklist-templates', bigTemplate)).status, 413);
  // The server-wide limit still applies first.
  const tooBig = JSON.stringify({ text: 'x'.repeat(1024 * 1024 + 10) });
  assert.equal((await t.call(t.owner.cookie, 'PUT', planPath(t, id, '/notes/en-US'), tooBig)).status, 413);
  // A full 500 character note in a multi-byte script is still allowed.
  assert.equal((await t.call(t.owner.cookie, 'PUT', planPath(t, id, '/notes/ja'), { text: 'あ'.repeat(500) })).status, 200);
});

dbTest('a malformed body is a 400 with the issues, never a 500', async (db) => {
  const t = await setup(db);
  const id = (await t.create({ version: '2.0.0' })).body.plan.id as string;
  const targets: [string, string][] = [
    ['POST', `/apps/${t.appId}/plans`],
    ['PATCH', planPath(t, id)],
    ['POST', planPath(t, id, '/items')],
    ['PUT', planPath(t, id, '/notes/en-US')],
    ['POST', '/checklist-templates'],
  ];
  for (const [method, path] of targets) {
    const r = await t.call(t.owner.cookie, method, path, 'not json{');
    assert.equal(r.status, 400, path);
    assert.equal(r.body.error, 'invalid_request');
    assert.ok(Array.isArray(r.body.issues));
  }
});
