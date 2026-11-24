import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { bootReviews } from './modules/reviews/test-helpers.ts';

// Per-app appearance (docs/adr/0068-app-tint.md): auto by default, off or a custom colour, stored in workspace_settings.

type Appearances = { apps: Record<string, { tint: string; color?: string }> };

dbTest('appearance: auto by default, off and custom are stored, auto removes the row, audited', async (db) => {
  const t = await bootReviews(db);
  const a = await t.addApp('ios', 'Alpha');
  const b = await t.addApp('android', 'Beta');
  assert.deepEqual((await t.call(t.owner, 'GET', '/apps/appearance')).body, { apps: {} });
  const off = await t.call(t.owner, 'PUT', `/apps/${a}/appearance`, { tint: 'off' });
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.body, { appearance: { tint: 'off' }, changed: true });
  const custom = await t.call(t.owner, 'PUT', `/apps/${b}/appearance`, { tint: 'custom', color: '#3B82F6' });
  assert.deepEqual(custom.body.appearance, { tint: 'custom', color: '#3b82f6' }, 'lower case');
  assert.deepEqual(((await t.call(t.owner, 'GET', '/apps/appearance')).body as Appearances).apps, {
    [a]: { tint: 'off' },
    [b]: { tint: 'custom', color: '#3b82f6' },
  });
  assert.equal((await t.call(t.owner, 'PUT', `/apps/${a}/appearance`, { tint: 'off' })).body.changed, false, 'same value, no change');
  assert.equal((await t.call(t.owner, 'PUT', `/apps/${a}/appearance`, { tint: 'auto' })).status, 200);
  assert.deepEqual(Object.keys(((await t.call(t.owner, 'GET', '/apps/appearance')).body as Appearances).apps), [b]);
  assert.equal((await t.auditActions()).filter((x) => x.action === 'app.appearance_update').length, 3);
});

dbTest('appearance: invalid values are refused, another workspace gets 404, viewers cannot write', async (db) => {
  const t = await bootReviews(db);
  const a = await t.addApp('ios', 'Alpha');
  for (const body of [{ tint: 'blue' }, { tint: 'custom' }, { tint: 'custom', color: 'red' }, { tint: 'off', extra: 1 }, {}]) {
    const res = await t.call(t.owner, 'PUT', `/apps/${a}/appearance`, body);
    assert.ok([400, 422].includes(res.status), `${JSON.stringify(body)} -> ${res.status}`);
  }
  assert.equal((await t.call(t.owner, 'PUT', '/apps/nope/appearance', { tint: 'off' })).status, 404);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  assert.equal((await t.call(outsider, 'PUT', `/apps/${a}/appearance`, { tint: 'off' }, 'other')).status, 404, 'an app of another workspace');
  assert.deepEqual(((await t.call(outsider, 'GET', '/apps/appearance', undefined, 'other')).body as Appearances).apps, {});
  const viewer = await t.addMember('viewer');
  assert.equal((await t.call(viewer, 'GET', '/apps/appearance')).status, 200);
  assert.equal((await t.call(viewer, 'PUT', `/apps/${a}/appearance`, { tint: 'off' })).status, 403);
});

dbTest('appearance: a token limited to one app reads and writes only that app', async (db) => {
  const t = await bootReviews(db);
  const a = await t.addApp('ios', 'Alpha');
  const b = await t.addApp('ios', 'Beta');
  await t.call(t.owner, 'PUT', `/apps/${a}/appearance`, { tint: 'off' });
  await t.call(t.owner, 'PUT', `/apps/${b}/appearance`, { tint: 'off' });
  const minted = await t.call(t.owner, 'POST', '/tokens', { name: 'T', role: 'admin', actions: ['apps.read', 'apps.write'], appIds: [a] });
  assert.equal(minted.status, 201, minted.text);
  const bearer = async (method: string, path: string, body?: unknown) => {
    const res = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
      method,
      headers: { authorization: `Bearer ${minted.body.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Appearances };
  };
  const list = await bearer('GET', '/apps/appearance');
  assert.equal(list.status, 200);
  assert.deepEqual(Object.keys(list.body.apps), [a]);
  assert.equal((await bearer('PUT', `/apps/${b}/appearance`, { tint: 'auto' })).status, 404);
  assert.equal((await bearer('PUT', `/apps/${a}/appearance`, { tint: 'auto' })).status, 200);
});

dbTest('appearance: deleting the app deletes its appearance', async (db) => {
  const t = await bootReviews(db);
  const a = await t.addApp('ios', 'Alpha');
  await t.call(t.owner, 'PUT', `/apps/${a}/appearance`, { tint: 'off' });
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${a}`)).status, 204);
  assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM workspace_settings WHERE key LIKE 'app.%.appearance'"))[0]?.n), 0);
});
