import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

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

test('only the Graphics tab judges the store\'s images, with core\'s rule; nothing else in the web app counts a set against a limit', () => {
  const all = sources(web);
  const users = all
    .filter((f) => /\bcheckStoreImages\(/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(web, f).split('\\').join('/'));
  assert.deepEqual(users, ['components/assets/StoreGraphics.svelte']);
  const own = all
    .filter((f) => /rows\.length\s*>\s*(?:\w+\.)?max\b|files\.length\s*>\s*(?:\w+\.)?max\b/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(web, f).split('\\').join('/'));
  assert.deepEqual(own, [], 'a limit is compared in core (`validateAssets`), never in a screen');
  // What the over-limit action removes is what the rule found over: it reads the problem's count and max, it has no limit of its own.
  assert.match(read('lib/assets/over-limit.ts'), /p\.count <= p\.max/);
});

test('the comparison of the release step follows the one invalidation that the store was read again', () => {
  const step = read('components/release/stepper/StepAssets.svelte');
  assert.match(step, /onInvalidated/);
  assert.match(step, /i\.event !== 'store_read'/);
  // `invalidate` forgets `assetdiff/` (facts/invalidate.ts); the step never forgets a key itself.
  assert.doesNotMatch(step, /readCache\.forget/);
});

test('"Read again" of the Graphics tab invalidates the store read (the comparison is forgotten there) and reads the counts next to the repository\'s again', () => {
  const tab = read('components/assets/AssetsTab.svelte');
  assert.match(tab, /invalidate\('store_read', \{ workspaceId, appId: app\.id, keepGraphics: true, origin: 'graphics' \}\)/);
  assert.doesNotMatch(tab, /readCache\.forget/);
  assert.match(tab, /storeSide: next\.storeSide/);
  assert.match(tab, /appStateStore\.storeRead\(/);
});

test('the server pairs one set per display with the rule the push uses', () => {
  const diff = readFileSync(join(root, 'apps/server/src/modules/listing/asset-diff.ts'), 'utf8');
  const side = readFileSync(join(root, 'apps/server/src/modules/listing/store-images.ts'), 'utf8');
  assert.match(diff, /primaryStoreSet\(list\)/);
  assert.match(side, /primaryStoreSet\(sets\)/);
  // The last of the siblings must never stand for the display again.
  assert.doesNotMatch(diff, /storeSets\.set\(keyOf\(s\.locale, s\.kind, s\.device\), s\)/);
});
