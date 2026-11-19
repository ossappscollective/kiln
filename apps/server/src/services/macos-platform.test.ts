import assert from 'node:assert/strict';
import test from 'node:test';
import { migrate } from '@mrm/db';
import { dbTest } from '@mrm/db/testing';
import { fileFitsPlatform } from './asset-index.ts';
import { reviewsOwnedByOtherRecord } from './review-sync.ts';

// The macOS rules of the server services that need no store: which assets belong to which Apple platform, and which
// record of a universal purchase app owns the customer reviews.

test('a Mac screenshot belongs to macOS only, an iPhone one to iOS only, and Google Play keeps everything', () => {
  const shot = (device: string | null) => ({ kind: 'screenshot' as const, device });
  assert.equal(fileFitsPlatform('macos', shot('mac')), true);
  assert.equal(fileFitsPlatform('ios', shot('mac')), false);
  assert.equal(fileFitsPlatform('macos', shot('iphone-6.9')), false);
  assert.equal(fileFitsPlatform('android', shot('mac')), true);
  // Not classified: iOS keeps it, as before; macOS does not guess.
  assert.equal(fileFitsPlatform('ios', shot(null)), true);
  assert.equal(fileFitsPlatform('macos', shot(null)), false);
  // Icons and text are not per display.
  assert.equal(fileFitsPlatform('macos', { kind: 'icon', device: null }), true);
});

dbTest('the reviews of an App Store Connect app belong to its iOS record, never to the macOS record', async (db) => {
  await migrate(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  const app = (id: string, platform: string, storeAppId: string | null, created: number) =>
    db.execute(
      `INSERT INTO apps (id, workspace_id, name, platform, identifier, store_app_id, credential_id, created_at)
       VALUES (?, 'w1', 'Trail', ?, ?, ?, 'c1', ?)`,
      [id, platform, `com.acme.${id}`, storeAppId, created],
    );
  await app('ios1', 'ios', '555', 1);
  await app('mac1', 'macos', '555', 2);
  await app('mac2', 'macos', '777', 3);
  await app('mac3', 'macos', null, 4);
  assert.equal(await reviewsOwnedByOtherRecord(db, 'w1', { platform: 'macos', storeAppId: '555' }), 'ios1');
  assert.equal(await reviewsOwnedByOtherRecord(db, 'w1', { platform: 'macos', storeAppId: '777' }), null, 'a macOS-only app keeps its own');
  assert.equal(await reviewsOwnedByOtherRecord(db, 'w1', { platform: 'macos', storeAppId: null }), null);
  assert.equal(await reviewsOwnedByOtherRecord(db, 'w1', { platform: 'ios', storeAppId: '555' }), null);
  assert.equal(await reviewsOwnedByOtherRecord(db, 'w2', { platform: 'macos', storeAppId: '555' }), null, 'never across workspaces');
});
