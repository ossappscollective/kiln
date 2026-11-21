import assert from 'node:assert/strict';
import { StoreError, StoreRateLimitError } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { ASC_SECRET, bootMonetization, type MonetizationBoot } from './test-helpers.ts';

const COINS = 'com.acme.coins100';
const PRO = 'com.acme.pro.monthly';
const NEW_TEXTS = { name: '120 coins', description: 'A bigger pile of coins' };
const KEY_LINE = (JSON.parse(ASC_SECRET) as { privateKey: string }).privateKey.split('\n')[1] ?? '';
const PASSWORD = 'correct horse battery staple';

/** An app with a synced copy of its products. */
async function synced(t: MonetizationBoot, platform: 'ios' | 'android' = 'ios') {
  const appId = await t.addApp(platform);
  assert.equal((await t.sync(appId)).status, 200);
  return appId;
}

const localizationOf = (t: MonetizationBoot, productId: string, locale: string) =>
  t.stores.ios.products
    .find((p) => p.productId === productId)
    ?.localizations.find((l) => l.locale === locale);

async function waitFor(condition: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A gate a test opens by hand: a write waits for it after the store accepted the guard. */
function hold(t: MonetizationBoot) {
  let release: () => void = () => undefined;
  t.stores.ios.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

// ----- the kill switch ---------------------------------------------------------------------------

dbTest(
  'kill switch: off by default; preview and apply answer 409 with the switch named, and no store is reached',
  async (db) => {
    const t = await bootMonetization(db, { write: { enabled: false } });
    const appId = await synced(t);
    const list = await t.list(appId);
    assert.deepEqual(list.body.write, {
      enabled: false,
      envName: 'KILN_STORE_PRODUCT_WRITE_ENABLED',
    });
    assert.equal(list.body.products.length, 2, 'reading does not depend on it');
    const preview = await t.preview(appId, COINS, 'en-US', NEW_TEXTS);
    assert.equal(preview.status, 409);
    assert.equal(preview.body.error, 'store_product_write_disabled');
    assert.equal(preview.body.envName, 'KILN_STORE_PRODUCT_WRITE_ENABLED');
    const apply = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, 'a'.repeat(64));
    assert.equal(apply.status, 409);
    assert.equal(apply.body.error, 'store_product_write_disabled');
    assert.equal(t.stores.ios.localizationReads + t.stores.ios.writes.length, 0);
    assert.equal(t.built.length, 1, 'only the sync built a connector');
    // The role is checked before the switch: a viewer learns nothing about it.
    const viewer = await t.addMember('viewer');
    assert.equal((await t.preview(appId, COINS, 'en-US', NEW_TEXTS, viewer)).status, 403);
  },
);

dbTest('the switch is off when nobody turns it on', async (db) => {
  const t = await bootMonetization(db, { write: { enabled: undefined } });
  const appId = await synced(t);
  assert.equal((await t.list(appId)).body.write.enabled, false);
  assert.equal((await t.preview(appId, COINS, 'en-US', NEW_TEXTS)).status, 409);
});

// ----- who may ---------------------------------------------------------------------------------------

dbTest('only owners and admins may preview or change; another workspace gets 404', async (db) => {
  const t = await bootMonetization(db);
  const appId = await synced(t);
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  const admin = await t.addMember('admin');
  for (const cookie of [viewer, member]) {
    assert.equal((await t.preview(appId, COINS, 'en-US', NEW_TEXTS, cookie)).status, 403);
    assert.equal(
      (await t.apply(appId, COINS, 'en-US', NEW_TEXTS, 'a'.repeat(64), cookie)).status,
      403,
    );
  }
  assert.equal(t.stores.ios.localizationReads, 0);
  const hash = await t.previewHash(appId, COINS, 'en-US', NEW_TEXTS);
  assert.equal((await t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash, admin)).status, 200);

  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  assert.equal((await t.preview(appId, COINS, 'en-US', NEW_TEXTS, outsider)).status, 404);
  const foreign = await t.call(
    outsider,
    'PUT',
    t.pp(appId, `/${COINS}/localizations/en-US`),
    { apply: false, ...NEW_TEXTS },
    'other',
  );
  assert.equal(foreign.status, 404, 'the app of one workspace does not exist in another');
  assert.equal(t.stores.ios.writes.length, 1);
});

