import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  type ReviewTranslation,
  canTranslate,
  chunkIds,
  isRetryable,
  needsTranslation,
  privacyNote,
  translatableIds,
  translationCaption,
  translationErrorMessage,
} from './review-translation.ts';

const review = (id: string, over: Partial<{ title: string | null; body: string; language: string | null }> = {}) => ({
  id,
  title: null,
  body: 'Hallo',
  language: 'de',
  ...over,
});

test('needsTranslation: text in another language, or in an unknown one', () => {
  assert.equal(needsTranslation(review('a'), 'en'), true);
  assert.equal(needsTranslation(review('a', { language: 'en' }), 'en'), false);
  assert.equal(needsTranslation(review('a', { language: 'en-GB' }), 'en'), false, 'region does not matter');
  assert.equal(needsTranslation(review('a', { language: 'pt_BR' }), 'pt'), false);
  assert.equal(needsTranslation(review('a', { language: null }), 'en'), true, 'the provider detects it');
  assert.equal(needsTranslation(review('a', { body: '  ', title: null }), 'en'), false, 'no text');
  assert.equal(needsTranslation(review('a', { body: '', title: 'Gut' }), 'en'), true);
});

test('translatableIds: those that need it, in order, at most one request', () => {
  const list = [review('a'), review('b', { language: 'en' }), review('c'), review('d', { body: '' })];
  assert.deepEqual(translatableIds(list, 'en'), ['a', 'c']);
  assert.deepEqual(translatableIds(list, 'en', 1), ['a']);
  const many = Array.from({ length: 40 }, (_, i) => review(`r${i}`));
  assert.equal(translatableIds(many, 'en').length, 25);
  assert.deepEqual(chunkIds(['a', 'b', 'c'], 2), [['a', 'b'], ['c']]);
  assert.deepEqual(chunkIds([]), []);
  assert.equal(chunkIds(many.map((r) => r.id)).length, 2);
});

test('roles: members translate, viewers do not', () => {
  assert.equal(canTranslate('viewer'), false);
  assert.equal(canTranslate('member'), true);
  assert.equal(canTranslate('admin'), true);
  assert.equal(canTranslate('owner'), true);
});

test('captions say what it is, from which language and by whom', () => {
  const t: ReviewTranslation = { reviewId: 'r', body: 'Hello', provider: 'google', cached: false, detectedSource: 'de' };
  assert.equal(translationCaption(t, null), 'Machine translation from German by Google Cloud Translation.');
  assert.equal(translationCaption({ ...t, detectedSource: undefined, cached: true }, 'fr'), 'Machine translation from French by Google Cloud Translation (kept from an earlier request).');
  assert.equal(translationCaption({ ...t, detectedSource: undefined }, null), 'Machine translation by Google Cloud Translation.');
  assert.match(privacyNote('google'), /sent to Google/);
  assert.match(privacyNote('libretranslate'), /address you enter/);
});

test('error messages: fixed, plain, and with the numbers of the budget', () => {
  const err = (status: number, code: string, body: Record<string, unknown> = {}, message = 'server message') => new ApiError(status, code, message, undefined, body);
  assert.match(translationErrorMessage(err(422, 'translation_not_configured', { reason: 'disabled' })), /turned off/);
  assert.match(translationErrorMessage(err(422, 'translation_not_configured', { reason: 'no_credential' })), /not fully set up/);
  assert.match(translationErrorMessage(err(429, 'translation_budget', { used: 49000, budget: 50000 })), /49,000 of 50,000/);
  assert.match(translationErrorMessage(err(429, 'translation_budget')), /00:00 UTC/);
  assert.equal(translationErrorMessage(err(422, 'translation_auth', {}, 'The provider did not accept the key.')), 'The provider did not accept the key.');
  assert.match(translationErrorMessage(err(403, 'forbidden')), /member or admin/);
  assert.equal(translationErrorMessage(new Error('x')), 'Something went wrong. Try again.');
  assert.equal(isRetryable(err(502, 'translation_unavailable')), true);
  assert.equal(isRetryable(err(422, 'translation_auth')), false);
  assert.equal(isRetryable(new Error('x')), false);
});
