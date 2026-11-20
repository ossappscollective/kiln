import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPLE_DISPLAYS,
  ASSET_RULES,
  type AssetFacts,
  type AssetStore,
  classifyApplePreviewName,
  classifyAppleScreenshot,
  deviceLabel,
  PLAY_DEVICES,
  summarizeAssets,
  validateAssets,
} from './store-asset-specs.ts';

const facts = (store: AssetStore, extra: Partial<AssetFacts>): AssetFacts => ({
  path: 'fastlane/metadata/x.png',
  store,
  locale: 'en-US',
  kind: 'screenshot',
  device: null,
  order: 1,
  bytes: 100_000,
  width: 1080,
  height: 1920,
  format: 'png',
  extension: 'png',
  hasAlpha: false,
  read: 'read',
  ...extra,
});

const rules = (store: AssetStore, assets: AssetFacts[]) =>
  validateAssets(store, assets).map((p) => `${p.severity}:${p.rule}`);

test('every Apple display size classifies to its own display, except the two shared sizes', () => {
  for (const display of APPLE_DISPLAYS) {
    for (const [w, h] of display.sizes) {
      const found = classifyAppleScreenshot(w, h);
      if (w === 3840 && h === 2160) assert.equal(found, 'apple_tv');
      else assert.equal(found, display.id, `${display.id} ${w}x${h}`);
    }
  }
  assert.equal(classifyAppleScreenshot(3840, 2160, 'screenshots/en-US/vision_1.png'), 'vision_pro');
  assert.equal(classifyAppleScreenshot(1290, 2796), 'iphone_6_9');
  assert.equal(classifyAppleScreenshot(2796, 1290), 'iphone_6_9', 'landscape');
  assert.equal(classifyAppleScreenshot(2048, 2732), 'ipad_13');
  assert.equal(classifyAppleScreenshot(1080, 1920), null, 'a Play phone size is no App Store size');
  assert.equal(classifyAppleScreenshot(0, 0), null);
});

test('the sizes of the Apple page, spot checked against the page', () => {
  const sizes = (id: string) =>
    APPLE_DISPLAYS.find((d) => d.id === id)
      ?.sizes.map((s) => s.join('x'))
      .sort();
  assert.deepEqual(sizes('iphone_4_7'), ['1334x750', '750x1334']);
  assert.deepEqual(sizes('mac'), ['1280x800', '1440x900', '2560x1600', '2880x1800']);
  assert.ok(sizes('watch')?.includes('422x514'));
  assert.ok(sizes('watch')?.includes('312x390'));
  assert.ok(sizes('iphone_duo')?.includes('2853x2007'));
  // Display ids are unique and no size belongs to two displays but the TV pair.
  assert.equal(new Set(APPLE_DISPLAYS.map((d) => d.id)).size, APPLE_DISPLAYS.length);
  const seen = new Map<string, string>();
  for (const d of APPLE_DISPLAYS) {
    for (const s of d.sizes) {
      const key = s.join('x');
      if (seen.has(key)) assert.equal(key, '3840x2160', `${key}: ${seen.get(key)} and ${d.id}`);
      seen.set(key, d.id);
    }
  }
});

test('preview device names follow fastlane deliver', () => {
  const table: [string, string | null][] = [
    ['1_APP_IPHONE_67_en.mov', 'iphone_6_9'],
    ['IPAD_PRO_129_demo.mp4', 'ipad_13'],
    ['desktop.mov', 'mac'],
    ['preview.mov', null],
  ];
  for (const [name, expected] of table)
    assert.equal(classifyApplePreviewName(name), expected, name);
});

