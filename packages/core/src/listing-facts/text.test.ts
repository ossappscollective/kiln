import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APP_STORE_FIELD_SPECS,
  countCharacters,
  measureField,
  PLAY_CHANGELOG_SPEC,
  PLAY_FIELD_SPECS,
  validateListing,
} from '../listing/listing.ts';
import { APP_STORE_KEYWORD_BYTES } from '../aso/aso.ts';
import { PLAY_NOTES_LIMIT } from '../release/play-release-checks.ts';
import { APP_STORE_RELEASE_NOTES_LIMIT, PLAY_RELEASE_NOTES_LIMIT } from '../release/release-plan.ts';
import { evaluateDraftContent } from '../listing/draft-readiness.ts';
import { checkReleaseField } from '../release/release-fields.ts';
import {
  checkTextField,
  emptyRequiredTexts,
  fieldSpecOf,
  normalizeStoreText,
  releaseNotesLimitOf,
  requiredFieldsOf,
  sameListingText,
  textLimitOf,
  validateListingText,
} from './text.ts';

/**
 * Limits, counting unit, required fields and the one check (audit listing.md F4-F7): one answer for every consumer.
 */

test('the limits come from the specs, never typed again', () => {
  const t = (store: 'app_store' | 'google_play', field: string) => {
    const l = textLimitOf(store, field);
    return l === null ? null : [l.max, l.unit, l.maxVerified];
  };
  assert.deepEqual(t('google_play', 'release_notes'), [500, 'characters', true]);
  assert.deepEqual(t('google_play', 'changelog'), [500, 'characters', true]);
  assert.deepEqual(t('app_store', 'release_notes'), [4000, 'characters', true]);
  assert.deepEqual(t('app_store', 'description'), [4000, 'characters', true]);
  assert.deepEqual(t('google_play', 'full_description'), [4000, 'characters', true]);
  assert.deepEqual(t('app_store', 'keywords'), [100, 'bytes', true]);
  assert.deepEqual(t('app_store', 'subtitle'), [30, 'characters', true]);
  assert.deepEqual(t('google_play', 'title'), [30, 'characters', true]);
  assert.deepEqual(t('google_play', 'short_description'), [80, 'characters', true]);
  assert.deepEqual(t('app_store', 'support_url'), [255, 'characters', false]);
  assert.equal(textLimitOf('app_store', 'copyright')?.max, null);
  assert.equal(textLimitOf('app_store', 'nope'), null);
  assert.equal(releaseNotesLimitOf('google_play'), 500);
  assert.equal(releaseNotesLimitOf('app_store'), 4000);
  assert.equal(fieldSpecOf('google_play', 'release_notes'), PLAY_CHANGELOG_SPEC);
  // every old literal is now the spec's number
  assert.equal(PLAY_NOTES_LIMIT, 500);
  assert.equal(PLAY_RELEASE_NOTES_LIMIT, 500);
  assert.equal(APP_STORE_RELEASE_NOTES_LIMIT, 4000);
  assert.equal(APP_STORE_KEYWORD_BYTES, APP_STORE_FIELD_SPECS.keywords.maxLength);
});

test('ONE counting unit: code points, trimmed. 480 code points with 30 emoji are 480, not the 510 UTF-16 units', () => {
  const note = `${'x'.repeat(450)}${'\u{1F600}'.repeat(30)}`;
  assert.equal(note.length, 510); // the web release-notes row counted this
  assert.equal(measureField(PLAY_CHANGELOG_SPEC, note), 480);
  assert.equal(countCharacters(note), 480);
  // trimmed: a trailing newline or leading spaces are not counted (countCharacters on the raw value counted them)
  assert.equal(measureField(PLAY_CHANGELOG_SPEC, `${'x'.repeat(500)}\n`), 500);
  assert.equal(countCharacters(`${'x'.repeat(500)}\n`), 501);
  assert.equal(measureField(PLAY_CHANGELOG_SPEC, '  hi  '), 2);
  assert.equal(measureField(PLAY_CHANGELOG_SPEC, ''), 0);
  // keywords are bytes (2 bytes for an accent)
  assert.equal(measureField(APP_STORE_FIELD_SPECS.keywords, 'café,x '), 'café,x'.length + 1);
  // every surface agrees on the note at the limit: the listing validator, readiness and the staged view
  const text = note + 'y'.repeat(20); // 500 code points, 530 UTF-16 units
  assert.equal(measureField(PLAY_CHANGELOG_SPEC, text), 500);
  const play = validateListing({ googlePlay: { locales: {}, changelogs: { 'en-US': { '1': text } } } });
  assert.deepEqual(play, []);
  const ready = evaluateDraftContent({ store: 'google_play', locales: [{ locale: 'en-US', text: {}, assets: [] }], releaseNotes: [{ locale: 'en-US', text }] });
  assert.equal(ready.some((f) => f.code === 'release_notes_too_long'), false);
  assert.deepEqual(checkReleaseField('android', 'release_notes', 'en-US', text, 0), []);
  // one more code point: all three say too long, with the same count
  const over = `${text}z`;
  assert.equal(validateListing({ googlePlay: { locales: {}, changelogs: { 'en-US': { '1': over } } } })[0]?.severity, 'error');
  assert.equal(evaluateDraftContent({ store: 'google_play', locales: [{ locale: 'en-US', text: {}, assets: [] }], releaseNotes: [{ locale: 'en-US', text: over }] }).some((f) => f.code === 'release_notes_too_long' && f.severity === 'blocking'), true);
  assert.equal(checkReleaseField('android', 'release_notes', 'en-US', over, 0)[0]?.severity, 'error');
});

