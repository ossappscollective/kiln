import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkPlayProposal,
  PLAY_NOTES_LIMIT,
  type PlayCheckContext,
  type PlayProposal,
  playStateText,
  playStatusOf,
} from './play-release-checks.ts';

const proposal = (over: Partial<PlayProposal> = {}): PlayProposal => ({
  track: 'production',
  releaseName: '2.1',
  versionCodes: ['241'],
  notes: [
    { locale: 'en-US', text: 'Fixes' },
    { locale: 'de-DE', text: 'Korrekturen' },
  ],
  userFraction: 0.1,
  ...over,
});
const context = (over: Partial<PlayCheckContext> = {}): PlayCheckContext => ({
  listingLocales: ['en-US', 'de-DE'],
  trackReleases: [{ name: '2.0', status: 'completed', versionCodes: ['200'] }],
  ...over,
});
const codes = (checks: { code: string }[]) => checks.map((c) => c.code);

test('a good proposal has nothing to say', () => {
  assert.deepEqual(checkPlayProposal(proposal(), context()), []);
});

test('the state follows the share: none is a draft, 100% completed, between is a rollout', () => {
  assert.equal(playStatusOf(null), 'draft');
  assert.equal(playStatusOf(0.1), 'inProgress');
  assert.equal(playStatusOf(1), 'completed');
  assert.match(playStateText('draft', null, 'production'), /goes to nobody/);
  assert.match(playStateText('inProgress', 0.125, 'production'), /12\.5%/);
  assert.match(playStateText('completed', 1, 'production'), /100%.*completed release/);
});

test('release notes are missing for a language that has a listing, and for all languages', () => {
  const checks = checkPlayProposal(
    proposal({ notes: [{ locale: 'en-US', text: 'Fixes' }] }),
    context({ listingLocales: ['en-US', 'fr_FR', 'de-DE'] }),
  );
  assert.deepEqual(codes(checks), ['notes_missing', 'notes_missing']);
  assert.deepEqual(
    checks.map((c) => c.item),
    ['fr_FR', 'de-DE'],
  );
  assert.deepEqual(codes(checkPlayProposal(proposal({ notes: [] }), context())), ['notes_none']);
  // en_US and en-US are the same language.
  assert.deepEqual(
    checkPlayProposal(
      proposal({ notes: [{ locale: 'en_US', text: 'x' }] }),
      context({ listingLocales: ['en-US'] }),
    ),
    [],
  );
});

test('notes over 500 characters are a problem, counted in characters not UTF-16 units', () => {
  const at = 'a'.repeat(PLAY_NOTES_LIMIT);
  assert.deepEqual(
    checkPlayProposal(
      proposal({ notes: [{ locale: 'en-US', text: at }] }),
      context({ listingLocales: [] }),
    ),
    [],
  );
  const emoji = '😀'.repeat(PLAY_NOTES_LIMIT);
  assert.deepEqual(
    checkPlayProposal(
      proposal({ notes: [{ locale: 'en-US', text: emoji }] }),
      context({ listingLocales: [] }),
    ),
    [],
  );
  const over = checkPlayProposal(
    proposal({ notes: [{ locale: 'en-US', text: `${at}b` }] }),
    context({ listingLocales: [] }),
  );
  assert.deepEqual(codes(over), ['notes_over_limit']);
  assert.equal(over[0]?.severity, 'problem');
  assert.equal(over[0]?.item, 'en-US');
});

test('a version code that production already holds is a problem; a lower one is a warning', () => {
  const held = checkPlayProposal(proposal({ versionCodes: ['200'] }), context());
  assert.deepEqual(codes(held), ['code_already_live']);
  const lower = checkPlayProposal(proposal({ versionCodes: ['150'] }), context());
  assert.deepEqual(codes(lower), ['code_not_newer']);
  assert.equal(lower[0]?.severity, 'warning');
  // A draft in the track does not count as held.
  assert.deepEqual(
    checkPlayProposal(
      proposal({ versionCodes: ['150'] }),
      context({ trackReleases: [{ status: 'draft', versionCodes: ['300'] }] }),
    ),
    [],
  );
  assert.deepEqual(codes(checkPlayProposal(proposal({ versionCodes: [] }), context())), [
    'codes_missing',
  ]);
});

test('a share outside 0..1 is a problem; 100% is explained as a completed release', () => {
  for (const bad of [0, -0.1, 1.5, Number.NaN]) {
    assert.deepEqual(
      codes(checkPlayProposal(proposal({ userFraction: bad }), context())),
      ['fraction_out_of_range'],
      String(bad),
    );
  }
  assert.deepEqual(codes(checkPlayProposal(proposal({ userFraction: 1 }), context())), [
    'full_rollout',
  ]);
  assert.deepEqual(checkPlayProposal(proposal({ userFraction: null }), context()), []);
});

test('an empty release name is a warning; problems come first', () => {
  const checks = checkPlayProposal(
    proposal({ releaseName: '  ', versionCodes: ['200'], track: '' }),
    context(),
  );
  assert.deepEqual(codes(checks), ['track_missing', 'code_already_live', 'name_empty']);
  assert.deepEqual(
    checks.map((c) => c.severity),
    ['problem', 'problem', 'warning'],
  );
});