test('App Store screenshots: format, alpha, size and counts', () => {
  const ok = facts('app_store', {
    device: 'iphone_6_9',
    width: 1290,
    height: 2796,
    format: 'jpeg',
    extension: 'jpg',
  });
  assert.deepEqual(rules('app_store', [ok]), []);
  const table: [string, Partial<AssetFacts>, string][] = [
    ['alpha', { device: 'iphone_6_9', hasAlpha: true }, 'error:apple.screenshot.alpha'],
    [
      'webp',
      { device: 'iphone_6_9', format: 'webp', extension: 'webp' },
      'error:apple.screenshot.format',
    ],
    [
      'gif by name',
      { device: 'iphone_6_9', format: null, extension: 'gif' },
      'error:apple.screenshot.format',
    ],
    ['unknown size', { device: null, width: 1000, height: 1000 }, 'error:apple.screenshot.size'],
    [
      'png named jpg',
      { device: 'iphone_6_9', format: 'png', extension: 'jpg' },
      'warning:inspect.extension',
    ],
    [
      'unread',
      { device: null, width: null, height: null, format: null, read: 'not_read' },
      'info:inspect.unread',
    ],
    [
      'too large to read',
      { device: null, width: null, height: null, format: null, read: 'too_large' },
      'info:inspect.unread',
    ],
  ];
  for (const [name, extra, expected] of table) {
    assert.deepEqual(
      rules('app_store', [facts('app_store', { width: 1290, height: 2796, ...extra })]),
      [expected],
      name,
    );
  }
  const eleven = Array.from({ length: 11 }, (_, i) =>
    facts('app_store', {
      device: 'iphone_6_9',
      path: `s/${i}.png`,
      order: i + 1,
      width: 1290,
      height: 2796,
    }),
  );
  assert.deepEqual(rules('app_store', eleven), ['error:apple.screenshot.count']);
  assert.deepEqual(rules('app_store', eleven.slice(0, 10)), []);
  // Ten on the iPhone and ten on the iPad are two sets.
  const two = [
    ...eleven.slice(0, 10),
    ...eleven
      .slice(0, 10)
      .map((a, i) => ({ ...a, device: 'ipad_13', width: 2064, height: 2752, path: `i/${i}.png` })),
  ];
  assert.deepEqual(rules('app_store', two), []);
  // A file put in a display's set must have one of that display's sizes (a set made by hand, an upload).
  assert.deepEqual(
    rules('app_store', [facts('app_store', { device: 'ipad_13', width: 1290, height: 2796 })]),
    ['error:apple.screenshot.size'],
  );
  assert.deepEqual(
    rules('app_store', [
      facts('app_store', { device: 'imessage:iphone_6_9', width: 2796, height: 1290 }),
    ]),
    [],
    'landscape is a size of the display too',
  );
  // Another locale is another set.
  const split = [...eleven.slice(0, 6), ...eleven.slice(6).map((a) => ({ ...a, locale: 'fr-FR' }))];
  assert.deepEqual(rules('app_store', split), []);
});

test('App Store icon: 1024 px is a verified rule, alpha is only information', () => {
  const icon = facts('app_store', { kind: 'app_icon', width: 1024, height: 1024 });
  assert.deepEqual(rules('app_store', [icon]), []);
  assert.deepEqual(rules('app_store', [{ ...icon, width: 512, height: 512 }]), [
    'error:apple.icon.size',
  ]);
  const alpha = validateAssets('app_store', [{ ...icon, hasAlpha: true }]);
  assert.deepEqual(
    alpha.map((p) => [p.rule, p.severity, p.verified]),
    [['apple.icon.alpha', 'info', false]],
  );
  assert.match(alpha[0]?.message ?? '', /UNVERIFIED/);
});

test('App previews: listed, with the extension, size and count rules', () => {
  const preview = (n: number, extra: Partial<AssetFacts> = {}) =>
    facts('app_store', {
      kind: 'preview',
      device: 'iphone_6_9',
      path: `p/${n}.mov`,
      extension: 'mov',
      format: 'video',
      read: 'not_read',
      width: null,
      height: null,
      hasAlpha: null,
      ...extra,
    });
  assert.deepEqual(rules('app_store', [preview(1), preview(2), preview(3)]), []);
  assert.deepEqual(rules('app_store', [preview(1), preview(2), preview(3), preview(4)]), [
    'error:apple.preview.count',
  ]);
  assert.deepEqual(rules('app_store', [preview(1, { extension: 'avi' })]), [
    'error:apple.preview.format',
  ]);
  assert.deepEqual(rules('app_store', [preview(1, { bytes: 501 * 1024 * 1024 })]), [
    'error:apple.preview.bytes',
  ]);
});

test('Google Play icon', () => {
  const icon = facts('google_play', { kind: 'icon', width: 512, height: 512, hasAlpha: true });
  assert.deepEqual(rules('google_play', [icon]), [], 'alpha is allowed on the icon');
  const table: [string, Partial<AssetFacts>, string][] = [
    ['size', { width: 1024, height: 1024 }, 'error:play.icon.size'],
    ['jpeg', { format: 'jpeg', extension: 'jpg' }, 'error:play.icon.format'],
    ['over 1024 KB', { bytes: 1024 * 1024 + 1 }, 'error:play.icon.bytes'],
  ];
  for (const [name, extra, expected] of table)
    assert.deepEqual(rules('google_play', [{ ...icon, ...extra }]), [expected], name);
  assert.deepEqual(
    rules('google_play', [{ ...icon, bytes: 1024 * 1024 }]),
    [],
    '1024 KB exactly is fine',
  );
});