dbTest(
  'tokens: the action must be named, the ceiling still applies, an app limited token reaches only its apps',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await synced(t);
    const other = await synced(t);
    const mint = async (input: Record<string, unknown>) => {
      const res = await t.call(t.owner, 'POST', '/tokens', { name: 'T', role: 'admin', ...input });
      assert.equal(res.status, 201, res.text);
      return res.body.token as string;
    };
    const bearer = async (token: string, path: string, body: unknown) => {
      const res = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
      };
    };
    const path = (app: string) => t.pp(app, `/${COINS}/localizations/en-US`);
    const everything = await mint({});
    const noList = await bearer(everything, path(appId), { apply: false, ...NEW_TEXTS });
    assert.equal(noList.status, 403, 'a token with no list of actions never gets it');
    const tooLow = await t.call(t.owner, 'POST', '/tokens', {
      name: 'T',
      role: 'member',
      actions: ['monetization.write'],
    });
    assert.equal(tooLow.status, 400);
    assert.equal(tooLow.body.error, 'action_above_role');
    assert.equal(t.stores.ios.writes.length, 0);

    const named = await mint({ actions: ['monetization.write', 'apps.read'] });
    const scoped = await mint({ actions: ['monetization.write', 'apps.read'], appIds: [appId] });
    const refused = await bearer(scoped, path(other), { apply: false, ...NEW_TEXTS });
    assert.equal(refused.status, 404, 'another app');
    const preview = await bearer(named, path(appId), { apply: false, ...NEW_TEXTS });
    assert.equal(preview.status, 200);
    const hash = (preview.body?.preview as { previewHash: string }).previewHash;
    const done = await bearer(scoped, path(appId), { apply: true, ...NEW_TEXTS, previewHash: hash });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const [changed] = await t.audit('monetization.localization_changed');
    assert.equal(changed?.actorType, 'token', 'a change by a token is attributed to the token');
  },
);

// ----- preview -----------------------------------------------------------------------------------------

dbTest('a preview reads the store, shows what would change and writes nothing', async (db) => {
  const t = await bootMonetization(db);
  const appId = await synced(t);
  const res = await t.preview(appId, COINS, 'en-us', NEW_TEXTS);
  assert.equal(res.status, 200, res.text);
  const p = res.body.preview;
  assert.equal(p.locale, 'en-US', 'the locale is the store’s own');
  assert.deepEqual(p.current, { name: '100 coins', description: 'A pile of coins' });
  assert.deepEqual(p.proposed, NEW_TEXTS);
  assert.deepEqual(p.changes, { name: true, description: true });
  assert.equal(p.unchanged, false);
  assert.match(p.previewHash, /^[0-9a-f]{64}$/);
  assert.equal(p.product.kind, 'consumable');
  assert.equal(p.app.id, appId);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(t.stores.ios.localizationReads, 1);
  assert.equal(t.stores.ios.writes.length, 0);
  assert.equal(localizationOf(t, COINS, 'en-US')?.name, '100 coins');
  assert.deepEqual(await t.audit('monetization.localization_%'), []);

  // Same inputs, same hash; other texts, another hash.
  const again = await t.preview(appId, COINS, 'en-US', NEW_TEXTS);
  assert.equal(again.body.preview.previewHash, p.previewHash);
  const other = await t.preview(appId, COINS, 'en-US', { ...NEW_TEXTS, name: 'Other' });
  assert.notEqual(other.body.preview.previewHash, p.previewHash);

  const same = await t.preview(appId, COINS, 'en-US', {
    name: '100 coins',
    description: 'A pile of coins',
  });
  assert.equal(same.body.preview.unchanged, true);
  assert.deepEqual(same.body.preview.changes, { name: false, description: false });

  const sub = await t.preview(appId, PRO, 'en-US', { name: 'Pro+', description: 'More' });
  assert.ok(sub.body.preview.warnings.some((w: string) => /Subscribers/.test(w)));
});

