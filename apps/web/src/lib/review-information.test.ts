import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewSummary } from '@kiln/core';
import { ApiError } from './api.ts';
import { useLocale } from './i18n/test-setup.ts';
import {
  carryLine,
  classifyReviewCopyFailure,
  copyLabel,
  isReviewCode,
  type ReviewInformationView,
  reviewFromParam,
  summaryText,
} from './review-information.ts';

useLocale('en');

const FULL: ReviewSummary = {
  contact: 'M. G.',
  phone: true,
  email: true,
  demoAccount: 'required',
  demoCredentials: true,
  notes: true,
};

test('the masked line: initials, phone and email present, demo account, notes, and nothing else', () => {
  assert.equal(
    summaryText(FULL),
    'Contact: M. G., phone and email present. Demo account: required, credentials present. Notes: present.',
  );
  assert.equal(
    summaryText({
      contact: null,
      phone: true,
      email: false,
      demoAccount: 'not_required',
      demoCredentials: false,
      notes: false,
    }),
    'Contact: no name, phone present, no email. Demo account: not required.',
  );
  assert.equal(
    summaryText({
      contact: 'É.',
      phone: false,
      email: true,
      demoAccount: 'required',
      demoCredentials: false,
      notes: false,
    }),
    'Contact: É., email present, no phone. Demo account: required, credentials missing.',
  );
  assert.equal(
    summaryText({
      contact: 'A.',
      phone: false,
      email: false,
      demoAccount: 'unknown',
      demoCredentials: false,
      notes: false,
    }),
    'Contact: A., no phone, no email.',
  );
  assert.equal(summaryText(null), '');
});

const view = (over: Partial<ReviewInformationView>): ReviewInformationView => ({
  outcome: 'created',
  from: '1.19.0',
  fieldsCopied: 8,
  summary: FULL,
  ...over,
});

test('the create form says what will be carried over (masked) and what was', () => {
  assert.equal(
    carryLine(view({}), 'preview'),
    'App Review Information is carried over from 1.19.0. Contact: M. G., phone and email present. Demo account: required, credentials present. Notes: present.',
  );
  assert.equal(
    carryLine(view({}), 'result'),
    'App Review Information was carried over from 1.19.0.',
  );
  assert.equal(
    carryLine(view({ outcome: 'merged' }), 'result'),
    'App Review Information was carried over from 1.19.0.',
  );
  assert.equal(
    carryLine(view({ outcome: 'already_complete' }), 'result'),
    'The new version already had its App Review Information.',
  );
  assert.equal(carryLine(view({ outcome: 'already_complete' }), 'preview'), null);
  assert.match(
    carryLine(view({ outcome: 'no_source', from: null, summary: null }), 'preview') ?? '',
    /No earlier version has App Review Information/,
  );
  // after the create the server's warning says it, so the line would repeat it
  assert.equal(
    carryLine(view({ outcome: 'no_source', from: null, summary: null }), 'result'),
    null,
  );
  assert.equal(
    carryLine(
      view({ outcome: 'failed', from: null, summary: null, code: 'store_rejected' }),
      'result',
    ),
    null,
  );
  assert.match(
    carryLine(view({ outcome: 'failed', from: null, summary: null }), 'preview') ?? '',
    /could not be read/,
  );
  assert.equal(carryLine(null, 'preview'), null);
  assert.equal(carryLine(undefined, 'result'), null);
  assert.equal(carryLine(view({ outcome: 'not_read' }), 'result'), null);
});

test('no sentence of this module can carry a value: only initials and yes/no go in', () => {
  const text = [
    summaryText(FULL),
    carryLine(view({}), 'preview'),
    carryLine(view({}), 'result'),
    copyLabel('1.19.0'),
  ].join(' ');
  for (const secret of ['Marie', 'Girard', '@', '+33', 'Tr0ub4dor'])
    assert.ok(!text.includes(secret));
});

test('the button names the version it copies from, or the previous one', () => {
  assert.equal(copyLabel('1.19.0'), 'Copy review information from 1.19.0');
  assert.equal(copyLabel(null), 'Copy review information from the previous version');
  assert.equal(copyLabel(''), 'Copy review information from the previous version');
});

test('the codes and the version a blocker names', () => {
  assert.equal(isReviewCode('no_review_contact'), true);
  assert.equal(isReviewCode('no_review_demo_account'), true);
  assert.equal(isReviewCode('no_build'), false);
  assert.equal(reviewFromParam({ missing: 'contactPhone', from: '1.19.0' }), '1.19.0');
  assert.equal(reviewFromParam({ missing: 'contactPhone' }), null);
  assert.equal(reviewFromParam(undefined), null);
  assert.equal(reviewFromParam({ from: 3 }), null);
});

test('the answers of the copy: disabled, state changed with the new preview, refused by the store, a step-up, anything else', () => {
  assert.equal(
    classifyReviewCopyFailure(new ApiError(409, 'store_draft_disabled', 'off')).kind,
    'disabled',
  );
  const next = {
    canCopy: true,
    reviewInformation: { outcome: 'merged', from: '1.19.0', fieldsCopied: 2, summary: null },
    version: { versionString: '2.0.1', state: 'PREPARE_FOR_SUBMISSION' },
    confirmHash: 'a'.repeat(64),
    note: '',
  };
  const changed = classifyReviewCopyFailure(
    new ApiError(409, 'state_changed', 'x', undefined, { preview: next }),
  );
  assert.equal(changed.kind, 'state_changed');
  assert.equal(changed.kind === 'state_changed' ? changed.next?.canCopy : null, true);
  assert.match(
    classifyReviewCopyFailure(new ApiError(502, 'store_rejected', 'x')).message,
    /did not accept the review information/,
  );
  assert.match(
    classifyReviewCopyFailure(new ApiError(403, 'forbidden', 'x')).message,
    /admin or owner/,
  );
  assert.match(
    classifyReviewCopyFailure(new ApiError(403, 'step_up_required', 'x')).message,
    /confirmation/,
  );
  assert.equal(
    classifyReviewCopyFailure(
      new ApiError(409, 'no_editable_version', 'There is no editable App Store version.'),
    ).message,
    'There is no editable App Store version.',
  );
  assert.match(classifyReviewCopyFailure(new Error('network')).message, /request failed/);
});