test('Google Play feature graphic and TV banner', () => {
  const graphic = facts('google_play', { kind: 'feature_graphic', width: 1024, height: 500 });
  assert.deepEqual(rules('google_play', [graphic]), []);
  assert.deepEqual(rules('google_play', [{ ...graphic, width: 1024, height: 501 }]), [
    'error:play.feature_graphic.size',
  ]);
  assert.deepEqual(rules('google_play', [{ ...graphic, hasAlpha: true }]), [
    'error:play.feature_graphic.format',
  ]);
  assert.deepEqual(rules('google_play', [{ ...graphic, format: 'webp', extension: 'webp' }]), [
    'error:play.feature_graphic.format',
  ]);
  const banner = facts('google_play', { kind: 'tv_banner', width: 1280, height: 720 });
  const tv = facts('google_play', { device: 'tv', path: 'tv/1.png', width: 1920, height: 1080 });
  const tv2 = { ...tv, path: 'tv/2.png', order: 2 };
  assert.deepEqual(rules('google_play', [banner, tv, tv2]), []);
  assert.deepEqual(rules('google_play', [{ ...banner, width: 1920 }, tv, tv2]), [
    'error:play.tv_banner.size',
  ]);
  assert.deepEqual(rules('google_play', [banner]), ['warning:play.tv.pair']);
  assert.deepEqual(rules('google_play', [tv, tv2]), ['warning:play.tv.pair']);
});

test('Google Play screenshots: dimensions, ratio, counts and minimums', () => {
  const shot = (n: number, extra: Partial<AssetFacts> = {}) =>
    facts('google_play', {
      device: 'phone',
      path: `p/${n}.png`,
      order: n,
      width: 1080,
      height: 1920,
      ...extra,
    });
  const four = [1, 2, 3, 4].map((n) => shot(n));
  assert.deepEqual(rules('google_play', four), []);
  const table: [string, Partial<AssetFacts>, string[]][] = [
    // A small screenshot also misses the "at least four at 1080 px" recommendation.
    [
      'under 320',
      { width: 300, height: 600 },
      ['error:play.screenshot.dimension', 'info:play.screenshot.phone_promo'],
    ],
    ['over 3840', { width: 1080, height: 3841 }, ['error:play.screenshot.dimension']],
    ['more than 2:1', { width: 1080, height: 2400 }, ['error:play.screenshot.ratio']],
    ['alpha', { hasAlpha: true }, ['error:play.screenshot.format']],
    ['gif', { format: 'gif', extension: 'gif' }, ['error:play.screenshot.format']],
  ];
  for (const [name, extra, expected] of table) {
    assert.deepEqual(
      rules('google_play', [shot(1, extra), shot(2), shot(3), shot(4)]),
      expected,
      name,
    );
  }
  assert.deepEqual(
    rules('google_play', [shot(1, { width: 1080, height: 2160 }), shot(2), shot(3), shot(4)]),
    [],
    '2:1 exactly is allowed',
  );
  assert.deepEqual(
    rules(
      'google_play',
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => shot(n)),
    ),
    ['error:play.screenshot.count'],
  );
  assert.deepEqual(
    rules(
      'google_play',
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => shot(n)),
    ),
    [],
  );
  // A locale with one screenshot cannot be published; three phone screenshots miss the "highly recommended" four.
  assert.deepEqual(rules('google_play', [shot(1)]).sort(), [
    'info:play.screenshot.phone_promo',
    'warning:play.screenshot.minimum',
  ]);
  assert.deepEqual(rules('google_play', [shot(1), shot(2), shot(3)]), [
    'info:play.screenshot.phone_promo',
  ]);
  assert.deepEqual(
    rules(
      'google_play',
      [1, 2, 3, 4].map((n) => shot(n, { width: 720, height: 1280 })),
    ),
    ['info:play.screenshot.phone_promo'],
  );
});

