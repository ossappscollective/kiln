import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkListing } from '../insights/listing-checks.ts';
import {
  type DraftContent,
  type DraftLocale,
  type DraftSet,
  draftTextFields,
  evaluateDraftContent,
  predictDraft,
  reconcileBlockers,
} from './draft-readiness.ts';

const IPHONE_65 = { width: 1242, height: 2688 };
const IPAD_13 = { width: 2064, height: 2752 };
const PHONE = { width: 1080, height: 1920 };

const shots = (n: number, size = IPHONE_65) => Array.from({ length: n }, () => ({ ...size }));
const iphone = (n: number): DraftSet => ({
  kind: 'screenshot',
  device: 'iphone_6_5',
  target: 'group-iphone-65',
  images: shots(n),
});
const ipad = (n: number): DraftSet => ({
  kind: 'screenshot',
  device: 'ipad_13',
  target: 'group-ipad-13',
  images: shots(n, IPAD_13),
});
const filled = {
  description: 'A long enough description of the app.',
  keywords: 'one,two',
  promotional_text: null,
  release_notes: null,
  marketing_url: null,
  support_url: 'https://example.com/support',
};
const empty = {
  description: null,
  keywords: '  ',
  promotional_text: null,
  release_notes: null,
  marketing_url: null,
  support_url: '',
};
const locale = (
  code: string,
  text: Record<string, string | null>,
  assets: DraftSet[] = [],
): DraftLocale => ({ locale: code, text, assets });
const apple = (...locales: DraftLocale[]): DraftContent => ({ store: 'app_store', locales });
const codes = (content: DraftContent) =>
  evaluateDraftContent(content)
    .filter((f) => f.severity === 'blocking')
    .map((f) => `${f.code}${f.locale ? `:${f.locale}` : ''}${f.item ? `:${f.item}` : ''}`);

test('a complete draft has nothing that blocks', () => {
  assert.deepEqual(codes(apple(locale('en-US', filled, [iphone(3)]))), []);
});

test('no locale at all blocks, and is the only finding', () => {
  assert.deepEqual(
    evaluateDraftContent(apple()).map((f) => f.code),
    ['no_locales'],
  );
});

test('an empty required text blocks per locale and field, with the same sentence as the store check', () => {
  const found = evaluateDraftContent(
    apple(locale('en-US', filled, [iphone(1)]), locale('fr-FR', empty, [iphone(1)])),
  ).filter((f) => f.code === 'missing_text');
  assert.deepEqual(
    found.map((f) => [f.severity, f.locale, f.item, f.message]),
    [
      ['blocking', 'fr-FR', 'description', 'Description is empty in fr-FR.'],
      ['blocking', 'fr-FR', 'keywords', 'Keywords is empty in fr-FR.'],
      ['blocking', 'fr-FR', 'support_url', 'Support URL is empty in fr-FR.'],
    ],
  );
  assert.deepEqual(found[0]?.params, {
    field: 'description',
    label: 'Description',
    locale: 'fr-FR',
    source: 'store_draft',
  });
});

test('an optional empty field is not a finding; a field the store does not hold is not asked for', () => {
  assert.deepEqual(
    codes(apple(locale('en-US', { ...filled, marketing_url: '' }, [iphone(1)]))),
    [],
  );
  assert.deepEqual(
    codes(apple(locale('en-US', { description: 'Fine and long enough.' }, [iphone(1)]))),
    [],
  );
});

test('a required field whose requirement is unverified is only a warning', () => {
  const found = evaluateDraftContent({
    store: 'google_play',
    locales: [
      locale(
        'en-US',
        { title: '', short_description: 'Short', full_description: 'Full', video: null },
        [
          {
            kind: 'screenshot',
            device: 'phone',
            target: 'phoneScreenshots',
            images: shots(2, PHONE),
          },
        ],
      ),
    ],
  }).filter((f) => f.code === 'missing_text');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, 'warning');
  assert.equal(found[0]?.verified, false);
  assert.match(found[0]?.message ?? '', /UNVERIFIED/);
});

