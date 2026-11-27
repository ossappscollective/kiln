import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  copyToLocales,
  type HistoryNote,
  historyStoreLine,
  isNoteLocale,
  type NotesHistory,
  type NoteUse,
  noteLimit,
  noteRows,
  overwriteCount,
  type PromoteNotesState,
  previewOf,
  promoteNotesFill,
  promoteNotesLine,
  releaseNotesView,
  reuseOptions,
  stateLabel,
  testFlightLine,
  unsavedLocales,
  useLine,
  useTestFlightNotes,
} from './release-notes.ts';

const date = (at: number) => new Date(at).toISOString().slice(0, 10);
const use = (extra: Partial<NoteUse>): NoteUse => ({
  source: 'appstoreconnect',
  locale: 'en-US',
  version: '2.3.0',
  track: null,
  state: 'READY_FOR_DISTRIBUTION',
  at: Date.UTC(2026, 10, 12),
  ...extra,
});

test('limits: 4000 on the App Store, 500 on Google Play', () => {
  assert.equal(noteLimit('ios'), 4000);
  assert.equal(noteLimit('macos'), 4000);
  assert.equal(noteLimit('android'), 500);
});

test('where a text was used is told in words, for the store, the plan and Google Play', () => {
  assert.equal(useLine(use({}), date), 'App Store version 2.3.0 (live), 2026-11-12');
  assert.equal(
    useLine(use({ source: 'plan', state: null, version: '2.5.0' }), date),
    'Release plan 2.5.0, 2026-11-12',
  );
  assert.equal(
    useLine(
      use({
        source: 'googleplay',
        version: 'Winter',
        track: 'production',
        state: 'completed',
        at: null,
      }),
      date,
    ),
    'Google Play release Winter on production (completed), no date (Google Play does not give one)',
  );
  assert.equal(
    useLine(use({ state: 'SOMETHING_NEW' }), date),
    'App Store version 2.3.0 (something new), 2026-11-12',
  );
});

const note = (text: string, uses: NoteUse[]): HistoryNote => ({
  text,
  truncated: false,
  locales: uses.map((u) => u.locale),
  lastUsedAt: null,
  uses,
});