dbTest(
  'the texts are normalized (line breaks, space around) and checked before the store is asked',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await synced(t);
    const ok = await t.preview(appId, COINS, 'en-US', {
      name: '  Coins  ',
      description: 'Line one\r\nLine two  ',
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.preview.proposed, { name: 'Coins', description: 'Line one\nLine two' });
    const reads = t.stores.ios.localizationReads;
    for (const [texts, why] of [
      [{ name: '   ', description: 'x' }, 'empty name'],
      [{ name: 'a\nb', description: 'x' }, 'a line break in the name'],
      [{ name: 'a\u0000b', description: 'x' }, 'a NUL in the name'],
      [{ name: 'ok', description: 'a\u0007b' }, 'a control character'],
      [{ name: 'n'.repeat(201), description: 'x' }, 'a long name'],
      [{ name: 'ok', description: 'd'.repeat(2001) }, 'a long description'],
    ] as const) {
      const res = await t.preview(appId, COINS, 'en-US', texts);
      assert.equal(res.status, 422, why);
      assert.equal(res.body.error, 'invalid_text', why);
    }
    assert.equal(t.stores.ios.localizationReads, reads, 'nothing reached the store');
    const empty = await t.preview(appId, COINS, 'en-US', { name: 'Ok', description: '' });
    assert.equal(empty.status, 200, 'an empty description is for the store to refuse or accept');
    const path = t.pp(appId, `/${COINS}/localizations/en-US`);
    const price = await t.call(t.owner, 'PUT', path, {
      apply: false,
      name: 'x',
      description: 'y',
      price: '1',
    });
    assert.equal(price.status, 400, 'an unknown field (a price) is refused, not ignored');
    const noApply = await t.call(t.owner, 'PUT', path, { name: 'x', description: 'y' });
    assert.equal(noApply.status, 400);
  },
);

dbTest(
  'unknown product, unknown locale and a bad locale are refused with their own codes',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await synced(t);
    const missing = await t.preview(appId, 'com.acme.nope', 'en-US', NEW_TEXTS);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'product_not_found');
    const locale = await t.preview(appId, COINS, 'fr-FR', NEW_TEXTS);
    assert.equal(locale.status, 422);
    assert.equal(locale.body.error, 'locale_not_found');
    assert.deepEqual(locale.body.locales, ['de-DE', 'en-US']);
    const apply = await t.apply(appId, COINS, 'fr-FR', NEW_TEXTS, 'a'.repeat(64));
    assert.equal(apply.status, 422);
    assert.equal(apply.body.error, 'locale_not_found');
    for (const bad of ['x', 'en%20US', '12-34', 'en-US-ab-cd-ef-gh']) {
      const res = await t.preview(appId, COINS, bad, NEW_TEXTS);
      assert.equal(res.status, 422, bad);
      assert.equal(res.body.error, 'invalid_locale', bad);
    }
    assert.equal(t.stores.ios.writes.length, 0);
    assert.deepEqual(await t.claims(), [], 'a refusal leaves no claim');
  },
);

// ----- apply -------------------------------------------------------------------------------------------

dbTest(
  'apply writes the texts to the store, updates the stored copy, audits hashes and gives the claim back',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await synced(t);
    const hash = await t.previewHash(appId, COINS, 'en-US', NEW_TEXTS);
    const res = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
    assert.equal(res.status, 200, res.text);
    const r = res.body.result;
    assert.deepEqual(r.before, { name: '100 coins', description: 'A pile of coins' });
    assert.deepEqual(r.after, NEW_TEXTS);
    assert.deepEqual(r.changes, { name: true, description: true });
    assert.equal(r.confirmedByReread, false);
    assert.equal(r.locale, 'en-US');
    assert.deepEqual(t.stores.ios.writes, [{ productId: COINS, locale: 'en-US', ...NEW_TEXTS }]);
    assert.equal(localizationOf(t, COINS, 'en-US')?.name, NEW_TEXTS.name);
    assert.equal(localizationOf(t, COINS, 'de-DE')?.name, '100 Münzen', 'other locales are untouched');

    const detail = (await t.call(t.owner, 'GET', t.pp(appId, `/${COINS}`))).body.product;
    assert.deepEqual(
      detail.localizations.find((l: { locale: string }) => l.locale === 'en-US'),
      { locale: 'en-US', ...NEW_TEXTS },
      'the stored copy shows the new texts without another sync',
    );
    assert.equal(detail.prices.length, 3, 'the prices are untouched');

    assert.deepEqual(await t.claims(), []);
    const [changed] = await t.audit('monetization.localization_changed');
    assert.equal(changed?.actorType, 'user');
    assert.equal(changed?.detail.productId, COINS);
    assert.equal(changed?.detail.locale, 'en-US');
    assert.equal(changed?.detail.previewHash, hash);
    assert.equal(changed?.detail.via, 'store');
    assert.match(String(changed?.detail.fromHash), /^[0-9a-f]{64}$/);
    assert.match(String(changed?.detail.toHash), /^[0-9a-f]{64}$/);
    const audited = JSON.stringify(await t.audit());
    assert.equal(audited.includes('120 coins'), false, 'no text in the audit');
    assert.equal(audited.includes('pile of coins'), false);
    const used = (await t.audit('credential.use')).filter(
      (a) => a.detail.purpose === 'monetization.write',
    );
    assert.equal(used.length, 2, 'the preview and the apply each used the credential');
    for (const text of t.texts) assert.equal(text.includes('SECRETKEYBODY'), false);
  },
);

