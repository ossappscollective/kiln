import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COPY_INTENT_CONSUMERS, type CopyChannel, copyText, pickCopy, storeCopyView } from './copy.ts';

/**
 * The channel intent, once (audit listing.md F1/F2). Scenario: iOS app, live 1.0 and a draft 1.1; fr-FR exists only in the draft; de-DE
 * only live. Five pages used to give five locale lists.
 */

const live: CopyChannel = {
  channel: 'live',
  locales: {
    'en-US': { name: 'Live', keywords: 'live,words', release_notes: 'Live notes' },
    'de-DE': { name: 'Live DE' },
    default: { name: 'fallback' },
  },
};
const draft: CopyChannel = {
  channel: 'editable',
  locales: {
    'en-US': { name: 'Draft', keywords: 'draft,words' },
    'fr-FR': { name: 'Draft FR' },
    es: {},
  },
};

test('shown: the union of locales; each from the LIVE copy when it has it, else the draft (the Listing grid, Insights, ASO, pull)', () => {
  const view = storeCopyView([live, draft], { intent: 'shown' });
  assert.deepEqual(view.codes, ['de-DE', 'en-US', 'es', 'fr-FR']);
  assert.equal(pickCopy(view, 'en-US')?.from, 'live');
  assert.equal(pickCopy(view, 'en-US')?.fields.name, 'Live');
  assert.deepEqual(pickCopy(view, 'en-US')?.held, ['live', 'editable']);
  assert.equal(pickCopy(view, 'fr-FR')?.from, 'editable');
  assert.deepEqual(pickCopy(view, 'fr-FR')?.held, ['editable']);
  assert.equal(pickCopy(view, 'de-DE')?.from, 'live');
  // the empty localization is kept; the default fallback folder is not a locale
  assert.deepEqual(pickCopy(view, 'es')?.fields, {});
  assert.equal(view.codes.includes('default'), false);
  assert.deepEqual(view.channels, { live: true, editable: true });
});

test('editable: the draft only (a push writes into it); the live copy only stands in when there is no draft at all', () => {
  const view = storeCopyView([live, draft], { intent: 'editable' });
  assert.deepEqual(view.codes, ['en-US', 'es', 'fr-FR']);
  assert.equal(pickCopy(view, 'en-US')?.fields.name, 'Draft');
  assert.equal(pickCopy(view, 'de-DE'), undefined);
  const noDraft = storeCopyView([live], { intent: 'editable' });
  assert.deepEqual(noDraft.codes, ['de-DE', 'en-US']);
  assert.equal(pickCopy(noDraft, 'en-US')?.from, 'live');
  assert.deepEqual(noDraft.channels, { live: true, editable: false });
});

test('live: only what is in users\' hands; a locale only the draft has is absent; no fallback to the draft', () => {
  const view = storeCopyView([live, draft], { intent: 'live' });
  assert.deepEqual(view.codes, ['de-DE', 'en-US']);
  assert.equal(pickCopy(view, 'fr-FR'), undefined);
  const first = storeCopyView([draft], { intent: 'live' });
  assert.deepEqual(first.codes, []);
});

test('the same locale across the stores is one locale: Play zh-CN is found by an App Store zh-Hans, and fr_FR by fr-FR', () => {
  const view = storeCopyView(
    [{ channel: 'live', locales: { 'zh-CN': { title: 'T' }, 'fr-FR': { title: 'F' } } }],
    { intent: 'shown' },
  );
  assert.equal(pickCopy(view, 'zh-Hans')?.locale, 'zh-CN');
  assert.equal(pickCopy(view, 'fr_FR')?.locale, 'fr-FR');
  assert.equal(pickCopy(view, 'fr'), undefined);
  // two spellings in the two copies are ONE row
  const both = storeCopyView(
    [{ channel: 'live', locales: { 'zh-Hans': { a: '1' } } }, { channel: 'editable', locales: { 'zh-CN': { a: '2' } } }],
    { intent: 'shown' },
  );
  assert.equal(both.locales.length, 1);
  assert.deepEqual(both.locales[0]?.held, ['live', 'editable']);
});

test('copyText reads one field; null for a missing locale or field; the input is never mutated', () => {
  const channels = [live, draft];
  const before = JSON.stringify(channels);
  const view = storeCopyView(channels, { intent: 'shown' });
  assert.equal(copyText(view, 'en-US', 'keywords'), 'live,words');
  assert.equal(copyText(view, 'en-US', 'subtitle'), null);
  assert.equal(copyText(view, 'ja', 'name'), null);
  assert.equal(JSON.stringify(channels), before);
});

test('every consumer is assigned to ONE intent', () => {
  const all = Object.values(COPY_INTENT_CONSUMERS).flat();
  assert.equal(new Set(all).size, all.length);
  assert.ok(COPY_INTENT_CONSUMERS.editable.includes('staged-baseline'));
  assert.ok(COPY_INTENT_CONSUMERS.shown.includes('listing-grid'));
  assert.ok(COPY_INTENT_CONSUMERS.live.includes('drift-store-column'));
});
