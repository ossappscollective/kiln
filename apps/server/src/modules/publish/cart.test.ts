import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StoreError } from '@kiln/connectors';
import type { Database } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import { FakeReplyStore, storeReview } from '../reviews/test-helpers.ts';
import { setPolicy, type StepUpAction } from '../../services/step-up.ts';
import { bootStaged } from './test-helpers.ts';

const TEXT = 'A freshly written description that nobody else would ever write';
const REPLY = 'Thank you, SECRET-CART-REPLY-77, we are on it.';
const cart = '/pending/cart';

/** Fake reply stores, wired the way the reviews tests wire them. */
function replyStores() {
  const stores = { ios: new FakeReplyStore('ios'), android: new FakeReplyStore('android') };
  const factory = (input: { kind: string }) =>
    input.kind === 'app_store_connect' ? stores.ios : stores.android;
  return {
    stores,
    extra: {
      reviews: {
        connectorFactory: factory,
        ratingFetcher: null,
        reply: { enabled: true, connectorFactory: factory },
      },
    },
  };
}

async function boot(db: Database, opts: { reply?: boolean; draft?: boolean } = {}) {
  const r = replyStores();
  const t = await bootStaged(db, {
    draft: { enabled: opts.draft ?? true },
    extra: opts.reply === false ? { reviews: { ratingFetcher: null } } : r.extra,
  });
  return { ...t, replyStores: r.stores };
}
type Boot = Awaited<ReturnType<typeof boot>>;

