import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type HistoryNote,
  type NoteUse,
  copyToLocales,
  historyStoreLine,
  isNoteLocale,
  noteLimit,
  noteRows,
  overwriteCount,
  previewOf,
  reuseOptions,
  stateLabel,
  testFlightLine,
  unsavedLocales,
  useLine,
  useTestFlightNotes,
} from './release-notes.ts';

const date = (at: number) => new Date(at).toISOString().slice(0, 10);
const use = (extra: Partial<NoteUse>): NoteUse => ({ source: 'appstoreconnect', locale: 'en-US', version: '2.3.0', track: null, state: 'READY_FOR_DISTRIBUTION', at: Date.UTC(2026, 10, 12), ...extra });

test('limits: 4000 on the App Store, 500 on Google Play', () => {
  assert.equal(noteLimit('ios'), 4000);
  assert.equal(noteLimit('macos'), 4000);
  assert.equal(noteLimit('android'), 500);
});

test('where a text was used is told in words, for the store, the plan and Google Play', () => {
  assert.equal(useLine(use({}), date), 'App Store version 2.3.0 (live), 2026-11-12');
  assert.equal(useLine(use({ source: 'plan', state: null, version: '2.5.0' }), date), 'Release plan 2.5.0, 2026-11-12');
  assert.equal(useLine(use({ source: 'googleplay', version: 'Winter', track: 'production', state: 'completed', at: null }), date), 'Google Play release Winter on production (completed), no date (Google Play does not give one)');
  assert.equal(useLine(use({ state: 'SOMETHING_NEW' }), date), 'App Store version 2.3.0 (something new), 2026-11-12');
});

const note = (text: string, uses: NoteUse[]): HistoryNote => ({ text, truncated: false, locales: uses.map((u) => u.locale), lastUsedAt: null, uses });

test('the reuse menu lists the texts of one language with their uses', () => {
  const history = {
    notes: [
      note('Bug fixes\nand more', [use({ version: '2.3.0' }), use({ version: '2.2.0', at: Date.UTC(2026, 9, 1) }), use({ version: '2.1.0' }), use({ version: '2.0.0' })]),
      note('Nur Deutsch', [use({ locale: 'de-DE' })]),
      note('x'.repeat(600), [use({ source: 'googleplay', version: 'A', track: 'beta', state: 'completed', at: null })]),
    ],
  };
  const en = reuseOptions(history, 'en_US', 'android', 'Bug fixes\nand more', date);
  assert.equal(en.length, 2);
  assert.equal(en[0]?.preview, 'Bug fixes');
  assert.equal(en[0]?.uses.length, 3);
  assert.equal(en[0]?.usesMore, 1);
  assert.equal(en[0]?.same, true);
  assert.equal(en[1]?.overLimit, 600);
  assert.equal(reuseOptions(history, 'de-DE', 'ios', '', date).length, 1);
  assert.equal(reuseOptions(history, 'fr-FR', 'ios', '', date).length, 0);
});

test('a history that could not be read from the store says so and still lists the plans', () => {
  assert.match(historyStoreLine({ read: false, error: 'rate_limited', cached: false, versionsRead: 0, failed: 0, truncated: false }) as string, /limiting requests/);
  assert.match(historyStoreLine({ read: false, error: 'store_forbidden', cached: false, versionsRead: 0, failed: 0, truncated: false }) as string, /cannot read them/);
  assert.equal(historyStoreLine({ read: true, error: null, cached: true, versionsRead: 12, failed: 0, truncated: false }), null);
  assert.equal(historyStoreLine({ read: true, error: null, cached: false, versionsRead: 12, failed: 2, truncated: true }), 'Only the newest versions were read. 2 versions could not be read.');
  assert.equal(historyStoreLine(undefined), null);
});

test('previews are the first line, cut', () => {
  assert.equal(previewOf('  Hello\nworld '), 'Hello');
  assert.equal(previewOf('a'.repeat(100), 10), 'aaaaaaaaa…');
});

test('copying one language to others overwrites only what differs, and counts it', () => {
  const drafts = { 'en-US': 'Hello', 'de-DE': 'Hallo', 'fr-FR': '', 'es-ES': 'Hello' };
  const r = copyToLocales(drafts, 'en-US', ['en-US', 'de-DE', 'fr-FR', 'es-ES']);
  assert.deepEqual(r.drafts, { 'en-US': 'Hello', 'de-DE': 'Hello', 'fr-FR': 'Hello', 'es-ES': 'Hello' });
  assert.equal(r.overwritten, 1);
  assert.equal(r.copied, 3);
  assert.equal(overwriteCount(drafts, 'en-US', ['de-DE', 'fr-FR']), 1);
  assert.equal(drafts['de-DE'], 'Hallo');
});

test('TestFlight notes fill the languages the drafts know and report the rest', () => {
  const drafts = { 'en-US': '', 'de-DE': 'alt' };
  const r = useTestFlightNotes(drafts, {
    read: true,
    locales: [
      { locale: 'en_US', text: 'Try the new editor.\r\n', truncated: false },
      { locale: 'ja', text: 'x', truncated: false },
    ],
  });
  assert.deepEqual(r.drafts, { 'en-US': 'Try the new editor.', 'de-DE': 'alt' });
  assert.deepEqual(r.filled, ['en-US']);
  assert.deepEqual(r.skipped, ['ja']);
  assert.equal(useTestFlightNotes(drafts, { read: false, locales: [] }).drafts, drafts);
  assert.equal(useTestFlightNotes(drafts, undefined).filled.length, 0);
});

test('the TestFlight line says plainly when the notes were not read or are empty', () => {
  assert.match(testFlightLine({ read: false, locales: [] }, 'Build 3'), /not read\. Only the newest eight/);
  assert.match(testFlightLine({ read: false, locales: [], error: 'rate_limited' }, 'Build 3'), /rate limited/);
  assert.match(testFlightLine({ read: true, locales: [] }, 'Build 3'), /no TestFlight notes/);
  assert.match(testFlightLine({ read: true, locales: [{ locale: 'en-US', text: 'a', truncated: false }] }, 'Build 3'), /1 language\./);
});

test('each language is same, edited, staged or new, with its count against the limit', () => {
  const rows = noteRows({
    platform: 'android',
    locales: ['en-US', 'de-DE', 'fr-FR', 'es-ES'],
    drafts: { 'de-DE': 'Hallo Welt', 'es-ES': 'x'.repeat(501) },
    store: { 'en-US': 'Hello', 'de-DE': 'Hallo' },
    staged: { 'fr-FR': 'Bonjour' },
  });
  assert.deepEqual(rows.map((r) => r.state), ['same', 'edited', 'staged', 'edited']);
  assert.equal(rows[3]?.over, true);
  assert.equal(rows[0]?.draft, 'Hello');
  assert.deepEqual(unsavedLocales(rows), ['de-DE', 'es-ES']);
  assert.equal(stateLabel('edited'), 'Not staged yet');
  const nothing = noteRows({ platform: 'ios', locales: ['en-US'], drafts: {}, store: {}, staged: {} });
  assert.equal(nothing[0]?.state, 'new');
  assert.deepEqual(unsavedLocales(nothing), []);
});

test('locale codes follow the server rule', () => {
  assert.equal(isNoteLocale('en-US'), true);
  assert.equal(isNoteLocale('pt_BR'), true);
  assert.equal(isNoteLocale('english'), false);
  assert.equal(isNoteLocale(''), false);
});
