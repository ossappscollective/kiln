import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compare,
  groupViolations,
  loadAllowlist,
  registryExists,
  SERVER_RULES,
  type ServerRuleId,
  scanFile,
  scanTree,
  serverFiles,
} from './server-guard.ts';

/**
 * The server guard (docs/state-model.md, "Consistency contract"): S1 no literal limits/thresholds, S2 no cache outside the registry.
 * `server-guard.allowlist.json` is what the tree does today; a new violation fails, and so does an entry that no longer matches.
 * S2 is checked only while `services/cache-registry.ts` exists. Burn-down: `node src/server-guard-cli.ts --files`; after a migration
 * `node src/server-guard-cli.ts --prune`.
 */
const active = (rule: ServerRuleId) => rule !== 'S2' || registryExists();
const { groups, files } = scanTree();
const list = loadAllowlist();
const diff = compare(groups, list, active);

test('the server guard sees the server', () => {
  assert.ok(files > 100, `only ${files} server files scanned`);
  assert.ok(serverFiles().every((f) => !f.endsWith('.test.ts')));
});

test('no NEW server violation of S1/S2 (not in server-guard.allowlist.json)', () => {
  const lines = diff.added.map(
    ({ group: g, allowed }) =>
      `  ${g.rule} ${g.file}:${g.line}  ${g.snippet}${allowed > 0 ? ` (allowlist grants ${allowed}, found ${g.count})` : ''}`,
  );
  assert.equal(
    lines.length,
    0,
    `new violations:\n${lines.join('\n')}\n\n${(Object.keys(SERVER_RULES) as ServerRuleId[])
      .map((r) => `  ${r}: ${SERVER_RULES[r].message}. Instead: ${SERVER_RULES[r].instead}`)
      .join('\n')}`,
  );
});

test('every server allowlist entry still matches (the list only shrinks)', () => {
  const lines = diff.stale.map(
    ({ entry: e, actual }) =>
      `  ${e.rule} ${e.file}  ${e.snippet} (allowed ${e.count}, found ${actual})`,
  );
  assert.equal(
    lines.length,
    0,
    `stale entries. Remove them: node src/server-guard-cli.ts --prune\n${lines.join('\n')}`,
  );
});

test('S1 sees literal limits and thresholds', () => {
  const got = groupViolations(
    scanFile(
      'modules/publish/x.ts',
      `const NOTES_MAX = 4000;
       const PUBLISH_SILENT_AFTER_MS = 60_000;
       const cfg = { maxChars: 500, retries: 3 };
       const ok = items.length > 10;
       const cheap = items.length > 3;
       const size = 8 * 1024 * 1024;
       const MAX_UPLOAD = 8 * 1024 * 1024;`,
    ),
  ).map((g) => g.snippet);
  assert.deepEqual(got.sort(), [
    'MAX_UPLOAD = 8 * 1024 * 1024',
    'NOTES_MAX = 4000',
    'PUBLISH_SILENT_AFTER_MS = 60_000',
    'items.length > 10',
    'maxChars = 500',
  ]);
});

test('S1 ignores the modules that judge no store fact (an AI prompt budget)', () => {
  assert.equal(scanFile('modules/ai/x.ts', 'const MAX_ITEMS = 100;').length, 0);
});

test('S2 sees an unaccounted module-level Map outside the registry, not inside it; timedCache IS the registered factory', () => {
  const src = 'const a = new Map<string, number>(); const b = timedCache(1, 2, {});';
  assert.equal(scanFile('modules/x.ts', src).filter((v) => v.rule === 'S2').length, 1);
  // registered through registerMapCache, or listed with a why in services/not-a-cache.ts: accounted for
  assert.equal(
    scanFile('modules/x.ts', 'const a = new Map(); registerMapCache(a, {});').filter(
      (v) => v.rule === 'S2',
    ).length,
    0,
  );
  assert.equal(
    scanFile('modules/ci/active.ts', 'const inFlight = new Map();').filter((v) => v.rule === 'S2')
      .length,
    0,
  );
  // a Map built inside a function to group rows is not a cache; one named like a cache is
  const local = 'function f() { const byId = new Map(); const viewCache = new Map(); }';
  assert.deepEqual(
    scanFile('modules/x.ts', local)
      .filter((v) => v.rule === 'S2')
      .map((v) => v.snippet),
    ['new Map()'],
  );
  assert.equal(
    scanFile('services/cache-registry.ts', src).filter((v) => v.rule === 'S2').length,
    0,
  );
});

test('the allowlist comparison fails a new violation and a stale entry, and skips an inactive rule', () => {
  const found = groupViolations(scanFile('modules/publish/x.ts', 'const MAX_ROWS = 500;'));
  const e = {
    file: 'modules/publish/x.ts',
    rule: 'S1' as const,
    hash: found[0]?.hash ?? '',
    snippet: 's',
    count: 1,
    reason: 'r',
  };
  assert.deepEqual(compare(found, { strict: false, entries: [e] }), { added: [], stale: [] });
  assert.equal(compare(found, { strict: false, entries: [] }).added.length, 1);
  assert.equal(compare([], { strict: false, entries: [e] }).stale.length, 1);
  assert.equal(compare(found, { strict: true, entries: [e] }).added.length, 1);
  assert.deepEqual(
    compare(found, { strict: false, entries: [] }, () => false),
    { added: [], stale: [] },
  );
});

test('STRICT: the server allowlist is empty and strict (the burn-down is complete: nothing is grandfathered)', () => {
  assert.equal(list.strict, true, 'server-guard.allowlist.json must be "strict": true');
  assert.deepEqual(list.entries, []);
});
