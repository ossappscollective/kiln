import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Database } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import { metadataLock } from './metadata-lock.ts';
import { bootStaged } from './test-helpers.ts';

const TEXT = 'A freshly written description that nobody else would ever write';

async function release(
  db: Database,
  t: { workspaceId: string },
  app: string,
  platform: string,
  version: string,
  status: string | null,
) {
  await db.execute(
    `INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, status, raw_state, status_since, synced_at)
     VALUES (?, ?, ?, ?, ?, '', ?, 'RAW', 5, 5)`,
    [randomUUID(), app, t.workspaceId, platform, version, status],
  );
}

dbTest(
  'a live Apple version locks staging of text, graphics and fixes with a coded 409; an editable version does not',
  async (db) => {
    const t = await bootStaged(db, { draft: { enabled: true } });
    const app = await t.addApp('ios');
    await release(db, t, app, 'ios', '1.0', 'live');
    assert.deepEqual(await metadataLock(db, t.workspaceId, { id: app, platform: 'ios' }), {
      locked: true,
      reason: 'live',
      liveVersion: '1.0',
    });

    const text = await t.stageText(app, {
      locale: 'en-US',
      field: 'description',
      from: 'local',
      value: TEXT,
    });
    assert.equal(text.status, 409, text.text);
    assert.equal(text.body.error, 'metadata_locked');
    assert.equal(text.body.code, 'staged.metadataLocked');
    assert.equal(text.body.params.version, '1.0');
    assert.equal(JSON.stringify(text.body).includes('at '), false); // no stack

    const assets = await t.stageAssets(app, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
    });
    assert.equal(assets.status, 409, assets.text);
    assert.equal(assets.body.error, 'metadata_locked');

    const fix = await t.call(t.owner, 'POST', `/apps/${app}/listing/fixes/stage`, {
      locale: 'en-US',
      field: 'description',
      fixId: 'x',
    });
    assert.equal(fix.status, 409, fix.text);
    assert.equal(fix.body.error, 'metadata_locked');

    // A new version (draft) opens the listing again.
    await release(db, t, app, 'ios', '1.1', 'draft');
    assert.equal(
      (await metadataLock(db, t.workspaceId, { id: app, platform: 'ios' })).locked,
      false,
    );
    assert.equal(
      (
        await t.stageText(app, {
          locale: 'en-US',
          field: 'description',
          from: 'local',
          value: TEXT,
        })
      ).status,
      200,
    );
  },
);

dbTest(
  'in review locks too; an app that was never synced, and Google Play, never lock',
  async (db) => {
    const t = await bootStaged(db, { draft: { enabled: true } });
    const review = await t.addApp('ios');
    await release(db, t, review, 'ios', '2.0', 'live');
    await release(db, t, review, 'ios', '2.1', 'in_review');
    const lock = await metadataLock(db, t.workspaceId, { id: review, platform: 'ios' });
    assert.deepEqual(lock, { locked: true, reason: 'in_review', liveVersion: '2.1' });

    const fresh = await t.addApp('ios', 'Fresh');
    assert.equal(
      (await metadataLock(db, t.workspaceId, { id: fresh, platform: 'ios' })).locked,
      false,
    );
    assert.equal(
      (
        await t.stageText(fresh, {
          locale: 'en-US',
          field: 'description',
          from: 'local',
          value: TEXT,
        })
      ).status,
      200,
    );

    const play = await t.addApp('android');
    await release(db, t, play, 'android', '3.0', 'live');
    await release(db, t, play, 'android', '3.1', 'rolling_out');
    assert.equal(
      (await metadataLock(db, t.workspaceId, { id: play, platform: 'android' })).locked,
      false,
    );
    assert.equal(
      (
        await t.stageText(play, {
          locale: 'en-US',
          field: 'full_description',
          from: 'local',
          value: TEXT,
        })
      ).status,
      200,
    );
  },
);

dbTest(
  'the push re-checks the lock, and the cart skips staged items of a locked app with reason metadata_locked',
  async (db) => {
    const t = await bootStaged(db, { draft: { enabled: true } });
    const app = await t.addApp('ios');
    assert.equal(
      (
        await t.stageText(app, {
          locale: 'en-US',
          field: 'description',
          from: 'local',
          value: TEXT,
        })
      ).status,
      200,
    );
    // The version goes live after the text was staged.
    await release(db, t, app, 'ios', '1.0', 'live');

    const cart = (await t.call(t.owner, 'GET', `/apps/${app}/pending/cart`)).body.cart as {
      items: {
        id: string;
        version: string;
        publishable: boolean;
        reason: { code: string } | null;
      }[];
    };
    assert.equal(cart.items.length > 0, true);
    for (const i of cart.items) {
      assert.equal(i.publishable, false);
      assert.equal(i.reason?.code, 'metadata_locked');
    }
    const done = await t.call(t.owner, 'POST', `/apps/${app}/pending/publish`, {
      items: cart.items.map((i) => ({ id: i.id, version: i.version })),
    });
    assert.equal(done.status, 200, done.text);
    for (const r of done.body.result.results) {
      assert.equal(r.status, 'skipped');
      assert.equal(r.reason, 'metadata_locked');
    }
    const preview = await t.call(t.owner, 'POST', `/apps/${app}/staged/push/preview`, {});
    assert.equal(preview.status, 409, preview.text);
    assert.equal(preview.body.error, 'metadata_locked');
    const push = await t.call(t.owner, 'POST', `/apps/${app}/staged/push`, {
      confirmHash: 'a'.repeat(64),
    });
    assert.notEqual(push.status, 200);
    assert.equal(
      push.body.error === 'metadata_locked' || push.status === 401 || push.status === 403,
      true,
      push.text,
    );
  },
);