test('no screenshot in any locale blocks; a locale without its own is a warning only', () => {
  const none = evaluateDraftContent(apple(locale('en-US', filled)));
  assert.deepEqual(
    none.map((f) => [f.code, f.severity]),
    [
      ['locale_without_screenshots', 'warning'],
      ['no_screenshots', 'blocking'],
    ],
  );
  const some = evaluateDraftContent(
    apple(locale('en-US', filled, [iphone(1)]), locale('de-DE', filled)),
  );
  assert.deepEqual(
    some.map((f) => [f.code, f.severity, f.locale]),
    [['locale_without_screenshots', 'warning', 'de-DE']],
  );
});

test('more screenshots than a device size allows blocks, with the documented sentence and the count', () => {
  const found = evaluateDraftContent(apple(locale('en-US', filled, [iphone(2), ipad(12)])));
  const over = found.filter((f) => f.code === 'asset_spec');
  assert.equal(over.length, 1);
  assert.equal(over[0]?.severity, 'blocking');
  assert.equal(over[0]?.rule, 'apple.screenshot.count');
  assert.equal(
    over[0]?.message,
    'At most 10 screenshots per device size. en-US iPad 13" / 12.9" (group-ipad-13): 12 found.',
  );
  assert.equal(evaluateDraftContent(apple(locale('en-US', filled, [ipad(10)]))).length, 0);
});

test('a screenshot that is not a size of its display blocks; one whose size is unknown does not', () => {
  const wrong: DraftSet = { ...iphone(1), images: [{ width: 100, height: 100 }] };
  assert.deepEqual(codes(apple(locale('en-US', filled, [wrong]))), [
    'asset_spec:en-US:en-US/screenshot/iphone_6_5#1',
  ]);
  const unknown: DraftSet = { ...iphone(1), images: [{ width: null, height: null }] };
  assert.deepEqual(codes(apple(locale('en-US', filled, [unknown]))), []);
});

test('Google Play: 8 screenshots per device type, the feature graphic size, the notes length; the texts are warnings until Google says they are required', () => {
  const play = (assets: DraftSet[], notes?: string): DraftContent => ({
    store: 'google_play',
    locales: [
      locale(
        'en-US',
        { title: 'Name', short_description: 'Short', full_description: '', video: null },
        assets,
      ),
    ],
    releaseNotes: notes === undefined ? [] : [{ locale: 'en-US', text: notes }],
  });
  const phone = (n: number): DraftSet => ({
    kind: 'screenshot',
    device: 'phone',
    target: 'phoneScreenshots',
    images: shots(n, PHONE),
  });
  const feature = (width: number, height: number): DraftSet => ({
    kind: 'feature_graphic',
    device: null,
    target: 'featureGraphic',
    images: [{ width, height }],
  });
  const found = evaluateDraftContent(play([phone(9), feature(1000, 500)], 'x'.repeat(501)));
  assert.deepEqual(
    found.map((f) => [f.severity, f.rule ?? f.code]),
    [
      ['warning', 'missing_text'],
      ['blocking', 'play.release_notes.length'],
      ['blocking', 'play.screenshot.count'],
      ['blocking', 'play.feature_graphic.size'],
    ],
  );
  assert.equal(found.find((f) => f.rule === 'play.release_notes.length')?.params?.count, 501);
  assert.deepEqual(
    evaluateDraftContent(play([phone(8), feature(1024, 500)], 'x'.repeat(500))).map((f) => f.code),
    ['missing_text'],
  );
});

