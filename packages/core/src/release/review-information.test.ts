import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockersOf, fixKindOf } from '../listing/draft-readiness.ts';
import {
  emptyReviewDetail,
  evaluateReviewInformation,
  maskedReviewSummary,
  mergeReviewDetail,
  type ReviewDetail,
  reviewDetailHasContent,
  reviewFactsOf,
  reviewSourceOrder,
} from './review-information.ts';

const full = (): ReviewDetail => ({
  text: {
    contactFirstName: 'Marie',
    contactLastName: 'Girard',
    contactPhone: '+33 1 23 45 67 89',
    contactEmail: 'marie@example.test',
    demoAccountName: 'reviewer',
    demoAccountPassword: 'hunter2',
    notes: 'Open the settings tab.',
  },
  demoAccountRequired: true,
});

test('facts hold presence only, whitespace counts as blank', () => {
  const d = full();
  d.text.contactPhone = '   ';
  const facts = reviewFactsOf(d);
  assert.equal(facts.exists, true);
  assert.equal(facts.contactPhone, false);
  assert.equal(facts.contactEmail, true);
  assert.ok(!JSON.stringify(facts).includes('Marie'));
  assert.deepEqual(Object.keys(reviewFactsOf(null)).sort(), Object.keys(facts).sort());
  assert.equal(reviewFactsOf(null).exists, false);
});

test('no_review_contact: no detail, blank fields, whitespace only; complete is clean; not read is silent', () => {
  assert.deepEqual(evaluateReviewInformation(undefined), []);
  assert.deepEqual(evaluateReviewInformation(null), []);
  assert.deepEqual(evaluateReviewInformation(reviewFactsOf(full())), []);
  const none = evaluateReviewInformation(reviewFactsOf(null));
  assert.equal(none.length, 1);
  assert.equal(none[0]?.code, 'no_review_contact');
  assert.equal(none[0]?.severity, 'blocking');
  assert.equal(none[0]?.params?.missing, 'contactFirstName,contactLastName,contactPhone,contactEmail');
  const blanks = full();
  blanks.text.contactFirstName = '  \t';
  blanks.text.contactEmail = '';
  const some = evaluateReviewInformation(reviewFactsOf(blanks));
  assert.equal(some[0]?.params?.missing, 'contactFirstName,contactEmail');
  assert.match(some[0]?.message ?? '', /first name, email address are missing/);
  assert.ok(!(some[0]?.message ?? '').includes('Girard'));
  const one = full();
  one.text.contactPhone = null;
  assert.match(evaluateReviewInformation(reviewFactsOf(one))[0]?.message ?? '', /phone number is missing/);
});

test('no_review_demo_account only when a demo account is required and its credentials are blank', () => {
  const d = full();
  d.text.demoAccountPassword = ' ';
  const found = evaluateReviewInformation(reviewFactsOf(d));
  assert.deepEqual(found.map((f) => f.code), ['no_review_demo_account']);
  assert.equal(found[0]?.params?.missing, 'demoAccountPassword');
  d.demoAccountRequired = false;
  assert.deepEqual(evaluateReviewInformation(reviewFactsOf(d)), []);
  d.demoAccountRequired = null;
  assert.deepEqual(evaluateReviewInformation(reviewFactsOf(d)), []);
  const both = evaluateReviewInformation(reviewFactsOf({ ...emptyReviewDetail(), demoAccountRequired: true }));
  assert.deepEqual(both.map((f) => f.code), ['no_review_contact', 'no_review_demo_account']);
});

test('the new codes are blockers whose fix is the review information', () => {
  assert.equal(fixKindOf('no_review_contact'), 'review');
  assert.equal(fixKindOf('no_review_demo_account'), 'review');
  const blockers = blockersOf({ id: 'a1', platform: 'ios' }, evaluateReviewInformation(reviewFactsOf(null)));
  assert.equal(blockers[0]?.fix.kind, 'review');
  assert.equal(blockers[0]?.fix.href, null);
});

test('merge into no detail copies every filled attribute and the demo flag', () => {
  const m = mergeReviewDetail(null, full());
  assert.equal(m.fieldsCopied, 8);
  assert.equal(m.attributes.contactFirstName, 'Marie');
  assert.equal(m.attributes.demoAccountRequired, true);
});

test('merge never overwrites a filled value and copies blanks only', () => {
  const target = emptyReviewDetail();
  target.text.contactFirstName = 'Paul';
  target.text.notes = '   ';
  target.demoAccountRequired = false;
  const m = mergeReviewDetail(target, full());
  assert.equal(m.attributes.contactFirstName, undefined);
  assert.equal(m.attributes.contactLastName, 'Girard');
  assert.equal(m.attributes.notes, 'Open the settings tab.');
  // the target has some text, so its `false` is its own answer
  assert.equal(m.attributes.demoAccountRequired, undefined);
  assert.equal(m.fieldsCopied, 6);
});

test('merge: an untouched default false is replaced, a complete target and a blank source change nothing', () => {
  const blank = { ...emptyReviewDetail(), demoAccountRequired: false };
  assert.equal(mergeReviewDetail(blank, full()).attributes.demoAccountRequired, true);
  assert.equal(mergeReviewDetail(full(), full()).fieldsCopied, 0);
  assert.equal(mergeReviewDetail(full(), emptyReviewDetail()).fieldsCopied, 0);
  assert.equal(mergeReviewDetail(null, emptyReviewDetail()).fieldsCopied, 0);
  assert.equal(reviewDetailHasContent(blank), false);
});

test('source order: live first, then the rest newest first, the target left out, at most four', () => {
  const v = (id: string, versionString: string | null, state: string, editable = false) => ({ id, versionString, state, editable });
  const order = reviewSourceOrder(
    [
      v('t', '2.0.1', 'PREPARE_FOR_SUBMISSION', true),
      v('a', '1.9.0', 'REPLACED_WITH_NEW_VERSION'),
      v('b', '1.19.0', 'READY_FOR_SALE'),
      v('c', '1.20.0', 'IN_REVIEW'),
      v('d', '1.8', 'READY_FOR_SALE'),
      v('e', null, 'REMOVED_FROM_SALE'),
      v('f', '1.1.0', 'REJECTED', true),
    ],
    't',
  );
  assert.deepEqual(order.map((x) => x.id), ['b', 'd', 'c', 'a']);
});

test('the masked summary holds initials and yes/no only', () => {
  const s = maskedReviewSummary(full());
  assert.deepEqual(s, { contact: 'M. G.', phone: true, email: true, demoAccount: 'required', demoCredentials: true, notes: true });
  const text = JSON.stringify(s);
  for (const secret of ['Marie', 'Girard', '+33', 'example.test', 'reviewer', 'hunter2', 'settings']) assert.ok(!text.includes(secret));
  assert.equal(maskedReviewSummary(emptyReviewDetail()).contact, null);
  assert.equal(maskedReviewSummary({ ...emptyReviewDetail(), text: { ...emptyReviewDetail().text, contactLastName: 'élise' } }).contact, 'É.');
});
