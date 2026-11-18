import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareAgeRating, compareCategories, compareMedia, comparePrivacy, normalizeCategory } from '@mrm/core';
import {
  expoSections,
  fastlaneAppStoreMedia,
  fastlaneCategories,
  fastlanePlayMedia,
  fastlaneSectionFiles,
  parseAgeRatingFile,
  readFastlaneSections,
} from './repo-sections.ts';
import * as expo from './expo-store.fixtures.ts';

const ROOTS = { appStore: 'fastlane/metadata', googlePlay: 'fastlane/metadata/android' };

const paths = [
  'fastlane/metadata/copyright.txt',
  'fastlane/metadata/primary_category.txt',
  'fastlane/metadata/secondary_category.txt',
  'fastlane/metadata/primary_first_sub_category.txt',
  'fastlane/metadata/en-US/name.txt',
  'fastlane/metadata/en-US/privacy_url.txt',
  'fastlane/metadata/review_information/first_name.txt',
  'fastlane/metadata/review_information/demo_user.txt',
  'fastlane/app_rating_config.json',
  'fastlane/screenshots/en-US/1_iphone.png',
  'fastlane/screenshots/en-US/2_iphone.PNG',
  'fastlane/screenshots/en-US/notes.txt',
  'fastlane/screenshots/de-DE/a.jpg',
  'fastlane/screenshots/README.txt',
  'fastlane/metadata/android/en-US/title.txt',
  'fastlane/metadata/android/en-US/images/icon.png',
  'fastlane/metadata/android/en-US/images/featureGraphic.png',
  'fastlane/metadata/android/en-US/images/phoneScreenshots/1.png',
  'fastlane/metadata/android/en-US/images/phoneScreenshots/2.png',
  'fastlane/metadata/android/en-US/images/tenInchScreenshots/1.jpg',
  'fastlane/metadata/android/en-US/images/other/1.png',
  'fastlane/metadata/android/de-DE/images/phoneScreenshots/1.png',
];

test('fastlane: only the category files and the age rating file are read, never review information or images', () => {
  assert.deepEqual(fastlaneSectionFiles(paths, ROOTS).sort(), [
    'fastlane/app_rating_config.json',
    'fastlane/metadata/primary_category.txt',
    'fastlane/metadata/primary_first_sub_category.txt',
    'fastlane/metadata/secondary_category.txt',
  ]);
  assert.deepEqual(fastlaneSectionFiles(paths, { appStore: '', googlePlay: ROOTS.googlePlay }), []);
});

test('fastlane: categories, the age rating answers and screenshot counts per locale', () => {
  const files = {
    'fastlane/metadata/primary_category.txt': 'Productivity\n',
    'fastlane/metadata/secondary_category.txt': 'FOOD_AND_DRINK\r\n',
    'fastlane/metadata/primary_first_sub_category.txt': '\n',
    'fastlane/app_rating_config.json': JSON.stringify({ gambling: false, contests: 'NONE', violenceRealistic: 1, kidsAgeBand: null, advertising: true, nested: { x: 1 } }),
  };
  const sections = readFastlaneSections(paths, ROOTS, files);
  assert.deepEqual(sections.appStore.categories, { primary: 'Productivity', secondary: 'FOOD_AND_DRINK' });
  assert.deepEqual(sections.appStore.ageRating, { answers: { advertising: true, contests: 'NONE', gambling: false, violenceRealistic: '1' } });
  assert.deepEqual(sections.appStore.media, {
    screenshots: { 'de-DE': [{ type: 'all', count: 1 }], 'en-US': [{ type: 'all', count: 2 }] },
  });
  assert.deepEqual(sections.googlePlay.media?.screenshots['en-US']?.map((s) => [s.type, s.count]), [
    ['phoneScreenshots', 2],
    ['sevenInchScreenshots', 0],
    ['tenInchScreenshots', 1],
    ['tvScreenshots', 0],
    ['wearScreenshots', 0],
  ]);
  assert.deepEqual(sections.googlePlay.media?.graphics?.['en-US']?.map((s) => [s.type, s.count]), [['icon', 1], ['featureGraphic', 1], ['tvBanner', 0]]);
  assert.deepEqual(sections.googlePlay.media?.screenshots['de-DE']?.[0], { type: 'phoneScreenshots', count: 1 });
  assert.deepEqual(sections.warnings, []);
  // The age rating's string form is compared through the legacy words.
  assert.equal(
    compareAgeRating({ answers: { violenceRealistic: 'INFREQUENT_OR_MILD', contests: 'NONE', gambling: false } }, sections.appStore.ageRating).status,
    'identical',
  );
});

