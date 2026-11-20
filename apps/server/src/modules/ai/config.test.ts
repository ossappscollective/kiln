import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from '../../config.ts';

const key = randomBytes(32).toString('base64');
const load = (env: Record<string, string>) => loadConfig({ MRM_MASTER_KEY: key, ...env });

test('AI is off by default and private model addresses are refused by default', () => {
  const c = load({});
  assert.equal(c.aiEnabled, false);
  assert.equal(c.aiAllowPrivateUrls, false);
  assert.equal(load({ MRM_AI_ENABLED: '' }).aiEnabled, false, 'blank means off');
  assert.equal(load({ MRM_AI_ALLOW_PRIVATE_URLS: '' }).aiAllowPrivateUrls, false);
});

test('MRM_AI_ENABLED and MRM_AI_ALLOW_PRIVATE_URLS accept only true and false', () => {
  assert.equal(load({ MRM_AI_ENABLED: 'true' }).aiEnabled, true);
  assert.equal(load({ MRM_AI_ENABLED: 'false' }).aiEnabled, false);
  assert.equal(load({ MRM_AI_ALLOW_PRIVATE_URLS: 'true' }).aiAllowPrivateUrls, true);
  for (const name of ['MRM_AI_ENABLED', 'MRM_AI_ALLOW_PRIVATE_URLS']) {
    for (const bad of ['1', 'yes', 'TRUE', 'on']) {
      assert.throws(() => load({ [name]: bad }), new RegExp(name), `${name}=${bad}`);
    }
  }
  assert.equal(
    load({ MRM_AI_ALLOW_PRIVATE_URLS: 'true' }).aiEnabled,
    false,
    'the two are independent',
  );
});
