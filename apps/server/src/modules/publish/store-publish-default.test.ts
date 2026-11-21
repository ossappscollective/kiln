import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { bootRepoApp } from '../../repo-test-helpers.ts';

/** An app created without the option has the batch publish OFF (docs/api/pending.md): the default, and the steps' switches do not turn it on. */

dbTest(
  'the batch publish is off by default: the config says so and the routes answer 409 publish_batch_disabled',
  async (db) => {
    const t = await bootRepoApp(db);
    const config = await t.call(t.owner, 'GET', '/store-publish/config');
    assert.equal(config.status, 200);
    assert.deepEqual(
      [config.body.enabled, config.body.envName, config.body.action, config.body.minimumRole],
      [false, 'MRM_STORE_PUBLISH_BATCH_ENABLED', 'store.publish', 'admin'],
    );
    for (const step of Object.values(config.body.steps) as { enabled: boolean }[])
      assert.equal(step.enabled, false);
    assert.equal((await t.call(t.owner, 'POST', '/apps/x/publish/preview', {})).status, 409);
    const apply = await t.call(t.owner, 'POST', '/apps/x/publish', {
      planHash: 'a'.repeat(64),
      steps: [{ type: 'push_draft' }],
    });
    assert.equal(apply.status, 409);
    assert.equal(apply.body.error, 'publish_batch_disabled');
  },
);
