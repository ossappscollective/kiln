import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssetProposalView, ProposalIssue, ProposalItem } from '@kiln/core';
import { cardMode, defaultSelection, idsToStage, issueGroups, refsLine, resultLine, selectedWithErrors, summaryLine } from './asset-proposal.ts';

const text = (field: string, hasErrors = false): ProposalItem => ({ id: `text:en-US:${field}`, kind: 'text', locale: 'en-US', field, before: null, after: 'x', hasErrors });
const issue = (severity: ProposalIssue['severity'], code: string, itemId: string | null = null): ProposalIssue => ({
  id: `${itemId}:${code}`,
  itemId,
  source: 'listing_check',
  severity,
  code,
  locale: 'en-US',
  field: null,
  params: {},
  message: null,
});
const view = (over: Partial<AssetProposalView> = {}): AssetProposalView => ({
  appId: 'a',
  platform: 'ios',
  version: '1.1',
  unavailable: null,
  state: { state: 'open', at: null },
  locked: { locked: false, reason: null, liveVersion: null },
  baseRef: { sha: 'b'.repeat(40), source: 'previous_build' },
  targetRef: { sha: 'c'.repeat(40), source: 'build' },
  noPreviousRelease: false,
  storeUnread: false,
  changes: [text('keywords', true), text('promotional_text')],
  alreadyStaged: [],
  issues: [],
  summary: { texts: 2, locales: 1, graphics: 0, errors: 1, warnings: 0, tips: 0 },
  skipped: { unchangedSinceRelease: 0, sameAsStore: 0, notStageable: 0 },
  notes: [],
  ...over,
});

test('the items without errors are checked, the ones with errors are not', () => {
  assert.deepEqual(defaultSelection(view().changes), ['text:en-US:promotional_text']);
  assert.deepEqual(selectedWithErrors(view().changes, ['text:en-US:keywords', 'text:en-US:promotional_text']), ['text:en-US:keywords']);
  assert.deepEqual(selectedWithErrors(view().changes, ['text:en-US:promotional_text']), []);
});

test('the findings are read errors first, then warnings; tips are kept apart', () => {
  const g = issueGroups([issue('tip', 'underused', 'a'), issue('warning', 'keywords_duplicate', 'a'), issue('error', 'too_long', 'b'), issue('error', 'empty', 'a')]);
  assert.deepEqual(g.errors.map((i) => i.code), ['too_long', 'empty']);
  assert.deepEqual(g.warnings.map((i) => i.code), ['keywords_duplicate']);
  assert.deepEqual(g.tips.map((i) => i.code), ['underused']);
});

test('which form the card takes', () => {
  assert.equal(cardMode(null), 'hidden');
  assert.equal(cardMode(view({ unavailable: 'no_repository', changes: [] })), 'hidden');
  assert.equal(cardMode(view({ changes: [] })), 'hidden', 'nothing changed');
  assert.equal(cardMode(view({ changes: [], alreadyStaged: [{ id: 'x', kind: 'text', locale: 'en-US', field: 'f', state: 'same' }] })), 'all_staged');
  assert.equal(cardMode(view()), 'proposal');
  assert.equal(cardMode(view({ locked: { locked: true, reason: 'live', liveVersion: '1.0' } })), 'locked');
  assert.equal(cardMode(view({ state: { state: 'later', at: 1 } })), 'later');
  assert.equal(cardMode(view({ state: { state: 'skipped', at: 1 }, locked: { locked: true, reason: 'live', liveVersion: '1.0' } })), 'skipped', 'a skip is remembered');
});

test('only ids of the card are sent, in the order of the card; results are counted', () => {
  assert.deepEqual(idsToStage(view(), ['text:en-US:promotional_text', 'made-up', 'text:en-US:keywords']), ['text:en-US:keywords', 'text:en-US:promotional_text']);
  assert.deepEqual(resultLine([{ status: 'staged' }, { status: 'already_staged' }, { status: 'kept_edited' }, { status: 'failed' }]), { staged: 1, left: 2, failed: 1 });
});

test('the summary and the compared refs are written for the language', () => {
  assert.equal(summaryLine({ texts: 2, locales: 1, graphics: 1, errors: 0, warnings: 0, tips: 0 }), '2 texts in 1 language and 1 graphics set');
  assert.equal(summaryLine({ texts: 0, locales: 0, graphics: 3, errors: 0, warnings: 0, tips: 0 }), '3 graphics sets');
  assert.match(refsLine(view()) ?? '', /bbbbbbb.*ccccccc/);
  assert.match(refsLine(view({ baseRef: null })) ?? '', /ccccccc/);
  assert.equal(refsLine(view({ targetRef: null })), null);
});
