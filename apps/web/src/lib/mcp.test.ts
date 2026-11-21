import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  groupTools,
  type McpStatus,
  mcpUrl,
  presetTokenInput,
  snippets,
  stateView,
  toolNeeds,
} from './mcp.ts';

const status: McpStatus = {
  enabled: true,
  endpoint: '/mcp',
  protocolVersion: '2025-06-18',
  envName: 'KILN_MCP_ENABLED',
  switches: [{ env: 'KILN_STORE_RELEASE_ENABLED', enabled: false }],
  tools: [
    {
      name: 'list_apps',
      title: 'List apps',
      description: 'd',
      kind: 'read',
      action: 'apps.read',
      switch: null,
      switchOn: true,
    },
    {
      name: 'preview_store_release',
      title: 'Preview releasing',
      description: 'd',
      kind: 'preview',
      action: 'store.release',
      switch: 'KILN_STORE_RELEASE_ENABLED',
      switchOn: false,
    },
    {
      name: 'triage_review',
      title: 'Triage',
      description: 'd',
      kind: 'write',
      action: 'reviews.triage',
      switch: null,
      switchOn: true,
    },
  ],
  preset: {
    name: 'MCP read-only',
    role: 'viewer',
    actions: ['apps.read', 'reviews.read'],
    expiresInDays: 90,
  },
};

test('the state says where to switch it on when it is off', () => {
  assert.equal(stateView(status).label, 'On');
  const off = stateView({ ...status, enabled: false });
  assert.equal(off.tone, 'warn');
  assert.match(off.detail, /KILN_MCP_ENABLED=true/);
  assert.match(off.detail, /404/);
});

test('the preset token is a viewer with the listed actions and an expiry', () => {
  const input = presetTokenInput(status, 1_000);
  assert.deepEqual(input, {
    name: 'MCP read-only',
    role: 'viewer',
    actions: ['apps.read', 'reviews.read'],
    expiresAt: 1_000 + 90 * 24 * 60 * 60 * 1000,
  });
  input.actions.push('x');
  assert.equal(status.preset.actions.length, 2, 'the status is not changed');
});

test('tools are grouped read, write, preview, and say what they need', () => {
  const groups = groupTools(status.tools);
  assert.deepEqual(
    groups.map((g) => g.kind),
    ['read', 'write', 'preview'],
  );
  assert.equal(groupTools([status.tools[0] as McpStatus['tools'][number]]).length, 1);
  assert.equal(toolNeeds(status.tools[0] as McpStatus['tools'][number]), 'needs apps.read');
  assert.equal(
    toolNeeds(status.tools[1] as McpStatus['tools'][number]),
    'token names store.release, KILN_STORE_RELEASE_ENABLED=true (off now)',
  );
});

test('snippets: a placeholder without a token, the token when there is one, valid JSON, quoted shell', () => {
  const placeholder = snippets('https://mrm.example.com/', null);
  assert.ok(placeholder.every((s) => s.text.includes('<your API token>')));
  const real = snippets('https://mrm.example.com', "mrm_abc'def");
  assert.deepEqual(
    real.map((s) => s.title),
    [
      'Claude Code (HTTP)',
      'Claude Code (stdio)',
      'Claude Desktop (stdio)',
      'Cursor (HTTP)',
      'Cursor (stdio)',
    ],
  );
  for (const s of real) {
    assert.ok(s.text.includes('mrm_abc'));
    if (s.language === 'json') JSON.parse(s.text);
  }
  const cursor = JSON.parse(
    (real.find((s) => s.title === 'Cursor (HTTP)') as { text: string }).text,
  );
  assert.equal(cursor.mcpServers['kiln'].url, 'https://mrm.example.com/mcp');
  assert.equal(
    cursor.mcpServers['kiln'].headers.Authorization,
    "Bearer mrm_abc'def",
  );
  const desktop = JSON.parse(
    (real.find((s) => s.client === 'claude-desktop') as { text: string }).text,
  );
  assert.equal(desktop.mcpServers['kiln'].env.KILN_URL, 'https://mrm.example.com');
  assert.ok(
    (real[0] as { text: string }).text.includes(`'Authorization: Bearer mrm_abc'\\''def'`),
    'a quote in the token cannot break out of the shell string',
  );
  assert.equal(mcpUrl('https://x.example///'), 'https://x.example/mcp');
});
