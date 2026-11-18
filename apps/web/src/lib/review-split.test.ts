import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_FIND_PAGES,
  appReviewHref,
  isReviewsAddress,
  moveSelection,
  resolveSelection,
  reviewFromHash,
  rowByline,
  rowDate,
  rowReplyText,
  rowTitle,
  shouldFindMore,
  shouldWriteAddress,
  statusTone,
  withReview,
} from './review-split.ts';

const ids = ['a', 'b', 'c'];

test('the review of an address is read and validated', () => {
  assert.equal(reviewFromHash('#/reviews?review=abc_1-2'), 'abc_1-2');
  assert.equal(reviewFromHash('#/reviews?rating=1%2C2&review=x9'), 'x9');
  assert.equal(reviewFromHash('#/portfolio/app1/reviews?platform=ios&review=r1'), 'r1');
  assert.equal(reviewFromHash('#/reviews'), null);
  assert.equal(reviewFromHash('#/reviews?review='), null);
  assert.equal(reviewFromHash('#/reviews?review=a%20b'), null);
  assert.equal(reviewFromHash('#/reviews?review=<script>'), null);
  assert.equal(reviewFromHash(`#/reviews?review=${'a'.repeat(101)}`), null);
});

test('the review is set in an address and the rest stays', () => {
  assert.equal(withReview('#/reviews', 'r1'), '#/reviews?review=r1');
  assert.equal(withReview('#/reviews?rating=1', 'r1'), '#/reviews?rating=1&review=r1');
  assert.equal(withReview('#/reviews?review=old&rating=1', 'new'), '#/reviews?review=new&rating=1');
  assert.equal(withReview('#/reviews?review=old', null), '#/reviews');
  assert.equal(withReview('#/reviews?review=old&rating=1', null), '#/reviews?rating=1');
  assert.equal(withReview('#/portfolio/a1/reviews?platform=ios', 'r2'), '#/portfolio/a1/reviews?platform=ios&review=r2');
  assert.equal(withReview('#/reviews', 'not valid'), '#/reviews');
  assert.equal(reviewFromHash(withReview('#/reviews?q=hello', 'r3')), 'r3');
});

test('the link from the inbox opens the app on the review', () => {
  assert.equal(appReviewHref('app 1', 'r1', 'android'), '#/portfolio/app%201/reviews?platform=android&review=r1');
  assert.equal(appReviewHref('a', 'r1'), '#/portfolio/a/reviews?review=r1');
  assert.equal(appReviewHref('a', 'bad id'), '#/portfolio/a/reviews');
});

test('the selection is the asked review, else the first, else none', () => {
  assert.equal(resolveSelection(ids, 'b'), 'b');
  assert.equal(resolveSelection(ids, 'zzz'), 'a');
  assert.equal(resolveSelection(ids, null), 'a');
  assert.equal(resolveSelection([], 'a'), null);
});

test('moving the selection stays inside the list', () => {
  assert.equal(moveSelection(ids, 'a', 'next'), 'b');
  assert.equal(moveSelection(ids, 'c', 'next'), 'c');
  assert.equal(moveSelection(ids, 'a', 'previous'), 'a');
  assert.equal(moveSelection(ids, 'c', 'previous'), 'b');
  assert.equal(moveSelection(ids, 'b', 'first'), 'a');
  assert.equal(moveSelection(ids, 'b', 'last'), 'c');
  assert.equal(moveSelection(ids, null, 'next'), 'a');
  assert.equal(moveSelection(ids, 'gone', 'next'), 'a');
  assert.equal(moveSelection(ids, 'b', 'triage'), 'b');
  assert.equal(moveSelection([], 'a', 'next'), null);
});

test('more pages are read only to find the asked review, and not forever', () => {
  assert.equal(shouldFindMore(ids, 'zzz', true, 0), true);
  assert.equal(shouldFindMore(ids, 'a', true, 0), false);
  assert.equal(shouldFindMore(ids, null, true, 0), false);
  assert.equal(shouldFindMore(ids, 'zzz', false, 0), false);
  assert.equal(shouldFindMore(ids, 'zzz', true, MAX_FIND_PAGES), false);
});

test('the address is rewritten only for a settled selection that differs', () => {
  assert.equal(shouldWriteAddress('a', null, true), true);
  assert.equal(shouldWriteAddress('a', 'a', true), false);
  assert.equal(shouldWriteAddress('a', 'b', false), false);
  assert.equal(shouldWriteAddress(null, 'b', true), false);
});

test('a row shows the title, else the first line of the text, on one line', () => {
  assert.equal(rowTitle({ title: ' Great ', body: 'x' }), 'Great');
  assert.equal(rowTitle({ title: null, body: '\n\n  First line  \nsecond' }), 'First line');
  assert.equal(rowTitle({ title: '', body: '' }), 'No text');
  const long = rowTitle({ title: null, body: 'word '.repeat(60) });
  assert.ok(long.length <= 90 && long.endsWith('…'));
});

test('the byline skips what is missing', () => {
  assert.equal(rowByline({ authorName: 'Anna', territory: 'de' }), 'Anna · DE');
  assert.equal(rowByline({ authorName: null, territory: 'us' }), 'US');
  assert.equal(rowByline({ authorName: ' ', territory: null }), '');
});

test('the reply text says where the reply stands', () => {
  const base = { developerResponse: null, reply: undefined, replyDraft: null };
  assert.equal(rowReplyText(base), '');
  assert.equal(rowReplyText({ ...base, developerResponse: { body: 'thanks', at: 1, state: null } }), 'Answered');
  assert.equal(rowReplyText({ ...base, reply: { status: 'draft', sentAt: null } }), 'Draft');
  assert.equal(rowReplyText({ ...base, reply: { status: 'failed', sentAt: null } }), 'Send failed');
  assert.equal(rowReplyText({ ...base, reply: { status: 'sent', sentAt: 5 }, developerResponse: { body: 'x', at: 1, state: null } }), 'Reply sent');
});

test('status tones follow the badge of the card', () => {
  assert.equal(statusTone('new'), 'info');
  assert.equal(statusTone('ignored'), 'neutral');
  assert.equal(statusTone('replied_in_console'), 'ok');
  assert.equal(statusTone('triaged'), 'accent');
});

test('a row date is short', () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  assert.equal(rowDate(now - 10_000, now), 'now');
  assert.equal(rowDate(now - 5 * 60_000, now), '5m');
  assert.equal(rowDate(now - 3 * 3_600_000, now), '3h');
  assert.equal(rowDate(now - 4 * 86_400_000, now), '4d');
  assert.match(rowDate(now - 30 * 86_400_000, now), /^May \d+$/);
  assert.match(rowDate(now - 400 * 86_400_000, now), /\d{4}/);
});

test('only the reviews screens carry a selected review', () => {
  assert.equal(isReviewsAddress('#/reviews'), true);
  assert.equal(isReviewsAddress('#/reviews?review=a'), true);
  assert.equal(isReviewsAddress('#/portfolio/a1/reviews?platform=ios'), true);
  assert.equal(isReviewsAddress('#/portfolio/a1/reviews'), true);
  assert.equal(isReviewsAddress('#/portfolio/a1'), false);
  assert.equal(isReviewsAddress('#/portfolio/a1/releases?review=a'), false);
  assert.equal(isReviewsAddress('#/reviewsx'), false);
});
