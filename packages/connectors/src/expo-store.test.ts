import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AppStoreListing, type Listing, listingIsValid } from '@mrm/core';
import { detectProject } from './detect.ts';
import {
  COMPACT,
  INVALID_JSON,
  MINIMAL,
  overLimit,
  STORE_PATH,
  TABS_CRLF,
  UNKNOWN_FIELDS,
  VALID,
} from './expo-store.fixtures.ts';
import {
  expoStoreChangeSet,
  ExpoStoreConfigError,
  type ExpoStoreSnapshot,
  keywordsToArray,
  loadExpoStoreConfig,
  readExpoStoreConfig,
  staticStoreConfigs,
  validateExpoStoreConfig,
} from './expo-store.ts';

const read = (text: string, expectedLocales?: string[]) =>
  readExpoStoreConfig(STORE_PATH, text, expectedLocales ? { expectedLocales } : {});

const apple = (listing: Listing): AppStoreListing => {
  assert.ok(listing.appStore);
  return listing.appStore;
};

/** A deep copy of the snapshot's listing that a test may edit. */
const edit = (snapshot: ExpoStoreSnapshot): Listing => structuredClone(snapshot.listing) as Listing;

const lines = (text: string) => text.split(/\r?\n/);

/** Applies the change and returns the new text (or the old one when there is no change). */
function apply(snapshot: ExpoStoreSnapshot, after: Listing) {
  const result = expoStoreChangeSet(snapshot, after);
  const file = result.changes[0];
  if (file) {
    assert.equal(file.path, snapshot.path);
    assert.equal(file.before, snapshot.text);
  }
  const text = file?.after ?? snapshot.text;
  // The edited file must read back to exactly what was asked for.
  const again = read(text);
  assert.equal(again.error, undefined);
  assert.deepEqual(again.listing.appStore?.locales, after.appStore?.locales);
  assert.equal(again.listing.appStore?.copyright, after.appStore?.copyright);
  return { ...result, text };
}

// ---------------------------------------------------------------------------------------------
// Reading

test('valid: maps every EAS field to the listing model', () => {
  const snapshot = read(VALID);
  assert.equal(snapshot.error, undefined);
  assert.equal(snapshot.found, true);
  assert.deepEqual(snapshot.warnings, []);
  const store = apple(snapshot.listing);
  assert.equal(store.copyright, '2026 Example, Inc.');
  assert.deepEqual(store.locales['en-US'], {
    name: 'Trail Notes',
    subtitle: 'Hike, log, share',
    description: 'Log every hike.\n\nShare it with friends.',
    keywords: 'hiking,trail,gps',
    release_notes: 'Bug fixes.',
    promotional_text: 'New: offline maps.',
    marketing_url: 'https://example.com/promo',
    support_url: 'https://example.com/support',
    privacy_url: 'https://example.com/privacy',
  });
  assert.equal(store.locales['de-DE']?.name, 'Wegnotizen');
  assert.equal(snapshot.listing.googlePlay, undefined);
  assert.deepEqual(validateExpoStoreConfig(snapshot), []);
});

test('minimal: the docs example reads, and only the missing copyright is a problem', () => {
  const snapshot = read(MINIMAL);
  assert.deepEqual(snapshot.warnings, []);
  assert.deepEqual(apple(snapshot.listing).locales['en-US']?.keywords, 'awesome,app');
  const problems = validateExpoStoreConfig(snapshot);
  assert.deepEqual(
    problems.map((p) => `${p.field}:${p.code}:${p.severity}`),
    ['copyright:missing_required:error'],
  );
  assert.equal(listingIsValid(problems), false);
});

test('unknown fields: reported, never part of the model', () => {
  const snapshot = read(UNKNOWN_FIELDS);
  assert.equal(snapshot.error, undefined);
  assert.deepEqual(snapshot.uncovered, [
    'apple.version',
    'apple.release',
    'apple.review',
    'apple.categories',
    'apple.info.en-US.privacyChoicesUrl',
    'apple.info.en-US.screenshots',
  ]);
  assert.deepEqual(snapshot.unknown, [
    'notes',
    'apple.futureFlag',
    'apple.info.en-US.mystery',
    'apple.info.xx-YY',
  ]);
  assert.equal(snapshot.warnings.length, 2);
  assert.match(snapshot.warnings[0] ?? '', /Not part of the listing model.*apple\.review/);
  assert.match(snapshot.warnings[1] ?? '', /Not in the EAS Metadata schema.*apple\.futureFlag/);
  assert.deepEqual(Object.keys(apple(snapshot.listing).locales), ['en-US']);
});

