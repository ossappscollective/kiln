import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkIcon, parsePath, pathInfo } from './icon-geometry.ts';
import { genericBrandIcons, iconDef, iconNames, iconPixels, icons, isIconName } from './icons.ts';

// The registry names, on purpose written out: adding or removing an icon is a deliberate change
// that updates this list (and docs/design-system.md if it is a store or tool mark).
const EXPECTED_NAMES = [
  'activity',
  'alert',
  'alert-triangle',
  'archive',
  'arrow-down',
  'arrow-left',
  'arrow-right',
  'arrow-up',
  'bell',
  'box',
  'bug',
  'calendar',
  'camera',
  'check',
  'check-circle',
  'chevron-down',
  'chevron-left',
  'chevron-right',
  'chevron-up',
  'clock',
  'code',
  'columns',
  'copy',
  'database',
  'download',
  'edit',
  'external-link',
  'eye',
  'eye-off',
  'file',
  'file-text',
  'filter',
  'flag',
  'folder',
  'git-branch',
  'git-commit',
  'git-merge',
  'git-pull-request',
  'globe',
  'grid',
  'hash',
  'help',
  'history',
  'image',
  'images',
  'inbox',
  'info',
  'key',
  'language',
  'laptop',
  'layers',
  'link',
  'list',
  'lock',
  'log-out',
  'mail',
  'menu',
  'message',
  'minus',
  'monitor',
  'moon',
  'more',
  'network',
  'pause',
  'percent',
  'pipeline',
  'platform-android',
  'platform-ios',
  'platform-macos',
  'play',
  'plus',
  'qr',
  'refresh',
  'repo',
  'rocket',
  'search',
  'send',
  'server',
  'settings',
  'shield',
  'smartphone',
  'sort',
  'sparkles',
  'star',
  'star-filled',
  'stop',
  'store',
  'store-android',
  'store-ios',
  'sun',
  'tablet',
  'tag',
  'terminal',
  'trash',
  'trending-up',
  'unlock',
  'upload',
  'user',
  'users',
  'x',
  'x-circle',
  'zap',
];

test('the registry lists exactly the expected icon names', () => {
  assert.deepEqual([...iconNames].sort(), [...EXPECTED_NAMES].sort());
  assert.equal(new Set(EXPECTED_NAMES).size, EXPECTED_NAMES.length);
});

test('names are kebab-case and every name resolves to its own definition', () => {
  for (const name of iconNames) {
    assert.match(name, /^[a-z]+(-[a-z]+)*$/, name);
    assert.ok(isIconName(name));
    assert.equal(iconDef(name), icons[name]);
  }
});

test('an unknown name is not an icon and draws the neutral help glyph', () => {
  assert.equal(isIconName('nope'), false);
  assert.equal(isIconName(undefined), false);
  assert.equal(isIconName('toString'), false);
  assert.equal(iconDef('nope'), icons.help);
});

test('every icon passes the path grammar and bounds checks', () => {
  for (const [name, def] of Object.entries(icons)) {
    const { problems } = checkIcon(def.style, def.body);
    assert.deepEqual(problems, [], name);
  }
});

test('no two icons share the same markup (except the filled twin of an outline)', () => {
  const seen = new Map<string, string>();
  for (const [name, def] of Object.entries(icons)) {
    const key = `${def.style}:${def.body}`;
    assert.equal(seen.get(key), undefined, `${name} duplicates ${seen.get(key)}`);
    seen.set(key, name);
  }
  assert.equal(icons['star-filled'].style, 'fill');
});

test('the checker rejects what it must', () => {
  assert.ok(checkIcon('stroke', '<path d="M0 0L30 30"/>').problems.length > 0, 'outside the box');
  assert.ok(checkIcon('stroke', '<path d="M2 2 L"/>').problems.length > 0, 'missing numbers');
  assert.ok(checkIcon('stroke', '<path d="M2 2 X5 5"/>').problems.length > 0, 'unknown command');
  assert.ok(checkIcon('stroke', '<path d="L2 2 4 4"/>').problems.length > 0, 'no leading M');
  assert.ok(
    checkIcon('stroke', '<path d="M2 2 a3 3 0 2 0 4 4"/>').problems.length > 0,
    'bad arc flag',
  );
  assert.ok(
    checkIcon('stroke', '<path d="M2 2 3 3" onclick="x"/>').problems.length > 0,
    'unknown attribute',
  );
  assert.ok(
    checkIcon('stroke', '<g><path d="M2 2 3 3"/></g>').problems.length > 0,
    'unknown element',
  );
  assert.ok(checkIcon('stroke', '<script/>').problems.length > 0, 'script');
  assert.ok(checkIcon('fill', '<path d="M4 4h6v6"/>').problems.length > 0, 'fill must be closed');
  assert.deepEqual(checkIcon('fill', '<path d="M4 4h6v6Z"/>').problems, []);
  assert.deepEqual(checkIcon('stroke', '<path d="M3 3 21 21"/>').problems, []);
});

test('path parsing and bounds', () => {
  assert.deepEqual(parsePath('M1 2l3 4'), [
    { cmd: 'M', args: [1, 2] },
    { cmd: 'l', args: [3, 4] },
  ]);
  // Extra pairs after M are implicit lines; compact arc flags are read one character each.
  assert.deepEqual(
    parsePath('M0 0 1 1').map((s) => s.cmd),
    ['M', 'L'],
  );
  assert.deepEqual(
    parsePath('M0 0a1 1 0 011 1').map((s) => s.args),
    [
      [0, 0],
      [1, 1, 0, 0, 1, 1, 1],
    ],
  );
  const circle = pathInfo('M2 12a10 10 0 0 1 20 0a10 10 0 0 1-20 0Z');
  assert.ok(Math.abs(circle.box.minY - 2) < 0.01 && Math.abs(circle.box.maxY - 22) < 0.01);
  assert.equal(circle.closedSubpaths, 1);
});

test('sizes: named, numeric and unusable values', () => {
  assert.deepEqual(
    [iconPixels('sm'), iconPixels('md'), iconPixels('lg'), iconPixels('xl')],
    [14, 16, 20, 24],
  );
  assert.equal(iconPixels(undefined), 16);
  assert.equal(iconPixels(18), 18);
  assert.equal(iconPixels(0), 16);
  assert.equal(iconPixels(-3), 16);
  assert.equal(iconPixels(Number.NaN), 16);
});

test('every store and platform mark is generic, exists and is declared in THIRD_PARTY_NOTICES.md', () => {
  const notices = readFileSync(
    new URL('../../../../THIRD_PARTY_NOTICES.md', import.meta.url),
    'utf8',
  );
  for (const [name, represents] of Object.entries(genericBrandIcons)) {
    assert.ok(isIconName(name), `${name} is not a registered icon`);
    assert.ok(represents.length > 0);
    assert.ok(notices.includes(`\`${name}\``), `THIRD_PARTY_NOTICES.md does not mention ${name}`);
  }
  assert.match(notices, /not\s+affiliated/i);
  assert.match(notices, /trademarks?\s+of\s+their\s+(respective\s+)?owners/i);
});
