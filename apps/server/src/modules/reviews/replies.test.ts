import assert from 'node:assert/strict';
import { StoreError, StoreRateLimitError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { bootReviews, type ReviewsBoot } from './test-helpers.ts';
import {
  checkTemplate,
  hashReplyText,
  plainValue,
  renderTemplate,
} from './replies.ts';
import { deleteReviewData, pruneReviews, purgeOrphanReviewRows } from './service.ts';

const TEXT = 'Thanks for the feedback, SECRET-REPLY-TEXT-42, we will fix it.';
const HOUR = 60 * 60 * 1000;
const rp = (appId: string, reviewId: string, rest = '') =>
  `/apps/${appId}/reviews/${reviewId}${rest}`;
const bidi = String.fromCharCode(0x202e);

/** An app with one review and a draft with TEXT, as the owner. */
async function withDraft(t: ReviewsBoot, text = TEXT, platform: 'ios' | 'android' = 'ios') {
  const appId = await t.addApp(platform);
  const reviewId = await t.seed(appId, platform, 1, { rating: 1 });
  const put = await t.call(t.owner, 'PUT', rp(appId, reviewId, '/reply-draft'), { text });
  assert.equal(put.status, 200, put.text);
  return { appId, reviewId, hash: put.body.draft.textHash as string };
}
const send = (
  t: ReviewsBoot,
  appId: string,
  reviewId: string,
  confirmHash: string,
  cookie = t.owner,
) => t.call(cookie, 'POST', rp(appId, reviewId, '/reply'), { confirmHash });
const draftRow = async (t: ReviewsBoot, reviewId: string) =>
  (
    await t.db.query(
      'SELECT status, error_code, text, evidence, claim_at, sent_by FROM review_reply_drafts WHERE review_id = ?',
      [reviewId],
    )
  )[0];

// ----- the kill switch --------------------------------------------------------------------------

dbTest(
  'kill switch: with replying off every reply route answers 409 reply_disabled, and the config says so',
  async (db) => {
    const t = await bootReviews(db, { reply: { enabled: false } });
    const appId = await t.addApp('ios');
    const reviewId = await t.seed(appId, 'ios', 1);
    const config = await t.call(t.owner, 'GET', '/reviews/reply-config');
    assert.equal(config.status, 200);
    assert.deepEqual(
      [config.body.enabled, config.body.envName],
      [false, 'MRM_REVIEW_REPLY_ENABLED'],
    );
    assert.deepEqual(config.body.limits, { appstoreconnect: 5000, googleplay: 350 });
    const calls: [string, string, unknown?][] = [
      ['PUT', rp(appId, reviewId, '/reply-draft'), { text: 'Hi' }],
      ['DELETE', rp(appId, reviewId, '/reply-draft')],
      ['POST', rp(appId, reviewId, '/reply'), { confirmHash: 'a'.repeat(64) }],
      ['POST', rp(appId, reviewId, '/reply-draft/translate'), { text: 'Hi', target: 'de' }],
      ['POST', '/reviews/reply-templates', { name: 'T', body: 'Hi' }],
      ['PUT', '/reviews/reply-templates/x', { name: 'T', body: 'Hi' }],
      ['DELETE', '/reviews/reply-templates/x'],
    ];
    for (const [method, path, body] of calls) {
      const res = await t.call(t.owner, method, path, body);
      assert.equal(res.status, 409, `${method} ${path}`);
      assert.equal(res.body.error, 'reply_disabled');
      assert.match(res.body.message, /MRM_REVIEW_REPLY_ENABLED=true/);
    }
    assert.equal(t.built.length, 0, 'no store was reached');
    // Reading is unaffected, and the review view carries no draft.
    const view = await t.call(t.owner, 'GET', rp(appId, reviewId));
    assert.equal(view.status, 200);
    assert.deepEqual(view.body.review.reply, { status: 'none', sentAt: null });
    assert.equal(view.body.review.replyDraft, null);
  },
);

// ----- rights -------------------------------------------------------------------------------------

dbTest(
  'rights: members draft, only owners and admins send, viewers do neither, non-members get 404',
  async (db) => {
    const t = await bootReviews(db);
    const appId = await t.addApp('ios');
    const reviewId = await t.seed(appId, 'ios', 1);
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const admin = await t.addMember('admin');
    assert.equal(
      (await t.call(viewer, 'PUT', rp(appId, reviewId, '/reply-draft'), { text: 'Hi' })).status,
      403,
    );
    const drafted = await t.call(member, 'PUT', rp(appId, reviewId, '/reply-draft'), {
      text: 'Hi there',
    });
    assert.equal(drafted.status, 200);
    const hash = drafted.body.draft.textHash as string;
    assert.equal(
      (await send(t, appId, reviewId, hash, member)).status,
      403,
      'drafting is not sending',
    );
    assert.equal((await send(t, appId, reviewId, hash, viewer)).status, 403);
    assert.equal(t.stores.ios.replies.length, 0);
    assert.equal((await send(t, appId, reviewId, hash, admin)).status, 200);
    assert.equal(t.stores.ios.replies.length, 1);
    assert.equal(
      (await send(t, appId, reviewId, hash)).status,
      409,
      'the owner may send too: already sent',
    );

    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    for (const [method, path, body] of [
      ['PUT', rp(appId, reviewId, '/reply-draft'), { text: 'Hi' }],
      ['POST', rp(appId, reviewId, '/reply'), { confirmHash: hash }],
      ['GET', '/reviews/reply-config'],
    ] as const) {
      assert.equal((await t.call(outsider, method, path, body)).status, 404, `${method} ${path}`);
    }
    // The app of one workspace does not exist in another, even for that one's owner.
    assert.equal(
      (await t.call(outsider, 'PUT', rp(appId, reviewId, '/reply-draft'), { text: 'Hi' }, 'other'))
        .status,
      404,
    );
    assert.equal(
      (
        await t.call(
          outsider,
          'POST',
          rp(appId, reviewId, '/reply'),
          { confirmHash: hash },
          'other',
        )
      ).status,
      404,
    );
    assert.equal(t.stores.ios.replies.length, 1);
  },
);

// ----- drafts ---------------------------------------------------------------------------------------

dbTest(
  'draft: created, edited, validated per store, shown in the review and the list, deleted',
  async (db) => {
    const t = await bootReviews(db);
    const appId = await t.addApp('android');
    const ios = await t.addApp('ios');
    const reviewId = await t.seed(appId, 'android', 1);
    const iosReview = await t.seed(ios, 'ios', 1);
    const put = (text: unknown, id = reviewId, app = appId) =>
      t.call(t.owner, 'PUT', rp(app, id, '/reply-draft'), { text });

    const first = await put('Thanks\r\nfor writing  ');
    assert.equal(first.status, 200);
    assert.equal(
      first.body.draft.text,
      'Thanks\nfor writing',
      'normalized: LF line breaks, trimmed',
    );
    assert.equal(first.body.draft.textHash, hashReplyText('Thanks\nfor writing'));
    assert.equal(first.body.draft.limit, 350);
    assert.equal(first.body.draft.status, 'draft');
    const same = await put('Thanks\nfor writing');
    assert.equal(same.body.draft.id, first.body.draft.id);
    assert.equal(
      same.body.draft.updatedAt,
      first.body.draft.updatedAt,
      'the same text changes nothing',
    );
    const edited = await put('Thanks a lot');
    assert.equal(edited.body.draft.id, first.body.draft.id, 'one row per review');
    assert.notEqual(edited.body.draft.textHash, first.body.draft.textHash);
    assert.equal((await db.query('SELECT id FROM review_reply_drafts')).length, 1);

    for (const [text, problem] of [
      ['', 'empty'],
      ['   \n ', 'empty'],
      ['x'.repeat(351), 'too_long'],
      ['tab\there', 'control_characters'],
      [`bidi ${bidi} override`, 'control_characters'],
      ['<b>bold</b>', 'markup'],
    ] as const) {
      const res = await put(text);
      assert.equal(res.status, 422, text.slice(0, 10));
      assert.equal(res.body.error, 'invalid_reply');
      assert.equal(res.body.problem, problem);
    }
    assert.equal((await put('x'.repeat(350))).status, 200);
    assert.equal(
      (await put('x'.repeat(351), iosReview, ios)).status,
      200,
      'the App Store limit is larger',
    );
    assert.equal(
      (await t.call(t.owner, 'PUT', rp(appId, reviewId, '/reply-draft'), {})).status,
      400,
    );
    assert.equal(
      (
        await t.call(t.owner, 'PUT', rp(appId, reviewId, '/reply-draft'), {
          text: 'a',
          templateId: 'b',
        })
      ).status,
      400,
    );
    assert.equal(
      (await t.call(t.owner, 'PUT', rp(appId, 'nope', '/reply-draft'), { text: 'a' })).status,
      404,
    );
    assert.equal(
      (await t.call(t.owner, 'PUT', rp('nope', reviewId, '/reply-draft'), { text: 'a' })).status,
      404,
    );

    const view = await t.call(t.owner, 'GET', rp(appId, reviewId));
    assert.equal(view.body.review.replyDraft.text, 'x'.repeat(350));
    assert.equal(view.body.review.reply.status, 'draft');
    const list = await t.call(t.owner, 'GET', `/apps/${appId}/reviews`);
    assert.equal(list.body.reviews[0].reply.status, 'draft');
    const inbox = await t.call(t.owner, 'GET', '/reviews');
    assert.ok(inbox.body.reviews.every((r: { reply: unknown; app: unknown }) => r.reply && r.app));

    assert.equal(
      (await t.call(t.owner, 'DELETE', rp(appId, reviewId, '/reply-draft'))).status,
      204,
    );
    assert.equal(
      (await t.call(t.owner, 'DELETE', rp(appId, reviewId, '/reply-draft'))).status,
      404,
    );
    assert.equal(
      (await t.call(t.owner, 'GET', rp(appId, reviewId))).body.review.reply.status,
      'none',
    );
    assert.equal(t.stores.android.replies.length, 0, 'drafting never reaches a store');
  },
);

// ----- sending ----------------------------------------------------------------------------------------

dbTest(
  'send: the hash must match; the exact text goes once; the review is refreshed; a second send is already_sent',
  async (db) => {
    const t = await bootReviews(db);
    const { appId, reviewId, hash } = await withDraft(t);
    const stale = await send(t, appId, reviewId, 'f'.repeat(64));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'stale_draft');
    assert.equal(stale.body.currentHash, hash);
    assert.equal(
      (await t.call(t.owner, 'POST', rp(appId, reviewId, '/reply'), { confirmHash: 'short' }))
        .status,
      400,
    );
    assert.equal((await t.call(t.owner, 'POST', rp(appId, reviewId, '/reply'), {})).status, 400);
    assert.equal(t.stores.ios.replies.length, 0);

    // A client holding the old hash cannot publish an edited draft.
    await t.call(t.owner, 'PUT', rp(appId, reviewId, '/reply-draft'), { text: 'An edited reply' });
    assert.equal((await send(t, appId, reviewId, hash)).body.error, 'stale_draft');
    assert.equal(t.stores.ios.replies.length, 0);
    const current = (await t.call(t.owner, 'GET', rp(appId, reviewId))).body.review.replyDraft
      .textHash as string;

    t.stores.ios.behavior = { kind: 'ok', state: 'PENDING_PUBLISH' };
    const done = await send(t, appId, reviewId, current);
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(
      t.stores.ios.replies.map((r) => r.text),
      ['An edited reply'],
    );
    assert.equal(done.body.reply.status, 'sent');
    assert.equal(done.body.reply.storeResponseId, 'resp-1');
    assert.equal(done.body.confirmedByReread, false);
    assert.equal(done.body.review.developerResponse.body, 'An edited reply');
    assert.equal(done.body.review.developerResponse.state, 'PENDING_PUBLISH');
    assert.equal(done.body.review.status, 'triaged', 'a new review is no longer new');
    assert.equal(done.body.review.reply.status, 'sent');
    assert.ok(done.body.review.reply.sentAt > 0);

    const again = await send(t, appId, reviewId, current);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'already_sent');
    assert.equal(t.stores.ios.replies.length, 1, 'no second request to the store');
    // Editing a sent reply makes it a draft again; sending that replaces the store's reply.
    const next = await t.call(t.owner, 'PUT', rp(appId, reviewId, '/reply-draft'), {
      text: 'A better reply',
    });
    assert.equal(next.body.draft.status, 'draft');
    assert.equal(next.body.draft.sentAt, null);
    assert.equal((await send(t, appId, reviewId, next.body.draft.textHash)).status, 200);
    assert.equal(t.stores.ios.replies.length, 2);
  },
);

