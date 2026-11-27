import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import {
  type CacheEvent,
  cacheEvents,
  clearAllCaches,
  emitCacheEvent,
  keyInScope,
  registeredCaches,
  registerCache,
  registerMapCache,
} from './cache-registry.ts';
import { NOT_A_CACHE } from './not-a-cache.ts';
import { timedCache } from './timed-cache.ts';

const SRC = join(import.meta.dirname, '..');
const DOCS = join(SRC, '..', '..', '..', 'docs', 'state-model.md');

// ---------------------------------------------------------------------------------------------
// The registry itself

test('a cache that nothing invalidates must say why', () => {
  assert.throws(
    () =>
      registerCache({
        name: 't.no_reason',
        owner: 'test',
        ttlMs: 1,
        invalidatedBy: [],
        drop: () => undefined,
      }),
    /no reason/,
  );
  assert.throws(
    () =>
      registerCache({
        name: 't.bad_event',
        owner: 'test',
        ttlMs: 1,
        invalidatedBy: ['nope' as CacheEvent],
        drop: () => undefined,
      }),
    /unknown event/,
  );
});

test('an event drops the caches that declared it, for the scope it names, and nothing else', () => {
  const a = new Map([
    ['w1|a1', 1],
    ['w1|a2', 2],
    ['w2|a1', 3],
    ['w1|a1|x', 4],
    ['w1|a10', 5],
  ]);
  const b = new Map([['w1|a1', 1]]);
  registerMapCache(a, {
    name: 't.scope_a',
    owner: 'test',
    ttlMs: 1,
    invalidatedBy: ['sync'],
    keys: 'workspace_app',
  });
  registerMapCache(b, {
    name: 't.scope_b',
    owner: 'test',
    ttlMs: 1,
    invalidatedBy: ['publish'],
  });
  const told = emitCacheEvent('sync', { workspaceId: 'w1', appId: 'a1' });
  assert.ok(told.includes('t.scope_a') && !told.includes('t.scope_b'));
  assert.deepEqual([...a.keys()].sort(), ['w1|a10', 'w1|a2', 'w2|a1'], 'only the app, not a10 or other workspaces');
  assert.equal(b.size, 1, 'a cache that did not declare sync keeps its entry');
  emitCacheEvent('sync', { workspaceId: 'w1' });
  assert.deepEqual([...a.keys()], ['w2|a1'], 'no app: the workspace');
  emitCacheEvent('sync');
  assert.equal(a.size, 0, 'no scope: everything');
  emitCacheEvent('publish', { workspaceId: 'w1', appId: 'a1' });
  assert.equal(b.size, 0);
});

test('keyInScope: shapes and separators', () => {
  assert.equal(keyInScope('w|a|x', { workspaceId: 'w', appId: 'a' }), true);
  assert.equal(keyInScope('w|ab', { workspaceId: 'w', appId: 'a' }), false);
  assert.equal(keyInScope('w|repo', { workspaceId: 'w', appId: 'a' }, 'workspace'), true);
  assert.equal(keyInScope('v|repo', { workspaceId: 'w', appId: 'a' }, 'workspace'), false);
  assert.equal(keyInScope('anything', { workspaceId: 'w' }, 'all'), true);
  assert.equal(keyInScope('w\0a\0fr', { workspaceId: 'w', appId: 'a' }, 'workspace_app', '\0'), true);
});

test('a timedCache is on the list from its birth and each event empties it as declared', () => {
  const cache = timedCache<number>(1000, 10, {
    name: 't.timed',
    owner: 'test',
    invalidatedBy: ['build_changed'],
    keys: 'workspace_app',
  });
  cache.set('w|a', 1, 0);
  cache.set('w|b', 2, 0);
  assert.equal(cache.get('w|a', 1), 1);
  assert.ok(registeredCaches().some((c) => c.name === 't.timed' && c.ttlMs === 1000));
  emitCacheEvent('store_read', { workspaceId: 'w', appId: 'a' });
  assert.equal(cache.get('w|a', 1), 1, 'store_read is not one of its events');
  emitCacheEvent('build_changed', { workspaceId: 'w', appId: 'a' });
  assert.equal(cache.get('w|a', 1), undefined);
  assert.equal(cache.get('w|b', 1), 2, 'another app keeps its entry');
  clearAllCaches();
  assert.equal(cache.get('w|b', 1), undefined);
});