test('a Play note of 520 characters is an ERROR in every surface (the staged view called it a warning, readiness a blocker)', () => {
  const long = 'x'.repeat(520);
  assert.equal(checkReleaseField('android', 'release_notes', 'en-US', long, 0)[0]?.severity, 'error');
  assert.equal(checkTextField(PLAY_CHANGELOG_SPEC, long, { locale: 'en-US' })[0]?.severity, 'error');
});

test('requiredFieldsOf: the required fields once, with their severity from the spec; stageable ones for a platform', () => {
  const apple = requiredFieldsOf('app_store').map((r) => [r.field, r.severity]);
  assert.deepEqual(apple, [
    ['name', 'warning'],
    ['description', 'error'],
    ['keywords', 'error'],
    ['support_url', 'error'],
    ['privacy_url', 'error'],
  ]);
  const play = requiredFieldsOf('google_play').map((r) => [r.field, r.severity]);
  assert.deepEqual(play, [['title', 'warning'], ['short_description', 'warning'], ['full_description', 'warning']]);
  // a push writes neither the App Store name nor the privacy policy URL
  const stageable = requiredFieldsOf('app_store', { stageableFor: 'ios' }).map((r) => r.field);
  assert.equal(stageable.includes('name'), false);
  assert.equal(stageable.includes('privacy_url'), false);
  assert.equal(stageable.includes('keywords'), true);
});

test('emptyRequiredTexts is the server emptyRequiredFields: blank, missing and whitespace-only count; non-stageable fields never', () => {
  assert.deepEqual(emptyRequiredTexts('ios', { description: 'x', keywords: ' ', support_url: undefined }), ['keywords', 'support_url']);
  assert.deepEqual(emptyRequiredTexts('ios', { description: 'x', keywords: 'k', support_url: 'https://a.b' }), []);
  assert.deepEqual(emptyRequiredTexts('android', { title: 'T', short_description: null }), ['short_description', 'full_description']);
});

test('iOS keywords: EMPTY is the same level everywhere (the Insights check said warning, readiness blocking, validateListing error)', () => {
  const problems = checkTextField(APP_STORE_FIELD_SPECS.keywords, '', { locale: 'en-US' });
  assert.deepEqual(problems.map((p) => [p.code, p.severity]), [['missing_required', 'error']]);
  assert.equal(requiredFieldsOf('app_store').find((r) => r.field === 'keywords')?.severity, 'error');
  const draft = evaluateDraftContent({ store: 'app_store', locales: [{ locale: 'en-US', text: { keywords: '' }, assets: [] }] });
  assert.equal(draft.find((f) => f.code === 'missing_text')?.severity, 'blocking');
});

test('checkTextField: length, minimum, URL, keyword advice, fallback, required off', () => {
  const kind = (spec: Parameters<typeof checkTextField>[0], value: string | null, options = {}) => checkTextField(spec, value, options).map((p) => p.code);
  assert.deepEqual(kind(PLAY_FIELD_SPECS.title, 'x'.repeat(31)), ['too_long']);
  assert.deepEqual(kind(PLAY_FIELD_SPECS.title, 'x'.repeat(30)), []);
  assert.deepEqual(kind(APP_STORE_FIELD_SPECS.description, 'short'), ['too_short']);
  assert.deepEqual(kind(APP_STORE_FIELD_SPECS.support_url, 'support'), ['invalid_url']);
  assert.deepEqual(kind(APP_STORE_FIELD_SPECS.keywords, 'a,,b,a'), ['keywords_empty_entry', 'keywords_duplicate', 'keywords_short_entry']);
  assert.deepEqual(kind(PLAY_FIELD_SPECS.title, null), ['missing_required']);
  assert.deepEqual(kind(PLAY_FIELD_SPECS.title, null, { fallback: 'Fallback' }), []);
  assert.deepEqual(kind(PLAY_FIELD_SPECS.title, null, { required: false }), []);
  const problem = checkTextField(PLAY_FIELD_SPECS.title, null, { locale: 'de-DE' })[0];
  assert.equal(problem?.locale, 'de-DE');
  assert.equal(problem?.field, 'title');
  assert.equal(problem?.severity, 'warning');
});

test('validateListingText composes validateListing: same problems, same order', () => {
  const locales = {
    'en-US': { name: 'App', description: 'A fine app indeed', keywords: 'one,two,three', support_url: 'https://a.b', privacy_url: 'https://a.b/p', subtitle: 'x'.repeat(31) },
    'de-DE': { name: 'App' },
    default: { support_url: 'https://a.b' },
  };
  const direct = validateListing({ appStore: { locales, copyright: '' } });
  const composed = validateListingText('app_store', locales, { copyright: '' });
  assert.deepEqual(composed, direct);
  assert.equal(composed.some((p) => p.field === 'subtitle' && p.code === 'too_long'), true);
  const play = { 'en-US': { title: 'T', short_description: 's', full_description: 'f' }, 'fr-FR': {} };
  assert.deepEqual(validateListingText('google_play', play), validateListing({ googlePlay: { locales: play, changelogs: {} } }));
});

test('normalizeStoreText: line breaks and no trailing white space (the server rule); per-line trailing blanks are kept', () => {
  assert.equal(normalizeStoreText('a\r\nb\r\n'), 'a\nb');
  assert.equal(normalizeStoreText('a \nb  \n\n'), 'a \nb');
  assert.equal(sameListingText('Fixes\r\n', 'Fixes'), true);
  assert.equal(sameListingText('Fixes', 'Fix'), false);
});