dbTest(
  'send: Google Play too, with its 350 character limit enforced again at send time',
  async (db) => {
    const t = await bootReviews(db);
    const { appId, reviewId, hash } = await withDraft(t, TEXT, 'android');
    const done = await send(t, appId, reviewId, hash);
    assert.equal(done.status, 200, done.text);
    assert.equal(t.stores.android.replies[0]?.text, TEXT);
    assert.equal(done.body.review.developerResponse.body, TEXT);
    // A draft longer than the store allows (made when the limit was higher) is refused before any call.
    const other = await t.addApp('android');
    const r2 = await t.seed(other, 'android', 2);
    const long = 'y'.repeat(400);
    await db.execute(
      `INSERT INTO review_reply_drafts (id, workspace_id, app_id, review_id, store, text, text_hash, created_by, updated_by, created_at, updated_at)
     VALUES ('d-long', ?, ?, ?, 'googleplay', ?, ?, 'u', 'u', 1, 1)`,
      [t.workspaceId, other, r2, long, hashReplyText(long)],
    );
    const res = await send(t, other, r2, hashReplyText(long));
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'invalid_reply');
    assert.equal(t.stores.android.replies.length, 1);
    assert.equal((await draftRow(t, r2))?.status, 'draft', 'the claim was given back');
  },
);

