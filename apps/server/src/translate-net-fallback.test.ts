import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createGuardedFetch } from './services/translate-net.ts';

// `localhost` often answers ::1 first while a published Docker port listens on IPv4 only.
test('a refused first address falls back to the next checked address', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"translatedText":"hallo"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const guard = createGuardedFetch({
      allowPrivate: true,
      resolve: async () => [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    const res = await guard.fetch(`http://localhost:${port}/translate`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { translatedText: string }).translatedText, 'hallo');
  } finally {
    server.close();
  }
});

test('a blocked address in any answer still refuses the whole host', async () => {
  const guard = createGuardedFetch({
    allowPrivate: true,
    resolve: async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ],
  });
  await assert.rejects(guard.fetch('http://localhost:5801/translate', { method: 'POST', body: '{}' }));
  assert.ok(guard.blocked());
});
