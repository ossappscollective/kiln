import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SHOTS,
  THEMES,
  appIdOf,
  appRoute,
  buildManifest,
  fileNameFor,
  indexApps,
  mergeManifest,
  parseArgs,
  pngSize,
  selectShots,
  shotUrl,
} from './capture.mjs';

// A 1x1 PNG, then widened in the IHDR so the reader has something to find.
const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

test('appRoute builds hash routes like lib/app-scope.ts', () => {
  assert.equal(appRoute('abc'), '#/portfolio/abc');
  assert.equal(
    appRoute('abc', 'listing', { platform: 'ios' }),
    '#/portfolio/abc/listing?platform=ios',
  );
  assert.equal(
    appRoute('a b', 'releases', { platform: 'ios', step: 'notes', x: undefined, y: '' }),
    '#/portfolio/a%20b/releases?platform=ios&step=notes',
  );
});

test('shotUrl joins base and hash', () => {
  assert.equal(
    shotUrl('http://localhost:8788/', '#/portfolio'),
    'http://localhost:8788/#/portfolio',
  );
  assert.equal(shotUrl('http://localhost:8788', '/portfolio'), 'http://localhost:8788/#/portfolio');
});

test('indexApps and appIdOf pick records by name and platform', () => {
  const index = indexApps([
    { id: 'n-ios', name: 'Demo Notes', platform: 'ios' },
    { id: 'n-mac', name: 'Demo Notes', platform: 'macos' },
    { id: 'w-and', name: 'Demo Weather', platform: 'android' },
    { nope: true },
  ]);
  assert.equal(appIdOf(index, 'Demo Notes', 'macos'), 'n-mac');
  assert.equal(appIdOf(index, 'Demo Notes'), 'n-ios');
  assert.equal(appIdOf(index, 'Demo Weather'), 'w-and');
  assert.throws(() => appIdOf(index, 'Demo Notes', 'android'), /not found/);
  assert.throws(() => appIdOf(index, 'Demo Focus'), /Demo Notes, Demo Weather/);
});

test('pngSize reads the header', () => {
  assert.deepEqual(pngSize(png(2880, 1800)), { width: 2880, height: 1800 });
  assert.equal(pngSize(Buffer.from('not a png at all, really not')), null);
});

test('shots are well formed and routes resolve for every demo app', () => {
  const ctx = { app: (name, platform) => `${name}:${platform ?? ''}` };
  const names = new Set();
  for (const s of SHOTS) {
    assert.match(s.name, /^\d\d-[a-z-]+$/);
    assert.ok(!names.has(s.name), `duplicate ${s.name}`);
    names.add(s.name);
    assert.ok(s.alt.length > 20 && s.title);
    assert.match(s.path(ctx), /^#\//);
    assert.ok(typeof s.ready === 'function' || s.ready.length > 0);
  }
  assert.equal(SHOTS.length, 13);
  assert.equal(
    SHOTS[2].path({ app: () => 'ID' }),
    '#/portfolio/ID/releases?platform=ios&step=notes',
  );
});

test('buildManifest is sorted, flat and carries alt text', () => {
  const m = buildManifest(
    [
      { name: '02-b', title: 'B', theme: 'light', width: 2880, height: 1800, alt: 'b' },
      { name: '01-a', title: 'A', theme: 'light', width: 2880, height: 1800, alt: 'a' },
      { name: '01-a', title: 'A', theme: 'dark', width: 2880, height: 1800, alt: 'a' },
    ],
    { scale: 2 },
  );
  assert.deepEqual(
    m.shots.map((s) => `${s.name}/${s.theme}`),
    ['01-a/dark', '01-a/light', '02-b/light'],
  );
  assert.equal(m.shots[0].file, fileNameFor('01-a', 'dark'));
  assert.deepEqual(m.viewport, { width: 1440, height: 900 });
  for (const s of m.shots)
    for (const k of ['name', 'theme', 'width', 'height', 'alt', 'file'])
      assert.ok(s[k] !== undefined, k);
  assert.deepEqual(THEMES, ['dark', 'light']);
});

test('mergeManifest keeps untouched entries whose file exists', () => {
  const prev = {
    shots: [
      { name: '01-a', theme: 'dark', file: 'x' },
      { name: '02-b', theme: 'dark', file: 'gone' },
    ],
  };
  const fresh = [
    { name: '01-a', theme: 'dark', file: 'new' },
    { name: '03-c', theme: 'dark', file: 'c' },
  ];
  const out = mergeManifest(prev, fresh, (s) => s.file !== 'gone');
  assert.deepEqual(out.map((s) => s.file).sort(), ['c', 'new']);
  assert.equal(mergeManifest(null, fresh).length, 2);
});

test('parseArgs: defaults, flags, short shot names and errors', () => {
  const d = parseArgs([]);
  assert.equal(d.base, 'http://localhost:8788');
  assert.deepEqual(d.themes, ['dark', 'light']);
  assert.equal(d.scale, 2);
  assert.equal(d.reset, false);
  const o = parseArgs([
    '--base',
    'http://127.0.0.1:9/',
    '--only',
    '02,04-store-listing,aso',
    '--themes=light',
    '--scale',
    '1',
    '--reset',
    '--list',
  ]);
  assert.equal(o.base, 'http://127.0.0.1:9');
  assert.deepEqual(o.only, ['02-app-overview', '04-store-listing', '10-aso']);
  assert.deepEqual(o.themes, ['light']);
  assert.equal(o.scale, 1);
  assert.ok(o.reset && o.list);
  assert.deepEqual(
    selectShots(o).map((s) => s.name),
    ['02-app-overview', '04-store-listing', '10-aso'],
  );
  assert.throws(() => parseArgs(['--themes', 'sepia']), /Unknown theme/);
  assert.throws(() => parseArgs(['--scale', '9']), /--scale/);
  assert.throws(() => parseArgs(['--only', 'nope']), /Unknown shot/);
  assert.throws(() => parseArgs(['--wat']), /Unknown option/);
  assert.throws(() => parseArgs(['--base']), /needs a value/);
});
