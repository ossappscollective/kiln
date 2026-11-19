import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatedName, layoutFor, type PlanLayout, planSet } from './services/asset-repo-plan.ts';

const layout: PlanLayout = {
  dir: 'fastlane/screenshots/en-US',
  fixedStem: null,
  stem: 'iphone_6_9',
};
const cur = (names: string[]) =>
  names.map((n) => ({ path: `${layout.dir}/${n}`, oid: `oid-${n}` }));

test('layout: iOS follows the folder the repository already uses', () => {
  const roots = { appStore: 'fastlane/metadata', googlePlay: null };
  const slot = { kind: 'screenshot' as const, device: 'iphone_6_9' };
  const same = layoutFor({
    platform: 'ios',
    locale: 'en-US',
    slot,
    roots,
    existing: [
      { path: 'x/shots/en-US/a.png', locale: 'en-US', kind: 'screenshot', device: 'iphone_6_9' },
    ],
  });
  assert.deepEqual(same, {
    ok: true,
    layout: { dir: 'x/shots/en-US', fixedStem: null, stem: 'iphone_6_9' },
  });
  const other = layoutFor({
    platform: 'ios',
    locale: 'de-DE',
    slot,
    roots,
    existing: [
      { path: 'x/shots/en-US/a.png', locale: 'en-US', kind: 'screenshot', device: 'ipad_13' },
    ],
  });
  assert.equal(other.ok && other.layout.dir, 'x/shots/de-DE');
  const fresh = layoutFor({ platform: 'ios', locale: 'de-DE', slot, roots, existing: [] });
  assert.equal(fresh.ok && fresh.layout.dir, 'fastlane/screenshots/de-DE');
  assert.equal(
    layoutFor({
      platform: 'ios',
      locale: 'de-DE',
      slot,
      roots: { appStore: null, googlePlay: null },
      existing: [],
    }).ok,
    false,
  );
  assert.equal(
    layoutFor({
      platform: 'ios',
      locale: 'de-DE',
      slot: { kind: 'icon', device: null },
      roots,
      existing: [],
    }).ok,
    false,
  );
});

test('layout: Google Play screenshots and graphics', () => {
  const roots = { appStore: null, googlePlay: 'fastlane/metadata/android' };
  const shots = layoutFor({
    platform: 'android',
    locale: 'en-US',
    slot: { kind: 'screenshot', device: 'tablet_7' },
    roots,
    existing: [],
  });
  assert.equal(
    shots.ok && shots.layout.dir,
    'fastlane/metadata/android/en-US/images/sevenInchScreenshots',
  );
  const feature = layoutFor({
    platform: 'android',
    locale: 'en-US',
    slot: { kind: 'feature_graphic', device: null },
    roots,
    existing: [],
  });
  assert.ok(
    feature.ok &&
      feature.layout.dir === 'fastlane/metadata/android/en-US/images' &&
      feature.layout.fixedStem === 'featureGraphic',
  );
  assert.equal(
    layoutFor({
      platform: 'android',
      locale: 'en-US',
      slot: { kind: 'screenshot', device: 'phone' },
      roots: { appStore: null, googlePlay: null },
      existing: [],
    }).ok,
    false,
  );
});

test('names sort as the numbers do', () => {
  assert.equal(generatedName(layout, 0, 3, 'png'), 'iphone_6_9-01.png');
  assert.equal(generatedName(layout, 9, 120, 'jpg'), 'iphone_6_9-010.jpg');
  assert.equal(generatedName({ ...layout, fixedStem: 'icon' }, 0, 1, 'png'), 'icon.png');
});

test('a new file takes over the path at its position; unchanged files cost nothing', () => {
  const current = cur(['a.png', 'b.png']);
  const plan = planSet({
    layout,
    current,
    wanted: [
      { kind: 'existing', path: current[0]!.path, oid: 'oid-a.png' },
      { kind: 'new', oid: 'new', format: 'png' },
    ],
    prune: false,
  });
  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.steps, [
    {
      op: 'write',
      path: current[1]!.path,
      oid: 'new',
      from: { kind: 'new', index: 1 },
      replacesOid: 'oid-b.png',
    },
  ]);
  assert.equal(plan.renamed, false);
});

