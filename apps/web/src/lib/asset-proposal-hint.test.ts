import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ProposalSummary, proposalHint, proposalHintText } from './asset-proposal-hint.ts';

const base: ProposalSummary = { available: true, reason: null, version: '1.1', track: null, state: 'open', count: 3, texts: 2, graphics: 1, locked: false, cached: true, computedAt: 1 };

test('a proposal that exists, is not skipped and has a repository is drawn with its count', () => {
  assert.deepEqual(proposalHint(base, true), { count: 3, texts: 2, graphics: 1 });
  assert.deepEqual(proposalHint({ ...base, state: 'later' }, true), { count: 3, texts: 2, graphics: 1 }, 'remind later still shows the line');
});

test('nothing is drawn without a repository, while unknown, unavailable, skipped or empty', () => {
  assert.equal(proposalHint(base, false), null);
  assert.equal(proposalHint(null, true), null);
  assert.equal(proposalHint({ ...base, available: false, reason: 'busy', count: 0 }, true), null);
  assert.equal(proposalHint({ ...base, state: 'skipped' }, true), null);
  assert.equal(proposalHint({ ...base, count: 0 }, true), null);
});

test('the words: one and many', () => {
  assert.equal(proposalHintText(1), '1 store asset change proposed');
  assert.equal(proposalHintText(3), '3 store asset changes proposed');
});
