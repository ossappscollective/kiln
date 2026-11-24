import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { seedWorkspace } from '../../testkit.ts';
import { type AiBoot, bootAi } from './test-helpers.ts';

/**
 * The per-app choice of what reviews may go to the AI provider (docs/adr/0065): the workspace ceiling, the app's choice, what is sent,
 * redaction, the refusal of the endpoint, the audit trail, the preview, deleting summaries and the workspace boundary. The model is a fake.
 */

const usage = { inputTokens: 900, outputTokens: 300 };
/** Just before the fake clock of bootAi (2026-11-15), so the reviews are inside every period. */
const RECENT = Date.UTC(2026, 10, 14);
const MAIL = 'Contact me at pat@example.com or +33 6 12 34 56 78, see https://evil.example/x, @patty on X. Pat Reviewer here.';

async function setup(t: AiBoot) {
  await t.ready();
  const appId = await t.addApp('ios');
  const id = await t.seedReview(appId, MAIL, { rating: 1, title: 'Broken pat@example.com', author: 'Pat Reviewer', language: 'fr-FR' });
  await t.db.execute('UPDATE app_reviews SET created_at = ? WHERE id = ?', [RECENT, id]);
  const answer = () => t.answer({ output: { overview: 'Fine.', changes: '', themes: [{ label: 'Crash', kind: 'issue', summary: 'It crashes.', refs: ['r1'] }] }, usage });
  const put = (body: Record<string, unknown>) => t.call(t.owner, 'PUT', `/apps/${appId}/ai/review-privacy`, body);
  const sent = () => JSON.stringify(t.fake.calls.at(-1)?.input);
  return { appId, answer, put, sent };
}

dbTest('the default follows the workspace, sends text only and redacts', async (db) => {
  const t = await bootAi(db);
  const { appId, answer, sent } = await setup(t);
  const got = await t.call(t.owner, 'GET', `/apps/${appId}/ai/review-privacy`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.stored, { ownReviews: null, competitorReviews: null, detail: 'text', redact: true });
  assert.equal(got.body.effective.own.allowed, true);
  assert.equal(got.body.effective.competitor.allowed, false, 'the workspace default for competitor reviews is off');
  assert.equal(got.body.canEdit, true);
  answer();
  const res = await t.run('review_summary', { appId });
  assert.equal(res.status, 201, res.text);
  const s = sent();
  assert.ok(!/pat@example|\+33 6|evil\.example|@patty|Pat Reviewer|Pat\b/.test(s), s);
  assert.ok(s.includes('[email]') && s.includes('[number]') && s.includes('[link]') && s.includes('[handle]') && s.includes('[name]'));
  assert.ok(!s.includes('"lang"') && !s.includes('"version"') && !s.includes('"day"'), 'text only: no language, version or day');
});

dbTest('app off: the run is refused with ai_reviews_disabled, nothing is sent, the old summary stays', async (db) => {
  const t = await bootAi(db);
  const { appId, answer, put } = await setup(t);
  answer();
  const first = await t.run('review_summary', { appId });
  assert.equal(first.status, 201);
  const calls = t.fake.calls.length;
  const off = await put({ ownReviews: 'off' });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.body.effective.own.reason, 'app_off');
  for (const task of ['review_summary', 'review_classify', 'fix_next']) {
    const refused = await t.run(task, { appId });
    assert.equal(refused.status, 409, task);
    assert.equal(refused.body.error, 'ai_reviews_disabled');
    assert.equal(refused.body.reason, 'app_off');
    assert.equal(refused.body.code, 'ai.reviewsDisabledApp');
  }
  const same = await t.run('review_summary', { appId, refresh: false });
  assert.equal(same.status, 409, 'the stored summary is not handed out through a run either');
  const preview = await t.call(t.owner, 'POST', `/ai/tasks/review_summary/preview`, { appId });
  assert.equal(preview.status, 409);
  assert.equal(t.fake.calls.length, calls, 'nothing reached the model');
  const list = await t.call(t.owner, 'GET', `/apps/${appId}/ai/suggestions?task=review_summary`);
  assert.equal(list.body.suggestions.length, 1, 'past summaries stay visible');
  assert.equal((await put({ ownReviews: null })).status, 200);
  answer();
  assert.equal((await t.run('review_summary', { appId, refresh: true })).status, 201, 'back to following the workspace');
});

dbTest('the workspace ceiling: an app cannot turn on what the workspace turned off', async (db) => {
  const t = await bootAi(db);
  const { appId, answer, put } = await setup(t);
  assert.equal((await t.configure({ reviewsToAi: false })).status, 200);
  const on = await put({ ownReviews: 'on' });
  assert.equal(on.status, 200);
  assert.equal(on.body.stored.ownReviews, 'on', 'the choice is kept');
  assert.deepEqual([on.body.effective.own.allowed, on.body.effective.own.locked, on.body.effective.own.reason], [false, true, 'workspace_off']);
  answer();
  const refused = await t.run('review_summary', { appId });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, 'workspace_off');
  assert.equal(refused.body.code, 'ai.reviewsDisabledWorkspace');
  assert.equal(t.fake.calls.length, 0);
  assert.equal((await t.configure({ reviewsToAi: true })).status, 200);
  assert.equal((await t.run('review_summary', { appId })).status, 201);
});