dbTest('apply works for Google Play too', async (db) => {
  const t = await bootMonetization(db);
  const appId = await synced(t, 'android');
  const texts = { name: 'Pro (monthly)', description: 'All features' };
  const hash = await t.previewHash(appId, 'pro_monthly', 'fr-FR', texts);
  const res = await t.apply(appId, 'pro_monthly', 'fr-FR', texts, hash);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(t.stores.android.writes, [{ productId: 'pro_monthly', locale: 'fr-FR', ...texts }]);
  assert.equal(t.built.at(-1)?.kind, 'google_play');
});

dbTest(
  'apply needs the previewHash; a hash of other texts, another locale or another product is refused and nothing is written',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await synced(t);
    const path = t.pp(appId, `/${COINS}/localizations/en-US`);
    const bare = await t.call(t.owner, 'PUT', path, { apply: true, ...NEW_TEXTS });
    assert.equal(bare.status, 400);
    const bad = await t.call(t.owner, 'PUT', path, {
      apply: true,
      ...NEW_TEXTS,
      previewHash: 'not-a-hash',
    });
    assert.equal(bad.status, 400);
    const hash = await t.previewHash(appId, COINS, 'en-US', NEW_TEXTS);
    const otherTexts = await t.apply(appId, COINS, 'en-US', { ...NEW_TEXTS, name: 'Changed' }, hash);
    assert.equal(otherTexts.status, 409);
    assert.equal(otherTexts.body.error, 'state_changed');
    assert.equal((await t.apply(appId, COINS, 'de-DE', NEW_TEXTS, hash)).status, 409);
    assert.equal((await t.apply(appId, PRO, 'en-US', NEW_TEXTS, hash)).status, 409);
    assert.equal(t.stores.ios.writes.length, 0);
    assert.deepEqual(await t.claims(), []);
  },
);

dbTest(
  'when the store changed since the preview nothing is overwritten; the answer carries a new preview that works',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await synced(t);
    const hash = await t.previewHash(appId, COINS, 'en-US', NEW_TEXTS);
    const live = localizationOf(t, COINS, 'en-US');
    assert.ok(live);
    live.description = 'Edited in the console meanwhile';
    const res = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'state_changed');
    assert.deepEqual(res.body.current, {
      name: '100 coins',
      description: 'Edited in the console meanwhile',
    });
    assert.deepEqual(res.body.proposed, NEW_TEXTS);
    assert.equal(t.stores.ios.writes.length, 0);
    assert.equal(live.description, 'Edited in the console meanwhile');
    assert.deepEqual(await t.claims(), []);
    const [failed] = await t.audit('monetization.localization_failed');
    assert.equal(failed?.detail.code, 'state_changed');
    assert.equal(failed?.detail.outcome, 'refused');
    const again = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, res.body.previewHash);
    assert.equal(again.status, 200, again.text);
    assert.equal(localizationOf(t, COINS, 'en-US')?.name, NEW_TEXTS.name);
  },
);

dbTest('texts the store already has are a 422 no_change, not a write', async (db) => {
  const t = await bootMonetization(db);
  const appId = await synced(t);
  const same = { name: '100 coins', description: 'A pile of coins' };
  const hash = await t.previewHash(appId, COINS, 'en-US', same);
  const res = await t.apply(appId, COINS, 'en-US', same, hash);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'no_change');
  assert.equal(t.stores.ios.writes.length, 0);
  assert.deepEqual(await t.claims(), []);
});

// ----- refusals and outcomes -----------------------------------------------------------------------

