import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * ONE rule counts the screenshots of a set (`validateAssets` -> `checkSets` in store-asset-specs.ts: per store set, never summed across the
 * sibling display types). Every place that judges images (the store's own images, a draft read, the files of a repository, what a push
 * would stage) calls it; none counts, or words the limit, itself. A user report (2026-11-27) came from a second path that built its own
 * facts without the store's set and so summed the 13" and 12.9" groups: this test keeps the second implementation from coming back.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'target' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}
const files = ['packages/core/src', 'packages/connectors/src', 'apps/server/src', 'apps/web/src'].flatMap((d) =>
  sources(join(root, d)),
);
const rel = (f: string) => relative(root, f).split('\\').join('/');
const using = (pattern: RegExp) =>
  files.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map(rel).sort();

test('the limit "At most N screenshots per device size" is worded in one place', () => {
  assert.deepEqual(using(/screenshots per device size\./), [
    'apps/server/src/modules/publish/staged-changes.ts', // a comment quoting the staging rule below
    'packages/core/src/listing/staged-changes.ts', // `slotLimitProblem`: what ONE set would hold once staged (the group a push writes)
    'packages/core/src/listing/store-asset-specs.ts', // the rule itself
  ]);
});

test('only these modules call the validators; each builds its facts from the same shape', () => {
  assert.deepEqual(using(/\bvalidateAssets\(/), [
    'apps/server/src/modules/listing/asset-index.ts', // the repository's files
    'apps/server/src/modules/publish/staged-changes.ts', // what a push would stage
    'apps/server/src/modules/publish/staged-sets.ts', // one staged set
    'packages/core/src/images/facts.ts', // the store's own images (`checkStoreImages` -> `validateImageFacts`) and a prediction
    'packages/core/src/listing/draft-readiness.ts', // a draft read (`assetFactsOf`)
    'packages/core/src/listing/store-asset-specs.ts',
  ]);
  assert.deepEqual(using(/\bsummarizeAssets\(/), [
    'apps/server/src/modules/listing/asset-index.ts',
    'packages/core/src/listing/store-asset-specs.ts',
  ]);
});

test('facts built from the store\'s sets carry the set (the key of the count): ONE builder, used by both places that read a store', () => {
  const builder = readFileSync(join(root, 'packages/core/src/images/facts.ts'), 'utf8');
  const asset = readFileSync(join(root, 'packages/core/src/listing/asset-sync.ts'), 'utf8');
  const draft = readFileSync(join(root, 'packages/core/src/listing/draft-readiness.ts'), 'utf8');
  assert.match(builder, /set: input\.store === 'app_store' \? \(input\.group \?\? null\) : null/);
  assert.match(asset, /storeImageFacts\(view\)/);
  assert.match(draft, /assetFact\(\{/);
  assert.match(draft, /group: set\.target/);
});

test('no screen or server module counts the images of a store set against the limit itself', () => {
  // `slotMaxFiles` is the limit for a display of ONE set (what the grid shows as "N of 10"); nothing may compare a count to it to raise a problem.
  const raising = using(/files\.length\s*>\s*(?:\w+\.)?max\b|rows\.length\s*>\s*(?:\w+\.)?max\b/);
  assert.deepEqual(raising, [
    'apps/server/src/modules/publish/staged-changes.ts', // the size of the ONE staged set a push writes (`slotLimitProblem`)
    'packages/connectors/src/apple/appstore-draft.ts', // the same set, refused before the write
  ]);
});
