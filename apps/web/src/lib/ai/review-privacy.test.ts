import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewAiEffective, ReviewAiPolicyStored } from '@kiln/core';
import { isPrivacyDirty, lockedText, previewJson, privacyChanges, privacySettingHref, privacyToForm, reviewAiGate, workspaceAiSettingHref, type ReviewPayloadPreview } from './review-privacy.ts';

const stored = (over: Partial<ReviewAiPolicyStored> = {}): ReviewAiPolicyStored => ({ ownReviews: null, competitorReviews: null, detail: 'text', redact: true, ...over });
const side = (allowed: boolean, reason: 'workspace_off' | 'app_off' | null = null, locked = false) => ({ choice: null, allowed, locked, reason });
const effective = (over: Partial<ReviewAiEffective> = {}): ReviewAiEffective =>
  ({ own: side(true), competitor: side(false, 'workspace_off', true), detail: 'text', redact: true, ...over }) as ReviewAiEffective;

test('the form mirrors what is saved and null reads as inherit', () => {
  assert.deepEqual(privacyToForm({ stored: stored() }), { own: 'inherit', competitor: 'inherit', detail: 'text', redact: true });
  assert.deepEqual(privacyToForm({ stored: stored({ ownReviews: 'off', competitorReviews: 'on', detail: 'ratings', redact: false }) }), {
    own: 'off',
    competitor: 'on',
    detail: 'ratings',
    redact: false,
  });
});

test('only what differs is sent, and inherit is null', () => {
  const view = { stored: stored({ ownReviews: 'off' }) };
  const form = privacyToForm(view);
  assert.deepEqual(privacyChanges(view, form), {});
  assert.equal(isPrivacyDirty(view, form), false);
  assert.deepEqual(privacyChanges(view, { ...form, own: 'inherit', redact: false }), { ownReviews: null, redact: false });
  assert.deepEqual(privacyChanges(view, { ...form, competitor: 'on', detail: 'full' }), { competitorReviews: 'on', detail: 'full' });
  assert.equal(isPrivacyDirty(view, { ...form, detail: 'ratings' }), true);
});

test('the gate opens, closes with the reason, or says ratings only', () => {
  assert.equal(reviewAiGate(null).state, 'open');
  assert.equal(reviewAiGate({ effective: effective() }).state, 'open');
  const app = reviewAiGate({ effective: effective({ own: side(false, 'app_off') }) });
  assert.ok(app.state === 'off' && app.reason === 'app_off' && app.text.length > 0);
  const ws = reviewAiGate({ effective: effective({ own: side(false, 'workspace_off', true) }) });
  assert.ok(ws.state === 'off' && ws.reason === 'workspace_off');
  assert.notEqual(app.state === 'off' && ws.state === 'off' ? app.text : '', ws.state === 'off' ? ws.text : '');
  assert.equal(reviewAiGate({ effective: effective({ detail: 'ratings' }) }).state, 'ratings');
  assert.equal(reviewAiGate({ effective: effective({ own: side(false, 'app_off'), detail: 'ratings' }) }).state, 'off');
});

test('a choice locked by the workspace says so, an open one says nothing', () => {
  assert.notEqual(lockedText('competitor', { effective: effective() }), '');
  assert.equal(lockedText('own', { effective: effective() }), '');
});

test('the links and the preview JSON', () => {
  assert.equal(privacySettingHref('a b'), '#/portfolio/a%20b/settings?section=ai-privacy');
  assert.equal(workspaceAiSettingHref, '#/settings?view=ai');
  const preview = { allowed: true, reason: null, detail: 'text', redact: true, reviews: [{ rating: 5, text: 'x' }], sampleOf: 1 } as unknown as ReviewPayloadPreview;
  assert.deepEqual(JSON.parse(previewJson(preview)), [{ rating: 5, text: 'x' }]);
});