test('fastlane: nothing found is "read, empty", an unreadable age rating file is a warning and not read', () => {
  const empty = readFastlaneSections(['fastlane/metadata/en-US/name.txt'], ROOTS, {});
  assert.deepEqual(empty.appStore.categories, {});
  assert.deepEqual(empty.appStore.ageRating, { answers: {} });
  assert.deepEqual(empty.appStore.media, { screenshots: {} });
  const broken = readFastlaneSections(['fastlane/app_rating_config.json'], ROOTS, { 'fastlane/app_rating_config.json': '[1,2' });
  assert.equal(broken.appStore.ageRating, undefined);
  assert.match(broken.warnings[0] ?? '', /not a JSON object/);
  assert.equal(parseAgeRatingFile('"text"'), undefined);
  assert.deepEqual(fastlaneCategories({}, 'fastlane/metadata'), {});
});

test('fastlane: screenshots are found beside, above or inside the metadata folder, and a locale-less folder is ignored', () => {
  assert.deepEqual(fastlaneAppStoreMedia(['screenshots/en/a.png', 'metadata/en/name.txt'], 'metadata'), { screenshots: { en: [{ type: 'all', count: 1 }] } });
  assert.deepEqual(fastlaneAppStoreMedia(['fastlane/metadata/ios/en-US/name.txt', 'fastlane/screenshots/en-US/a.png'], 'fastlane/metadata/ios'), {
    screenshots: { 'en-US': [{ type: 'all', count: 1 }] },
  });
  assert.deepEqual(fastlaneAppStoreMedia(['fastlane/metadata/screenshots/fr-FR/a.png'], 'fastlane/metadata'), { screenshots: { 'fr-FR': [{ type: 'all', count: 1 }] } });
  assert.deepEqual(fastlaneAppStoreMedia(['fastlane/screenshots/a.png'], 'fastlane/metadata'), { screenshots: {} });
  assert.deepEqual(fastlanePlayMedia([], 'x'), { screenshots: {} });
});

test('expo: categories, advisory and the privacy choices URL come from store.config.json, media is not expressed', () => {
  const sections = expoSections(
    JSON.stringify({
      configVersion: 0,
      apple: {
        categories: [['GAMES', 'GAMES_CARD', 'GAMES_BOARD'], 'ENTERTAINMENT'],
        advisory: { gambling: false, contests: 'NONE', kidsAgeBand: null, ageRatingOverride: 'NONE', bogus: 3 },
        info: { 'en-US': { title: 'Coffee', privacyChoicesUrl: 'https://example.org/choices' }, 'de-DE': { title: 'Kaffee' } },
      },
    }),
  );
  assert.deepEqual(sections.categories, { primary: 'GAMES', primarySubcategories: ['GAMES_CARD', 'GAMES_BOARD'], secondary: 'ENTERTAINMENT' });
  assert.deepEqual(sections.ageRating, { answers: { ageRatingOverride: 'NONE', contests: 'NONE', gambling: false } });
  assert.deepEqual(sections.privacy, { choicesUrls: { 'en-US': 'https://example.org/choices' } });
  assert.equal(sections.media, undefined);
});

test('expo: the shared fixtures, a file without those keys and broken JSON never throw', () => {
  const valid = expoSections(expo.VALID);
  assert.ok(valid.categories !== undefined && valid.ageRating !== undefined && valid.privacy !== undefined);
  assert.deepEqual(expoSections(expo.MINIMAL).categories, {});
  assert.deepEqual(expoSections(expo.INVALID_JSON), {});
  assert.deepEqual(expoSections('[]'), {});
  assert.deepEqual(expoSections('{"apple":{"categories":"GAMES","advisory":[1],"info":[]}}').categories, {});
});

