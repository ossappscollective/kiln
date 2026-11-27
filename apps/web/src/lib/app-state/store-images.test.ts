import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StagedChangesView, StoreImageFile, StoreImageSet, StoreImagesView } from '@kiln/core';
import { deriveImagesFacts } from './store-images.ts';

/**
 * The facts of the store's images, derived once for every screen (store-images.ts). The audit's scenario: the iPad 13" display held in
 * TWO placement groups, 10 in APP_IPAD_PRO_3GEN_129 and 2 in the legacy APP_IPAD_PRO_129. Each group is within its limit of 10; the
 * display is 12 and does not fit ONE staged set.
 */

const urls = { thumb: (r: string) => `t/${r}`, file: (r: string) => `f/${r}`, blob: (o: string) => `b/${o}`, repo: (p: string) => p };
const file = (position: number, prefix: string): StoreImageFile => ({
  ref: `${prefix}-${position}`,
  position,
  name: `${position}.png`,
  width: 2064,
  height: 2752,
  bytes: 1000,
  sizeFrom: 'store',
  checksum: null,
  checksumKind: null,
  state: null,
  downloadable: true,
});
const files = (count: number, from: number, prefix: string) => Array.from({ length: count }, (_, i) => file(from + i, prefix));
const group = (target: string, list: StoreImageFile[]): StoreImageSet => ({
  platform: 'ios',
  locale: 'en-US',
  kind: 'screenshot',
  device: 'ipad_13',
  deviceLabel: 'iPad 13"',
  target,
  files: list,
});
const view = (): StoreImagesView => ({
  appId: 'app',
  platform: 'ios',
  store: 'app_store',
  version: { id: 'v1', versionString: '1.0', state: 'PREPARE_FOR_SUBMISSION', editable: true },
  readAt: 1000,
  unplaced: 0,
  notes: [],
  sets: [group('APP_IPAD_PRO_3GEN_129', files(10, 1, 'a')), group('APP_IPAD_PRO_129', files(2, 11, 'b'))],
});
const stagedView = (assets: unknown[]): StagedChangesView => ({ text: [], assets, release: [] }) as unknown as StagedChangesView;
const stagedSet = (count: number, over: Record<string, unknown> = {}) => ({
  id: 'en-US/screenshot:ipad_13',
  locale: 'en-US',
  slot: { kind: 'screenshot', device: 'ipad_13' },
  status: 'changed',
  source: 'store',
  pushed: false,
  cleared: false,
  problems: [],
  label: 'iPad 13"',
  files: Array.from({ length: count }, (_, i) => ({ path: `${i + 1}.png`, oid: `o${i + 1}`, upload: false, width: 2064, height: 2752, bytes: 1000, ref: `a-${i + 1}` })),
  ...over,
});
const derive = (v: StoreImagesView | null, staged: StagedChangesView | null = null, channel: 'editable' | 'live' = 'editable') =>
  deriveImagesFacts({ platform: 'ios', channel, view: v, staged, urls });

test('a display held in 10 + 2: each group is within its limit, the display is 12, and the number next to the repository is the main group\'s', () => {
  const f = derive(view());
  assert.equal(f.displays.length, 1);
  assert.deepEqual(f.displays[0]?.counts, { perGroup: [{ target: 'APP_IPAD_PRO_3GEN_129', count: 10 }, { target: 'APP_IPAD_PRO_129', count: 2 }], primary: 10, merged: 12 });
  assert.equal(f.displays[0]?.stagedFits, false);
  assert.deepEqual(f.problems.filter((p) => p.rule === 'apple.screenshot.count'), [], 'no group is over 10');
  // storeSide: the browser's view, one entry per DISPLAY, the primary group's count, the groups named when there are several
  assert.equal(f.side?.observedAt, 1000);
  assert.equal(f.side?.counts.length, 1);
  assert.equal(f.side?.counts[0]?.count, 10);
  assert.equal(f.side?.counts[0]?.target, 'APP_IPAD_PRO_3GEN_129');
  assert.equal(f.side?.counts[0]?.groups?.length, 2);
  // the Graphics tab draws the display merged (12), with both groups named
  assert.equal(f.counts.images, 12);
  assert.equal(f.graphicSets[0]?.sets[0]?.rows.length, 12);
  assert.deepEqual(f.graphicSets[0]?.sets[0]?.groups.map((g) => g.count), [10, 2]);
  // the pull offers the main group only and says what stays
  assert.equal(f.counts.pullSets, 1);
  assert.equal(f.pullChoices[0]?.count, 10);
  assert.equal(f.pullChoices[0]?.others, 2);
  assert.equal(f.pullChoices[0]?.key, 'ios/en-US/screenshot:ipad_13');
});

test('the store side follows the view the browser holds, per display, and is null before the first read', () => {
  assert.equal(derive(null).side, null);
  assert.equal(derive(null).readAt, null);
  const other = view();
  other.readAt = 5000;
  other.sets.push({ ...group('screenshot:iphone_6_9', files(3, 1, 'c')), device: 'iphone_6_9', deviceLabel: 'iPhone 6.9"' });
  const f = derive(other);
  assert.equal(f.readAt, 5000);
  assert.deepEqual(f.side?.counts.map((c) => [c.device, c.count]), [['ipad_13', 10], ['iphone_6_9', 3]]);
  assert.equal(f.side?.counts[1]?.groups, undefined, 'a display of one group has nothing to name');
});

test('predicted: removing the two extras is one staged set of 10; the store as it IS still says 12, the store AFTER says the draft is fine', () => {
  const f = derive(view(), stagedView([stagedSet(10)]));
  assert.equal(f.predicted?.displays[0]?.count, 10);
  assert.deepEqual(f.problemsAfter.filter((p) => p.rule === 'apple.screenshot.count'), []);
  assert.equal(f.counts.staged, 1);
  assert.equal(f.graphicSets[0]?.sets[0]?.rows.length, 10, 'the staged rows replace the store\'s');
  // 11 would still be too many for one staged set
  const over = derive(view(), stagedView([stagedSet(11)]));
  assert.equal(over.problemsAfter.filter((p) => p.rule === 'apple.screenshot.count').length, 1);
  assert.ok(over.overLimit.length > 0, 'the over-limit action sees the staged set');
});

test('a staged set that was pushed already is not predicted again, and a live view shows nothing staged', () => {
  const pushed = derive(view(), stagedView([stagedSet(10, { pushed: true })]));
  assert.equal(pushed.predicted, null);
  assert.equal(pushed.counts.staged, 0);
  const live = derive(view(), stagedView([stagedSet(10)]), 'live');
  assert.equal(live.predicted, null, 'staged changes are for the draft');
  assert.equal(live.counts.images, 12);
});

test('the same arguments give the same facts (the harness and the screens read one computation)', () => {
  const v = view();
  const s = stagedView([stagedSet(10)]);
  assert.deepEqual(derive(v, s).side, derive(v, s).side);
  assert.deepEqual(derive(v, s).counts, derive(v, s).counts);
});
