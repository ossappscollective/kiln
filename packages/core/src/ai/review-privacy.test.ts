import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultReviewAiPolicy,
  maskName,
  normalizeReviewAiPolicy,
  type ReviewForAi,
  redactReviewText,
  resolveReviewAiPolicy,
  shapeReviewForAi,
} from './review-privacy.ts';

const review = (over: Partial<ReviewForAi> = {}): ReviewForAi => ({
  rating: 2,
  title: 'Broken, mail me jo@example.com',
  body: 'Hi I am Marie Curie. Call +33 6 12 34 56 78 or see https://evil.example/x?a=1 and www.foo.bar, DM @marie_c today.',
  authorName: 'Marie Curie',
  language: 'en',
  appVersion: '3.2.1',
  createdAt: Date.UTC(2026, 10, 3, 12),
  ...over,
});

test('every combination of the workspace ceiling and the app choice', () => {
  const cases: [boolean, 'on' | 'off' | null, boolean, string | null, boolean][] = [
    [true, null, true, null, false],
    [true, 'on', true, null, false],
    [true, 'off', false, 'app_off', false],
    [false, null, false, 'workspace_off', true],
    [false, 'on', false, 'workspace_off', true],
    [false, 'off', false, 'workspace_off', true],
  ];
  for (const [ceiling, choice, allowed, reason, locked] of cases) {
    const stored = { ...defaultReviewAiPolicy(), ownReviews: choice, competitorReviews: choice };
    const eff = resolveReviewAiPolicy({ ownReviews: ceiling, competitorReviews: ceiling }, stored);
    for (const k of [eff.own, eff.competitor]) {
      assert.equal(k.allowed, allowed);
      assert.equal(k.reason, reason);
      assert.equal(k.locked, locked);
      assert.equal(k.choice, choice);
    }
  }
  const mixed = resolveReviewAiPolicy({ ownReviews: true, competitorReviews: false }, defaultReviewAiPolicy());
  assert.equal(mixed.own.allowed, true);
  assert.equal(mixed.competitor.allowed, false);
});

test('the default sends text only, redacted, and follows the workspace', () => {
  assert.deepEqual(defaultReviewAiPolicy(), { ownReviews: null, competitorReviews: null, detail: 'text', redact: true });
});

test('redaction replaces emails, phones, links, handles and the name', () => {
  const out = redactReviewText(review().body, 'Marie Curie');
  assert.ok(!out.includes('Marie') && !out.includes('+33') && !out.includes('evil.example') && !out.includes('foo.bar') && !out.includes('@marie_c'));
  assert.ok(out.includes('[name]') && out.includes('[number]') && out.includes('[link]') && out.includes('[handle]'));
  assert.equal(redactReviewText('mail jo@example.com now', null), 'mail [email] now');
  assert.equal(redactReviewText('hi @bob_1 and @x', null), 'hi [handle] and @x');
  assert.equal(redactReviewText('no personal data, 5 stars', null), 'no personal data, 5 stars');
});

test('an email is not taken for a handle and a short name is left alone', () => {
  assert.equal(redactReviewText('a@b.co', 'Al'), '[email]');
  assert.equal(maskName('Al was here', 'Al'), 'Al was here');
});

test('text mode: no name, no language, version or day; redacted', () => {
  const out = shapeReviewForAi(review(), { detail: 'text', redact: true }, { titleChars: 80, textChars: 280 });
  assert.deepEqual(Object.keys(out).sort(), ['stars', 'text', 'title']);
  assert.ok(!JSON.stringify(out).includes('Marie') && !JSON.stringify(out).includes('example.com'));
});

test('full mode adds language, version and day, still no name', () => {
  const out = shapeReviewForAi(review(), { detail: 'full', redact: true }, { titleChars: 80, textChars: 280 });
  assert.equal(out.lang, 'en');
  assert.equal(out.version, '3.2.1');
  assert.equal(out.day, '2026-11-03');
  assert.ok(!JSON.stringify(out).includes('Marie'));
});

test('ratings mode sends the stars and nothing else', () => {
  assert.deepEqual(shapeReviewForAi(review(), { detail: 'ratings', redact: true }, { titleChars: 80, textChars: 280 }), { stars: 2 });
});

test('with redaction off the text stays but the reviewer name is still masked', () => {
  const out = shapeReviewForAi(review(), { detail: 'text', redact: false }, { titleChars: 80, textChars: 280 });
  assert.ok(out.text?.includes('https://evil.example'));
  assert.ok(!out.text?.includes('Marie'));
});

test('text is cut to the limits', () => {
  const out = shapeReviewForAi(review({ body: 'x'.repeat(500) }), { detail: 'text', redact: true }, { titleChars: 80, textChars: 280 });
  assert.equal(Array.from(out.text ?? '').length, 280);
});

test('normalize: a missing field keeps its value, a bad one is an issue', () => {
  const base = defaultReviewAiPolicy();
  const ok = normalizeReviewAiPolicy({ ownReviews: 'off', detail: 'ratings' }, base);
  assert.ok(ok.ok && ok.value.ownReviews === 'off' && ok.value.detail === 'ratings' && ok.value.redact === true);
  const back = normalizeReviewAiPolicy({ ownReviews: null }, { ...base, ownReviews: 'off' });
  assert.ok(back.ok && back.value.ownReviews === null);
  const bad = normalizeReviewAiPolicy({ ownReviews: 'maybe', detail: 'all', redact: 'yes' }, base);
  assert.ok(!bad.ok && bad.issues.length === 3);
});