dbTest(
  'a refusal by the store keeps the draft as failed; it can be sent again once fixed',
  async (db) => {
    const t = await bootReviews(db);
    const { appId, reviewId, hash } = await withDraft(t);
    t.stores.ios.behavior = {
      kind: 'refuse',
      error: new StoreError('appstoreconnect', 'forbidden', 'Apple refused', 403),
    };
    const refused = await send(t, appId, reviewId, hash);
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error, 'store_forbidden');
    assert.equal(refused.body.reply.status, 'failed');
    assert.equal(refused.body.reply.text, TEXT, 'the draft is kept');
    const row = await draftRow(t, reviewId);
    assert.deepEqual(
      [row?.status, row?.error_code, row?.claim_at],
      ['failed', 'store_forbidden', null],
    );
    assert.equal(
      (await t.call(t.owner, 'GET', rp(appId, reviewId))).body.review.developerResponse,
      null,
    );
    assert.equal((await t.events('review.reply_sent')).length, 0);

    t.stores.ios.behavior = {
      kind: 'refuse',
      error: new StoreRateLimitError('appstoreconnect', 30),
    };
    const limited = await send(t, appId, reviewId, hash);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '30');
    assert.equal((await draftRow(t, reviewId))?.status, 'failed');

    t.stores.ios.behavior = { kind: 'ok' };
    assert.equal((await send(t, appId, reviewId, hash)).status, 200);
    assert.equal((await draftRow(t, reviewId))?.status, 'sent');
    const actions = (
      await db.query(
        "SELECT action FROM audit_events WHERE action LIKE 'review.reply_%' ORDER BY created_at",
      )
    ).map((r) => r.action);
    assert.deepEqual(actions, [
      'review.reply_draft',
      'review.reply_failed',
      'review.reply_failed',
      'review.reply_sent',
    ]);
  },
);

