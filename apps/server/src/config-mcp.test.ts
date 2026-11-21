import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from './config.ts';

const key = randomBytes(32).toString('base64');
const load = (env: Record<string, string>) => loadConfig({ KILN_MASTER_KEY: key, ...env });

test('the MCP endpoint is off by default, and blank means off', () => {
  assert.equal(load({}).mcpEnabled, false);
  assert.equal(load({ KILN_MCP_ENABLED: '' }).mcpEnabled, false);
  assert.equal(load({ KILN_MCP_ENABLED: 'false' }).mcpEnabled, false);
});

test('KILN_MCP_ENABLED accepts only true and false', () => {
  assert.equal(load({ KILN_MCP_ENABLED: 'true' }).mcpEnabled, true);
  for (const bad of ['1', 'yes', 'TRUE', 'on'])
    assert.throws(() => load({ KILN_MCP_ENABLED: bad }), /KILN_MCP_ENABLED/, bad);
});