async function loadRegisteringModules(): Promise<void> {
  // A cache is registered when its module loads.
  await Promise.all(
    [
      '../modules/publish/current-readiness.ts',
      '../modules/listing/store-images.ts',
      '../modules/listing/asset-proposal-summary.ts',
      '../modules/listing/asset-repo.ts',
      '../modules/builds/service.ts',
      '../services/notes-history.ts',
      '../modules/ci/active.ts',
      '../modules/ci/scan.ts',
      '../modules/ci/service.ts',
      '../services/repo-snapshot.ts',
      '../modules/aso/competitor-images.ts',
    ].map((p) => import(new URL(p, import.meta.url).href)),
  );
}

test('every event of the list has at least one cache that declared it', async () => {
  await loadRegisteringModules();
  for (const event of cacheEvents)
    assert.ok(
      registeredCaches().some((c) => c.invalidatedBy.includes(event)),
      `no cache declares ${event}`,
    );
});

// ---------------------------------------------------------------------------------------------
// Completeness: no cache outside the registry

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'demo' || name === 'node_modules') continue;
      sources(path, out);
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !/test-helpers\.ts$|-test-helpers\.ts$/.test(name)
    )
      out.push(path);
  }
  return out;
}

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const rel = (path: string) => relative(SRC, path).split(sep).join('/');

/** The top-level arguments of the call that opens at `open` (the index of its "("). */
function argsOf(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) {
        args.push(text.slice(start, i));
        return args.map((a) => a.trim()).filter((a) => a !== '');
      }
    } else if (ch === ',' && depth === 1) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return args;
}

test('every timedCache( call in the source carries its declaration (name, owner, events)', () => {
  const offenders: string[] = [];
  let calls = 0;
  for (const file of sources(SRC)) {
    if (['services/timed-cache.ts', 'server-guard.ts'].includes(rel(file))) continue;
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/\btimedCache\s*(<[^(]*>)?\s*\(/g)) {
      calls += 1;
      const args = argsOf(text, (m.index ?? 0) + m[0].length - 1);
      if (args.length < 3) offenders.push(`${rel(file)}: timedCache( with ${args.length} arguments`);
    }
  }
  assert.ok(calls >= 10, `the scan found ${calls} timedCache( calls: the pattern is broken`);
  assert.deepEqual(offenders, [], 'a cache is born with timedCache(ttl, max, { name, owner, invalidatedBy, ... })');
});

test('every NOT_A_CACHE entry says why it is not a cache', () => {
  const bare = Object.entries(NOT_A_CACHE).filter(([, why]) => why.trim().length < 8).map(([id]) => id);
  assert.deepEqual(bare, [], 'NOT_A_CACHE needs a `why` for every Map');
});

test('no module-level Map exists outside the registry unless it is listed as not a cache', () => {
  const found = new Set<string>();
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    if (['services/cache-registry.ts', 'server-guard.ts'].includes(rel(file))) continue;
    const text = stripComments(readFileSync(file, 'utf8'));
    // Also a Map inside a function that the server guard names (`const inflight = new Map()`): listed with a why, never required to register.
    for (const m of text.matchAll(/^[ \t]+const (\w+)\s*=\s*new Map\b/gm)) found.add(`${rel(file)}:${m[1]}`);
    for (const m of text.matchAll(/^(?:export )?const (\w+)\s*=\s*new Map\b/gm)) {
      const id = `${rel(file)}:${m[1]}`;
      found.add(id);
      // Registered through registerMapCache(map, ...), or by a registerCache({ ..., drop() { map.clear() } }) that empties it.
      const blocks = text.split('registerCache({').slice(1).map((b) => b.slice(0, b.indexOf('\n});')));
      const registered =
        new RegExp(`registerMapCache\\(\\s*${m[1]}\\b`).test(text) ||
        blocks.some((b) => new RegExp(`\\b${m[1]}\\.(clear|delete)\\(`).test(b));
      if (!registered && !(id in NOT_A_CACHE))
        offenders.push(`${id}: a module-level Map that is neither registered (registerMapCache) nor listed in NOT_A_CACHE`);
    }
  }
  assert.deepEqual(offenders, []);
  const stale = Object.keys(NOT_A_CACHE).filter((id) => !found.has(id));
  assert.deepEqual(stale, [], 'NOT_A_CACHE lists a Map that does not exist any more');
});

