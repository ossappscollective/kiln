import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOTE_SOURCE_ORDER, notesView } from './notes.ts';

/**
 * The release notes in five places (audit listing.md F9): one status, per-locale text and the conflicts.
 */

test('the five places, in order of what ships: staged, store, plan, repo, section', () => {
  assert.deepEqual(NOTE_SOURCE_ORDER, ['staged', 'store', 'plan', 'repo', 'section']);
  const v = notesView('app_store', {
    staged: [{ locale: 'en-US', text: 'Staged' }],
    store: [{ locale: 'en-US', text: 'Store' }, { locale: 'de-DE', text: 'Store DE' }],
    plan: [{ locale: 'en-US', text: 'Plan' }, { locale: 'de-DE', text: 'Plan DE' }, { locale: 'fr-FR', text: 'Plan FR' }],
    repo: [{ locale: 'en-US', text: 'Repo' }, { locale: 'fr-FR', text: 'Repo FR' }, { locale: 'ja', text: 'Repo JA' }],
    section: [{ locale: 'ja', text: 'Section JA' }, { locale: 'it', text: 'Section IT' }],
  });
  const by = Object.fromEntries(v.locales.map((l) => [l.locale, l]));
  assert.deepEqual(
    Object.entries(by).map(([k, l]) => [k, l.from, l.text]),
    [
      ['de-DE', 'store', 'Store DE'],
      ['en-US', 'staged', 'Staged'],
      ['fr-FR', 'plan', 'Plan FR'],
      ['it', 'section', 'Section IT'],
      ['ja', 'repo', 'Repo JA'],
    ],
  );
  assert.deepEqual(by['en-US']?.candidates.map((c) => c.source), ['staged', 'store', 'plan', 'repo']);
  assert.equal(v.status, 'complete');
});

test('conflicts: two sources with different text are reported with every candidate; equal text (line breaks aside) is not one', () => {
  const v = notesView('google_play', {
    store: [{ locale: 'en-US', text: 'Fixes\r\n' }, { locale: 'de-DE', text: 'Fehler' }],
    plan: [{ locale: 'en-US', text: 'Fixes' }, { locale: 'de-DE', text: 'Behoben' }],
  });
  assert.deepEqual(v.conflicts.map((l) => l.locale), ['de-DE']);
  assert.equal(v.conflicts[0]?.text, 'Fehler');
  assert.deepEqual(v.conflicts[0]?.candidates, [{ source: 'store', text: 'Fehler' }, { source: 'plan', text: 'Behoben' }]);
  assert.equal(v.locales.find((l) => l.locale === 'en-US')?.conflict, false);
});

test('a PUSHED staged text is the store text now: it is not a source of its own; an unpushed one wins', () => {
  const pushed = notesView('app_store', { staged: [{ locale: 'en-US', text: 'Old staged', pushed: true }], store: [{ locale: 'en-US', text: 'Store' }] });
  assert.equal(pushed.locales[0]?.from, 'store');
  const unpushed = notesView('app_store', { staged: [{ locale: 'en-US', text: 'New staged', pushed: false }], store: [{ locale: 'en-US', text: 'Store' }] });
  assert.equal(unpushed.locales[0]?.from, 'staged');
});

test('locales that are one: plan fr_FR, store fr-FR and Play zh-CN against App Store zh-Hans share a row; the listing code names it', () => {
  const v = notesView(
    'app_store',
    { plan: [{ locale: 'fr_FR', text: 'Plan' }, { locale: 'zh-CN', text: 'Plan ZH' }], store: [{ locale: 'fr-FR', text: 'Store' }] },
    { locales: ['fr-FR', 'zh-Hans'] },
  );
  assert.deepEqual(v.locales.map((l) => l.locale), ['fr-FR', 'zh-Hans']);
  assert.equal(v.locales[0]?.from, 'store');
  assert.equal(v.locales[0]?.conflict, true);
  assert.equal(v.locales[1]?.from, 'plan');
});

test('status: empty, partial (a required listing locale has no notes), complete; missing names them', () => {
  assert.equal(notesView('app_store', {}).status, 'empty');
  assert.equal(notesView('app_store', {}, { locales: ['en-US'] }).status, 'empty');
  const partial = notesView('app_store', { plan: [{ locale: 'en-US', text: 'x' }] }, { locales: ['en-US', 'de-DE', 'fr-FR'] });
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.missing, ['de-DE', 'fr-FR']);
  const complete = notesView('app_store', { repo: [{ locale: 'en-US', text: 'x' }, { locale: 'de-DE', text: 'y' }] }, { locales: ['en-US', 'de-DE'] });
  assert.equal(complete.status, 'complete');
  assert.deepEqual(complete.missing, []);
  // blank text is no text
  assert.equal(notesView('app_store', { store: [{ locale: 'en-US', text: '  \n' }, { locale: 'de-DE', text: null }] }).status, 'empty');
  // no required list: any locale with text is enough
  assert.equal(notesView('app_store', { store: [{ locale: 'en-US', text: 'x' }] }).status, 'complete');
});

test('the limit is the store\'s (500 Play, 4000 App Store) and the count is code points: 480 with 30 emoji is NOT over', () => {
  const emoji = `${'x'.repeat(450)}${'\u{1F600}'.repeat(30)}`;
  const play = notesView('google_play', { store: [{ locale: 'en-US', text: emoji }, { locale: 'de-DE', text: 'y'.repeat(501) }] });
  assert.equal(play.locales.find((l) => l.locale === 'en-US')?.length, 480);
  assert.equal(play.locales.find((l) => l.locale === 'en-US')?.limit, 500);
  assert.deepEqual(play.over, ['de-DE']);
  const apple = notesView('app_store', { store: [{ locale: 'de-DE', text: 'y'.repeat(501) }] });
  assert.deepEqual(apple.over, []);
  assert.equal(apple.locales[0]?.limit, 4000);
});

test('plan notes keyed by the default fallback stay their own row', () => {
  const v = notesView('app_store', { plan: [{ locale: 'default', text: 'All' }] });
  assert.deepEqual(v.locales.map((l) => l.locale), ['default']);
});
