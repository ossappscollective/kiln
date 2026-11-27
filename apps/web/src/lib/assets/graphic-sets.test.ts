import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StagedChangesView, StoreImagesView } from '@kiln/core';
import { buildGraphicSets, canAddMore, moveBy } from './graphic-sets.ts';

const urls = {
  thumb: (r: string) => `t/${r}`,
  file: (r: string) => `f/${r}`,
  blob: (o: string) => `b/${o}`,
  repo: (p: string, c: string) => `r/${c}/${p}`,
};
const file = (position: number, over = {}) => ({
  ref: `ref${position}`,
  position,
  name: `s${position}.png`,
  width: 1,
  height: 2,
  bytes: 3,
  sizeFrom: 'store' as const,
  checksum: null,
  checksumKind: null,
  state: null,
  downloadable: true,
  ...over,
});
const view = (files: ReturnType<typeof file>[]): StoreImagesView => ({
  appId: 'a',
  platform: 'android',
  store: 'googleplay',
  version: null,
  readAt: 1,
  unplaced: 0,
  notes: [],
  sets: [
    {
      platform: 'android',
      locale: 'en-US',
      kind: 'screenshot',
      device: 'phone',
      deviceLabel: 'Phone',
      target: 'phoneScreenshots',
      files,
    },
  ],
});
const staged = (
  files: { position: number; oid: string; upload: boolean }[],
  over = {},
): StagedChangesView =>
  ({
    assets: [
      {
        id: 'en-US/screenshot:phone',
        kind: 'asset',
        locale: 'en-US',
        slot: { kind: 'screenshot', device: 'phone' },
        slotKey: 'screenshot:phone',
        label: 'x',
        source: 'local',
        status: 'changed',
        problems: [],
        pushedAt: null,
        pushed: false,
        createdAt: 1,
        updatedAt: 1,
        files: files.map((f) => ({
          id: `${f.position}`,
          position: f.position,
          path: f.upload ? `uploads/ab/${f.position}.png` : `shots/${f.position}.png`,
          commit: f.upload ? '' : 'c1',
          oid: f.oid,
          bytes: 5,
          width: 1,
          height: 2,
          format: 'png',
          hasAlpha: false,
          upload: f.upload,
        })),
        ...over,
      },
    ],
  }) as unknown as StagedChangesView;

test('the store set is shown with thumbnails and originals from refs', () => {
  const [loc] = buildGraphicSets({
    platform: 'android',
    view: view([file(1), file(2, { downloadable: false })]),
    staged: null,
    urls,
  });
  const set = loc?.sets[0];
  assert.equal(set?.staged, false);
  assert.deepEqual(
    set?.rows.map((r) => [r.thumb, r.full]),
    [
      ['t/ref1', 'f/ref1'],
      [null, null],
    ],
  );
});

test('a staged set replaces the store rows, keeps the store count, and draws uploads and repository files', () => {
  const [loc] = buildGraphicSets({
    platform: 'android',
    view: view([file(1), file(2)]),
    staged: staged([
      { position: 1, oid: 'o1', upload: true },
      { position: 2, oid: 'o2', upload: false },
      { position: 3, oid: 'o3', upload: true },
    ]),
    urls,
  });
  const set = loc?.sets[0];
  assert.equal(set?.staged, true);
  assert.equal(set?.storeCount, 2);
  assert.deepEqual(
    set?.rows.map((r) => r.thumb),
    ['b/o1', 'r/c1/shots/2.png', 'b/o3'],
  );
  assert.ok(set?.rows.every((r) => r.staged));
});

test('a staged set the store does not hold is listed; a pushed one is not', () => {
  assert.equal(
    buildGraphicSets({
      platform: 'android',
      view: null,
      staged: staged([{ position: 1, oid: 'o1', upload: true }]),
      urls,
    })[0]?.sets[0]?.storeCount,
    0,
  );
  assert.deepEqual(
    buildGraphicSets({
      platform: 'android',
      view: null,
      staged: staged([{ position: 1, oid: 'o1', upload: true }], { pushed: true }),
      urls,
    }),
    [],
  );
});

test('a discarded staged set shows the store rows again (the view without it)', () => {
  const [loc] = buildGraphicSets({
    platform: 'android',
    view: view([file(1)]),
    staged: { assets: [] } as unknown as StagedChangesView,
    urls,
  });
  assert.equal(loc?.sets[0]?.staged, false);
});

test('moves stay inside the set, and the limit of the set stops adding', () => {
  assert.deepEqual(moveBy(2, -1, 3), { from: 2, to: 1 });
  assert.equal(moveBy(1, -1, 3), null);
  assert.equal(moveBy(3, 1, 3), null);
  assert.equal(canAddMore({ rows: new Array(8).fill(0), stagedMax: 8 }), false);
  assert.equal(canAddMore({ rows: [], stagedMax: 1 }), true);
});

