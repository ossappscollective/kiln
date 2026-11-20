import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildsLead, needsAnswerText, reviewsLead } from './page-lead.ts';

test('needsAnswerText says what the person has to do', () => {
  assert.equal(needsAnswerText('5 unanswered, oldest 3 d'), '5 reviews need an answer, oldest 3 d');
  assert.equal(needsAnswerText('1 unanswered (1 star)'), '1 review needs an answer (1 star)');
  assert.equal(needsAnswerText('something else'), 'something else');
});

test('reviewsLead: the first action follows the state', () => {
  assert.equal(reviewsLead({ loaded: false, stored: 0, chip: null }).primary, 'none');
  assert.equal(reviewsLead({ loaded: true, stored: 0, chip: null }).primary, 'none');
  const open = reviewsLead({ loaded: true, stored: 40, chip: { text: '2 unanswered' } });
  assert.deepEqual(open, { headline: '2 reviews need an answer', tone: 'warn', primary: 'show' });
  const done = reviewsLead({ loaded: true, stored: 40, chip: null });
  assert.deepEqual(done, { headline: 'No review is waiting for an answer', tone: 'ok', primary: 'read' });
});

test('buildsLead counts builds and the ones without a run', () => {
  assert.equal(buildsLead(0, 0).headline, 'No builds yet');
  assert.deepEqual(buildsLead(1, 0), { headline: '1 build, each matched to a CI run', tone: 'ok' });
  assert.deepEqual(buildsLead(12, 3), { headline: '12 builds, 3 without a CI run', tone: 'info' });
});
