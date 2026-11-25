import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api.ts';
import {
  canSendDraft,
  checkReply,
  confirmFacts,
  draftChanged,
  insertTemplateText,
  isLocked,
  lengthState,
  limitFor,
  needsReload,
  normalizeReplyText,
  previewTemplate,
  publicWarning,
  REPLY_ENV,
  type ReplyDraft,
  replyAvailability,
  replyErrorMessage,
  replyStatusLabel,
  replyStatusTone,
  statusExplanation,
} from './reply.ts';

const config = {
  enabled: true,
  envName: REPLY_ENV,
  limits: { appstoreconnect: 5000, googleplay: 350 },
};

const draft = (over: Partial<ReplyDraft> = {}): ReplyDraft => ({
  id: 'd1',
  reviewId: 'r1',
  appId: 'a1',
  store: 'googleplay',
  text: 'Thanks!',
  textHash: 'h'.repeat(64),
  length: 7,
  limit: 350,
  status: 'draft',
  errorCode: null,
  evidence: null,
  createdBy: 'u',
  updatedBy: 'u',
  createdAt: 1,
  updatedAt: 1,
  sentAt: null,
  sentBy: null,
  storeResponseId: null,
  ...over,
});

const apiError = (code: string, message = 'm', body: Record<string, unknown> = {}) =>
  new ApiError(409, code, message, undefined, { message, ...body });

test('the text is normalized as the server does: LF line breaks, trimmed', () => {
  assert.equal(normalizeReplyText('  a\r\nb\rc \n'), 'a\nb\nc');
});

test('checkReply explains the same problems the server refuses', () => {
  assert.deepEqual(checkReply('Hello', 10), { ok: true });
  assert.equal(checkReply('  \n', 10).ok, false);
  const problem = (text: string, limit = 10) => {
    const r = checkReply(text, limit);
    return r.ok ? null : r.problem;
  };
  assert.equal(problem(''), 'empty');
  assert.equal(problem('x'.repeat(11)), 'too_long');
  assert.equal(problem('a\tb'), 'control_characters');
  assert.equal(problem('a\u202eb'), 'control_characters');
  assert.equal(problem('<b>x</b>'), 'markup');
  assert.equal(problem('a < b and c > d', 50), null, 'a comparison is not markup');
  assert.equal(problem('line\nbreak'), null);
});

test('the counter counts the normalized text and warns near the limit', () => {
  assert.deepEqual(lengthState('hello', 350), {
    count: 5,
    limit: 350,
    remaining: 345,
    over: false,
    tone: 'ok',
    label: '5 of 350 characters',
  });
  assert.equal(lengthState('x'.repeat(340), 350).tone, 'warn');
  assert.equal(lengthState('x'.repeat(350), 350).tone, 'warn');
  const over = lengthState('x'.repeat(355), 350);
  assert.deepEqual([over.over, over.tone, over.label], [true, 'bad', '5 over the limit of 350']);
  assert.equal(lengthState('  a\r\nb  ', 350).count, 3, 'CRLF counts once, edges do not count');
  assert.equal(limitFor(config, 'googleplay'), 350);
  assert.equal(limitFor(config, 'appstoreconnect'), 5000);
});

test('draftChanged compares the normalized text with the saved draft', () => {
  assert.equal(draftChanged(null, ''), false);
  assert.equal(draftChanged(null, 'a'), true);
  assert.equal(draftChanged(draft(), 'Thanks!  '), false);
  assert.equal(draftChanged(draft(), 'Thanks'), true);
});

test('availability: off names the env var, rights explain who can do what', () => {
  assert.equal(replyAvailability(null, 'owner').state, 'loading');
  const off = replyAvailability({ enabled: false, envName: REPLY_ENV }, 'owner');
  assert.deepEqual([off.canDraft, off.canSend, off.state], [false, false, 'off']);
  assert.ok(off.reason?.includes('KILN_REVIEW_REPLY_ENABLED=true'));
  const viewer = replyAvailability(config, 'viewer');
  assert.deepEqual([viewer.canDraft, viewer.canSend, viewer.state], [false, false, 'rights']);
  const member = replyAvailability(config, 'member');
  assert.deepEqual([member.canDraft, member.canSend, member.state], [true, false, 'rights']);
  assert.match(member.reason ?? '', /admin or owner/);
  for (const role of ['admin', 'owner'] as const) {
    const a = replyAvailability(config, role);
    assert.deepEqual([a.canDraft, a.canSend, a.reason, a.state], [true, true, null, 'ready']);
  }
});

test('statuses: labels, tones, locking and explanations', () => {
  assert.equal(replyStatusLabel('none'), 'No reply');
  assert.equal(replyStatusLabel('unknown'), 'Outcome unknown');
  assert.equal(replyStatusTone('sent'), 'ok');
  assert.equal(replyStatusTone('failed'), 'bad');
  assert.equal(replyStatusTone('unknown'), 'warn');
  assert.equal(isLocked('sending'), true);
  assert.equal(isLocked('unknown'), true);
  for (const status of ['none', 'draft', 'failed', 'sent'] as const)
    assert.equal(isLocked(status), false);
  assert.equal(statusExplanation({ status: 'draft', errorCode: null }), null);
  assert.match(statusExplanation({ status: 'unknown', errorCode: null }) ?? '', /not sent again/);
  assert.match(statusExplanation({ status: 'failed', errorCode: 'x' }) ?? '', /draft is kept/);
});

