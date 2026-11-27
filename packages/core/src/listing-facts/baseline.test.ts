import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUnchangedStaged, stagedBaselineOf } from './baseline.ts';
import { type CopyChannel, storeCopyView } from './copy.ts';

/**
 * The ONE staged-text baseline (audit listing.md F2): the editable draft when there is one, else live. Both scenarios of the audit.
 */

const live: CopyChannel = {
  channel: 'live',
  locales: { 'en-US': { release_notes: 'Bug fixes', subtitle: 'Live sub' } },
};
const draft = (notes: string): CopyChannel => ({
  channel: 'editable',
  locales: { 'en-US': { release_notes: notes } },
});
const baseline = (channels: CopyChannel[], field = 'release_notes') =>
  stagedBaselineOf(storeCopyView(channels, { intent: 'editable' }), 'en-US', field);

test('staged equals the LIVE text but the draft was edited: it is NOT unchanged (a push would change the draft); before it was "not pending"', () => {
  const b = baseline([live, draft('New in the draft')]);
  assert.deepEqual(b, { value: 'New in the draft', from: 'editable' });
  assert.equal(isUnchangedStaged('Bug fixes', b), false);
});

test('staged equals the DRAFT text while live differs (a stale snapshot said "changed"): unchanged', () => {
  const b = baseline([live, draft('Draft notes')]);
  assert.equal(isUnchangedStaged('Draft notes', b), true);
  assert.equal(isUnchangedStaged('Draft notes\r\n', b), true);
});

test('no draft at all (Google Play, an app with no version in preparation): the live text is the baseline', () => {
  const b = baseline([live]);
  assert.deepEqual(b, { value: 'Bug fixes', from: 'live' });
  assert.equal(isUnchangedStaged('Bug fixes', b), true);
  assert.equal(isUnchangedStaged('Other', b), false);
});

test('a field the draft does not hold has no baseline even when live has it: it is a change, not "unchanged"', () => {
  const b = baseline([live, draft('x')], 'subtitle');
  assert.equal(b, null);
  assert.equal(isUnchangedStaged('Live sub', b), false);
});

test('no baseline: never unchanged; a plain string baseline is accepted; empty staged text vs empty baseline is unchanged', () => {
  assert.equal(isUnchangedStaged('x', null), false);
  assert.equal(isUnchangedStaged('x\n', 'x'), true);
  assert.equal(isUnchangedStaged('', ''), true);
  assert.equal(baseline([]), null);
});
