import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProposalItem } from '@kiln/core';
import { fieldLimit, imagePairs, pairIndexOf, textDiffItems, textIndexOf } from './asset-proposal-diff.ts';

const text = (field: string, before: string | null, after: string): ProposalItem => ({ id: `text:en-US:${field}`, kind: 'text', locale: 'en-US', field, before, after, hasErrors: false });
const gfx = (before: number | null, beforeFiles: { ref: string; position: number }[] | undefined, files: number): ProposalItem => ({
  id: 'graphics:en-US:screenshot:iphone_6_5', kind: 'graphics', locale: 'en-US', slot: 'screenshot:iphone_6_5', slotKind: 'screenshot', device: 'iphone_6_5', deviceLabel: 'iPhone 6.5"', before,
  ...(beforeFiles ? { beforeFiles: beforeFiles.map((f) => ({ ...f, name: null, width: 1, height: 2, bytes: 3 })) } : {}),
  after: { count: files, commit: 'c'.repeat(40), files: Array.from({ length: files }, (_, i) => ({ path: `fastlane/metadata/en-US/${i}.png`, oid: null, width: 1, height: 2, bytes: 3, format: 'png' })) },
  hasErrors: false,
});

test('text items carry the store and repository text and the store limit', () => {
  const items = textDiffItems([text('description', 'old', 'new'), gfx(0, [], 0), text('keywords', null, 'a,b')], 'ios');
  assert.deepEqual(items.map((i) => [i.key, i.before, i.after]), [['text:en-US:description', 'old', 'new'], ['text:en-US:keywords', null, 'a,b']]);
  assert.equal(items[0]?.limit, 4000);
  assert.equal(textIndexOf(items, 'text:en-US:keywords'), 1);
  assert.equal(textIndexOf(items, 'nope'), 0);
  assert.equal(fieldLimit('ios', 'unknown_field'), null);
});

test('image pairs go through Kiln\'s own routes only and pair by position', () => {
  const pairs = imagePairs([gfx(2, [{ ref: 'ab12', position: 1 }, { ref: 'cd34', position: 2 }], 3)], 'w', 'a');
  assert.equal(pairs.length, 3);
  assert.match(pairs[0]?.before?.url ?? '', /^\/api\/workspaces\/w\/apps\/a\/assets\/store\/thumb\?ref=ab12&size=640$/);
  assert.match(pairs[0]?.after?.url ?? '', /^\/api\/workspaces\/w\/apps\/a\/assets\/file\?path=/);
  assert.equal(pairs[2]?.before, null, 'a new third image');
  assert.ok(pairs.every((p) => [p.before?.url, p.after?.url].every((u) => u === undefined || u === null || u.startsWith('/api/'))));
  assert.equal(pairIndexOf(pairs, 'graphics:en-US:screenshot:iphone_6_5'), 0);
  // The store was not read: only the repository images, no before.
  assert.equal(imagePairs([gfx(null, undefined, 1)], 'w', 'a')[0]?.before, null);
});