test('a file that is already there with the same bytes is not written again', () => {
  const current = cur(['a.png']);
  const plan = planSet({
    layout,
    current,
    wanted: [{ kind: 'new', oid: 'oid-a.png', format: 'png' }],
    prune: false,
  });
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.unchanged, 1);
});

test('an added file gets a generated name that sorts last; extras are kept unless pruning', () => {
  const current = cur(['iphone_6_9-01.png']);
  const wanted = [
    { kind: 'existing' as const, path: current[0]!.path, oid: 'oid-iphone_6_9-01.png' },
    { kind: 'new' as const, oid: 'n', format: 'png' as const },
  ];
  const plan = planSet({ layout, current, wanted, prune: false });
  assert.deepEqual(plan.paths, [current[0]!.path, `${layout.dir}/iphone_6_9-02.png`]);
  assert.equal(plan.steps.length, 1);
  const extra = cur(['a.png', 'b.png', 'c.png']);
  const keep = planSet({
    layout,
    current: extra,
    wanted: [{ kind: 'new', oid: 'x', format: 'png' }],
    prune: false,
  });
  assert.deepEqual(keep.left, [extra[1]!.path, extra[2]!.path]);
  const prune = planSet({
    layout,
    current: extra,
    wanted: [{ kind: 'new', oid: 'x', format: 'png' }],
    prune: true,
  });
  assert.deepEqual(
    prune.steps.filter((s) => s.op === 'delete').map((s) => s.path),
    [extra[1]!.path, extra[2]!.path],
  );
});

test('a reorder renames the whole set, deletes the old places and never loses a file', () => {
  const current = cur(['a.png', 'b.png']);
  const plan = planSet({
    layout,
    current,
    wanted: [
      { kind: 'existing', path: current[1]!.path, oid: 'oid-b.png' },
      { kind: 'existing', path: current[0]!.path, oid: 'oid-a.png' },
    ],
    prune: false,
  });
  assert.equal(plan.renamed, true);
  assert.deepEqual(plan.paths, [
    `${layout.dir}/iphone_6_9-01.png`,
    `${layout.dir}/iphone_6_9-02.png`,
  ]);
  const writes = plan.steps.filter((s) => s.op === 'write');
  assert.equal(writes.length, 2);
  assert.deepEqual(
    plan.steps
      .filter((s) => s.op === 'delete')
      .map((s) => s.path)
      .sort(),
    current.map((c) => c.path),
  );
});

test('a Play graphic always replaces the file, whatever its extension was', () => {
  const g: PlanLayout = { dir: 'm/en-US/images', fixedStem: 'icon', stem: 'icon' };
  const plan = planSet({
    layout: g,
    current: [{ path: 'm/en-US/images/icon.jpg', oid: 'old' }],
    wanted: [{ kind: 'new', oid: 'n', format: 'png' }],
    prune: false,
  });
  assert.deepEqual(plan.steps, [
    {
      op: 'write',
      path: 'm/en-US/images/icon.png',
      oid: 'n',
      from: { kind: 'new', index: 0 },
      replacesOid: null,
    },
    { op: 'delete', path: 'm/en-US/images/icon.jpg', oid: 'old' },
  ]);
});

test('a jpeg replaces a png at its position under a new name', () => {
  const current = cur(['a.png']);
  const plan = planSet({
    layout,
    current,
    wanted: [{ kind: 'new', oid: 'j', format: 'jpeg' }],
    prune: false,
  });
  assert.deepEqual(plan.paths, [`${layout.dir}/iphone_6_9-01.jpg`]);
  assert.equal(
    plan.steps.filter((s) => s.op === 'delete').length,
    0,
    'the old file stays unless pruning',
  );
});
