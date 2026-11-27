import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, test } from 'node:test';
import type { StoreImagesView } from '@kiln/core';
import { storeMediaCache } from '../assets/store-cache.ts';
import { readCache } from '../read-cache.ts';
import {
  bindInvalidation,
  FAMILIES_FOR,
  INVALIDATION_EVENTS,
  type Invalidation,
  type InvalidationEvent,
  invalidate,
  KEY_FAMILIES,
  type KeyFamily,
  onInvalidated,
  readFact,
  readKeys,
} from './invalidate.ts';

const loads: Record<string, number> = {};

afterEach(() => {
  for (const k of Object.keys(loads)) delete loads[k];
  readCache.forget('w');
  readCache.forget('other');
  storeMediaCache.clear();
});

/** The key of each family for an app, and a counter of how often it was loaded. */
const keyOf = (family: KeyFamily, app: string): string =>
  family === 'pipeline'
    ? readKeys.pipeline(app)
    : family === 'storeBuilds'
      ? readKeys.storeBuilds(app)
      : family === 'editable'
        ? readKeys.editable(app, 'production')
        : family === 'candidates'
          ? readKeys.candidates(app, 'production')
          : family === 'live'
            ? readKeys.live(app)
            : family === 'assetDiff'
              ? readKeys.assetDiff(app)
              : family === 'appBuilds'
                ? readKeys.appBuilds(app)
                : family === 'plans'
                  ? readKeys.plans(app, '')
                  : family === 'notesHistory'
                    ? readKeys.notesHistory(app, 'x')
                    : readKeys.testflight(app, '');

const touch = (workspaceId: string, family: KeyFamily, app: string) => {
  const key = `${workspaceId}/${keyOf(family, app)}`;
  return readFact(family, {
    workspaceId,
    key: keyOf(family, app),
    load: async () => {
      loads[key] = (loads[key] ?? 0) + 1;
      return key;
    },
  });
};
const loadedTimes = (workspaceId: string, family: KeyFamily, app: string) =>
  loads[`${workspaceId}/${keyOf(family, app)}`] ?? 0;

/** What each event must make old: written out here so a change to FAMILIES_FOR is a change to this table and to docs/state-model.md. */
const EXPECTED: Record<InvalidationEvent, readonly KeyFamily[]> = {
  sync: ['pipeline', 'storeBuilds', 'editable', 'candidates', 'live', 'assetDiff', 'appBuilds', 'plans', 'notesHistory', 'testflight'],
  publish: ['pipeline', 'storeBuilds', 'editable', 'candidates', 'live', 'assetDiff', 'appBuilds', 'plans', 'notesHistory', 'testflight'],
  release_created: ['pipeline', 'storeBuilds', 'editable', 'candidates', 'live', 'assetDiff', 'appBuilds', 'plans', 'notesHistory', 'testflight'],
  store_read: ['editable', 'candidates', 'live', 'assetDiff', 'notesHistory'],
  build_changed: ['pipeline', 'storeBuilds', 'candidates', 'appBuilds', 'testflight'],
  staged_changed: ['assetDiff'],
};

test('FAMILIES_FOR is what the docs say, for every event', () => {
  for (const event of INVALIDATION_EVENTS)
    assert.deepEqual([...FAMILIES_FOR[event]].sort(), [...EXPECTED[event]].sort(), event);
  assert.deepEqual(Object.keys(FAMILIES_FOR).sort(), [...INVALIDATION_EVENTS].sort());
});

for (const event of INVALIDATION_EVENTS) {
  test(`${event} forgets its key families for the app, and nothing of another app or workspace`, async () => {
    for (const family of KEY_FAMILIES) {
      await touch('w', family, 'a1');
      await touch('w', family, 'a2');
      await touch('other', family, 'a1');
    }
    const before = Object.fromEntries(KEY_FAMILIES.map((f) => [f, loadedTimes('w', f, 'a1')]));
    await invalidate(event, { workspaceId: 'w', appId: 'a1' });
    for (const family of KEY_FAMILIES) {
      await touch('w', family, 'a1');
      const again = loadedTimes('w', family, 'a1') - (before[family] as number);
      assert.equal(again, EXPECTED[event].includes(family) ? 1 : 0, `${event}: ${family} of the app`);
      const a2 = loadedTimes('w', family, 'a2');
      await touch('w', family, 'a2');
      assert.equal(loadedTimes('w', family, 'a2'), a2, `${event}: ${family} of another app is kept`);
      const o = loadedTimes('other', family, 'a1');
      await touch('other', family, 'a1');
      assert.equal(loadedTimes('other', family, 'a1'), o, `${event}: ${family} of another workspace is kept`);
    }
  });
}