/** An iOS app with a staged text, a staged screenshot set and a reply draft on a 1 star review. */
async function filled(t: Boot) {
  const app = await t.addApp('ios');
  assert.equal(
    (await t.stageText(app, { locale: 'en-US', field: 'description', from: 'local', value: TEXT }))
      .status,
    200,
  );
  assert.equal(
    (await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' }))
      .status,
    200,
  );
  const review = await seedReview(t, app);
  const put = await t.call(t.owner, 'PUT', `/apps/${app}/reviews/${review}/reply-draft`, {
    text: REPLY,
  });
  assert.equal(put.status, 200, put.text);
  return { app, review };
}
async function seedReview(t: Boot, appId: string, n = 1) {
  const r = storeReview(n, { rating: 1, body: `Body ${n} with some words` }, 'ios');
  const id = randomUUID();
  await t.db.execute(
    `INSERT INTO app_reviews (id, workspace_id, app_id, store, store_review_id, rating, title, body, author_name, territory,
       created_at, updated_at, first_seen_at, fetched_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'new')`,
    [
      id,
      t.workspaceId,
      appId,
      r.store,
      `${appId.slice(0, 4)}-${r.storeReviewId}`,
      r.rating,
      r.title ?? null,
      r.body,
      r.authorName ?? null,
      r.territory ?? null,
      r.createdAt,
      r.updatedAt,
    ],
  );
  t.replyStores.ios.reviews.push({
    ...r,
    storeReviewId: `${appId.slice(0, 4)}-${r.storeReviewId}`,
  });
  return id;
}
const read = async (t: Boot, app: string, cookie = t.owner) =>
  (await t.call(cookie, 'GET', `/apps/${app}${cart}`)).body.cart as {
    items: {
      id: string;
      kind: string;
      version: string;
      publishable: boolean;
      reason: { code: string } | null;
      summary: string | null;
      bundle: string | null;
      canDiscard: boolean;
      review?: { rating: number };
    }[];
    can: Record<string, boolean>;
  };
const publish = (
  t: Boot,
  app: string,
  items: { id: string; version: string }[],
  cookie = t.owner,
) => t.call(cookie, 'POST', `/apps/${app}/pending/publish`, { items });
const all = (c: Awaited<ReturnType<typeof read>>) =>
  c.items.map((i) => ({ id: i.id, version: i.version }));
const result = (res: {
  body: { result: { results: { id: string; status: string; reason: string | null }[] } };
}) =>
  Object.fromEntries(
    res.body.result.results.map((r) => [r.id, `${r.status}${r.reason ? `:${r.reason}` : ''}`]),
  );

dbTest(
  'the cart lists every kind from the existing tables: ordered, typed, with excerpts and no new state',
  async (db) => {
    const t = await boot(db);
    const { app } = await filled(t);
    const c = await read(t, app);
    assert.deepEqual(
      c.items.map((i) => i.kind),
      ['listing', 'graphics', 'review_reply'],
    );
    assert.equal(c.items[0]?.summary, TEXT);
    assert.equal(c.items[0]?.bundle, c.items[1]?.bundle);
    assert.equal(c.items[2]?.bundle, null);
    assert.equal(c.items[2]?.review?.rating, 1);
    assert.ok(c.items.every((i) => i.publishable && i.reason === null && i.version.length > 0));
    assert.equal(c.can.push, true);
    // Reading changes nothing and writes no audit entry.
    assert.deepEqual(await t.audit('pending.%'), []);
    assert.equal(t.stores.ios.applyCalls, 0);
  },
);

dbTest('an empty app has an empty cart; a missing app is 404', async (db) => {
  const t = await boot(db);
  const app = await t.addApp('ios');
  assert.deepEqual((await read(t, app)).items, []);
  assert.equal((await t.call(t.owner, 'GET', `/apps/nope${cart}`)).status, 404);
});

dbTest(
  'an item the caller cannot publish is listed with its reason and is skipped, never sent',
  async (db) => {
    const t = await boot(db);
    const { app } = await filled(t);
    const member = await t.addMember('member');
    const c = await read(t, app, member);
    assert.equal(c.items.length, 3);
    assert.deepEqual([...new Set(c.items.map((i) => i.publishable))], [false]);
    assert.deepEqual([...new Set(c.items.map((i) => i.reason?.code))], ['no_right']);
    assert.deepEqual(
      [c.can.push, c.can.reply, c.can.discardStaged, c.can.discardReply],
      [false, false, true, true],
    );
    const res = await publish(t, app, all(c), member);
    assert.equal(res.status, 200);
    assert.ok(Object.values(result(res)).every((r) => r === 'skipped:no_right'));
    assert.equal(t.stores.ios.applyCalls, 0);
    assert.equal(t.replyStores.ios.replies.length, 0);
    const viewer = await t.addMember('viewer');
    const v = await read(t, app, viewer);
    assert.deepEqual(v.can, {
      push: false,
      reply: false,
      price: false,
      discardStaged: false,
      discardReply: false,
    });
    assert.ok(v.items.every((i) => !i.canDiscard));
  },
);

dbTest('a switch that is off is a reason, not a hidden item', async (db) => {
  const t = await boot(db, { draft: false, reply: false });
  const app = await t.addApp('ios');
  const staged = await t.stageText(app, {
    locale: 'en-US',
    field: 'description',
    from: 'local',
    value: 'Acme',
  });
  assert.equal(staged.status, 200, staged.text);
  const c = await read(t, app);
  assert.equal(c.items[0]?.reason?.code, 'switch_off');
  assert.equal(c.items[0]?.publishable, false);
});

dbTest('publishing a subset sends only that subset; the rest stays pending', async (db) => {
  const t = await boot(db);
  const { app, review } = await filled(t);
  const c = await read(t, app);
  const only = c.items.filter((i) => i.kind === 'review_reply');
  const res = await publish(
    t,
    app,
    only.map((i) => ({ id: i.id, version: i.version })),
  );
  assert.deepEqual(result(res), { [`review_reply:${review}`]: 'ok' });
  assert.equal(res.body.result.remaining, 2);
  assert.equal(t.replyStores.ios.replies.length, 1);
  assert.equal(t.stores.ios.applyCalls, 0, 'the staged changes were not pushed');
  assert.deepEqual(
    (await read(t, app)).items.map((i) => i.kind),
    ['listing', 'graphics'],
  );
  const audit = await t.audit('pending.cart_published');
  assert.equal(audit.length, 1);
  assert.ok(!JSON.stringify(audit).includes('SECRET-CART-REPLY-77'), 'no reply text in the audit');
});

dbTest(
  'staged changes are a bundle: all named, one push, a draft only; repeating is safe',
  async (db) => {
    const t = await boot(db);
    const { app } = await filled(t);
    const c = await read(t, app);
    const staged = c.items
      .filter((i) => i.bundle !== null)
      .map((i) => ({ id: i.id, version: i.version }));
    const res = await publish(t, app, staged);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.values(result(res)), ['ok', 'ok']);
    assert.equal(t.stores.ios.texts.get('en-US\u0000description'), TEXT);
    assert.equal(t.replyStores.ios.replies.length, 0, 'the reply was not named, so not sent');
    assert.equal((await t.submitStores.ios.submitCalls) ?? 0, 0);
    // The same request again: nothing is pending any more, nothing is written twice.
    const calls = t.stores.ios.applyCalls;
    const again = await publish(t, app, staged);
    assert.deepEqual(Object.values(result(again)), ['skipped:not_pending', 'skipped:not_pending']);
    assert.equal(t.stores.ios.applyCalls, calls);
  },
);