test('invalid JSON: an error and an empty listing, no throw on read', () => {
  const snapshot = read(INVALID_JSON);
  assert.match(snapshot.error ?? '', /not valid JSON/);
  assert.deepEqual(snapshot.listing, {});
  assert.equal(snapshot.found, false);
  assert.deepEqual(validateExpoStoreConfig(snapshot), []);
  const none: Listing = { appStore: { locales: {} } };
  assert.throws(() => expoStoreChangeSet(snapshot, none), ExpoStoreConfigError);
  assert.match(read('[1, 2]').error ?? '', /not a JSON object/);
  assert.match(read('').error ?? '', /not valid JSON/);
});

test('over limit: every limit from core is reported against the right locale and field', () => {
  const snapshot = read(overLimit());
  assert.deepEqual(snapshot.warnings, []);
  const problems = validateExpoStoreConfig(snapshot);
  const tooLong = problems.filter((p) => p.code === 'too_long');
  assert.deepEqual(
    tooLong.map((p) => [p.locale, p.field, p.limit, p.actual, p.unit, p.severity]),
    [
      ['en-US', 'name', 30, 31, 'characters', 'error'],
      ['en-US', 'subtitle', 30, 31, 'characters', 'error'],
      ['en-US', 'description', 4000, 4001, 'characters', 'error'],
      ['en-US', 'keywords', 100, 101, 'bytes', 'error'],
      ['en-US', 'promotional_text', 170, 171, 'characters', 'error'],
      ['en-US', 'release_notes', 4000, 4001, 'characters', 'error'],
    ],
  );
  assert.equal(listingIsValid(problems), false);
});

test('missing locale: an expected locale without an entry is a warning', () => {
  const snapshot = read(MINIMAL, ['en-US', 'fr-FR']);
  assert.deepEqual(snapshot.warnings, ['Locale fr-FR is expected but has no entry in apple.info.']);
  // No apple section at all.
  const bare = read('{ "configVersion": 0 }', ['en-US']);
  assert.deepEqual(bare.warnings, [
    `${STORE_PATH} has no apple section.`,
    'Locale en-US is expected but has no entry in apple.info.',
  ]);
  assert.equal(bare.found, false);
});

test('odd shapes are warnings, not crashes', () => {
  const snapshot = read(
    JSON.stringify({
      configVersion: 1,
      apple: {
        copyright: 7,
        info: {
          'en-US': { title: 3, keywords: 'a,b', subtitle: 'ok' },
          'fr-FR': 'nope',
          'ja': { keywords: ['a,b', 'c'] },
        },
      },
    }),
  );
  assert.equal(snapshot.error, undefined);
  const all = snapshot.warnings.join('\n');
  assert.match(all, /configVersion 1/);
  assert.match(all, /apple\.copyright is not a string/);
  assert.match(all, /apple\.info\.en-US\.title is not a string/);
  assert.match(all, /apple\.info\.en-US\.keywords is not an array of strings/);
  assert.match(all, /apple\.info\.fr-FR is not an object/);
  assert.match(all, /apple\.info\.ja\.keywords has an entry with a comma/);
  assert.equal(apple(snapshot.listing).locales['en-US']?.subtitle, 'ok');
  assert.equal(apple(snapshot.listing).locales['en-US']?.name, undefined);
  assert.match(read('{"apple": {}}').warnings[0] ?? '', /no configVersion/);
});

test('keywordsToArray trims and drops empty entries', () => {
  assert.deepEqual(keywordsToArray(' a, b ,,c,'), ['a', 'b', 'c']);
  assert.deepEqual(keywordsToArray(''), []);
});

// ---------------------------------------------------------------------------------------------
// Writing