test('the confirmation shows store, app, review, count and the exact text with the warning', () => {
  const facts = confirmFacts({
    store: 'googleplay',
    appName: 'Alpha',
    review: { rating: 1, authorName: 'Sam', createdAt: 1 },
    draft: { text: 'Exact text\nsecond line', length: 22, limit: 350 },
    replacing: false,
  });
  assert.deepEqual(facts.rows, [
    { label: 'Store', value: 'Google Play' },
    { label: 'App', value: 'Alpha' },
    { label: 'Review', value: '1 out of 5 stars by Sam' },
    { label: 'Length', value: '22 of 350 characters' },
  ]);
  assert.equal(facts.text, 'Exact text\nsecond line');
  assert.equal(
    facts.warning,
    'This will be published publicly in the store and cannot be recalled by this tool.',
  );
  assert.equal(publicWarning(), facts.warning);
  const replacing = confirmFacts({
    store: 'appstoreconnect',
    appName: 'Beta',
    review: { rating: 5, authorName: null, createdAt: 1 },
    draft: { text: 'x', length: 1, limit: 5000 },
    replacing: true,
  });
  assert.equal(replacing.rows[0]?.value, 'App Store');
  assert.match(replacing.rows[2]?.value ?? '', /anonymous reviewer/);
  assert.equal(replacing.rows.at(-1)?.label, 'Replaces');
});

test('the send button needs a saved draft that fits, rights, and the acknowledgement', () => {
  const admin = replyAvailability(config, 'admin');
  const member = replyAvailability(config, 'member');
  const ok = { draft: draft(), unsavedChanges: false, acknowledged: true, availability: admin };
  assert.equal(canSendDraft(ok), true);
  assert.equal(canSendDraft({ ...ok, acknowledged: false }), false);
  assert.equal(
    canSendDraft({ ...ok, unsavedChanges: true }),
    false,
    'the saved text is what is sent',
  );
  assert.equal(canSendDraft({ ...ok, availability: member }), false);
  assert.equal(canSendDraft({ ...ok, draft: null }), false);
  assert.equal(canSendDraft({ ...ok, draft: draft({ length: 400 }) }), false);
  assert.equal(canSendDraft({ ...ok, draft: draft({ length: 0 }) }), false);
  assert.equal(canSendDraft({ ...ok, draft: draft({ status: 'sending' }) }), false);
  assert.equal(canSendDraft({ ...ok, draft: draft({ status: 'sent' }) }), false);
  assert.equal(
    canSendDraft({ ...ok, draft: draft({ status: 'failed' }) }),
    true,
    'a failed send may be sent again',
  );
  assert.equal(
    canSendDraft({ ...ok, draft: draft({ status: 'unknown' }) }),
    true,
    'sending again checks first',
  );
});

test('error messages: each code says what happened and what is safe', () => {
  assert.match(replyErrorMessage(apiError('reply_disabled')), /KILN_REVIEW_REPLY_ENABLED=true/);
  assert.match(replyErrorMessage(apiError('forbidden'), 'send'), /admin or owner/);
  assert.match(replyErrorMessage(apiError('forbidden'), 'draft'), /member/);
  assert.match(replyErrorMessage(apiError('stale_draft')), /changed/);
  assert.match(replyErrorMessage(apiError('already_sent')), /Nothing was sent again/);
  assert.match(replyErrorMessage(apiError('send_in_progress')), /being sent/);
  assert.match(replyErrorMessage(apiError('outcome_unknown')), /Nothing was sent again/);
  assert.equal(
    replyErrorMessage(apiError('send_failed', 'x', { message: 'Apple said no.' })),
    'The reply was not published. Apple said no. The draft is kept.',
  );
  assert.equal(
    replyErrorMessage(apiError('invalid_reply', 'x', { message: 'The reply is empty.' })),
    'The reply is empty.',
  );
  assert.equal(
    replyErrorMessage(apiError('store_forbidden', 'x', { message: 'Needs a role.' })),
    'The credential is not allowed to reply to reviews. Needs a role.',
  );
  assert.equal(replyErrorMessage(apiError('something_else', 'Plain message')), 'Plain message');
  assert.match(replyErrorMessage(new Error('x')), /Reload the review/);
  assert.equal(
    replyErrorMessage(apiError('rate_limited', 'Try again in 5 minutes.')),
    'Try again in 5 minutes.',
  );
});

test('which failures call for loading the review again', () => {
  for (const code of [
    'stale_draft',
    'already_sent',
    'send_in_progress',
    'outcome_unknown',
    'send_failed',
    'not_found',
  ])
    assert.equal(needsReload(apiError(code)), true, code);
  for (const code of ['forbidden', 'invalid_reply', 'reply_disabled'])
    assert.equal(needsReload(apiError(code)), false, code);
  assert.equal(needsReload(new Error('x')), false);
});

test('templates: inserting and previewing as plain text', () => {
  assert.equal(insertTemplateText('', 'Hi'), 'Hi');
  assert.equal(insertTemplateText('  First  ', 'Second'), 'First\n\nSecond');
  assert.equal(
    previewTemplate('Hi {{author}} from {{ app }} {{x}}', { author: 'Sam', app: 'Coffee' }),
    'Hi Sam from Coffee {{x}}',
  );
  assert.equal(previewTemplate('Hi {{author}}', { author: null, app: 'A' }), 'Hi there');
  assert.equal(
    previewTemplate('Hi {{author}}', { author: '<b>Al</b>\n\u202eBo', app: 'A' }),
    'Hi b Al /b Bo',
  );
  assert.equal(previewTemplate('{{author}}', { author: 'x'.repeat(100), app: 'A' }).length, 60);
});