test('an event that names no app forgets the families for the whole workspace', async () => {
  for (const app of ['a1', 'a2']) await touch('w', 'pipeline', app);
  await invalidate('sync', { workspaceId: 'w' });
  const n = loadedTimes('w', 'pipeline', 'a1');
  await touch('w', 'pipeline', 'a1');
  await touch('w', 'pipeline', 'a2');
  assert.equal(loadedTimes('w', 'pipeline', 'a1'), n + 1);
  assert.equal(loadedTimes('w', 'pipeline', 'a2'), 2);
});

test('the Graphics tab keeps its read through a staged change and a build, and drops it with everything that may change the store', async () => {
  const view = { readAt: 1 } as unknown as StoreImagesView;
  for (const event of INVALIDATION_EVENTS) {
    storeMediaCache.set('w|a1|ios', view);
    storeMediaCache.set('w|a2|ios', view);
    await invalidate(event, { workspaceId: 'w', appId: 'a1' });
    const drops = event !== 'staged_changed' && event !== 'build_changed';
    assert.equal(storeMediaCache.get('w|a1|ios') === undefined, drops, event);
    assert.ok(storeMediaCache.get('w|a2|ios'), `${event}: another app keeps its read`);
  }
  storeMediaCache.set('w|a1|ios', view);
  storeMediaCache.set('w|a2|ios', view);
  await invalidate('sync', { workspaceId: 'w' });
  assert.equal(storeMediaCache.size(), 0, 'no app: the workspace');
});

test('keepGraphics: the caller that has just stored the fresh read keeps it, the rest is forgotten', async () => {
  const view = { readAt: 1 } as unknown as StoreImagesView;
  storeMediaCache.set('w|a1|ios', view);
  await touch('w', 'assetDiff', 'a1');
  await invalidate('store_read', { workspaceId: 'w', appId: 'a1', keepGraphics: true, origin: 'graphics' });
  assert.ok(storeMediaCache.get('w|a1|ios'));
  const n = loadedTimes('w', 'assetDiff', 'a1');
  await touch('w', 'assetDiff', 'a1');
  assert.equal(loadedTimes('w', 'assetDiff', 'a1'), n + 1);
});

test('screens that listen hear every event; a handler that throws does not stop the others', async () => {
  const heard: Invalidation[] = [];
  const off1 = onInvalidated(() => {
    throw new Error('broken screen');
  });
  const off2 = onInvalidated((i) => heard.push(i));
  await invalidate('publish', { workspaceId: 'w', appIds: ['a1', 'a2'] });
  await invalidate('staged_changed', { workspaceId: 'w', appId: 'a1', reason: 'discard' });
  off1();
  off2();
  await invalidate('sync', { workspaceId: 'w' });
  assert.deepEqual(
    heard.map((h) => [h.event, [...h.appIds], h.reason]),
    [
      ['publish', ['a1', 'a2'], undefined],
      ['staged_changed', ['a1'], 'discard'],
    ],
  );
});

test('the model reads again for the workspace it is bound to, and is let go on unbind', async () => {
  const seen: Invalidation[] = [];
  const bus = new EventTarget();
  const off = bindInvalidation('w', (i) => void seen.push(i), bus, (fn) => {
    fn();
    return () => {};
  });
  await invalidate('sync', { workspaceId: 'w', appId: 'a1' });
  await invalidate('sync', { workspaceId: 'other', appId: 'a1' });
  assert.deepEqual(
    seen.map((s) => s.workspaceId),
    ['w'],
  );
  off();
  await invalidate('sync', { workspaceId: 'w', appId: 'a1' });
  assert.equal(seen.length, 1);
});