dbTest(
  'a store that refuses leaves the copy as it was, gives the claim back and says why without the credential',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await synced(t);
    const hash = await t.previewHash(appId, COINS, 'en-US', NEW_TEXTS);
    t.stores.ios.behavior = {
      kind: 'refuse',
      error: new StoreError('appstoreconnect', 'unexpected', `Name too long ${KEY_LINE}`, 409),
    };
    const res = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'store_rejected');
    assert.equal(res.text.includes('SECRETKEYBODY'), false);
    assert.equal((await t.list(appId)).body.products[0].name, '100 coins');
    assert.deepEqual(await t.claims(), []);
    const [failed] = await t.audit('monetization.localization_failed');
    assert.equal(failed?.detail.outcome, 'failed');
    assert.equal(JSON.stringify(failed).includes('SECRETKEYBODY'), false);

    t.stores.ios.behavior = {
      kind: 'refuse',
      error: new StoreError('appstoreconnect', 'forbidden', 'No.', 403),
    };
    const forbidden = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
    assert.equal(forbidden.body.error, 'store_forbidden');
    t.stores.ios.behavior = {
      kind: 'refuse',
      error: new StoreRateLimitError('appstoreconnect', 30),
    };
    const limited = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '30');
    assert.equal(t.stores.ios.writes.length, 3, 'each attempt reached the store once: never retried');
  },
);

dbTest(
  'a lost answer is checked, not sent again: the texts are there, so it is a success found by reading back',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await synced(t);
    const hash = await t.previewHash(appId, COINS, 'en-US', NEW_TEXTS);
    t.stores.ios.behavior = { kind: 'unknown', applied: true };
    const res = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.result.confirmedByReread, true);
    assert.equal(t.stores.ios.writes.length, 1, 'never retried');
    assert.deepEqual(await t.claims(), []);
    const [changed] = await t.audit('monetization.localization_changed');
    assert.equal(changed?.detail.via, 'reread');
    assert.equal((await t.list(appId)).body.products[0].name, NEW_TEXTS.name);
  },
);

dbTest(
  'a lost answer and the old texts still showing is unknown: writing is blocked until a preview reads the store',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await synced(t);
    const hash = await t.previewHash(appId, COINS, 'en-US', NEW_TEXTS);
    t.stores.ios.behavior = { kind: 'unknown', applied: false };
    const res = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'outcome_unknown');
    assert.deepEqual(
      (await t.claims()).map((c) => c.status),
      ['unknown'],
    );
    assert.equal(t.stores.ios.writes.length, 1);

    const blocked = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'outcome_unknown');
    assert.equal(t.stores.ios.writes.length, 1, 'no second write while it is unknown');

    t.stores.ios.behavior = { kind: 'ok' };
    const preview = await t.preview(appId, COINS, 'en-US', NEW_TEXTS);
    assert.equal(preview.status, 200);
    assert.deepEqual(await t.claims(), [], 'a successful read of the store clears it');
    const done = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, preview.body.preview.previewHash);
    assert.equal(done.status, 200, done.text);
    assert.equal(t.stores.ios.writes.length, 2);
  },
);

dbTest('a lost answer and an unreadable store is an unknown outcome', async (db) => {
  const t = await bootMonetization(db);
  const appId = await synced(t);
  const hash = await t.previewHash(appId, COINS, 'en-US', NEW_TEXTS);
  t.stores.ios.behavior = { kind: 'unknown', applied: true };
  t.stores.ios.readFailsAfterWrite = true;
  const res = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'outcome_unknown');
  assert.deepEqual(
    (await t.claims()).map((c) => c.status),
    ['unknown'],
  );
  const [failed] = await t.audit('monetization.localization_failed');
  assert.equal(failed?.detail.outcome, 'unknown');
  assert.equal(failed?.detail.readBack, 'failed');
});

dbTest(
  'a lost answer after somebody else changed the texts is state_changed, and nothing more is done',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await synced(t);
    const hash = await t.previewHash(appId, COINS, 'en-US', NEW_TEXTS);
    const release = hold(t);
    t.stores.ios.behavior = { kind: 'unknown', applied: false };
    const pending = t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
    await waitFor(() => t.stores.ios.writes.length === 1);
    const live = localizationOf(t, COINS, 'en-US');
    assert.ok(live);
    live.name = 'Someone else';
    release();
    const res = await pending;
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'state_changed');
    assert.deepEqual(await t.claims(), []);
    assert.equal(t.stores.ios.writes.length, 1);
  },
);