test('no change gives no change set, even through different but equal keyword text', () => {
  const snapshot = read(VALID);
  assert.deepEqual(expoStoreChangeSet(snapshot, snapshot.listing), { changes: [], warnings: [] });
  const same = edit(snapshot);
  const en = apple(same).locales['en-US'];
  assert.ok(en);
  en.keywords = 'hiking, trail, gps';
  assert.deepEqual(expoStoreChangeSet(snapshot, same).changes, []);
  assert.deepEqual(expoStoreChangeSet(snapshot, {}).changes, []);
});

test('one changed field changes one line and nothing else', () => {
  const snapshot = read(VALID);
  const after = edit(snapshot);
  const en = apple(after).locales['en-US'];
  assert.ok(en);
  en.subtitle = 'Hike, log, share it';
  const { text, warnings } = apply(snapshot, after);
  assert.deepEqual(warnings, []);
  const was = lines(VALID);
  const now = lines(text);
  assert.equal(now.length, was.length);
  const diff = now.flatMap((line, i) => (line === was[i] ? [] : [[was[i], line]]));
  assert.deepEqual(diff, [
    ['        "subtitle": "Hike, log, share",', '        "subtitle": "Hike, log, share it",'],
  ]);
  assert.ok(text.endsWith('}\n'));
});

test('changed keywords keep the array on its line, with the file separator', () => {
  const snapshot = read(VALID);
  const after = edit(snapshot);
  const en = apple(after).locales['en-US'];
  assert.ok(en);
  en.keywords = 'hiking,trail,maps';
  const { text } = apply(snapshot, after);
  assert.match(text, /^ {8}"keywords": \["hiking", "trail", "maps"\],$/m);

  const compact = read(UNKNOWN_FIELDS);
  const next = edit(compact);
  const us = apple(next).locales['en-US'];
  assert.ok(us);
  us.keywords = 'hiking,trail,maps';
  assert.match(apply(compact, next).text, /"keywords": \["hiking","trail","maps"\],/);
});

test('unknown and uncovered keys survive an edit byte for byte', () => {
  const snapshot = read(UNKNOWN_FIELDS);
  const after = edit(snapshot);
  const en = apple(after).locales['en-US'];
  assert.ok(en);
  en.name = 'Trail Notes Pro';
  en.description = 'Log every hike, share it, and plan the next.';
  apple(after).copyright = '2027 Example, Inc.';
  const { text } = apply(snapshot, after);
  const was = lines(UNKNOWN_FIELDS);
  const now = lines(text);
  assert.equal(now.length, was.length);
  const changed = now.flatMap((line, i) => (line === was[i] ? [] : [i]));
  assert.equal(changed.length, 3);
  for (const i of changed) {
    assert.match(was[i] ?? '', /"(title|description|copyright)"/);
  }
  assert.deepEqual(JSON.parse(text).notes, { owner: 'growth team' });
  assert.deepEqual(Object.keys(JSON.parse(text)), ['configVersion', 'notes', 'apple']);
});

test('a new locale is appended with the file indentation, other locales untouched', () => {
  const snapshot = read(MINIMAL);
  const after = edit(snapshot);
  apple(after).locales['fr-FR'] = {
    name: 'Notes de sentier',
    keywords: 'randonnée,sentier',
    support_url: 'https://example.com/fr/support',
    privacy_url: 'https://example.com/fr/privacy',
  };
  const { text } = apply(snapshot, after);
  assert.ok(text.startsWith(MINIMAL.slice(0, MINIMAL.indexOf('\n      }\n    }\n  }\n}'))));
  assert.ok(text.includes(`      },
      "fr-FR": {
        "title": "Notes de sentier",
        "keywords": ["randonnée", "sentier"],
        "supportUrl": "https://example.com/fr/support",
        "privacyPolicyUrl": "https://example.com/fr/privacy"
      }
    }
  }
}
`));
  assert.deepEqual(Object.keys(JSON.parse(text).apple.info), ['en-US', 'fr-FR']);
});

test('a new field in an existing locale is appended after its last key', () => {
  const snapshot = read(MINIMAL);
  const after = edit(snapshot);
  const en = apple(after).locales['en-US'];
  assert.ok(en);
  en.promotional_text = 'Now with maps.';
  const { text } = apply(snapshot, after);
  assert.ok(
    text.includes(`        "privacyPolicyUrl": "https://example.com/en/privacy",
        "promoText": "Now with maps."
      }`),
  );
});