test('the reuse menu lists the texts of one language with their uses', () => {
  const history = {
    notes: [
      note('Bug fixes\nand more', [
        use({ version: '2.3.0' }),
        use({ version: '2.2.0', at: Date.UTC(2026, 9, 1) }),
        use({ version: '2.1.0' }),
        use({ version: '2.0.0' }),
      ]),
      note('Nur Deutsch', [use({ locale: 'de-DE' })]),
      note('x'.repeat(600), [
        use({ source: 'googleplay', version: 'A', track: 'beta', state: 'completed', at: null }),
      ]),
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
  assert.match(
    historyStoreLine({
      read: false,
      error: 'rate_limited',
      cached: false,
      versionsRead: 0,
      failed: 0,
      truncated: false,
    }) as string,
    /limiting requests/,
  );
  assert.match(
    historyStoreLine({
      read: false,
      error: 'store_forbidden',
      cached: false,
      versionsRead: 0,
      failed: 0,
      truncated: false,
    }) as string,
    /cannot read them/,
  );
  assert.equal(
    historyStoreLine({
      read: true,
      error: null,
      cached: true,
      versionsRead: 12,
      failed: 0,
      truncated: false,
    }),
    null,
  );
  assert.equal(
    historyStoreLine({
      read: true,
      error: null,
      cached: false,
      versionsRead: 12,
      failed: 2,
      truncated: true,
    }),
    'Only the newest versions were read. 2 versions could not be read.',
  );
  assert.equal(historyStoreLine(undefined), null);
});

test('previews are the first line, cut', () => {
  assert.equal(previewOf('  Hello\nworld '), 'Hello');
  assert.equal(previewOf('a'.repeat(100), 10), 'aaaaaaaaa…');
});

test('copying one language to others overwrites only what differs, and counts it', () => {
  const drafts = { 'en-US': 'Hello', 'de-DE': 'Hallo', 'fr-FR': '', 'es-ES': 'Hello' };
  const r = copyToLocales(drafts, 'en-US', ['en-US', 'de-DE', 'fr-FR', 'es-ES']);
  assert.deepEqual(r.drafts, {
    'en-US': 'Hello',
    'de-DE': 'Hello',
    'fr-FR': 'Hello',
    'es-ES': 'Hello',
  });
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
  assert.match(
    testFlightLine({ read: false, locales: [] }, 'Build 3'),
    /not read\. Only the newest eight/,
  );
  assert.match(
    testFlightLine({ read: false, locales: [], error: 'rate_limited' }, 'Build 3'),
    /rate limited/,
  );
  assert.match(testFlightLine({ read: true, locales: [] }, 'Build 3'), /no TestFlight notes/);
  assert.match(
    testFlightLine(
      { read: true, locales: [{ locale: 'en-US', text: 'a', truncated: false }] },
      'Build 3',
    ),
    /1 language\./,
  );
});

test('each language is same, edited, staged or new, with its count against the limit', () => {
  const rows = noteRows({
    platform: 'android',
    locales: ['en-US', 'de-DE', 'fr-FR', 'es-ES'],
    drafts: { 'de-DE': 'Hallo Welt', 'es-ES': 'x'.repeat(501) },
    store: { 'en-US': 'Hello', 'de-DE': 'Hallo' },
    staged: { 'fr-FR': 'Bonjour' },
  });
  assert.deepEqual(
    rows.map((r) => r.state),
    ['same', 'edited', 'staged', 'edited'],
  );
  assert.equal(rows[3]?.over, true);
  assert.equal(rows[0]?.draft, 'Hello');
  assert.deepEqual(unsavedLocales(rows), ['de-DE', 'es-ES']);
  assert.equal(stateLabel('edited'), 'Not staged yet');
  const nothing = noteRows({
    platform: 'ios',
    locales: ['en-US'],
    drafts: {},
    store: {},
    staged: {},
  });
  assert.equal(nothing[0]?.state, 'new');
  assert.deepEqual(unsavedLocales(nothing), []);
});

test('locale codes follow the server rule', () => {
  assert.equal(isNoteLocale('en-US'), true);
  assert.equal(isNoteLocale('pt_BR'), true);
  assert.equal(isNoteLocale('english'), false);
  assert.equal(isNoteLocale(''), false);
});

const hist = (
  notes: { text: string; locales: string[] }[],
  store: Partial<NotesHistory['store']> = {},
) => ({
  notes: notes.map((n) => ({ ...n, truncated: false, lastUsedAt: null, uses: [] as NoteUse[] })),
  store: {
    read: true,
    error: null,
    cached: false,
    versionsRead: 1,
    failed: 0,
    truncated: false,
    ...store,
  },
});

test('promote: the notes of the source release fill the editors of every language that has text, and add the languages not shown', () => {
  const out = promoteNotesFill({
    history: hist([
      { text: 'Same\r\ntext ', locales: ['en-US', 'de_DE'] },
      { text: 'Texte', locales: ['fr-FR'] },
    ]),
    drafts: {},
    staged: {},
    locales: ['en-US', 'de-DE'],
    platform: 'android',
  });
  assert.deepEqual(out.drafts, { 'en-US': 'Same\ntext', 'de-DE': 'Same\ntext', 'fr-FR': 'Texte' });
  assert.deepEqual(out.state.filled, ['en-US', 'de-DE', 'fr-FR']);
  assert.deepEqual(out.addLocales, ['fr-FR']);
  assert.deepEqual(out.state.kept, []);
  assert.equal(out.state.none, false);
});

test('promote: a typed or staged text is never replaced', () => {
  const out = promoteNotesFill({
    history: hist([{ text: 'From internal', locales: ['en-US', 'de-DE', 'fr-FR'] }]),
    drafts: { 'en-us': 'I typed this', 'fr-FR': '' },
    staged: { 'de-DE': 'Staged already' },
    locales: ['en-US', 'de-DE', 'fr-FR'],
    platform: 'android',
  });
  assert.deepEqual(out.drafts, { 'en-us': 'I typed this', 'fr-FR': '' });
  assert.deepEqual(out.state.filled, []);
  assert.deepEqual(out.state.kept, ['en-US', 'de-DE', 'fr-FR']);
  // A staged text that is only blank does not protect the language.
  const blank = promoteNotesFill({
    history: hist([{ text: 'x', locales: ['de-DE'] }]),
    drafts: {},
    staged: { 'de-DE': '  ' },
    locales: ['de-DE'],
    platform: 'android',
  });
  assert.deepEqual(blank.drafts, { 'de-DE': 'x' });
});

test('promote: a text over the Google Play limit is flagged, an empty history says there are no notes', () => {
  const long = promoteNotesFill({
    history: hist([{ text: 'y'.repeat(501), locales: ['en-US'] }]),
    drafts: {},
    staged: {},
    locales: ['en-US'],
    platform: 'android',
  });
  assert.deepEqual(long.state.tooLong, ['en-US']);
  const none = promoteNotesFill({
    history: hist([]),
    drafts: { a: 'b' },
    staged: {},
    locales: [],
    platform: 'android',
  });
  assert.equal(none.state.none, true);
  assert.deepEqual(none.drafts, { a: 'b' });
});

test('promote: the sentence says where the text came from, that nothing is staged, and plainly when there are no notes', () => {
  const done = (
    over: Partial<Extract<PromoteNotesState, { status: 'done' }>>,
  ): PromoteNotesState => ({
    status: 'done',
    filled: [],
    kept: [],
    tooLong: [],
    none: false,
    storeError: null,
    storeRead: true,
    ...over,
  });
  assert.equal(
    promoteNotesLine(done({ none: true }), 'internal testing', ['241']).text,
    'The internal testing release has no notes; write them or reuse earlier ones.',
  );
  assert.equal(
    promoteNotesLine(done({ filled: ['en-US', 'de-DE'], kept: ['fr-FR'] }), 'internal testing', [
      '241',
      '240',
    ]).text,
    'Put in the editors from the internal testing release (version codes 241, 240): en-US, de-DE. Nothing is staged yet. Not replaced, because you already wrote or staged text: fr-FR.',
  );
  assert.match(
    promoteNotesLine(done({ kept: ['en-US'] }), 'internal testing', ['241']).text,
    /nothing was replaced/,
  );
  const unread = promoteNotesLine(
    done({ storeRead: false, storeError: 'timeout' }),
    'internal testing',
    [],
  );
  assert.equal(unread.tone, 'warn');
  assert.match(unread.text, /did not answer in time\)\. Write them or reuse earlier ones\.$/);
  assert.match(
    promoteNotesLine({ status: 'loading' }, 'internal testing', []).text,
    /^Reading the notes/,
  );
  assert.match(
    promoteNotesLine({ status: 'error', message: 'Not allowed.' }, 'beta', []).text,
    /could not be read \(Not allowed\.\)/,
  );
});

test('releaseNotesView: one status over the typed, staged and store texts; a Play note of 501 characters is over, 500 with an emoji is not', () => {
  const view = releaseNotesView({
    platform: 'android',
    listingLocales: ['en-US', 'fr-FR', 'de-DE'],
    drafts: { 'en-US': 'x'.repeat(500) },
    staged: { 'fr-FR': 'Corrections' },
    store: { 'en-US': 'Old' },
  });
  assert.equal(view.status, 'partial');
  assert.deepEqual(view.missing, ['de-DE']);
  assert.deepEqual(view.over, []);
  assert.equal(
    view.locales.find((l) => l.locale === 'en-US')?.from,
    'staged',
    'what is typed wins',
  );
  const over = releaseNotesView({
    platform: 'android',
    listingLocales: [],
    drafts: { 'en-US': 'x'.repeat(501) },
  });
  assert.deepEqual(over.over, ['en-US']);
  const emoji = releaseNotesView({
    platform: 'android',
    listingLocales: [],
    drafts: { 'en-US': `${'a'.repeat(470)}${'\u{1F600}'.repeat(30)}` },
  });
  assert.deepEqual(emoji.over, [], '500 code points (530 UTF-16 units) are within the limit');
});