dbTest(
  'a store that does not answer in time is read back; the old texts still showing is unknown',
  async (db) => {
    const t = await bootMonetization(db, { write: { timeoutMs: 40 } });
    const appId = await synced(t);
    const hash = await t.previewHash(appId, COINS, 'en-US', NEW_TEXTS);
    t.stores.ios.gate = new Promise(() => undefined);
    const res = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'outcome_unknown');
    assert.deepEqual(
      (await t.claims()).map((c) => c.status),
      ['unknown'],
    );
    assert.equal((await t.preview(appId, COINS, 'en-US', NEW_TEXTS)).status, 200);
  },
);

dbTest('one write per app at a time; another app is not held up', async (db) => {
  const t = await bootMonetization(db);
  const appId = await synced(t);
  const hash = await t.previewHash(appId, COINS, 'en-US', NEW_TEXTS);
  const hashDe = await t.previewHash(appId, COINS, 'de-DE', NEW_TEXTS);
  const release = hold(t);
  const first = t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
  await waitFor(() => t.stores.ios.writes.length === 1);
  assert.deepEqual(
    (await t.claims()).map((c) => c.status),
    ['writing'],
  );
  const second = await t.apply(appId, COINS, 'de-DE', NEW_TEXTS, hashDe);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'write_in_progress');
  release();
  assert.equal((await first).status, 200);
  assert.deepEqual(await t.claims(), []);
  assert.equal(t.stores.ios.writes.length, 1);
  assert.equal((await t.apply(appId, COINS, 'de-DE', NEW_TEXTS, hashDe)).status, 200);
});

dbTest('a claim that never finished expires; an unknown one never does', async (db) => {
  const t = await bootMonetization(db, { write: { claimTtlMs: 1 } });
  const appId = await synced(t);
  const claim = (status: string) =>
    db.execute(
      `INSERT INTO store_product_claims (app_id, workspace_id, product_id, status, claimed_by, claim_at)
       VALUES (?, ?, ?, ?, 'gone', 1)`,
      [appId, t.workspaceId, COINS, status],
    );
  await claim('writing');
  const hash = await t.previewHash(appId, COINS, 'en-US', NEW_TEXTS);
  const done = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
  assert.equal(done.status, 200, 'the old claim was taken over');
  await claim('unknown');
  const blocked = await t.apply(appId, COINS, 'de-DE', NEW_TEXTS, hash);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'outcome_unknown');
});

// ----- step-up -----------------------------------------------------------------------------------------

dbTest(
  'with a step-up policy covering store.push_draft: the preview is free, the apply needs a grant bound to the app and the preview',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await synced(t);
    const policy = await t.call(t.owner, 'PUT', '/step-up/policy', {
      mode: 'hard_actions',
      actions: ['store.push_draft'],
    });
    assert.equal(policy.status, 200, policy.text);
    const hash = await t.previewHash(appId, COINS, 'en-US', NEW_TEXTS);
    const refused = await t.apply(appId, COINS, 'en-US', NEW_TEXTS, hash);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'step_up_required');
    assert.equal(refused.body.action, 'store.push_draft');
    assert.equal(t.stores.ios.writes.length, 0);
    assert.equal(t.stores.ios.localizationReads, 1, 'refused before the store was asked again');

    const grantFor = async (target: { id: string; hash: string }) => {
      const res = await t.call(t.owner, 'POST', '/step-up/verify', {
        factor: 'password',
        action: 'store.push_draft',
        target,
        password: PASSWORD,
      });
      assert.equal(res.status, 200, res.text);
      return res.body.grant as string;
    };
    const withGrant = (grant: string, previewHash: string) =>
      t.app.request(
        `/api/workspaces/${t.workspaceId}${t.pp(appId, `/${COINS}/localizations/en-US`)}`,
        {
          method: 'PUT',
          headers: { cookie: t.owner, 'content-type': 'application/json', 'x-step-up-grant': grant },
          body: JSON.stringify({ apply: true, ...NEW_TEXTS, previewHash }),
        },
      );
    const wrong = await withGrant(await grantFor({ id: appId, hash: 'b'.repeat(64) }), hash);
    assert.equal(wrong.status, 403, 'a grant for another hash does not work');
    const done = await withGrant(await grantFor({ id: appId, hash }), hash);
    assert.equal(done.status, 200, await done.text());
    assert.equal(t.stores.ios.writes.length, 1);
  },
);