test('compare: categories are normalized, differences are named, empty and unread are told apart', () => {
  assert.equal(normalizeCategory('Food & Drink'), 'FOOD_AND_DRINK');
  assert.equal(normalizeCategory('MZGenre.Action'), 'ACTION');
  assert.equal(compareCategories({ primary: 'FOOD_AND_DRINK' }, { primary: 'Food & Drink' }).status, 'identical');
  const differs = compareCategories({ primary: 'GAMES', primarySubcategories: ['GAMES_CARD'] }, { primary: 'BUSINESS' });
  assert.equal(differs.status, 'differs');
  assert.deepEqual(differs.details, ['primary category: store GAMES, repository BUSINESS', 'first primary subcategory: store GAMES_CARD, repository none']);
  assert.equal(compareCategories({ primary: 'GAMES' }, {}).status, 'missing-in-repo');
  assert.equal(compareCategories({}, { primary: 'GAMES' }).status, 'missing-in-store');
  assert.equal(compareCategories({}, {}).status, 'identical');
  assert.equal(compareCategories(undefined, {}).status, 'not-read');
  assert.equal(compareCategories({ primary: 'GAMES' }, undefined).status, 'not-comparable');
});

test('compare: an age rating is only compared for keys both sides use, otherwise it is not comparable', () => {
  const store = { rating: 'FOUR_PLUS', answers: { gambling: false, contests: 'NONE', advertising: true } };
  assert.equal(compareAgeRating(store, { answers: { gambling: false, contests: 'NONE' } }).status, 'identical');
  const d = compareAgeRating(store, { answers: { gambling: true, contests: 'NONE', LEGACY_KEY: '1' } });
  assert.equal(d.status, 'differs');
  assert.deepEqual(d.details.slice(0, 1), ['gambling: store false, repository true']);
  assert.match(d.details[1] ?? '', /1 repository key\(s\) are not reported/);
  assert.equal(compareAgeRating(store, { answers: { CARTOON_FANTASY_VIOLENCE: '1' } }).status, 'not-comparable');
  assert.equal(compareAgeRating(store, { answers: {} }).status, 'missing-in-repo');
  assert.equal(compareAgeRating(undefined, { answers: {} }).status, 'not-read');
  assert.equal(compareAgeRating(store, undefined).status, 'not-comparable');
});

test('compare: privacy choices URLs per locale, and media by count only', () => {
  assert.equal(comparePrivacy({ choicesUrls: { en: 'https://a' } }, { choicesUrls: { en: 'https://a ' } }).status, 'identical');
  assert.deepEqual(comparePrivacy({ choicesUrls: { en: 'https://a' } }, { choicesUrls: { en: 'https://b' } }).details, ['en: store https://a, repository https://b']);
  const ios = compareMedia(
    { screenshots: { 'en-US': [{ type: 'APP_IPHONE_67', count: 3 }, { type: 'APP_IPAD_PRO_3GEN_129', count: 2 }], 'de-DE': [{ type: 'APP_IPHONE_67', count: 1 }] } },
    { screenshots: { 'en-US': [{ type: 'all', count: 5 }], 'de-DE': [{ type: 'all', count: 2 }] } },
    'ios',
  );
  assert.equal(ios.status, 'differs');
  assert.deepEqual(ios.details.slice(0, 1), ['de-DE: store 1, repository 2']);
  assert.match(ios.details[1] ?? '', /Totals per locale/);
  const android = compareMedia(
    { screenshots: { en: [{ type: 'phoneScreenshots', count: 2 }] }, graphics: { en: [{ type: 'icon', count: 1 }] } },
    { screenshots: { en: [{ type: 'phoneScreenshots', count: 2 }] }, graphics: { en: [{ type: 'icon', count: 1 }] } },
    'android',
  );
  assert.equal(android.status, 'identical');
  assert.equal(compareMedia({ screenshots: { en: [{ type: 'phoneScreenshots', count: 2 }] }, truncated: true }, { screenshots: {} }, 'android').status, 'missing-in-repo');
  assert.equal(compareMedia({ screenshots: {} }, undefined, 'ios').status, 'not-comparable');
});
