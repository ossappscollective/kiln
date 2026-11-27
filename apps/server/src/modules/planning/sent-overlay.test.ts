import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { listAppReleases } from '../../services/apps.ts';
import { bootCi } from '../ci/test-helpers.ts';
import { kilnEvents } from '../timeline/events.ts';
import { appPipeline, loadPipelineFacts } from './release-pipeline.ts';

// The Google Play "sent for review" overlay lives in ONE place (`sentOverlay` of services/apps.ts): the web's release list, the release
// pipeline read for screens and the timeline all apply it; the release watch (`release.stalled`) does NOT, on purpose: a stall must not
// run on a state Google never reported.

dbTest(
  'the sent-for-review overlay: list, pipeline and timeline agree; the release watch does not apply it',
  async (db) => {
    const t = await bootCi(db);
    const app = await t.seedApp('android', [
      { version: '2.1', build: '241', track: 'production', codes: ['241'], status: 'live' },
      { version: '2.0', build: '200', track: 'production', codes: ['200'], status: 'live' },
    ]);
    const now = Date.now();
    await db.execute(
      `INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, 'user', 'u1', 'store.released', 'app', ?, ?, ?)`,
      [
        crypto.randomUUID(),
        t.workspaceId,
        app,
        JSON.stringify({ track: 'production', versionCodes: ['241'] }),
        now - 1000,
      ],
    );

    const list = await listAppReleases(db, t.workspaceId, app);
    assert.equal(list.find((r) => r.version === '2.1')?.status, 'in_review');
    assert.equal(list.find((r) => r.version === '2.0')?.status, 'live');

    const screen = await appPipeline(db, { workspaceId: t.workspaceId, appId: app, now });
    assert.equal(
      screen?.pipeline.state,
      'in_review',
      'the pipeline of the screens says what the release list says',
    );
    assert.equal(screen?.pipeline.latest.version?.version, '2.1');

    const events = await kilnEvents(db, t.workspaceId, { id: app, platform: 'android' });
    const released = events.filter((e) => e.kind === 'release').map((e) => e.version);
    assert.deepEqual(
      released,
      ['2.0'],
      'the timeline does not say 2.1 came out while it waits for review',
    );

    const watched = await loadPipelineFacts(db, { workspaceId: t.workspaceId, appIds: [app], now });
    assert.deepEqual(
      watched.facts[0]?.versions.map((v) => `${v.version}:${v.status}`).sort(),
      ['2.0:live', '2.1:live'],
      'the release watch reads the stored states: no overlay',
    );
  },
);