dbTest(
  'a partial bundle is refused: nothing is pushed that the person did not name',
  async (db) => {
    const t = await boot(db);
    const { app } = await filled(t);
    const c = await read(t, app);
    const one = c.items.filter((i) => i.kind === 'listing');
    const res = await publish(
      t,
      app,
      one.map((i) => ({ id: i.id, version: i.version })),
    );
    assert.deepEqual(Object.values(result(res)), ['skipped:bundle_incomplete']);
    assert.equal(t.stores.ios.applyCalls, 0);
  },
);

dbTest('an item that changed since it was listed is skipped (changed_since_review)', async (db) => {
  const t = await boot(db);
  const { app } = await filled(t);
  const old = await read(t, app);
  await t.stageText(app, {
    locale: 'en-US',
    field: 'description',
    from: 'local',
    value: 'A different text now',
  });
  const res = await publish(t, app, all(old));
  const r = result(res);
  assert.equal(
    Object.values(r).filter((x) => x === 'skipped:changed_since_review').length,
    2,
    JSON.stringify(r),
  );
  assert.equal(t.stores.ios.applyCalls, 0);
  // The reply version did not change: it is sent.
  assert.ok(Object.values(r).includes('ok'));
});

dbTest('one failure never blocks the others', async (db) => {
  const t = await boot(db);
  const { app, review } = await filled(t);
  t.replyStores.ios.behavior = {
    kind: 'refuse',
    error: new StoreError('appstoreconnect', 'forbidden', 'Apple refused', 403),
  };
  const res = await publish(t, app, all(await read(t, app)));
  const r = result(res);
  assert.match(String(r[`review_reply:${review}`]), /^failed:/);
  assert.equal(
    Object.values(r).filter((x) => x === 'ok').length,
    2,
    'the staged bundle was pushed',
  );
  assert.equal(t.stores.ios.texts.get('en-US\u0000description'), TEXT);
});

dbTest(
  'discard removes Kiln’s draft only; a subset; rights per kind; the store is untouched',
  async (db) => {
    const t = await boot(db);
    const { app, review } = await filled(t);
    const c = await read(t, app);
    const viewer = await t.addMember('viewer');
    const denied = await t.call(viewer, 'POST', `/apps/${app}/pending/discard`, {
      ids: c.items.map((i) => i.id),
    });
    assert.ok(Object.values(result(denied)).every((x) => x === 'skipped:no_right'));
    assert.equal((await read(t, app)).items.length, 3);
    const res = await t.call(t.owner, 'POST', `/apps/${app}/pending/discard`, {
      ids: [`review_reply:${review}`, 'listing:missing'],
    });
    assert.deepEqual(result(res), {
      [`review_reply:${review}`]: 'ok',
      'listing:missing': 'skipped:not_pending',
    });
    assert.deepEqual(
      (await read(t, app)).items.map((i) => i.kind),
      ['listing', 'graphics'],
    );
    const rest = await t.call(t.owner, 'POST', `/apps/${app}/pending/discard`, {
      ids: c.items.filter((i) => i.bundle).map((i) => i.id),
    });
    assert.equal(rest.body.result.remaining, 0);
    // Discard then read: the staged view (what the listing, the locale panel and the graphics tab draw) and the pending view hold nothing.
    const staged = (await t.call(t.owner, 'GET', `/apps/${app}/staged`)).body.staged;
    assert.deepEqual(
      [staged.text.length, staged.assets.length, staged.totals.text, staged.totals.assetSets],
      [0, 0, 0, 0],
    );
    assert.equal((await t.rows(app)).length, 0);
    assert.equal(t.stores.ios.applyCalls, 0);
    assert.equal(t.replyStores.ios.replies.length, 0);
    assert.equal((await t.audit('pending.cart_discarded')).length, 3, 'also the refused attempt');
  },
);

dbTest('a non-member gets 404 and bodies are validated', async (db) => {
  const t = await boot(db);
  const { app } = await filled(t);
  assert.equal(
    (await t.call(t.owner, 'POST', `/apps/${app}/pending/publish`, { items: [] })).status,
    400,
  );
  assert.equal(
    (await t.call(t.owner, 'POST', `/apps/${app}/pending/discard`, { ids: 'x' })).status,
    400,
  );
});

const summaryPath = '/pending/cart-summary';
const summary = async (t: Boot, cookie = t.owner, ws?: string) =>
  (await t.call(cookie, 'GET', summaryPath, undefined, ws)) as {
    status: number;
    body: {
      apps: { appId: string; count: number; kinds: Record<string, number> }[];
      totals: { apps: number; count: number };
    };
  };