dbTest(
  'a credential that is gone gives the claim back and fails without a store call',
  async (db) => {
    const t = await bootReviews(db);
    const { appId, reviewId, hash } = await withDraft(t);
    await db.execute('DELETE FROM credentials WHERE id = ?', [t.iosCredential]);
    const res = await send(t, appId, reviewId, hash);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'credential_not_found');
    assert.equal((await draftRow(t, reviewId))?.status, 'draft');
    assert.equal(t.stores.ios.replies.length, 0);
  },
);

// ----- unknown outcomes ---------------------------------------------------------------------------------

dbTest(
  'an unknown outcome is settled by reading the review back: published, not applied, or still unknown',
  async (db) => {
    const t = await bootReviews(db);
    // Applied although the answer was lost: the re-read finds the text and the reply is sent.
    const a = await withDraft(t);
    t.stores.ios.behavior = { kind: 'unknown', applied: true };
    const applied = await send(t, a.appId, a.reviewId, a.hash);
    assert.equal(applied.status, 200, applied.text);
    assert.equal(applied.body.confirmedByReread, true);
    assert.equal(applied.body.reply.status, 'sent');
    assert.equal(t.stores.ios.replies.length, 1, 'never retried');
    assert.ok(t.stores.ios.reads.length >= 1);
    const evidence = JSON.parse(String((await draftRow(t, a.reviewId))?.evidence));
    assert.equal(evidence.check, 'matched');
    assert.ok(!JSON.stringify(evidence).includes('SECRET-REPLY-TEXT'), 'no text in the evidence');
    assert.equal((await t.events('review.reply_sent')).length, 1);

    // Not applied: the re-read shows another reply, the draft is kept as failed, nothing is repeated.
    const app2 = await t.addApp('ios');
    const r2 = await t.seed(app2, 'ios', 2, { response: 'An older reply' });
    const put = await t.call(t.owner, 'PUT', rp(app2, r2, '/reply-draft'), {
      text: 'New reply here',
    });
    t.stores.ios.behavior = { kind: 'unknown', applied: false };
    const notApplied = await send(t, app2, r2, put.body.draft.textHash);
    assert.equal(notApplied.status, 502);
    assert.equal(notApplied.body.error, 'send_failed');
    assert.equal(notApplied.body.outcome, 'not_applied');
    assert.equal(notApplied.body.reply.status, 'failed');
    assert.equal(notApplied.body.reply.text, 'New reply here');
    assert.equal(t.stores.ios.replies.length, 2, 'one more request, no retry');

    // Unreadable: stays unknown, editing and deleting are refused, sending again checks without writing.
    const app3 = await t.addApp('ios');
    const r3 = await t.seed(app3, 'ios', 3);
    const put3 = await t.call(t.owner, 'PUT', rp(app3, r3, '/reply-draft'), {
      text: 'Third reply',
    });
    t.stores.ios.behavior = { kind: 'unknown', applied: true };
    t.stores.ios.readError = new StoreError('appstoreconnect', 'network', 'down');
    const unknown = await send(t, app3, r3, put3.body.draft.textHash);
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body.error, 'outcome_unknown');
    assert.equal(unknown.body.reply.status, 'unknown');
    const writes = t.stores.ios.replies.length;
    assert.equal(
      (await t.call(t.owner, 'PUT', rp(app3, r3, '/reply-draft'), { text: 'Edited meanwhile' }))
        .status,
      409,
    );
    assert.equal((await t.call(t.owner, 'DELETE', rp(app3, r3, '/reply-draft'))).status, 409);
    const still = await send(t, app3, r3, put3.body.draft.textHash);
    assert.equal(still.body.error, 'outcome_unknown');
    assert.equal(t.stores.ios.replies.length, writes, 'checking does not write');
    t.stores.ios.readError = undefined;
    const settled = await send(t, app3, r3, put3.body.draft.textHash);
    assert.equal(settled.status, 200);
    assert.equal(settled.body.confirmedByReread, true);
    assert.equal(t.stores.ios.replies.length, writes);
  },
);