dbTest('competitor reviews: workspace ceiling, app choice and the gate every future task must call', async (db) => {
  const t = await bootAi(db);
  const { appId, put } = await setup(t);
  const { gateCompetitorReviews, getAppReviewPolicy } = await import('./ai-review-policy.ts');
  const gate = async () => gateCompetitorReviews((await getAppReviewPolicy(db, t.workspaceId, appId)).effective);
  assert.equal((await gate())?.body.error, 'ai_reviews_disabled', 'off in the workspace by default');
  await t.configure({ competitorReviewsToAi: true });
  assert.equal(await gate(), null);
  await put({ competitorReviews: 'off' });
  assert.equal((await gate())?.body.reason, 'app_off');
  await put({ competitorReviews: 'on' });
  assert.equal(await gate(), null);
  await t.configure({ competitorReviewsToAi: false });
  assert.equal((await gate())?.body.reason, 'workspace_off');
});

dbTest('what is sent: full adds the language; ratings sends no text and the summary is statistical', async (db) => {
  const t = await bootAi(db);
  const { appId, answer, put, sent } = await setup(t);
  await put({ detail: 'full' });
  answer();
  assert.equal((await t.run('review_summary', { appId })).status, 201);
  assert.ok(/"lang":"fr-FR"/.test(sent()), 'full carries the language');
  assert.ok(!/Pat Reviewer|pat@example/.test(sent()), 'still no name and no email');

  await put({ detail: 'ratings' });
  t.answer({ output: { overview: 'Mostly low.', changes: 'ignored', themes: [{ label: 'Made up', kind: 'issue', summary: 'x', refs: ['r1'] }] }, usage });
  const res = await t.run('review_summary', { appId });
  assert.equal(res.status, 201, res.text);
  const s = sent();
  assert.ok(!/Broken|pat@|evil|Contact|"text"|"title"|"reviews":\[\{/i.test(s), s);
  assert.ok(s.includes('ratings_only') && s.includes('starCounts'));
  const p = res.body.suggestion.proposal;
  assert.equal(p.detail, 'ratings');
  assert.deepEqual(p.themes, [], 'a statistical summary has no themes, whatever the model wrote');
  assert.equal(p.analysed, 0);
  assert.equal(p.reviewCount, 1);
  assert.equal(p.sentiment.negative, 1);
  // tasks that need text refuse
  const need = await t.run('fix_next', { appId });
  assert.equal(need.status, 409);
  assert.equal(need.body.error, 'ai_reviews_need_text');
  assert.equal((await t.run('review_classify', { appId })).body.error, 'ai_reviews_need_text');
});

dbTest('redaction off keeps links and emails in the text but never the reviewer name', async (db) => {
  const t = await bootAi(db);
  const { appId, answer, put, sent } = await setup(t);
  await put({ redact: false });
  answer();
  assert.equal((await t.run('review_summary', { appId })).status, 201);
  assert.ok(sent().includes('evil.example'));
  assert.ok(!/Pat Reviewer/.test(sent()));
  // a different policy is different data: not the stored summary of the redacted run
  await put({ redact: true });
  answer();
  const again = await t.run('review_summary', { appId });
  assert.equal(again.body.cached, false);
});

dbTest('reply drafts follow the same policy', async (db) => {
  const t = await bootAi(db);
  const { appId, put } = await setup(t);
  const reviewId = (await t.db.query('SELECT id FROM app_reviews WHERE app_id = ?', [appId]))[0]?.id as string;
  t.answer({ output: { reply: 'Thanks for telling us.' }, usage });
  assert.equal((await t.run('review_reply_draft', { appId, reviewId })).status, 201);
  assert.ok(!/pat@example|Pat Reviewer|evil\.example/.test(JSON.stringify(t.fake.calls.at(-1)?.input)));
  await put({ ownReviews: 'off' });
  const refused = await t.run('review_reply_draft', { appId, reviewId });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'ai_reviews_disabled');
});

dbTest('changes are audited with who and from to; a bad body and a viewer are refused', async (db) => {
  const t = await bootAi(db);
  const { appId, put } = await setup(t);
  assert.equal((await put({ ownReviews: 'off', detail: 'ratings' })).status, 200);
  assert.equal((await put({ ownReviews: 'off', detail: 'ratings' })).status, 200, 'no change, no second entry');
  const rows = await db.query("SELECT actor_id, detail FROM audit_events WHERE action = 'ai.review_policy_update'");
  assert.equal(rows.length, 1);
  const detail = JSON.parse(String(rows[0]?.detail));
  assert.deepEqual(detail.changes, [
    { field: 'ownReviews', from: null, to: 'off' },
    { field: 'detail', from: 'text', to: 'ratings' },
  ]);
  assert.ok(String(rows[0]?.actor_id).length > 0, 'who');
  assert.equal((await put({ detail: 'everything' })).status, 400);
  assert.equal((await put({ unknown: true })).status, 400);
  const viewer = await t.addMember('viewer');
  assert.equal((await t.call(viewer, 'PUT', `/apps/${appId}/ai/review-privacy`, { ownReviews: 'on' })).status, 403);
  const member = await t.addMember('member');
  assert.equal((await t.call(member, 'GET', `/apps/${appId}/ai/review-privacy`)).body.canEdit, false);
  assert.equal((await t.call(member, 'PUT', `/apps/${appId}/ai/review-privacy`, { ownReviews: 'on' })).status, 403);
});

dbTest('the preview shows the first three reviews as they would be sent, reading no provider', async (db) => {
  const t = await bootAi(db);
  const { appId, put } = await setup(t);
  for (const body of ['two', 'three', 'four']) await t.seedReview(appId, `${body} mail a@b.co`, { rating: 3 });
  const res = await t.call(t.owner, 'POST', `/apps/${appId}/ai/review-privacy/preview`);
  assert.equal(res.status, 200, res.text);
  const p = res.body.preview;
  assert.equal(p.reviews.length, 3);
  assert.equal(p.sampleOf, 3);
  assert.equal(p.detail, 'text');
  assert.ok(!/@b\.co|Pat Reviewer|pat@example/.test(JSON.stringify(p)));
  assert.equal(t.fake.calls.length, 0);
  await put({ detail: 'ratings' });
  const ratings = (await t.call(t.owner, 'POST', `/apps/${appId}/ai/review-privacy/preview`)).body.preview;
  assert.ok(ratings.reviews.every((r: Record<string, unknown>) => Object.keys(r).join() === 'stars'));
  await put({ ownReviews: 'off' });
  const off = (await t.call(t.owner, 'POST', `/apps/${appId}/ai/review-privacy/preview`)).body.preview;
  assert.equal(off.allowed, false);
  assert.equal(off.reason, 'app_off');
});

dbTest('delete AI summaries removes the summaries of the app only, and is audited', async (db) => {
  const t = await bootAi(db);
  const { appId, answer } = await setup(t);
  const other = await t.addApp('android', 'Other');
  const o = await t.seedReview(other, 'meh', { rating: 2 });
  await t.db.execute('UPDATE app_reviews SET created_at = ? WHERE id = ?', [RECENT, o]);
  answer();
  assert.equal((await t.run('review_summary', { appId })).status, 201);
  answer();
  const second = await t.run('review_summary', { appId: other });
  assert.equal(second.status, 201, second.text);
  const del = await t.call(t.owner, 'DELETE', `/apps/${appId}/ai/summaries`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, 1);
  assert.equal((await t.call(t.owner, 'GET', `/apps/${appId}/ai/suggestions?task=review_summary`)).body.suggestions.length, 0);
  assert.equal((await t.call(t.owner, 'GET', `/apps/${other}/ai/suggestions?task=review_summary`)).body.suggestions.length, 1);
  const rows = await db.query("SELECT detail FROM audit_events WHERE action = 'ai.summaries_delete'");
  assert.equal(JSON.parse(String(rows[0]?.detail)).deleted, 1);
  const viewer = await t.addMember('viewer');
  assert.equal((await t.call(viewer, 'DELETE', `/apps/${other}/ai/summaries`)).status, 403);
});

dbTest('another workspace gets 404 on every route, and an app of another workspace is not found', async (db) => {
  const t = await bootAi(db);
  const { appId } = await setup(t);
  const other = await seedWorkspace(db, 'Other', 'other@example.com', Date.now());
  const call = (cookie: string, workspaceId: string, method: string, path: string, body?: unknown) =>
    t.app.request(`/api/workspaces/${workspaceId}${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const paths: [string, string, unknown?][] = [
    ['GET', `/apps/${appId}/ai/review-privacy`],
    ['PUT', `/apps/${appId}/ai/review-privacy`, { ownReviews: 'off' }],
    ['POST', `/apps/${appId}/ai/review-privacy/preview`],
    ['DELETE', `/apps/${appId}/ai/summaries`],
  ];
  for (const [method, path, body] of paths) {
    assert.equal((await call(other.cookie, t.workspaceId, method, path, body)).status, 404, `not a member: ${method} ${path}`);
    assert.equal((await call(other.cookie, other.workspaceId, method, path, body)).status, 404, `not their app: ${method} ${path}`);
  }
  const mine = await t.call(t.owner, 'GET', `/apps/${appId}/ai/review-privacy`);
  assert.equal(mine.body.stored.ownReviews, null, 'nothing of theirs touched ours');
});