test('the required fields are the ones the live listing check calls empty problems', () => {
  const live = checkListing({
    store: 'app_store',
    locales: [
      {
        locale: 'en-US',
        fields: { description: '', keywords: 'a,b', support_url: 'https://x.test' },
      },
    ],
  });
  const empties = (live.locales[0]?.issues ?? [])
    .filter((i) => i.code === 'empty' && i.severity === 'problem')
    .map((i) => i.field);
  const mine = evaluateDraftContent(
    apple(locale('en-US', { ...filled, description: '' }, [iphone(1)])),
  )
    .filter((f) => f.code === 'missing_text' && f.severity === 'blocking')
    .map((f) => f.item);
  assert.ok(empties.indexOf('description') >= 0, JSON.stringify(live.locales));
  assert.deepEqual(mine, ['description']);
});

// ---------------------------------------------------------------------------------------------
// predictDraft

const store = (): DraftContent =>
  apple(locale('en-US', filled, [iphone(3), ipad(12)]), locale('fr-FR', empty, [iphone(1)]));

test('predictDraft: staged texts are written over the store, the rest is kept, the input is not touched', () => {
  const before = JSON.stringify(store());
  const current = store();
  const next = predictDraft(current, {
    texts: [
      { locale: 'fr-FR', field: 'description', value: 'Une description assez longue.' },
      { locale: 'fr-FR', field: 'keywords', value: 'un,deux' },
    ],
    sets: [],
  });
  assert.equal(JSON.stringify(current), before);
  assert.deepEqual(
    evaluateDraftContent(next)
      .filter((f) => f.code === 'missing_text')
      .map((f) => `${f.locale}:${f.item}`),
    ['fr-FR:support_url'],
  );
});

test('predictDraft: a staged set replaces the set of the same device, so a push can fix a count', () => {
  const next = predictDraft(store(), {
    texts: [],
    sets: [
      {
        locale: 'en-US',
        kind: 'screenshot',
        device: 'ipad_13',
        target: 'APP_IPAD_PRO_3GEN_129',
        images: shots(4, IPAD_13),
      },
    ],
  });
  const en = next.locales.filter((l) => l.locale === 'en-US')[0] as DraftLocale;
  assert.equal(en.assets.length, 2);
  assert.equal(en.assets.filter((s) => s.device === 'ipad_13')[0]?.images.length, 4);
  assert.equal(en.assets.filter((s) => s.device === 'ipad_13')[0]?.target, 'group-ipad-13');
  assert.equal(evaluateDraftContent(next).filter((f) => f.code === 'asset_spec').length, 0);
});