// ----- one send at a time -----------------------------------------------------------------------------------

dbTest(
  'concurrency: a second send while one is in flight is send_in_progress; one request reaches the store',
  async (db) => {
    const t = await bootReviews(db);
    const { appId, reviewId, hash } = await withDraft(t);
    let release: () => void = () => undefined;
    t.stores.ios.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = send(t, appId, reviewId, hash);
    // Wait until the claim is taken and the store was asked.
    for (let i = 0; i < 200 && t.stores.ios.replies.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal((await draftRow(t, reviewId))?.status, 'sending');
    const second = await send(t, appId, reviewId, hash);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'send_in_progress');
    assert.equal(
      (await t.call(t.owner, 'PUT', rp(appId, reviewId, '/reply-draft'), { text: 'Edit now' })).body
        .error,
      'send_in_progress',
    );
    assert.equal(
      (await t.call(t.owner, 'DELETE', rp(appId, reviewId, '/reply-draft'))).status,
      409,
    );
    release();
    assert.equal((await first).status, 200);
    assert.equal(t.stores.ios.replies.length, 1);
    // Two sends started together: exactly one wins the claim.
    t.stores.ios.gate = undefined;
    const app2 = await t.addApp('ios');
    const r2 = await t.seed(app2, 'ios', 2);
    const put = await t.call(t.owner, 'PUT', rp(app2, r2, '/reply-draft'), { text: 'Together' });
    const both = await Promise.all([
      send(t, app2, r2, put.body.draft.textHash),
      send(t, app2, r2, put.body.draft.textHash),
    ]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    assert.equal(t.stores.ios.replies.filter((r) => r.text === 'Together').length, 1);
  },
);

dbTest(
  'a claim that expired is not trusted: the review is read back before anything is sent again',
  async (db) => {
    const t = await bootReviews(db, { reply: { claimTtlMs: 1000 } });
    const { appId, reviewId, hash } = await withDraft(t);
    // A process died mid-send, long ago; the store did apply the reply.
    await db.execute(
      "UPDATE review_reply_drafts SET status = 'sending', claim_at = ? WHERE review_id = ?",
      [Date.now() - 10 * HOUR, reviewId],
    );
    const stored = t.stores.ios.reviews[0];
    if (stored) stored.developerResponse = { body: TEXT, at: 1, state: 'PUBLISHED' };
    const fresh = await send(t, appId, reviewId, hash);
    assert.equal(fresh.status, 200, fresh.text);
    assert.equal(fresh.body.confirmedByReread, true);
    assert.equal(t.stores.ios.replies.length, 0, 'no second write');
    // A claim still within its TTL blocks.
    const app2 = await t.addApp('ios');
    const r2 = await t.seed(app2, 'ios', 2);
    const put = await t.call(t.owner, 'PUT', rp(app2, r2, '/reply-draft'), { text: 'Fresh claim' });
    await db.execute(
      "UPDATE review_reply_drafts SET status = 'sending', claim_at = ? WHERE review_id = ?",
      [Date.now() + HOUR, r2],
    );
    assert.equal((await send(t, app2, r2, put.body.draft.textHash)).body.error, 'send_in_progress');
  },
);

// ----- rate limit ---------------------------------------------------------------------------------------------

dbTest(
  'rate limit: sends per workspace per hour are limited; the draft survives and the claim is released',
  async (db) => {
    const t = await bootReviews(db, { reply: { sendsPerHour: 2 } });
    const drafts: { appId: string; reviewId: string; hash: string }[] = [];
    for (let i = 1; i <= 3; i++) {
      const appId = await t.addApp('ios');
      const reviewId = await t.seed(appId, 'ios', i);
      const put = await t.call(t.owner, 'PUT', rp(appId, reviewId, '/reply-draft'), {
        text: `Reply ${i}`,
      });
      drafts.push({ appId, reviewId, hash: put.body.draft.textHash as string });
    }
    const [d1, d2, d3] = drafts as [
      (typeof drafts)[number],
      (typeof drafts)[number],
      (typeof drafts)[number],
    ];
    assert.equal((await send(t, d1.appId, d1.reviewId, d1.hash)).status, 200);
    assert.equal((await send(t, d2.appId, d2.reviewId, d2.hash)).status, 200);
    const limited = await send(t, d3.appId, d3.reviewId, d3.hash);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(t.stores.ios.replies.length, 2);
    const row = await draftRow(t, d3.reviewId);
    assert.deepEqual([row?.status, row?.claim_at], ['draft', null]);
    // An hour later the allowance is back.
    await db.execute(
      "UPDATE audit_events SET created_at = created_at - ? WHERE action LIKE 'review.reply_%'",
      [2 * HOUR],
    );
    assert.equal((await send(t, d3.appId, d3.reviewId, d3.hash)).status, 200);
  },
);

// ----- no text anywhere but the draft ----------------------------------------------------------------------------

dbTest('the reply text is never in the audit log, the events, the jobs or the logs', async (db) => {
  const logs: string[] = [];
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };
  for (const name of ['log', 'warn', 'error', 'info'] as const)
    console[name] = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  try {
    const t = await bootReviews(db);
    const { appId, reviewId, hash } = await withDraft(t);
    t.stores.ios.behavior = {
      kind: 'refuse',
      error: new StoreError('appstoreconnect', 'unexpected', 'nope', 400),
    };
    await send(t, appId, reviewId, hash);
    t.stores.ios.behavior = { kind: 'unknown', applied: true };
    await send(t, appId, reviewId, hash);
    await t.call(t.owner, 'PATCH', `/apps/${appId}/reviews/${reviewId}`, {
      internalNote: 'a note',
    });
    for (const table of ['audit_events', 'events', 'jobs', 'webhook_deliveries']) {
      const text = JSON.stringify(await db.query(`SELECT * FROM ${table}`).catch(() => []));
      assert.ok(!text.includes('SECRET-REPLY-TEXT'), `${table} has the reply text`);
    }
    const audit = await db.query(
      "SELECT detail FROM audit_events WHERE action LIKE 'review.reply_%'",
    );
    assert.ok(audit.length >= 3);
    for (const row of audit) {
      const detail = JSON.parse(String(row.detail));
      assert.ok(detail.hash === undefined || detail.hash === hash);
      assert.ok(detail.length === undefined || detail.length === TEXT.length);
      assert.equal(detail.text, undefined);
    }
    const sent = (await t.events('review.reply_sent'))[0];
    assert.deepEqual(Object.keys(sent?.payload ?? {}).sort(), [
      'actor',
      'appId',
      'reviewId',
      'store',
      'storeReviewId',
    ]);
    assert.ok(!logs.join('\n').includes('SECRET-REPLY-TEXT'));
    // Answers to calls that are not about the draft never echo it (failures do not either).
    for (const text of t.texts) {
      if (text.includes('"textHash"') || text.includes('"reply"') || text.includes('"review":'))
        continue;
      assert.ok(!text.includes('SECRET-REPLY-TEXT'), text.slice(0, 300));
    }
  } finally {
    Object.assign(console, originals);
  }
});

