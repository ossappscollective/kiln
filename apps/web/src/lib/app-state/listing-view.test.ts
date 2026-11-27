import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoreCopyViewJson, StoreListingView } from '../types.ts';
import {
  baseLocaleOf,
  copyOf,
  defaultLocaleOf,
  draftOnlyLocales,
  heldOf,
  localesOf,
  noteLocalesOf,
} from './listing-view.ts';

const copy = (
  intent: StoreCopyViewJson['intent'],
  locales: [string, 'live' | 'editable', ('live' | 'editable')[]][],
): StoreCopyViewJson => ({
  intent,
  codes: locales.map((l) => l[0]),
  channels: { live: true, editable: true },
  locales: locales.map(([locale, from, held]) => ({ locale, from, held, fields: {} })),
});

// iOS app, live 1.0 and a draft 1.1; fr-FR only in the draft (audit listing F1).
const view = {
  appId: 'a1',
  platform: 'ios',
  readAt: 1,
  error: null,
  warnings: [],
  channels: [],
  locales: ['en-US', 'fr-FR'],
  copies: {
    shown: copy('shown', [
      ['en-US', 'live', ['live', 'editable']],
      ['fr-FR', 'editable', ['editable']],
    ]),
    editable: copy('editable', [
      ['en-US', 'editable', ['live', 'editable']],
      ['fr-FR', 'editable', ['editable']],
    ]),
    live: copy('live', [['en-US', 'live', ['live', 'editable']]]),
  },
  defaultLocale: { locale: 'de-DE', declared: 'de-DE', source: 'declared', reason: 'declared' },
  drift: null,
} as unknown as StoreListingView;

test('the page, the stepper and the live sentence each ask for their intent and get the same store read', () => {
  assert.deepEqual(localesOf(view), ['en-US', 'fr-FR']);
  assert.deepEqual(
    noteLocalesOf(view),
    ['en-US', 'fr-FR'],
    'the stepper offers the locale only the draft has',
  );
  assert.deepEqual(localesOf(view, 'live'), ['en-US']);
  assert.deepEqual(draftOnlyLocales(view), ['fr-FR']);
  assert.deepEqual(heldOf(view, 'fr-FR'), { from: 'editable', held: ['editable'] });
  assert.equal(heldOf(view, 'ja'), null);
});

test('not read yet: nothing, not a guess', () => {
  assert.deepEqual(localesOf(null), []);
  assert.equal(copyOf(null, 'shown'), null);
  assert.equal(defaultLocaleOf(null), null);
  assert.equal(baseLocaleOf(null), null);
});

test('the base locale is the one the store read decided (the App Store primary locale, not "none")', () => {
  assert.equal(baseLocaleOf(view), 'de-DE');
  assert.equal(defaultLocaleOf(view)?.source, 'declared');
});