// ---------------------------------------------------------------------------------------------
// The caches that exist, their events (the table of docs/state-model.md)

/** name -> events. Changing a cache's events means changing this table and the docs. */
const EXPECTED: Record<string, readonly CacheEvent[]> = {
  'publish.current_readiness': ['store_read', 'sync', 'publish', 'release_changed', 'build_changed', 'staged_changed'],
  'listing.store_images_view': ['store_read', 'sync', 'publish', 'release_changed'],
  'listing.image_refs': ['store_read', 'sync', 'publish', 'release_changed'],
  'listing.image_thumbs': [],
  'listing.image_probes': [],
  'listing.proposal_summary': ['sync', 'staged_changed', 'release_changed', 'build_changed', 'publish'],
  'listing.asset_repo_opened': [],
  'listing.asset_index': [],
  'builds.repo_artifacts': ['sync', 'build_changed'],
  'builds.repo_artifacts_etag': [],
  'builds.artifact_trouble': ['sync', 'build_changed'],
  'builds.testflight_groups': ['sync', 'build_changed'],
  'builds.testflight_trouble': ['sync', 'build_changed'],
  'notes.history': ['store_read', 'sync', 'publish', 'release_changed'],
  'ci.active_runs': ['build_changed'],
  'ci.tag_data': [],
  'ci.commit_facts': [],
  'ci.workflows': [],
  'ci.workflow_inputs': [],
  'ci.compare': [],
  'ci.tags_preview': [],
  'ci.run_actor': [],
  'ci.run_jobs': [],
  'repo.snapshot': [],
  'aso.competitor_search_refs': [],
  'aso.competitor_thumbs': [],
};

test('the registered caches are exactly the documented ones, with their events', async () => {
  await loadRegisteringModules();
  const have = Object.fromEntries(
    registeredCaches()
      .filter((c) => !c.name.startsWith('t.'))
      .map((c) => [c.name, c.invalidatedBy]),
  );
  for (const [name, events] of Object.entries(EXPECTED)) {
    assert.ok(name in have, `${name} is not registered`);
    assert.deepEqual([...(have[name] as readonly CacheEvent[])].sort(), [...events].sort(), `${name}: events`);
  }
  // The four public-search caches of aso/net.ts are made by a factory (`createAsoSources`), so they exist only once one was made.
  const FACTORY_MADE = ['aso.searches', 'aso.lookups', 'aso.app_searches', 'aso.hint_lists'];
  const unlisted = Object.keys(have).filter((n) => !(n in EXPECTED) && !FACTORY_MADE.includes(n));
  assert.deepEqual(unlisted, [], 'a registered cache is not in EXPECTED (and so not in the docs)');
  for (const c of registeredCaches().filter((c) => c.invalidatedBy.length === 0))
    assert.ok((c.why ?? '').length > 20, `${c.name}: no event and no real reason`);
});

test('docs/state-model.md names every registered cache and every event', () => {
  const docs = readFileSync(DOCS, 'utf8');
  for (const name of Object.keys(EXPECTED)) assert.ok(docs.includes(`\`${name}\``), `${name} is not in docs/state-model.md`);
  for (const event of cacheEvents) assert.ok(docs.includes(`\`${event}\``), `${event} is not in docs/state-model.md`);
});
