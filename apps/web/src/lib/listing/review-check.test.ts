import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewLinesOf } from './review-check.ts';

const reading = (codes: string[]) => ({
  reading: {
    ready: codes.length === 0,
    blockers: codes.map((code) => ({
      code,
      message: `${code} message`,
      fix: { kind: code.indexOf('review') >= 0 ? ('review' as const) : ('listing' as const) },
    })),
    unknown: [],
    versionString: '2.0',
    storeReadAt: 1,
  },
  checking: false,
  error: null,
});

test('the review-information blockers of the readiness are the early check; other blockers are not', () => {
  const lines = reviewLinesOf('ios', reading(['no_review_contact', 'missing_text', 'no_review_demo_account']) as never);
  assert.deepEqual(lines.map((l) => l.code), ['no_review_contact', 'no_review_demo_account']);
  assert.equal(lines[0]?.kind, 'review');
  assert.deepEqual(reviewLinesOf('ios', reading([]) as never), []);
  assert.deepEqual(reviewLinesOf('ios', null), []);
});