test('copyright and the whole apple section are created when missing', () => {
  const copyright = read(MINIMAL);
  const withCopyright = edit(copyright);
  apple(withCopyright).copyright = '2026 Example, Inc.';
  const one = apply(copyright, withCopyright);
  assert.ok(one.text.includes('\n    "copyright": "2026 Example, Inc."\n  }\n}'));

  const empty = read('{}');
  const built = edit(empty);
  apple(built).locales['en-US'] = { name: 'Trail Notes' };
  const two = apply(empty, built);
  assert.equal(
    two.text,
    `{
  "apple": {
    "info": {
      "en-US": {
        "title": "Trail Notes"
      }
    }
  }
}`,
  );
});

test('removing a field removes its member and the comma, first, middle and last', () => {
  const snapshot = read(VALID);
  const after = edit(snapshot);
  const en = apple(after).locales['en-US'];
  assert.ok(en);
  delete en.name;
  delete en.subtitle;
  delete en.privacy_url;
  delete apple(after).copyright;
  const { text } = apply(snapshot, after);
  assert.ok(!text.includes('"title": "Trail Notes"'));
  assert.ok(!text.includes('"subtitle"'));
  assert.ok(!text.includes('"copyright"'));
  assert.ok(text.includes('"supportUrl": "https://example.com/support"\n      },'));
  assert.deepEqual(JSON.parse(text).apple.info['de-DE'], JSON.parse(VALID).apple.info['de-DE']);
});

test('removing a locale drops it; one with unmodeled content keeps those keys', () => {
  const snapshot = read(VALID);
  const after = edit(snapshot);
  delete apple(after).locales['de-DE'];
  const { text } = apply(snapshot, after);
  assert.deepEqual(Object.keys(JSON.parse(text).apple.info), ['en-US']);
  assert.ok(text.includes('"privacyPolicyUrl": "https://example.com/privacy"\n      }\n    }'));

  const mixed = read(UNKNOWN_FIELDS);
  const next = edit(mixed);
  delete apple(next).locales['en-US'];
  const result = expoStoreChangeSet(mixed, next);
  const out = JSON.parse(result.changes[0]?.after ?? '{}');
  assert.deepEqual(Object.keys(out.apple.info['en-US']), [
    'privacyChoicesUrl',
    'screenshots',
    'mystery',
  ]);
  assert.ok(out.apple.info['xx-YY']);
});

test('removing the last member leaves an empty object', () => {
  const snapshot = read(COMPACT);
  const after = edit(snapshot);
  delete apple(after).locales['en-US'];
  const { text } = apply(snapshot, after);
  assert.equal(text, '{"configVersion":0,"apple":{"info":{}}}');
});

test('compact one line files stay on one line', () => {
  const snapshot = read(COMPACT);
  const after = edit(snapshot);
  const en = apple(after).locales['en-US'];
  assert.ok(en);
  en.name = 'Trail Notes 2';
  en.subtitle = 'Hike';
  const { text } = apply(snapshot, after);
  assert.equal(
    text,
    '{"configVersion":0,"apple":{"info":{"en-US":{"title":"Trail Notes 2",' +
      '"keywords":["a","b"], "subtitle": "Hike"}}}}',
  );
});

test('tabs, CRLF, multi-line keywords and a missing final newline are kept', () => {
  const snapshot = read(TABS_CRLF);
  assert.deepEqual(snapshot.warnings, []);
  const after = edit(snapshot);
  const en = apple(after).locales['en-US'];
  assert.ok(en);
  en.keywords = 'hiking,trail,maps';
  en.release_notes = 'Fixes.';
  const { text } = apply(snapshot, after);
  assert.ok(!/[^\r]\n/.test(text), 'every line break is still CRLF');
  assert.ok(text.endsWith('\r\n}'));
  assert.ok(
    text.includes(
      '\t\t\t\t"keywords": [\r\n\t\t\t\t\t"hiking",\r\n\t\t\t\t\t"trail",' +
        '\r\n\t\t\t\t\t"maps"\r\n\t\t\t\t],',
    ),
  );
  assert.ok(
    text.includes(
      '"supportUrl": "https://example.com/support",\r\n\t\t\t\t"releaseNotes": "Fixes."\r\n\t\t\t}',
    ),
  );
});