// ----- API tokens ----------------------------------------------------------------------------------------------------

dbTest(
  'tokens: sending needs the action named; an app limited token reaches only its apps',
  async (db) => {
    const t = await bootReviews(db);
    const { appId, reviewId, hash } = await withDraft(t);
    const other = await t.addApp('ios');
    const otherReview = await t.seed(other, 'ios', 2);
    const otherDraft = await t.call(t.owner, 'PUT', rp(other, otherReview, '/reply-draft'), {
      text: 'Other reply',
    });
    const mint = async (input: Record<string, unknown>) => {
      const res = await t.call(t.owner, 'POST', '/tokens', { name: 'T', role: 'admin', ...input });
      assert.equal(res.status, 201, res.text);
      return res.body.token as string;
    };
    const bearer = async (token: string, method: string, path: string, body?: unknown) => {
      const res = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: res.status,
        body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
      };
    };
    const everything = await mint({});
    assert.equal(
      (await bearer(everything, 'POST', rp(appId, reviewId, '/reply'), { confirmHash: hash }))
        .status,
      403,
      'no list: never',
    );
    const readOnly = await mint({ actions: ['reviews.read', 'reviews.triage'] });
    assert.equal(
      (await bearer(readOnly, 'POST', rp(appId, reviewId, '/reply'), { confirmHash: hash })).status,
      403,
    );
    assert.equal(
      (await bearer(readOnly, 'PUT', rp(appId, reviewId, '/reply-draft'), { text: 'From a token' }))
        .status,
      200,
      'drafting is allowed',
    );
    assert.equal(t.stores.ios.replies.length, 0);

    const scoped = await mint({ actions: ['reviews.reply', 'reviews.read'], appIds: [appId] });
    const wrongApp = await bearer(scoped, 'POST', rp(other, otherReview, '/reply'), {
      confirmHash: otherDraft.body.draft.textHash,
    });
    assert.equal(wrongApp.status, 404, 'another app');
    assert.equal(t.stores.ios.replies.length, 0);
    const fresh = (await t.call(t.owner, 'GET', rp(appId, reviewId))).body.review.replyDraft
      .textHash as string;
    const sent = await bearer(scoped, 'POST', rp(appId, reviewId, '/reply'), {
      confirmHash: fresh,
    });
    assert.equal(sent.status, 200);
    assert.equal(t.stores.ios.replies.length, 1);
    const audit = (
      await db.query("SELECT actor_type FROM audit_events WHERE action = 'review.reply_sent'")
    )[0];
    assert.equal(audit?.actor_type, 'token', 'a send by a token is attributed to the token');
    // An app limited token cannot use the workspace wide reply endpoints.
    assert.equal((await bearer(scoped, 'GET', '/reviews/reply-config')).status, 403);
  },
);