test('Google Play tablets and Wear OS', () => {
  const tablet = (n: number, extra: Partial<AssetFacts> = {}) =>
    facts('google_play', {
      device: 'tablet_10',
      path: `t/${n}.png`,
      order: n,
      width: 1920,
      height: 1080,
      ...extra,
    });
  assert.deepEqual(
    rules(
      'google_play',
      [1, 2, 3, 4].map((n) => tablet(n)),
    ),
    [],
  );
  assert.deepEqual(
    rules(
      'google_play',
      [1, 2, 3].map((n) => tablet(n)),
    ),
    ['info:play.screenshot.large_screen'],
  );
  assert.deepEqual(
    rules(
      'google_play',
      [1, 2, 3, 4].map((n) => tablet(n, { width: 1600, height: 1200 })),
    ),
    ['info:play.screenshot.large_screen'],
  );
  const wear = (extra: Partial<AssetFacts>) =>
    facts('google_play', { device: 'wear', path: 'w/1.png', width: 400, height: 400, ...extra });
  assert.deepEqual(rules('google_play', [wear({}), wear({ path: 'w/2.png' })]), []);
  // 300 px is under the 320 px floor of every screenshot as well.
  assert.deepEqual(
    rules('google_play', [
      wear({ width: 384, height: 384 }),
      wear({ path: 'w/2.png', width: 300, height: 300 }),
    ]),
    ['error:play.screenshot.dimension', 'warning:play.screenshot.wear'],
  );
  assert.deepEqual(
    rules('google_play', [wear({ width: 400, height: 500 }), wear({ path: 'w/2.png' })]),
    ['warning:play.screenshot.wear'],
  );
});

test('the promo graphic has no verified spec and is only listed', () => {
  const found = validateAssets('google_play', [
    facts('google_play', { kind: 'promo_graphic', width: 180, height: 120 }),
  ]);
  assert.deepEqual(
    found.map((p) => [p.rule, p.severity, p.verified]),
    [['play.promo_graphic.spec', 'info', false]],
  );
});

test('every problem carries its rule text, source and verification state', () => {
  const found = validateAssets('google_play', [
    facts('google_play', { kind: 'feature_graphic', width: 10, height: 10 }),
  ]);
  assert.equal(found.length, 1);
  const p = found[0];
  assert.ok(p);
  assert.match(p.message, /^The feature graphic is 1024 px by 500 px\. It is 10x10\.$/);
  assert.match(p.source, /^https:\/\/support\.google\.com\//);
  assert.equal(p.verified, true);
  for (const rule of Object.values(ASSET_RULES)) {
    assert.match(rule.source, /^https:\/\//, rule.id);
    assert.ok(rule.text.length > 10, rule.id);
    if (!rule.verified) assert.match(rule.text, /UNVERIFIED|not stated|no requirement/i, rule.id);
  }
  // An unverified rule is never more than information, whatever severity the caller asked for.
  assert.deepEqual(
    rules('app_store', [
      facts('app_store', { kind: 'app_icon', width: 1024, height: 1024, hasAlpha: true }),
    ]),
    ['info:apple.icon.alpha'],
  );
});

test('assets of the other store are ignored, sorting puts errors first', () => {
  const play = facts('google_play', { kind: 'icon', width: 10, height: 10 });
  assert.deepEqual(rules('app_store', [play]), []);
  const mixed = validateAssets('google_play', [
    facts('google_play', { kind: 'promo_graphic', path: 'a.png' }),
    facts('google_play', { kind: 'icon', path: 'z.png', width: 1, height: 1 }),
  ]);
  assert.deepEqual(
    mixed.map((p) => p.severity),
    ['error', 'info'],
  );
});

test('summaries count per locale, kind and device with the limit of the set', () => {
  const sets = summarizeAssets('google_play', [
    facts('google_play', { device: 'phone', path: 'a' }),
    facts('google_play', { device: 'phone', path: 'b' }),
    facts('google_play', { kind: 'icon', path: 'c' }),
    facts('google_play', { device: 'wear', path: 'd', locale: 'fr-FR' }),
  ]);
  assert.deepEqual(
    sets.map((s) => [s.locale, s.kind, s.device, s.count, s.max]),
    [
      ['en-US', 'screenshot', 'phone', 2, 8],
      ['en-US', 'icon', null, 1, null],
      ['fr-FR', 'screenshot', 'wear', 1, 8],
    ],
  );
  assert.equal(deviceLabel('google_play', 'tablet_7'), '7-inch tablet');
  assert.equal(deviceLabel('app_store', 'imessage:ipad_13'), 'iMessage, iPad 13" / 12.9"');
  assert.equal(deviceLabel('app_store', null), 'Unclassified');
  assert.equal(PLAY_DEVICES.length, 5);
});

test('the checker is total: odd facts never throw', () => {
  const odd = [
    facts('app_store', { width: Number.NaN, height: Number.NaN }),
    facts('google_play', { width: -1, height: 0, kind: 'screenshot', device: 'phone' }),
    facts('google_play', {
      kind: 'screenshot',
      device: 'nope',
      width: Number.POSITIVE_INFINITY,
      height: 5,
    }),
  ];
  for (const store of ['app_store', 'google_play'] as const)
    assert.ok(Array.isArray(validateAssets(store, odd)));
});