test('Play kinds without a device dimension have no device suffix; an unrecognised screenshot device says so', () => {
  const v = view([file(1)]);
  v.sets.push(
    {
      platform: 'android',
      locale: 'en-US',
      kind: 'feature_graphic',
      device: null,
      deviceLabel: '',
      target: 'featureGraphic',
      files: [file(1)],
    },
    {
      platform: 'android',
      locale: 'en-US',
      kind: 'icon',
      device: null,
      deviceLabel: '',
      target: 'icon',
      files: [file(1)],
    },
    {
      platform: 'android',
      locale: 'en-US',
      kind: 'screenshot',
      device: null,
      deviceLabel: '',
      target: 'x',
      files: [file(1)],
    },
  );
  const sets =
    buildGraphicSets({ platform: 'android', view: v, staged: null, urls })[0]?.sets ?? [];
  const label = (kind: string, device: string | null) =>
    sets.find((x) => x.kind === kind && x.device === device)?.deviceLabel;
  assert.equal(label('feature_graphic', null), '');
  assert.equal(label('icon', null), '');
  assert.equal(label('screenshot', 'phone'), 'Phone');
  assert.equal(label('screenshot', null), 'Device not recognised');
});

test('a row is named by its blob id and copy, not by its place: removing one image keeps the keys of the others', () => {
  const three = buildGraphicSets({
    platform: 'android',
    view: null,
    staged: staged([
      { position: 1, oid: 'o1', upload: true },
      { position: 2, oid: 'o2', upload: true },
      { position: 3, oid: 'o3', upload: true },
    ]),
    urls,
  })[0]?.sets[0];
  const two = buildGraphicSets({
    platform: 'android',
    view: null,
    staged: staged([
      { position: 1, oid: 'o1', upload: true },
      { position: 2, oid: 'o3', upload: true },
    ]),
    urls,
  })[0]?.sets[0];
  assert.deepEqual(
    three?.rows.map((r) => r.key),
    ['staged:o1:1', 'staged:o2:1', 'staged:o3:1'],
  );
  assert.deepEqual(
    two?.rows.map((r) => r.key),
    ['staged:o1:1', 'staged:o3:1'],
    'o3 keeps its key although it moved from place 3 to 2',
  );
  assert.deepEqual(
    three?.rows.map((r) => r.oid),
    ['o1', 'o2', 'o3'],
  );
  const twice = buildGraphicSets({
    platform: 'android',
    view: null,
    staged: staged([
      { position: 1, oid: 'o1', upload: true },
      { position: 2, oid: 'o1', upload: true },
    ]),
    urls,
  })[0]?.sets[0];
  assert.deepEqual(
    twice?.rows.map((r) => r.key),
    ['staged:o1:1', 'staged:o1:2'],
    'the same picture twice is two rows with two keys',
  );
});

test('a set staged empty is listed with no row, as cleared, and keeps what the store holds', () => {
  const [loc] = buildGraphicSets({
    platform: 'android',
    view: view([file(1), file(2)]),
    staged: staged([], { cleared: true }),
    urls,
  });
  const set = loc?.sets[0];
  assert.equal(set?.staged, true);
  assert.equal(set?.cleared, true);
  assert.deepEqual(set?.rows, []);
  assert.equal(set?.storeCount, 2);
  assert.equal(buildGraphicSets({ platform: 'android', view: view([file(1)]), staged: null, urls })[0]?.sets[0]?.cleared, false);
});

test('a display the store keeps in two groups is one grid, one group after the other, and says which groups: never one count', () => {
  const two: StoreImagesView = {
    ...view([]),
    platform: 'ios',
    store: 'app_store',
    sets: [
      { platform: 'ios', locale: 'en-US', kind: 'screenshot', device: 'ipad_13', deviceLabel: 'iPad', target: 'APP_IPAD_PRO_3GEN_129', files: [file(1, { ref: 'a1' }), file(2, { ref: 'a2' })] },
      { platform: 'ios', locale: 'en-US', kind: 'screenshot', device: 'ipad_13', deviceLabel: 'iPad', target: 'APP_IPAD_PRO_129', files: [file(1, { ref: 'b1' }), file(2, { ref: 'b2' })] },
    ],
  };
  const [loc] = buildGraphicSets({ platform: 'ios', view: two, staged: null, urls });
  const set = loc?.sets[0];
  assert.deepEqual(set?.rows.map((r) => r.key), ['a1', 'a2', 'b1', 'b2']);
  assert.deepEqual(set?.groups, [
    { target: 'APP_IPAD_PRO_3GEN_129', count: 2 },
    { target: 'APP_IPAD_PRO_129', count: 2 },
  ]);
  // One group: no note to make.
  const [one] = buildGraphicSets({ platform: 'android', view: view([file(1)]), staged: null, urls });
  assert.deepEqual(one?.sets[0]?.groups, []);
});