// ----- templates -----------------------------------------------------------------------------------------------------------

dbTest(
  'templates: CRUD for members, placeholders rendered as plain text, at most 50, unknown placeholders refused',
  async (db) => {
    const t = await bootReviews(db);
    const member = await t.addMember('member');
    const viewer = await t.addMember('viewer');
    const created = await t.call(member, 'POST', '/reviews/reply-templates', {
      name: 'Thanks',
      body: 'Hi {{author}}, thanks for using {{app}}!',
    });
    assert.equal(created.status, 201);
    assert.equal(
      (await t.call(viewer, 'POST', '/reviews/reply-templates', { name: 'x', body: 'y' })).status,
      403,
    );
    assert.equal(
      (await t.call(viewer, 'GET', '/reviews/reply-templates')).body.templates.length,
      1,
    );
    for (const body of ['Hi {{nope}}', 'Hi {{', '<b>x</b>', 'tab\there']) {
      const res = await t.call(member, 'POST', '/reviews/reply-templates', { name: 'Bad', body });
      assert.equal(res.status, 422, body);
      assert.equal(res.body.error, 'invalid_template');
    }
    assert.equal(
      (await t.call(member, 'POST', '/reviews/reply-templates', { name: 'Bad', body: '' })).status,
      422,
    );
    assert.equal(
      (await t.call(member, 'POST', '/reviews/reply-templates', { name: '', body: 'x' })).status,
      422,
    );
    const id = created.body.template.id as string;
    assert.equal(
      (
        await t.call(member, 'PUT', `/reviews/reply-templates/${id}`, {
          name: 'Thanks 2',
          body: 'Hello {{author}}',
        })
      ).status,
      200,
    );
    assert.equal(
      (await t.call(member, 'PUT', '/reviews/reply-templates/nope', { name: 'a', body: 'b' }))
        .status,
      404,
    );

    const appId = await t.addApp('ios', 'Coffee App');
    const reviewId = await t.seed(appId, 'ios', 1, { authorName: '<script>x</script>\nSam' });
    const draft = await t.call(member, 'PUT', rp(appId, reviewId, '/reply-draft'), {
      templateId: id,
    });
    assert.equal(draft.status, 200, draft.text);
    assert.equal(draft.body.draft.text, 'Hello script x /script Sam');
    assert.ok(!/[<>\n]/.test(draft.body.draft.text), 'no markup and no line break from a name');
    assert.equal(
      (await t.call(member, 'PUT', rp(appId, reviewId, '/reply-draft'), { templateId: 'missing' }))
        .status,
      404,
    );

    for (let i = 0; i < 49; i++)
      assert.equal(
        (await t.call(member, 'POST', '/reviews/reply-templates', { name: `N${i}`, body: 'x' }))
          .status,
        201,
      );
    const over = await t.call(member, 'POST', '/reviews/reply-templates', {
      name: 'one more',
      body: 'x',
    });
    assert.equal(over.status, 422);
    assert.equal(over.body.error, 'too_many_templates');
    assert.equal((await t.call(member, 'DELETE', `/reviews/reply-templates/${id}`)).status, 204);
    assert.equal(
      (await t.call(member, 'POST', '/reviews/reply-templates', { name: 'one more', body: 'x' }))
        .status,
      201,
    );
  },
);

