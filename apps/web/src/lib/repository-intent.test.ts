import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearChangeSetReview, peekChangeSetReview, requestChangeSetReview, reviewHref, takeChangeSetReview } from './repository-intent.ts';

test('a requested review is taken once, then it is gone', () => {
  clearChangeSetReview();
  assert.equal(takeChangeSetReview(), null);
  requestChangeSetReview({ repositoryId: 'r1', changeSetId: 'c1' });
  assert.deepEqual(peekChangeSetReview(), { repositoryId: 'r1', changeSetId: 'c1' });
  assert.deepEqual(takeChangeSetReview(), { repositoryId: 'r1', changeSetId: 'c1' });
  assert.equal(takeChangeSetReview(), null);
});

test('a later request replaces an earlier one, and clearing forgets it', () => {
  requestChangeSetReview({ repositoryId: 'r1', changeSetId: 'c1' });
  requestChangeSetReview({ repositoryId: 'r2', changeSetId: 'c2' });
  assert.deepEqual(takeChangeSetReview(), { repositoryId: 'r2', changeSetId: 'c2' });
  requestChangeSetReview({ repositoryId: 'r3', changeSetId: 'c3' });
  clearChangeSetReview();
  assert.equal(peekChangeSetReview(), null);
});

test('what is returned cannot change the waiting intent', () => {
  requestChangeSetReview({ repositoryId: 'r1', changeSetId: 'c1' });
  const peeked = peekChangeSetReview();
  if (peeked) peeked.changeSetId = 'other';
  assert.deepEqual(takeChangeSetReview(), { repositoryId: 'r1', changeSetId: 'c1' });
  assert.equal(reviewHref, '#/repositories');
});
