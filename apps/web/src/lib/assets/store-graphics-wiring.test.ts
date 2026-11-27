import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Wiring of the Graphics tab's removal (docs/api/staged-changes.md "Remove files from a set"): the screen is a thin shell over
 * lib/assets/selection.ts and lib/assets/removal.ts. These read the component as text, as lib/app-state/wiring.test.ts does, because
 * a component cannot be mounted under `node --test`.
 */
const source = (name: string) =>
  readFileSync(new URL(`../../components/assets/${name}`, import.meta.url), 'utf8').replace(
    /<!--[\s\S]*?-->/g,
    '',
  );
const graphics = source('StoreGraphics.svelte');
const editor = source('AssetSetEditor.svelte');
const store = readFileSync(new URL('../app-state/store-images.ts', import.meta.url), 'utf8');

test('one request stages every removal of a selection, and nothing loops over the files', () => {
  assert.equal((graphics.match(/api\.removeStagedAssetFiles\(/g) ?? []).length, 1);
  assert.doesNotMatch(
    graphics,
    /removeStagedAssetFile\(/,
    'the one-file-by-place route is not used by the grid',
  );
  assert.doesNotMatch(
    graphics,
    /for\s*\([^)]*\)\s*\{[^}]*removeStagedAssetFiles/,
    'no request per image',
  );
  assert.match(graphics, /files: rows\.map\(fileIdOf\)/, 'files are named by store ref or blob id');
  assert.match(graphics, /base: 'store'/, 'the Graphics tab edits the store side');
});

test('the answer of the server is the only source of the staged view and of what the tray counts', () => {
  assert.match(graphics, /storeImagesStore\.applyStaged\(done\.staged\)/);
  assert.doesNotMatch(
    graphics,
    /staged-store/,
    'the staged store is reached through the images store only',
  );
  assert.doesNotMatch(
    graphics,
    /pendingStore|cartSummaryStore|appStateStore|pendingCount/,
    'no local count of pending changes',
  );
});

test('removing is optimistic and local: images stay in place with a stable key, marked busy, never the whole tree', () => {
  assert.match(graphics, /\{#each set\.rows as row \(row\.key\)\}/);
  assert.match(graphics, /aria-busy=\{mark\?\.status === 'removing'\}/);
  assert.match(graphics, /store\.removingItem/);
  assert.match(graphics, /store\.removingCount/);
  assert.match(graphics, /openLocales\[loc\.locale\]/, 'a section the person opened stays open');
  assert.match(graphics, /ontoggle=/);
  assert.doesNotMatch(graphics, /\{#key /, 'no {#key} remount');
});

test('multi-select: a checkbox per image, shift range, select all, a toolbar with Escape and Delete', () => {
  assert.match(graphics, /type="checkbox"/);
  assert.match(graphics, /event\.shiftKey/);
  assert.match(graphics, /store\.selectAll/);
  assert.match(graphics, /role="toolbar"/);
  assert.match(graphics, /event\.key === 'Escape'/);
  assert.match(graphics, /event\.key === 'Delete'/);
  assert.match(graphics, /position: sticky/);
});

test('asking first is inline, not a dialog; the last image of a set can be removed; undo discards the staged change', () => {
  assert.match(graphics, /needsConfirm\(set\.rows\.length, keys\.length\)/);
  assert.match(graphics, /class="confirm" role="alert"/);
  assert.doesNotMatch(graphics, /set\.rows\.length <= 1/, 'no "last image" guard');
  assert.doesNotMatch(
    editor,
    /EMPTY_SET_REASON|rows\.length <= 1/,
    'no "last file" guard in the editor',
  );
  assert.match(graphics, /api\.unstageItem\(workspaceId, app\.id, last\.setId\)/);
  assert.match(graphics, /canUndo\(wasStaged, done\.summary\)/);
});

test('the consequence of emptying a set comes from the core content rule', () => {
  assert.match(graphics, /emptyingConsequence\(store,/);
  assert.match(graphics, /setNeedsAnImage\(store,/);
  assert.match(graphics, /store\.noneLeftApple/);
});

test('the editor names a file by its blob id and reads the per-file answer', () => {
  assert.match(editor, /files: \[fileIdOf\(r\)\]/);
  assert.match(editor, /result\.outcome === 'not_found'/);
});

test('the tab says which version it shows (draft or live), offers the switch, and keeps the live view read only', () => {
  assert.match(graphics, /storeVersionLabel\(view, channel\)/);
  assert.match(graphics, /assets:store\.version\.draft/);
  assert.match(graphics, /assets:store\.version\.live'/);
  assert.match(
    graphics,
    /assets:store\.version\.draftNote/,
    'a removal is explained: it changes the draft only',
  );
  assert.match(graphics, /offersChannelSwitch\(view\)/);
  assert.match(
    store,
    /staged: channel === 'live' \? null : staged/,
    'staged changes are for the draft, not shown on the live view',
  );
  assert.match(graphics, /!versionLabel\.editable/, 'the live view cannot be edited');
});
