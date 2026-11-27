import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The images of the store's draft are one fact with several screens (the Graphics tab, the comparison of the release step, the counts
 * next to the repository's, what blocks a submit). A user report (2026-11-27): the Graphics tab said "12 found", the release step said
 * "repository 8, store 4" and the store showed 10: three screens, three ways of counting and three ages of the same read.
 * What keeps them one, read from the source:
 *  - the count of a set is core's (`checkStoreImages` -> `validateAssets`): no screen counts a group against the limit itself;
 *  - a screen that keeps the store's images (the comparison of the release step, the browser's graphics) forgets them when the store is
 *    read again, through the one announcement (`store_read`), and the Graphics tab's own "Read again" forgets the comparison;
 *  - the comparison pairs ONE set per display with `primaryStoreSet`, the same the push writes.
 */
const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', '..');
const root = join(web, '..', '..', '..');
const read = (path: string) => readFileSync(join(web, path), 'utf8');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

test("only the derivation of the web store of the store's images judges the store's images, with core's rule; nothing else in the web app counts a set against a limit", () => {
  const all = sources(web);
  const users = all
    .filter((f) => /\bcheckStoreImages\(/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(web, f).split('\\').join('/'));
  assert.deepEqual(users, ['lib/app-state/store-images.ts']);
  const own = all
    .filter((f) =>
      /rows\.length\s*>\s*(?:\w+\.)?max\b|files\.length\s*>\s*(?:\w+\.)?max\b/.test(
        readFileSync(f, 'utf8'),
      ),
    )
    .map((f) => relative(web, f).split('\\').join('/'));
  assert.deepEqual(own, [], 'a limit is compared in core (`validateAssets`), never in a screen');
  // What the over-limit action removes is what the rule found over: it reads the problem's count and max, it has no limit of its own.
  assert.match(read('lib/assets/over-limit.ts'), /p\.count <= p\.max/);
  // The limit table and the upload cap are core's: the web retypes neither.
  const tables = all
    .filter((f) =>
      /\bslotMaxFiles\b|\bmaxFor\b|8 \* MiB|8 \* 1024 \* 1024/.test(readFileSync(f, 'utf8')),
    )
    .map((f) => relative(web, f).split('\\').join('/'));
  assert.deepEqual(
    tables,
    [],
    'limitOf and ASSET_UPLOAD_MAX_BYTES (core) are the only limit and cap',
  );
});

test("the screens that show the store's images read them from the one web store, and nothing else reads their endpoints", () => {
  const all = sources(web);
  const readers = (pattern: RegExp) =>
    all
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => relative(web, f).split('\\').join('/'))
      .filter((f) => f !== 'lib/api.ts');
  assert.deepEqual(readers(/\.appStoreImages\(/), ['lib/app-state/store-images-store.svelte.ts']);
  assert.deepEqual(readers(/\.appAssets\(/), ['lib/app-state/store-images-store.svelte.ts']);
  assert.deepEqual(readers(/\.appAssetDiff\(/), ['lib/app-state/store-images-store.svelte.ts']);
  assert.deepEqual(readers(/\.releaseAssetProposal(?:Summary)?\(/), [
    'lib/app-state/store-images-store.svelte.ts',
  ]);
  // Not the plain cache either: the surfaces go through the store.
  const cache = all
    .filter((f) => /storeMediaCache/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(web, f).split('\\').join('/'))
    .filter((f) => !/lib\/assets\/store-cache\.ts$|\.test\.ts$/.test(f));
  assert.deepEqual(cache, [
    'lib/app-state/store-images-store.svelte.ts',
    'lib/facts/invalidate.ts',
  ]);
});

test('the comparison follows the one invalidation that the store was read again', () => {
  const store = read('lib/app-state/store-images-store.svelte.ts');
  assert.match(store, /'store_read', 'publish', 'sync', 'release_created'/);
  assert.match(store, /watchDiff\(/);
  const step = read('components/release/stepper/StepAssets.svelte');
  assert.match(step, /storeImagesStore\.watchDiff\(/);
  // `invalidate` forgets `assetdiff/` (facts/invalidate.ts); the step never forgets a key itself.
  assert.doesNotMatch(step, /readCache\./);
});

test('"Read again" asks the store once: the comparison is forgotten and what blocks a submit is judged on the same read', () => {
  const store = read('lib/app-state/store-images-store.svelte.ts');
  assert.match(
    store,
    /invalidate\('store_read', \{ workspaceId, appId: app\.id, keepGraphics: true, origin: 'graphics' \}\)/,
  );
  assert.match(store, /appStateStore\.storeRead\(/);
  assert.doesNotMatch(store, /readCache\.forget/);
  // The counts next to the repository's are computed from the view the browser holds (core `storeSideOf`), never read again from the server.
  assert.match(read('lib/app-state/store-images.ts'), /storeSideOf\(view\)/);
  const tab = read('components/assets/AssetsTab.svelte');
  assert.doesNotMatch(tab, /storeSide: next\.storeSide/);
  assert.match(tab, /facts\.channel === 'editable' \? facts\.side : null/);
});

test('the server pairs one set per display with the rule the push uses (core `groupStoreImages`), and a pull names an image by its ref', () => {
  const diff = readFileSync(join(root, 'apps/server/src/modules/listing/asset-diff.ts'), 'utf8');
  const groups = readFileSync(join(root, 'packages/core/src/images/groups.ts'), 'utf8');
  assert.match(diff, /groupStoreImages\(/);
  assert.match(diff, /compareRows\(/);
  assert.match(groups, /primaryStoreSet\(sets\)/);
  assert.match(
    groups,
    /for \(const d of groupStoreImages\(view\)\)/,
    'storeSideOf counts displays',
  );
  // The last of the siblings must never stand for the display again.
  assert.doesNotMatch(diff, /storeSets\.set\(keyOf\(s\.locale, s\.kind, s\.device\), s\)/);
  // The pull dialog and the comparison select an image by the store's own position of it, never the row's place in the comparison.
  const sync = read('lib/assets/sync.ts');
  assert.match(sync, /row\.storePosition/);
  assert.doesNotMatch(sync, /#\$\{r\.position\}/);
});