dbTest('template rendering is pure plain text', async () => {
  assert.equal(
    renderTemplate('Hi {{ author }} and {{app}} {{other}}', { author: 'Sam', app: 'Coffee' }),
    'Hi Sam and Coffee {{other}}',
  );
  assert.equal(renderTemplate('Hi {{author}}', { author: null }), 'Hi there');
  assert.equal(
    renderTemplate('Hi {{author}}', { author: `  ${bidi}<b>Al</b>\n\tBo{{app}} ` }),
    'Hi b Al /b Bo app',
  );
  assert.equal(plainValue('x'.repeat(200), 'f').length, 60);
  assert.equal(checkTemplate({ name: 'n', body: 'ok {{app}}' }), null);
  assert.ok(checkTemplate({ name: 'n', body: 'bad {{x}}' }));
});

// ----- translation seam --------------------------------------------------------------------------------------------------------

dbTest(
  'translation seam: wired to the workspace translator by default; without a credential it fails and changes nothing',
  async (db) => {
    const t = await bootReviews(db);
    const appId = await t.addApp('ios');
    const reviewId = await t.seed(appId, 'ios', 1);
    assert.equal(
      (await t.call(t.owner, 'GET', '/reviews/reply-config')).body.translation.available,
      true,
    );
    const none = await t.call(t.owner, 'POST', rp(appId, reviewId, '/reply-draft/translate'), {
      text: 'Hello',
      target: 'de',
    });
    assert.notEqual(none.status, 200, 'no translation credential is stored in this test');
    assert.equal((await db.query('SELECT id FROM review_reply_drafts')).length, 0);
    assert.equal(t.stores.ios.replies.length, 0);
  },
);

dbTest(
  'translation seam: with a translator injected it returns text and changes nothing',
  async (db) => {
    const t = await bootReviews(db, {
      reply: { translateDraft: async (i) => ({ ok: true, text: `[${i.target}] ${i.text}` }) },
    });
    const appId = await t.addApp('ios');
    const reviewId = await t.seed(appId, 'ios', 1);
    assert.equal(
      (await t.call(t.owner, 'GET', '/reviews/reply-config')).body.translation.available,
      true,
    );
    const done = await t.call(t.owner, 'POST', rp(appId, reviewId, '/reply-draft/translate'), {
      text: 'Hello',
      target: 'de',
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.text, '[de] Hello');
    assert.equal((await db.query('SELECT id FROM review_reply_drafts')).length, 0);
    assert.equal(t.stores.ios.replies.length, 0);
  },
);

// ----- cleanup -------------------------------------------------------------------------------------------------------------------------

dbTest(
  'cleanup: deleting an app, pruning old reviews and the orphan sweep leave no draft behind',
  async (db) => {
    const t = await bootReviews(db);
    const a = await withDraft(t);
    const b = await withDraft(t);
    const count = async () =>
      Number((await db.query('SELECT COUNT(*) AS n FROM review_reply_drafts'))[0]?.n);
    assert.equal(await count(), 2);
    // Retention pruning of the review removes its draft.
    assert.equal(await pruneReviews(db, 1_700_000_001_500, 10), 2, 'both seeded reviews are older');
    assert.equal(await count(), 0, 'no orphan draft after pruning');
    assert.equal((await db.query('SELECT id FROM app_reviews')).length, 0);
    assert.ok(a.reviewId && b.reviewId);

    const c = await withDraft(t);
    await db.transaction((tx) => deleteReviewData(tx, t.workspaceId, c.appId));
    assert.equal(await count(), 0, 'deleting the app data removes the drafts');

    const d = await withDraft(t);
    await t.call(t.owner, 'DELETE', `/apps/${d.appId}`);
    assert.equal(await count(), 0, 'deleting the app through the API removes the drafts');
    assert.equal(await purgeOrphanReviewRows(db), 0);

    // The foreign key is the backstop: a review deleted by hand takes its draft.
    const e = await withDraft(t);
    await db.execute('DELETE FROM app_reviews WHERE id = ?', [e.reviewId]);
    assert.equal(await count(), 0);
  },
);