test('values with quotes, backslashes and non-ASCII are escaped as JSON', () => {
  const snapshot = read(MINIMAL);
  const after = edit(snapshot);
  const en = apple(after).locales['en-US'];
  assert.ok(en);
  en.description = 'Say "hi" \\ 日本語\nsecond line';
  const { text } = apply(snapshot, after);
  assert.ok(text.includes('"description": "Say \\"hi\\" \\\\ 日本語\\nsecond line",'));
});

test('what cannot be written is reported, not written', () => {
  const snapshot = read(MINIMAL);
  const after = edit(snapshot);
  apple(after).locales.default = { name: 'Fallback' };
  apple(after).locales['xx-YY'] = { name: 'Nope' };
  after.googlePlay = { locales: {}, changelogs: {} };
  const result = expoStoreChangeSet(snapshot, after);
  assert.deepEqual(result.changes, []);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings.join('\n'), /Google Play/);
  assert.match(result.warnings.join('\n'), /Locale default is not one EAS Metadata supports/);
  assert.match(result.warnings.join('\n'), /Locale xx-YY/);
});

test('every edit is idempotent: applying the same listing to the result changes nothing', () => {
  const snapshot = read(VALID);
  const after = edit(snapshot);
  const en = apple(after).locales['en-US'];
  assert.ok(en);
  en.name = 'Trail Notes 2';
  apple(after).locales['ja'] = { name: 'トレイル', privacy_url: 'https://example.com/ja' };
  const { text } = apply(snapshot, after);
  const again = read(text);
  assert.deepEqual(expoStoreChangeSet(again, after).changes, []);
});

// ---------------------------------------------------------------------------------------------
// Detection

test('detect: an Expo repository with a store config is read through detectProject', async () => {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ dependencies: { expo: '~53.0.0' } }),
    'app.json': JSON.stringify({ expo: { name: 'Trail Notes', ios: {} } }),
    [STORE_PATH]: VALID,
  };
  const reader = async (p: string) => files[p];
  const detection = await detectProject(Object.keys(files), reader);
  assert.equal(detection.kind, 'expo');
  assert.deepEqual(
    staticStoreConfigs(detection).map((c) => c.path),
    [STORE_PATH],
  );
  assert.deepEqual(detection.locales.ios, ['de-DE', 'en-US']);
  const snapshot = await loadExpoStoreConfig(detection, reader, { expectedLocales: ['fr-FR'] });
  assert.ok(snapshot);
  assert.equal(snapshot.path, STORE_PATH);
  assert.deepEqual(snapshot.warnings, ['Locale fr-FR is expected but has no entry in apple.info.']);
});

test('detect: a dynamic store config, a missing file and no store config are handled', async () => {
  const dynamicFiles: Record<string, string> = {
    'package.json': JSON.stringify({ dependencies: { expo: '~53.0.0' } }),
    'eas.json': JSON.stringify({
      submit: { production: { ios: { metadataPath: './store.config.js' } } },
    }),
    'store.config.js': 'module.exports = {};',
  };
  const dynamic = await detectProject(Object.keys(dynamicFiles), async (p) => dynamicFiles[p]);
  assert.deepEqual(staticStoreConfigs(dynamic), []);
  assert.equal(await loadExpoStoreConfig(dynamic, async (p) => dynamicFiles[p]), undefined);

  const files: Record<string, string> = {
    'package.json': JSON.stringify({ dependencies: { expo: '~53.0.0' } }),
    [STORE_PATH]: MINIMAL,
  };
  const detection = await detectProject(Object.keys(files), async (p) => files[p]);
  const missing = await loadExpoStoreConfig(detection, async () => undefined);
  assert.equal(missing?.error, `${STORE_PATH} could not be read.`);

  const none = await detectProject(['package.json'], async () => files['package.json']);
  assert.equal(await loadExpoStoreConfig(none, async () => undefined), undefined);
});