dbTest(
  "the cart summary counts every app's cart with the numbers of the carts themselves, and lists only apps that hold something",
  async (db) => {
    const t = await boot(db);
    const empty = await summary(t);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.totals, { apps: 0, count: 0 });
    const { app } = await filled(t);
    const second = await t.addApp('ios');
    await t.addApp('ios');
    assert.equal(
      (
        await t.stageText(second, {
          locale: 'en-US',
          field: 'description',
          from: 'local',
          value: TEXT,
        })
      ).status,
      200,
    );
    const s = await summary(t);
    assert.equal(s.status, 200);
    assert.equal(s.body.totals.apps, 2);
    assert.equal(s.body.apps.length, 2);
    for (const line of s.body.apps)
      assert.equal(
        line.count,
        (await read(t, line.appId)).items.length,
        "equals the length of the app's own cart",
      );
    assert.equal(
      s.body.totals.count,
      s.body.apps.reduce((n, l) => n + l.count, 0),
    );
    const first = s.body.apps.find((l) => l.appId === app);
    assert.deepEqual(first?.kinds, { listing: 1, graphics: 1, review_reply: 1 });
    // No item payload, no audit entry, nothing written.
    assert.ok(!JSON.stringify(s.body).includes(TEXT));
    assert.deepEqual(await t.audit('pending.%'), []);
    // A discard shrinks it.
    const c = await read(t, app);
    const res = await t.call(t.owner, 'POST', `/apps/${app}/pending/discard`, {
      ids: c.items.map((i) => i.id),
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(
      (await summary(t)).body.apps.map((l) => l.appId),
      [second],
    );
  },
);

dbTest(
  'the cart summary is scoped: another workspace sees nothing and a stranger is a 404; a token limited to an app sees only that app',
  async (db) => {
    const t = await boot(db);
    const { app } = await filled(t);
    const second = await t.addApp('ios');
    assert.equal(
      (
        await t.stageText(second, {
          locale: 'en-US',
          field: 'description',
          from: 'local',
          value: TEXT,
        })
      ).status,
      200,
    );
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    assert.equal((await summary(t, outsider)).status, 404);
    const theirs = await summary(t, outsider, 'other');
    assert.equal(theirs.status, 200);
    assert.deepEqual(theirs.body.totals, { apps: 0, count: 0 });
    const minted = await t.call(t.owner, 'POST', '/tokens', {
      name: 'T',
      role: 'admin',
      appIds: [second],
    });
    assert.equal(minted.status, 201, minted.text);
    const res = await t.app.request(`/api/workspaces/${t.workspaceId}${summaryPath}`, {
      headers: { authorization: `Bearer ${minted.body.token as string}` },
    });
    const limited = (await res.json()) as { apps: { appId: string }[]; totals: { count: number } };
    assert.equal(res.status, 200);
    assert.deepEqual(
      limited.apps.map((l) => l.appId),
      [second],
    );
    assert.ok(!limited.apps.some((l) => l.appId === app));
  },
);

dbTest(
  'the cart summary follows the role: a viewer without listing.read is refused, a member sees the counts',
  async (db) => {
    const t = await boot(db);
    await filled(t);
    const member = await t.addMember('member');
    assert.equal((await summary(t, member)).body.totals.apps, 1);
    const viewer = await t.addMember('viewer');
    const v = await summary(t, viewer);
    assert.equal(v.status, 200, 'a viewer reads the cart too (listing.read)');
    assert.equal(v.body.totals.count, 3);
  },
);

const detailPath = (app: string, id: string) =>
  `/apps/${app}/pending/cart/detail?id=${encodeURIComponent(id)}`;
type Detail = {
  id: string;
  kind: string;
  version: string;
  text?: { after: string; before: string | null; limit: number | null; truncated: boolean };
  graphics?: { before: unknown[] | null; after: { url: string; position: number }[] };
  reply?: { text: string; review: { rating: number; body: string } };
};
const detail = async (t: Boot, app: string, id: string, cookie = t.owner) => {
  const res = await t.call(cookie, 'GET', detailPath(app, id));
  return {
    status: res.status,
    detail: res.body.detail as Detail | undefined,
    headers: res.headers,
  };
};

dbTest(
  'the detail of an item carries the full text, the image refs and the reply with its review, at the listed version',
  async (db) => {
    const t = await boot(db);
    const { app } = await filled(t);
    const c = await read(t, app);
    const [listing, graphics, reply] = c.items;
    const l = await detail(t, app, listing!.id);
    assert.equal(l.status, 200);
    assert.equal(l.detail?.version, listing!.version);
    assert.equal(l.detail?.text?.after, TEXT);
    assert.equal(l.detail?.text?.truncated, false);
    assert.equal(typeof l.detail?.text?.limit, 'number');
    const g = await detail(t, app, graphics!.id);
    assert.equal(g.status, 200);
    assert.equal(g.detail?.graphics?.before, null, 'no store read is remembered');
    assert.ok((g.detail?.graphics?.after.length ?? 0) > 0);
    for (const f of g.detail?.graphics?.after ?? [])
      assert.ok(
        f.url.startsWith(`/api/workspaces/${t.workspaceId}/apps/${app}/`),
        'same origin routes only',
      );
    const r = await detail(t, app, reply!.id);
    assert.equal(r.detail?.reply?.text, REPLY);
    assert.equal(r.detail?.reply?.review.rating, 1);
    assert.match(r.detail?.reply?.review.body ?? '', /^Body 1/);
    // Reading changes nothing and writes no audit entry.
    assert.deepEqual(await t.audit('pending.%'), []);
  },
);

dbTest(
  'the detail is scoped: unknown id, a discarded item, another app and another workspace are 404; a bad id is 400',
  async (db) => {
    const t = await boot(db);
    const { app } = await filled(t);
    const other = await t.addApp('ios');
    const c = await read(t, app);
    const id = c.items[0]!.id;
    assert.equal((await detail(t, app, 'listing:nope')).status, 404);
    assert.equal((await detail(t, other, id)).status, 404, "the id is of another app's cart");
    assert.equal((await t.call(t.owner, 'GET', `/apps/${app}/pending/cart/detail`)).status, 400);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    assert.equal(
      (await t.call(outsider, 'GET', detailPath(app, id), undefined, 'other')).status,
      404,
    );
    assert.equal(
      (await t.call(outsider, 'GET', detailPath(app, id))).status,
      404,
      'a stranger to the workspace',
    );
    const res = await t.call(t.owner, 'POST', `/apps/${app}/pending/discard`, { ids: [id] });
    assert.equal(res.status, 200, res.text);
    assert.equal((await detail(t, app, id)).status, 404);
  },
);

dbTest(
  'the detail needs the right of the cart only: a viewer reads it, a member without push too (rights unchanged)',
  async (db) => {
    const t = await boot(db);
    const { app } = await filled(t);
    const id = (await read(t, app)).items[0]!.id;
    const viewer = await t.addMember('viewer');
    assert.equal((await detail(t, app, id, viewer)).status, 200);
    const member = await t.addMember('member');
    assert.equal((await detail(t, app, id, member)).detail?.text?.after, TEXT);
  },
);

dbTest(
  'the detail cuts a review over the cap and says so (the size of a detail is bounded)',
  async (db) => {
    const t = await boot(db);
    const { app, review } = await filled(t);
    await db.execute('UPDATE app_reviews SET body = ? WHERE id = ?', ['x'.repeat(20000), review]);
    const reply = (await read(t, app)).items.find((i) => i.kind === 'review_reply')!;
    const d = await detail(t, app, reply.id);
    assert.equal(d.detail?.reply?.review.body.length, 8000);
    assert.equal((d.detail?.reply?.review as { truncated?: boolean }).truncated, true);
  },
);

dbTest(
  'the pending cart asks for the step-up of "Publish to the stores" when "Write a store draft" is not covered',
  async (db) => {
    const t = await boot(db);
    const { app } = await filled(t);
    const items = await read(t, app);
    const staged = all({ ...items, items: items.items.filter((i) => i.kind !== 'review_reply') });
    const reply = all({ ...items, items: items.items.filter((i) => i.kind === 'review_reply') });
    const cover = (actions: StepUpAction[]) =>
      setPolicy(
        db,
        {
          workspaceId: t.workspaceId,
          policy: { mode: 'hard_actions', actions, unattended: [] },
          userId: 'u',
        },
        Date.now(),
      );
    // Only "Publish to the stores": a staged change and a reply both ask (the button says Publish).
    await cover(['store.publish']);
    const a = await publish(t, app, staged);
    assert.equal(a.status, 403);
    assert.match(String(a.body.error), /^step_up/);
    const b = await publish(t, app, reply);
    assert.equal(b.status, 403);
    assert.match(String(b.body.error), /^step_up/);
    // Only "Write a store draft": a staged change asks, a public reply does not (it is not a draft write).
    await cover(['store.push_draft']);
    const c = await publish(t, app, staged);
    assert.equal(c.status, 403);
    const d = await publish(t, app, reply);
    assert.notEqual(d.status, 403);
  },
);