test('the one subscription to the browser event turns announcements into one invalidation per event', async () => {
  const seen: Invalidation[] = [];
  const bus = new EventTarget();
  const queue: (() => void)[] = [];
  const off = bindInvalidation('w', (i) => void seen.push(i), bus, (fn) => {
    queue.push(fn);
    return () => {};
  });
  const announce = (appId: string, reason: string) =>
    bus.dispatchEvent(new CustomEvent('kiln:staged-changed', { detail: { appId, reason } }));
  announce('a1', 'stage');
  announce('a2', 'stage');
  announce('a1', 'discard');
  announce('a1', 'publish');
  announce('a3', 'store_read');
  for (const run of queue.splice(0)) run();
  await new Promise((r) => setTimeout(r, 0));
  const by = Object.fromEntries(seen.map((s) => [s.event, s]));
  assert.deepEqual([...(by.staged_changed?.appIds ?? [])].sort(), ['a1', 'a2']);
  assert.equal(by.staged_changed?.reason, 'discard', 'the strongest reason of the burst');
  assert.deepEqual(by.publish?.appIds, ['a1']);
  assert.deepEqual(by.store_read?.appIds, ['a3']);
  assert.equal(seen.length, 3);
  off();
});

// ---------------------------------------------------------------------------------------------
// Guards over the source

const SRC = join(import.meta.dirname, '..', '..');
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') sources(path, out);
    } else if ((name.endsWith('.ts') || name.endsWith('.svelte')) && !name.endsWith('.test.ts'))
      out.push(path);
  }
  return out;
}
const rel = (p: string) => relative(SRC, p).split(sep).join('/');
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('no raw readCache.forget( outside facts/invalidate.ts: a screen says what happened, `invalidate` forgets', () => {
  const offenders = sources(SRC)
    .filter((f) => !['lib/facts/invalidate.ts', 'lib/read-cache.ts'].includes(rel(f)))
    .filter((f) => /\breadCache\s*\.\s*forget\s*\(/.test(strip(readFileSync(f, 'utf8'))))
    .map(rel);
  assert.deepEqual(offenders, []);
});

test('the browser event kiln:staged-changed has ONE subscriber (facts/invalidate.ts); screens use onInvalidated', () => {
  const offenders = sources(SRC)
    .filter((f) => !['lib/facts/invalidate.ts', 'lib/staged-sync.ts'].includes(rel(f)))
    .filter((f) => /\bonStagedChanged\s*\(|kiln:staged-changed/.test(strip(readFileSync(f, 'utf8'))))
    .map(rel);
  assert.deepEqual(offenders, []);
});

test('no raw readCache.read( outside facts/invalidate.ts: a read of a fact goes through `readFact` (a typed family)', () => {
  const offenders = sources(SRC)
    .filter((f) => !['lib/read-cache.ts', 'lib/facts/invalidate.ts'].includes(rel(f)))
    .filter((f) => /\breadCache\s*\.\s*read\s*(?:<[^(]*>)?\s*\(/.test(strip(readFileSync(f, 'utf8'))))
    .map(rel);
  assert.deepEqual(offenders, [], 'use `readFact(family, { workspaceId, key: readKeys.<family>(...), load })`');
});

test('every readFact( in the app names its key with `readKeys.` (a key of a listed family: an unknown one is a type error)', () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const file of sources(SRC)) {
    if (['lib/read-cache.ts', 'lib/facts/invalidate.ts'].includes(rel(file))) continue;
    const text = strip(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/\breadFact\s*(?:<[^(]*>)?\s*\(/g)) {
      seen += 1;
      const call = text.slice(m.index ?? 0, (m.index ?? 0) + 400);
      if (!/\bkey:\s*readKeys\.\w+\(/.test(call)) offenders.push(rel(file));
    }
  }
  assert.ok(seen >= 6, `the scan found ${seen} readFact calls`);
  assert.deepEqual(offenders, []);
});
