import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { dbTest } from '@mrm/db/testing';
import { endpointFor, runBridge } from './mcp/stdio.ts';
import { bootRepoApp } from './repo-test-helpers.ts';

async function* lines(...parts: string[]) {
  for (const part of parts) yield part;
}

test('the bridge address: https, or http for this machine only, with /mcp added once', () => {
  assert.equal(endpointFor('https://mrm.example.com').href, 'https://mrm.example.com/mcp');
  assert.equal(endpointFor('https://mrm.example.com/').href, 'https://mrm.example.com/mcp');
  assert.equal(endpointFor('https://mrm.example.com/mcp').href, 'https://mrm.example.com/mcp');
  assert.equal(endpointFor('https://host.example/base').href, 'https://host.example/base/mcp');
  assert.equal(endpointFor('http://localhost:8787').href, 'http://localhost:8787/mcp');
  assert.equal(endpointFor('http://127.0.0.1:8787/mcp?x=1#y').href, 'http://127.0.0.1:8787/mcp');
  assert.throws(() => endpointFor('http://mrm.example.com'), /https/);
  assert.throws(() => endpointFor('ftp://localhost'), /https/);
  assert.throws(() => endpointFor('https://user:pw@mrm.example.com'), /user name/);
  assert.throws(() => endpointFor('not a url'), /valid address/);
});

test('the bridge forwards each line with the token, writes the answers, skips notifications and reports failures without the token', async () => {
  const sent: { body: string; auth: string | null; version: string | null }[] = [];
  const out: string[] = [];
  const logs: string[] = [];
  const answers = [
    () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }), { status: 200 }),
    () => new Response(null, { status: 202 }),
    () => new Response('{"error":"invalid_token"}', { status: 401 }),
    () => new Response('<html>', { status: 200 }),
  ];
  let i = 0;
  const fakeFetch = (async (_url: URL, init: RequestInit) => {
    const headers = new Headers(init.headers);
    sent.push({ body: String(init.body), auth: headers.get('authorization'), version: headers.get('mcp-protocol-version') });
    return answers[i++]?.() ?? new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  await runBridge({
    url: 'https://mrm.example.com',
    token: 'mrm_secrettokenvalue000000000000',
    input: lines('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n', '{"jsonrpc":"2.0","id":3,"method":"ping"}\nnot json\n'),
    write: (line) => out.push(line),
    log: (line) => logs.push(line),
    fetch: fakeFetch,
  });
  assert.equal(sent.length, 4);
  assert.ok(sent.every((s) => s.auth === 'Bearer mrm_secrettokenvalue000000000000'));
  assert.equal(sent[0]?.version, null, 'no version header on initialize');
  assert.equal(sent[2]?.version, '2025-03-26', 'the negotiated version is sent afterwards');
  const parsed = out.map((l) => JSON.parse(l));
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].result.protocolVersion, '2025-03-26');
  assert.equal(parsed[1].id, 2);
  assert.match(parsed[1].error.message, /token was refused/);
  assert.equal(parsed[2].id, 3);
  assert.match(parsed[2].error.message, /not JSON/);
  assert.equal(parsed[3].error.code, -32700, 'a line that is not JSON');
  assert.ok(![...out, ...logs].join('\n').includes('secrettokenvalue'), 'the token is never written');
});

test('the bridge reports an unreachable server as an error for the request, not a crash', async () => {
  const out: string[] = [];
  await runBridge({
    url: 'http://localhost:9',
    token: 'mrm_x',
    input: lines('{"jsonrpc":"2.0","id":7,"method":"ping"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n'),
    write: (l) => out.push(l),
    fetch: (async () => { throw new Error('ECONNREFUSED 127.0.0.1:9 secret'); }) as unknown as typeof fetch,
  });
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0] as string).id, 7);
  assert.ok(!out[0]?.includes('ECONNREFUSED'));
});

dbTest('end to end: the bridge in front of the real app lists the tools and calls one', async (db) => {
  const t = await bootRepoApp(db, undefined, { mcp: { enabled: true } });
  const minted = await t.call(t.owner, 'POST', '/tokens', { name: 'Bridge', role: 'viewer' });
  const out: string[] = [];
  await runBridge({
    url: 'http://localhost:8787',
    token: minted.body.token,
    input: lines('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_apps","arguments":{}}}\n'),
    write: (l) => out.push(l),
    fetch: ((url: URL, init: RequestInit) => t.app.request(url.pathname, init)) as unknown as typeof fetch,
  });
  const parsed = out.map((l) => JSON.parse(l));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].result.serverInfo.name, 'mobile-release-manager');
  assert.ok(parsed[1].result.tools.some((x: { name: string }) => x.name === 'list_apps'));
  assert.deepEqual(JSON.parse(parsed[2].result.content[0].text).data, { apps: [] });
});

test('the script runs as a command: environment in, newline delimited JSON out, nothing else on stdout', async () => {
  const seen: { auth: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body });
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) { res.statusCode = 202; res.end(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echo: message.method } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const script = fileURLToPath(new URL('./mcp/stdio.ts', import.meta.url));
  const run = (env: Record<string, string>, input: string) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? '', ...env } });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.on('close', (code) => resolve({ code, out, err }));
      child.stdin.end(input);
    });
  try {
    const ok = await run({ MRM_URL: `http://127.0.0.1:${port}`, MRM_TOKEN: 'mrm_smoketoken' }, '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    assert.equal(ok.code, 0);
    assert.deepEqual(ok.out.trim().split('\n').map((l) => JSON.parse(l)), [{ jsonrpc: '2.0', id: 1, result: { echo: 'ping' } }]);
    assert.deepEqual(seen.map((s) => s.auth), ['Bearer mrm_smoketoken', 'Bearer mrm_smoketoken']);
    const missing = await run({}, '');
    assert.equal(missing.code, 2);
    assert.equal(missing.out, '');
    const plain = await run({ MRM_URL: 'http://mrm.example.com', MRM_TOKEN: 'mrm_smoketoken' }, '');
    assert.equal(plain.code, 1);
    assert.match(plain.err, /https/);
    assert.ok(!plain.err.includes('smoketoken'));
  } finally {
    server.close();
  }
});