test('predictDraft: a staged set matched by its group, a new set added, a cleared set removed', () => {
  const next = predictDraft(store(), {
    texts: [],
    sets: [
      {
        locale: 'en-US',
        kind: 'screenshot',
        device: null,
        target: 'APP_IPAD_PRO_3GEN_129',
        group: 'group-ipad-13',
        images: shots(2, IPAD_13),
      },
      {
        locale: 'fr-FR',
        kind: 'screenshot',
        device: 'ipad_13',
        target: 'APP_IPAD_PRO_3GEN_129',
        group: 'group-new',
        images: shots(2, IPAD_13),
      },
      { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5', target: 'x', images: [] },
    ],
  });
  const en = next.locales[0] as DraftLocale;
  assert.deepEqual(
    en.assets.map((s) => [s.device, s.images.length]),
    [['ipad_13', 2]],
  );
  const fr = next.locales[1] as DraftLocale;
  assert.deepEqual(
    fr.assets.map((s) => [s.target, s.images.length]),
    [
      ['group-iphone-65', 1],
      ['group-new', 2],
    ],
  );
});

test('predictDraft: a locale the store does not have is created with every text empty but the staged ones', () => {
  const next = predictDraft(apple(locale('en-US', filled, [iphone(1)])), {
    texts: [{ locale: 'de-DE', field: 'description', value: 'Eine lange Beschreibung hier.' }],
    sets: [],
  });
  assert.deepEqual(
    next.locales.map((l) => l.locale),
    ['en-US', 'de-DE'],
  );
  assert.deepEqual(
    Object.keys((next.locales[1] as DraftLocale).text).sort(),
    draftTextFields('app_store').sort(),
  );
  assert.deepEqual(
    evaluateDraftContent(next)
      .filter((f) => f.code === 'missing_text')
      .map((f) => `${f.locale}:${f.item}`),
    ['de-DE:keywords', 'de-DE:support_url'],
  );
});

test('predictDraft: a field the store does not hold for this platform is ignored; Play notes are replaced or cleared', () => {
  const current: DraftContent = {
    store: 'google_play',
    locales: [
      locale('en-US', { title: 'T', short_description: 'S', full_description: 'F', video: null }),
    ],
    releaseNotes: [
      { locale: 'en-US', text: 'old' },
      { locale: 'fr-FR', text: 'ancien' },
    ],
  };
  const next = predictDraft(current, {
    texts: [{ locale: 'en-US', field: 'keywords', value: 'ignored' }],
    sets: [],
    releaseNotes: [
      { locale: 'en-US', value: 'y'.repeat(501) },
      { locale: 'fr-FR', value: '' },
      { locale: 'de-DE', value: 'neu' },
    ],
  });
  assert.equal('keywords' in (next.locales[0] as DraftLocale).text, false);
  assert.deepEqual(
    (next.releaseNotes ?? []).map((n) => [n.locale, n.text.length]),
    [
      ['en-US', 501],
      ['de-DE', 3],
    ],
  );
  assert.ok(evaluateDraftContent(next).some((f) => f.code === 'release_notes_too_long'));
});

test('the user case: fr-FR description, keywords and support URL empty and 12 screenshots on iPad 13 are four blockers', () => {
  const next = predictDraft(store(), {
    texts: [],
    sets: [
      {
        locale: 'en-US',
        kind: 'screenshot',
        device: 'iphone_6_5',
        target: 'APP_IPHONE_65',
        images: shots(3),
      },
    ],
  });
  assert.deepEqual(codes(next), [
    'missing_text:fr-FR:description',
    'missing_text:fr-FR:keywords',
    'missing_text:fr-FR:support_url',
    'asset_spec:en-US:apple.screenshot.count:group-ipad-13',
  ]);
});

// ---------------------------------------------------------------------------------------------
// Counting per set (a display type), never per device size across sets

const ipadSet = (target: string, n: number): DraftSet => ({
  kind: 'screenshot',
  device: 'ipad_13',
  target,
  images: shots(n, IPAD_13),
});
const countProblems = (content: DraftContent) =>
  evaluateDraftContent(content).filter((f) => f.rule === 'apple.screenshot.count');

test('10 in the 13" display type and 2 in the sibling 12.9" type are NOT summed: each set counts against its own 10', () => {
  const content = apple(
    locale('en-US', filled, [ipadSet('APP_IPAD_PRO_3GEN_129', 10), ipadSet('APP_IPAD_PRO_129', 2)]),
  );
  assert.deepEqual(countProblems(content), []);
});

test('12 in ONE display type is flagged, and the sentence says which display type is over and by how much', () => {
  const content = apple(
    locale('en-US', filled, [ipadSet('APP_IPAD_PRO_3GEN_129', 12), ipadSet('APP_IPAD_PRO_129', 2)]),
  );
  const over = countProblems(content);
  assert.equal(over.length, 1);
  assert.equal(over[0]?.severity, 'blocking');
  assert.match(over[0]?.message ?? '', /\(APP_IPAD_PRO_3GEN_129\): 12 found\.$/);
  assert.deepEqual(over[0]?.params, {
    count: 12,
    max: 10,
    device: 'ipad_13',
    set: 'APP_IPAD_PRO_3GEN_129',
  });
});

test('two sets over their own limit are two findings, one per display type', () => {
  const content = apple(
    locale('en-US', filled, [
      ipadSet('APP_IPAD_PRO_3GEN_129', 11),
      ipadSet('APP_IPAD_PRO_129', 12),
    ]),
  );
  assert.deepEqual(
    countProblems(content).map((f) => f.item),
    ['apple.screenshot.count:APP_IPAD_PRO_129', 'apple.screenshot.count:APP_IPAD_PRO_3GEN_129'],
  );
});

test('the same display in two locales is counted per locale', () => {
  const content = apple(
    locale('en-US', filled, [ipadSet('APP_IPAD_PRO_3GEN_129', 10)]),
    locale('fr-FR', filled, [ipadSet('APP_IPAD_PRO_3GEN_129', 10)]),
  );
  assert.deepEqual(countProblems(content), []);
});

test('Google Play counts per device type as before (no store set is named)', () => {
  const play: DraftContent = {
    store: 'google_play',
    locales: [
      locale('en-US', {}, [
        {
          kind: 'screenshot',
          device: 'phone',
          target: 'phoneScreenshots',
          images: shots(9, PHONE),
        },
      ]),
    ],
  };
  const over = evaluateDraftContent(play).filter((f) => f.rule === 'play.screenshot.count');
  assert.equal(over.length, 1);
  assert.doesNotMatch(over[0]?.message ?? '', /\(/);
});

test('predictDraft: a push that removes screenshots leaves the staged set only; a sibling group of the same display goes with it', () => {
  const current = apple(
    locale('en-US', filled, [ipadSet('APP_IPAD_PRO_3GEN_129', 12), ipadSet('APP_IPAD_PRO_129', 2)]),
  );
  const next = predictDraft(current, {
    texts: [],
    sets: [
      {
        locale: 'en-US',
        kind: 'screenshot',
        device: 'ipad_13',
        target: 'ipad_13',
        group: 'APP_IPAD_PRO_3GEN_129',
        images: shots(10, IPAD_13),
      },
    ],
  });
  const sets = next.locales[0]?.assets ?? [];
  assert.equal(sets.length, 1);
  assert.equal(sets[0]?.target, 'APP_IPAD_PRO_3GEN_129');
  assert.equal(sets[0]?.images.length, 10);
  assert.deepEqual(countProblems(next), []);
  // The input is not touched.
  assert.equal(current.locales[0]?.assets.length, 2);
});

test('predictDraft: staged removals applied: clearing the set of a display removes every set that shows it', () => {
  const current = apple(locale('en-US', filled, [ipadSet('APP_IPAD_PRO_3GEN_129', 12), iphone(3)]));
  const next = predictDraft(current, {
    texts: [],
    sets: [
      { locale: 'en-US', kind: 'screenshot', device: 'ipad_13', target: 'ipad_13', images: [] },
    ],
  });
  assert.deepEqual(
    (next.locales[0]?.assets ?? []).map((a) => a.target),
    ['group-iphone-65'],
  );
});

test('reconcileBlockers: what an earlier reading said and no longer holds is resolved; the current list is what to show', () => {
  const earlier = [
    { code: 'asset_spec', locale: 'en-US', item: 'apple.screenshot.count' },
    { code: 'missing_text', locale: 'fr-FR', item: 'description' },
  ];
  const now = [{ code: 'missing_text', locale: 'fr-FR', item: 'description' }];
  const r = reconcileBlockers(earlier, now);
  assert.deepEqual(r.resolved, [earlier[0]]);
  assert.deepEqual(r.remaining, now);
  assert.deepEqual(r.added, []);
  const none = reconcileBlockers(earlier, []);
  assert.equal(none.resolved.length, 2);
  assert.equal(none.remaining.length, 0);
});

test('reconcileBlockers: a count blocker that names its set is the same blocker as the older one without it; a new one is added', () => {
  const r = reconcileBlockers(
    [{ code: 'asset_spec', locale: 'en-US', item: 'apple.screenshot.count' }],
    [
      { code: 'asset_spec', locale: 'en-US', item: 'apple.screenshot.count:APP_IPAD_PRO_129' },
      { code: 'no_build' },
    ],
  );
  assert.equal(r.resolved.length, 0);
  assert.deepEqual(
    r.added.map((b) => b.code),
    ['no_build'],
  );
});

test('readiness has the text length and URL checks of the one text check: the same severity as validateListing', () => {
  const locale: DraftLocale = {
    locale: 'en-US',
    text: {
      ...filled,
      description: 'd'.repeat(4001),
      support_url: 'not a url',
      keywords: 'k'.repeat(101),
    },
    assets: [iphone(3)],
  };
  const found = evaluateDraftContent({ store: 'app_store', locales: [locale] }).filter(
    (f) => f.code === 'text_problem',
  );
  const by = (field: string) => found.find((f) => f.item === field);
  assert.equal(by('description')?.severity, 'blocking');
  assert.equal(by('keywords')?.severity, 'blocking');
  assert.equal(by('support_url')?.severity, 'blocking');
  assert.equal(by('description')?.params?.limit, 4000);
});

test('an empty iOS keywords field blocks the submit and is a problem in the Insights checks (one severity)', () => {
  const locale: DraftLocale = {
    locale: 'en-US',
    text: { ...filled, keywords: '' },
    assets: [iphone(3)],
  };
  const missing = evaluateDraftContent({ store: 'app_store', locales: [locale] }).find(
    (f) => f.code === 'missing_text' && f.item === 'keywords',
  );
  assert.equal(missing?.severity, 'blocking');
  const checks = checkListing({
    store: 'app_store',
    locales: [
      {
        locale: 'en-US',
        fields: { name: 'App', subtitle: 'S', description: filled.description, keywords: '' },
      },
    ],
  });
  assert.equal(
    checks.locales[0]?.issues.find((i) => i.code === 'empty' && i.field === 'keywords')?.severity,
    'problem',
  );
});

test('the locales of a draft are the store draft locales plus the staged ones, and every finding says which', () => {
  const empty = { description: '', keywords: '', support_url: '' };
  const store: DraftContent = {
    store: 'app_store',
    version: '2.00.1',
    locales: [
      { locale: 'en-US', origin: 'store', text: { ...filled }, assets: [iphone(3)] },
      { locale: 'fr-FR', origin: 'store', text: { ...filled, ...empty }, assets: [iphone(3)] },
    ],
  };
  const missing = (c: DraftContent) =>
    evaluateDraftContent(c).filter((f) => f.code === 'missing_text');
  const fromStore = missing(store);
  assert.equal(fromStore.length, 3);
  for (const f of fromStore) {
    assert.equal(f.locale, 'fr-FR');
    assert.equal(f.params?.source, 'store_draft');
    assert.equal(f.params?.version, '2.00.1');
  }
  // Nothing else makes a locale: a store with en-US only judges en-US only, whatever else exists elsewhere.
  const only = { ...store, locales: [store.locales[0] as DraftLocale] };
  assert.deepEqual(missing(only), []);
  assert.deepEqual(
    predictDraft(only, { texts: [], sets: [] }).locales.map((l) => l.locale),
    ['en-US'],
  );
  // A staged text for a locale the store lacks adds it, as staged.
  const staged = predictDraft(only, {
    texts: [{ locale: 'de-DE', field: 'description', value: 'Hallo' }],
    sets: [],
  });
  const de = missing(staged).filter((f) => f.locale === 'de-DE');
  assert.ok(de.length > 0);
  assert.ok(de.every((f) => f.params?.source === 'staged'));
  // A staged text for a locale the store has keeps it a store locale.
  const kept = predictDraft(store, {
    texts: [{ locale: 'fr-FR', field: 'description', value: 'Bonjour' }],
    sets: [],
  });
  assert.ok(missing(kept).every((f) => f.params?.source === 'store_draft'));
});
