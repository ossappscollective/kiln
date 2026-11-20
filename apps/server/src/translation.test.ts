import assert from 'node:assert/strict';
import { dbTest } from '@mrm/db/testing';
import { storeReview } from './modules/reviews/test-helpers.ts';
import { createTestLimiter } from './services/credential-tests.ts';
import {
  bootTranslation,
  captureConsole,
  fakeGoogle,
  GOOGLE_KEY,
  GOOGLE_SECRET,
} from './translation-test-helpers.ts';

// Everything runs against fakes: no translation provider is ever contacted.

const rows = (db: import('@mrm/db').Database, sql: string) => db.query(sql);

dbTest('translating reviews: rights, isolation, limits and the shape of the answer', async (db) => {
  const t = await bootTranslation(db);
  await t.enable();
  const id = await t.seed(1, { language: 'de' });
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');

  assert.equal((await t.translate(viewer, [id])).status, 403);
  const ok = await t.translate(member, [id]);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.provider, 'google');
  assert.equal(ok.body.target, 'en');
  assert.equal(ok.body.cached, false);
  assert.deepEqual(ok.body.notFound, []);
  assert.deepEqual(ok.body.translations, [
    {
      reviewId: id,
      title: '[en] Title 1',
      body: '[en] Body of review 1',
      detectedSource: 'de',
      provider: 'google',
      cached: false,
    },
  ]);

  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  const res = await t.call(outsider, 'POST', `/apps/${t.appId}/reviews/translate`, {
    reviewIds: [id],
  });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
  assert.equal(
    (
      await t.call(
        outsider,
        'POST',
        `/apps/${t.appId}/reviews/translate`,
        { reviewIds: [id] },
        'other',
      )
    ).status,
    404,
  );
  assert.equal((await t.translate(t.owner, [id], undefined, 'no-such-app')).status, 404);

  // Only stored reviews of this app are read; the client never sends text.
  assert.deepEqual((await t.translate(t.owner, ['nope', id])).body.notFound, ['nope']);
  for (const body of [
    { reviewIds: [] },
    { reviewIds: Array.from({ length: 26 }, (_, i) => `r${i}`) },
    { reviewIds: [id], target: '??' },
    { reviewIds: [id], text: 'free translation please' },
    {},
  ]) {
    assert.equal(
      (await t.call(t.owner, 'POST', `/apps/${t.appId}/reviews/translate`, body)).status,
      400,
      JSON.stringify(body),
    );
  }
  assert.equal(t.google.sent().includes('free translation please'), false);
});

dbTest(
  'translating: not configured, off, and an unreadable credential each answer 422 with a fixed message',
  async (db) => {
    const t = await bootTranslation(db);
    const id = await t.seed(1, { language: 'de' });
    let res = await t.translate(t.owner, [id]);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'translation_not_configured');
    assert.equal(res.body.reason, 'disabled');
    await t.put(t.owner, { 'translation.enabled': true });
    res = await t.translate(t.owner, [id]);
    assert.equal(res.body.error, 'translation_not_configured');
    assert.equal(res.body.reason, 'no_credential');
    const credential = await t.addCredential('translate_google', GOOGLE_SECRET);
    assert.equal((await t.translate(t.owner, [id])).status, 200);
    await t.put(t.owner, { 'translation.mode': 'off' });
    assert.equal((await t.translate(t.owner, [id])).body.reason, 'disabled');
    await t.put(t.owner, { 'translation.mode': 'on_demand' });
    // A credential that cannot be decrypted (rotated master key, damaged row).
    await db.execute("UPDATE credentials SET ciphertext = 'garbage' WHERE id = ?", [credential]);
    res = await t.translate(t.owner, [id], 'es');
    assert.equal(res.status, 422);
    assert.equal(res.body.reason, 'credential_unreadable');
    // LibreTranslate needs an address.
    await t.put(t.owner, { 'translation.provider': 'libretranslate' });
    assert.equal((await t.translate(t.owner, [id], 'es')).body.reason, 'no_url');
  },
);

dbTest(
  'translating: the cache serves a second request, a changed text or a new target asks the provider again',
  async (db) => {
    const t = await bootTranslation(db);
    await t.enable();
    const a = await t.seed(1, { language: 'de' });
    const b = await t.seed(2, { language: 'fr' });
    await t.translate(t.owner, [a, b]);
    assert.equal(t.google.requests.length, 1);
    assert.equal(
      t.google.requests[0]?.texts.length,
      4,
      'title and body of both reviews in one call',
    );

    const again = await t.translate(t.owner, [a, b]);
    assert.equal(t.google.requests.length, 1, 'served from the cache');
    assert.equal(again.body.cached, true);
    assert.ok(again.body.translations.every((x: { cached: boolean }) => x.cached));
    assert.equal(again.body.translations[0].body, '[en] Body of review 1');

    // The text changed: only that field is translated again, and the old translation is dropped.
    await db.execute("UPDATE app_reviews SET body = 'A new body' WHERE id = ?", [a]);
    const changed = await t.translate(t.owner, [a]);
    assert.deepEqual(t.google.requests[1]?.texts, ['A new body']);
    assert.equal(changed.body.translations[0].body, '[en] A new body');
    assert.equal(changed.body.translations[0].title, '[en] Title 1');
    assert.equal(
      (
        await rows(
          db,
          `SELECT id FROM review_translations WHERE review_id = '${a}' AND field = 'body'`,
        )
      ).length,
      1,
    );

    // Another target language is another translation.
    await t.translate(t.owner, [a], 'es');
    assert.equal(t.google.requests[2]?.target, 'es');
    assert.equal(
      (await rows(db, `SELECT id FROM review_translations WHERE review_id = '${a}'`)).length,
      4,
    );

    // Deleting the app's reviews takes their translations along.
    const { deleteReviewData } = await import('./modules/reviews/service.ts');
    await deleteReviewData(db, t.workspaceId, t.appId);
    assert.equal((await rows(db, 'SELECT id FROM review_translations')).length, 0);
  },
);

dbTest(
  'translating: reviews already in the target language, empty text and long text',
  async (db) => {
    const t = await bootTranslation(db);
    await t.enable();
    const english = await t.seed(1, { language: 'en' });
    const long = await t.seed(2, { language: 'de', body: 'x'.repeat(6000) });
    const empty = await t.seed(3, { language: 'de', title: '', body: ' ' });
    const res = await t.translate(t.owner, [english, long, empty]);
    assert.equal(res.status, 200, res.text);
    const by = (id: string) =>
      res.body.translations.find((x: { reviewId: string }) => x.reviewId === id);
    assert.equal(by(english).sameLanguage, true);
    assert.equal(by(english).body, undefined);
    assert.equal(by(long).truncated, true);
    assert.equal(by(long).body.length, '[en] '.length + 5000);
    assert.equal(by(empty).body, undefined);
    assert.ok(t.google.sent().every((s) => s.length <= 5000));
    assert.ok(!t.google.sent().includes('Body of review 1'), 'an English review is not sent');
  },
);

dbTest(
  'translating: the daily character budget, its refund on failure and the day rollover',
  async (db) => {
    const t = await bootTranslation(db);
    await t.enable({ 'translation.dailyCharBudget': 30 });
    const a = await t.seed(1, { language: 'de' }); // 'Title 1' + 'Body of review 1' = 23 characters
    const b = await t.seed(2, { language: 'de' });
    assert.equal((await t.translate(t.owner, [a])).status, 200);
    assert.equal((await t.usage()).used, 23);

    const over = await t.translate(t.owner, [b]);
    assert.equal(over.status, 429);
    assert.equal(over.body.error, 'translation_budget');
    assert.equal(over.body.budget, 30);
    assert.equal(over.body.used, 23);
    assert.equal(t.google.requests.length, 1, 'the provider was not called');
    // A cached translation costs nothing, even over the budget.
    assert.equal((await t.translate(t.owner, [a])).status, 200);

    // The next UTC day starts again.
    t.advance(24 * 60 * 60 * 1000);
    assert.equal((await t.translate(t.owner, [b])).status, 200);
    assert.equal((await t.usage()).used, 23);
    assert.equal((await rows(db, 'SELECT day FROM translation_usage')).length, 2);

    // A failed call gives its characters back.
    const c = await t.seed(3, { language: 'de' });
    t.advance(24 * 60 * 60 * 1000);
    t.google.mode = { status: 500 };
    assert.equal((await t.translate(t.owner, [c])).status, 502);
    assert.equal((await t.usage()).used, 0);
    t.google.mode = {};
    // 0 means no limit here; usage is still counted.
    await t.put(t.owner, { 'translation.dailyCharBudget': 0 });
    assert.equal((await t.translate(t.owner, [c])).status, 200);
    assert.equal((await t.usage()).used, 23);
    assert.equal((await t.usage()).budget, 0);
  },
);

dbTest('translating: provider failures map to stable codes and fixed messages', async (db) => {
  const t = await bootTranslation(db);
  await t.enable();
  const id = await t.seed(1, { language: 'de' });
  const cases: [Record<string, unknown>, number, string][] = [
    [
      {
        status: 403,
        body: {
          error: {
            message: 'API key not valid. secret detail',
            errors: [{ reason: 'keyInvalid' }],
          },
        },
      },
      422,
      'translation_auth',
    ],
    [
      { status: 403, body: { error: { message: 'Daily Limit Exceeded' } } },
      422,
      'translation_quota',
    ],
    [{ status: 429, headers: { 'retry-after': '7' } }, 429, 'translation_rate_limited'],
    [{ status: 500 }, 502, 'translation_unavailable'],
    [{ throws: true }, 502, 'translation_unavailable'],
  ];
  for (const [mode, status, code] of cases) {
    t.google.mode = mode;
    const res = await t.translate(t.owner, [id]);
    assert.equal(res.status, status, code);
    assert.equal(res.body.error, code);
    assert.equal(typeof res.body.message, 'string');
    assert.ok(
      !res.text.includes('secret detail') && !res.text.includes(GOOGLE_KEY),
      'nothing of the provider or the key is passed on',
    );
    if (code === 'translation_rate_limited') assert.equal(res.headers.get('retry-after'), '7');
  }
  assert.equal((await t.usage()).used, 0, 'every failure was refunded');
  t.google.mode = {};
  assert.equal((await t.translate(t.owner, [id], 'xx-invalid-language-zz')).status, 400);
});

dbTest('translating: a request limit per workspace', async (db) => {
  const t = await bootTranslation(db, {
    translation: { limiter: createTestLimiter({ limit: 2, now: () => 1 }) },
  });
  await t.enable();
  const id = await t.seed(1, { language: 'de' });
  assert.equal((await t.translate(t.owner, [id])).status, 200);
  assert.equal((await t.translate(t.owner, [id])).status, 200);
  const slow = await t.translate(t.owner, [id]);
  assert.equal(slow.status, 429);
  assert.equal(slow.body.error, 'rate_limited');
  assert.ok(slow.headers.get('retry-after'));
});

dbTest('translate/test: admins only, one fixed word, the key never echoed', async (db) => {
  const t = await bootTranslation(db);
  const admin = await t.addMember('admin');
  const member = await t.addMember('member');
  assert.equal((await t.call(member, 'POST', '/translate/test')).status, 403);
  let res = await t.call(admin, 'POST', '/translate/test');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, 'no_credential');
  await t.addCredential('translate_google', GOOGLE_SECRET);
  res = await t.call(admin, 'POST', '/translate/test');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(t.google.requests.at(-1)?.texts, ['Hello']);
  t.google.mode = { status: 403, body: { error: { message: 'API key not valid. secret detail' } } };
  res = await t.call(admin, 'POST', '/translate/test');
  assert.equal(res.body.ok, false);
  assert.ok(!res.text.includes('secret detail') && !res.text.includes(GOOGLE_KEY));
  assert.ok((await t.auditActions()).some((a) => a.action === 'translation.test'));
});

dbTest(
  'vault: the translate_* kinds are stored, listed without secrets, and tested without echoing them',
  async (db) => {
    const t = await bootTranslation(db);
    const kinds: [string, string][] = [
      ['translate_google', JSON.stringify({ apiKey: GOOGLE_KEY })],
      ['translate_deepl', JSON.stringify({ apiKey: '11111111-2222-3333-4444-555555555555:fx' })],
      [
        'translate_azure',
        JSON.stringify({ apiKey: 'azurekey0123456789abcdef0123456789', region: 'westeurope' }),
      ],
      ['translate_libretranslate', JSON.stringify({ apiKey: 'libre-key-123' })],
    ];
    for (const [kind, secret] of kinds) {
      const res = await t.call(t.owner, 'POST', '/credentials', { kind, label: kind, secret });
      assert.equal(res.status, 201, `${kind}: ${res.text}`);
    }
    const bad = await t.call(t.owner, 'POST', '/credentials', {
      kind: 'translate_google',
      label: 'x',
      secret: JSON.stringify({ apiKey: 'has space' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(
      (
        await t.call(t.owner, 'POST', '/credentials', {
          kind: 'translate_azure',
          label: 'x',
          secret: JSON.stringify({ apiKey: 'k'.repeat(32), region: 'not a region!' }),
        })
      ).status,
      400,
    );
    const list = await t.call(t.owner, 'GET', '/credentials');
    assert.ok(!list.text.includes(GOOGLE_KEY) && !list.text.includes('libre-key-123'));

    // Test connection of an unsaved secret: translates a fixed word, says ok or a fixed sentence.
    let res = await t.call(t.owner, 'POST', '/credentials/test', {
      kind: 'translate_google',
      secret: kinds[0]?.[1],
    });
    assert.equal(res.body.ok, true, res.text);
    assert.deepEqual(t.google.requests.at(-1)?.texts, ['Hello']);
    t.google.mode = {
      status: 403,
      body: { error: { message: `API key not valid ${GOOGLE_KEY}` } },
    };
    res = await t.call(t.owner, 'POST', '/credentials/test', {
      kind: 'translate_google',
      secret: kinds[0]?.[1],
    });
    assert.equal(res.body.ok, false);
    assert.ok(!res.text.includes(GOOGLE_KEY), 'the key is never echoed');
    // The same through a saved credential.
    const saved = await t.call(t.owner, 'POST', '/credentials', {
      kind: 'translate_google',
      label: 'again',
      secret: kinds[0]?.[1],
    });
    res = await t.call(t.owner, 'POST', `/credentials/${saved.body.credential.id}/test`);
    assert.equal(res.body.ok, false);
    assert.ok(!res.text.includes(GOOGLE_KEY));
    for (const text of t.texts)
      assert.ok(!text.includes('libre-key-123'), 'no response carries a key');
  },
);

// ---------------------------------------------------------------------------------------------
// LibreTranslate with a custom address: the SSRF rules

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
type Seen = {
  address: string;
  url: string;
  servername?: string;
  headers: Record<string, string>;
  body: string;
};
function libreExchange(
  answer: {
    status?: number;
    json?: unknown;
    headers?: Record<string, string>;
    overflow?: boolean;
  } = {},
) {
  const seen: Seen[] = [];
  const exchange = async (req: {
    address: string;
    url: URL;
    servername?: string;
    headers: Record<string, string>;
    body: string | undefined;
  }) => {
    seen.push({
      address: req.address,
      url: req.url.toString(),
      ...(req.servername ? { servername: req.servername } : {}),
      headers: req.headers,
      body: req.body ?? '',
    });
    const body = JSON.parse(req.body ?? '{}') as { q: string | string[]; target: string };
    const json = answer.json ?? {
      translatedText: Array.isArray(body.q)
        ? body.q.map((q) => `L[${body.target}] ${q}`)
        : `L[${body.target}] ${body.q}`,
    };
    return {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) },
      body: new TextEncoder().encode(JSON.stringify(json)),
      overflow: answer.overflow ?? false,
    };
  };
  return { exchange: exchange as never, seen };
}
type Boot = Awaited<ReturnType<typeof bootTranslation>>;
const useLibre = async (t: Boot) => {
  await t.db.execute(
    "INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at, updated_by) VALUES (?, 'translation.libretranslate.url', '\"https://libre.example.com/api\"', 1, 'x')",
    [t.workspaceId],
  );
  await t.put(t.owner, { 'translation.enabled': true, 'translation.provider': 'libretranslate' });
  await t.addCredential('translate_libretranslate', JSON.stringify({ apiKey: 'libre-key-123' }));
  return t.seed(1, { language: 'de' });
};

dbTest(
  'LibreTranslate: the call goes to the checked address, with the key in the body and no redirects',
  async (db) => {
    const net = libreExchange();
    const t = await bootTranslation(db, {
      translation: { resolve: async () => PUBLIC, exchange: net.exchange },
    });
    const id = await useLibre(t);
    const res = await t.translate(t.owner, [id]);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.provider, 'libretranslate');
    assert.equal(res.body.translations[0].body, 'L[en] Body of review 1');
    assert.equal(net.seen.length, 1);
    assert.equal(
      net.seen[0]?.address,
      '93.184.216.34',
      'the connection is pinned to the checked address',
    );
    assert.equal(net.seen[0]?.servername, 'libre.example.com');
    assert.equal(net.seen[0]?.url, 'https://libre.example.com/api/translate');
    assert.equal(JSON.parse(net.seen[0]?.body ?? '{}').api_key, 'libre-key-123');
    assert.equal(t.google.requests.length, 0);
    assert.ok(!t.texts.some((x) => x.includes('libre-key-123')));
  },
);

dbTest('LibreTranslate: a redirect is a failure and is not followed', async (db) => {
  const redirect = libreExchange({
    status: 302,
    headers: { location: 'http://169.254.169.254/latest' },
  });
  const t = await bootTranslation(db, {
    translation: { resolve: async () => PUBLIC, exchange: redirect.exchange },
  });
  const res = await t.translate(t.owner, [await useLibre(t)]);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'translation_unavailable');
  assert.equal(redirect.seen.length, 1, 'the redirect was not followed');
  assert.ok(!res.text.includes('169.254'));
});

dbTest('LibreTranslate: an answer over the size cap is a failure', async (db) => {
  const big = libreExchange({ overflow: true });
  const t = await bootTranslation(db, {
    translation: { resolve: async () => PUBLIC, exchange: big.exchange },
  });
  const res = await t.translate(t.owner, [await useLibre(t)]);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'translation_unavailable');
});

for (const [address, allow] of [
  ['10.0.0.5', false],
  ['169.254.169.254', true],
  ['100.100.100.200', true],
  ['127.0.0.1', false],
] as const) {
  dbTest(
    `LibreTranslate: a name that now resolves to ${address} (private allowed: ${allow}) is refused at call time`,
    async (db) => {
      const net = libreExchange();
      const t = await bootTranslation(db, {
        translation: {
          resolve: async () => [{ address, family: 4 }],
          exchange: net.exchange,
          allowPrivateUrls: allow,
        },
      });
      const res = await t.translate(t.owner, [await useLibre(t)]);
      assert.equal(res.status, 502, address);
      assert.equal(res.body.reason, 'address_not_allowed', address);
      assert.equal(net.seen.length, 0, 'nothing was sent');
      assert.ok(!res.text.includes(address), 'the address is not echoed');
    },
  );
}

dbTest('LibreTranslate: the key credential is tested against the saved address', async (db) => {
  const net = libreExchange();
  const t = await bootTranslation(db, {
    translation: { resolve: async () => PUBLIC, exchange: net.exchange },
  });
  const secret = JSON.stringify({ apiKey: 'libre-key-123' });
  let res = await t.call(t.owner, 'POST', '/credentials/test', {
    kind: 'translate_libretranslate',
    secret,
  });
  assert.equal(res.body.ok, false);
  assert.match(res.body.message, /address/i);
  assert.equal(net.seen.length, 0);
  await t.put(t.owner, { 'translation.libretranslate.url': 'https://libre.example.com' });
  res = await t.call(t.owner, 'POST', '/credentials/test', {
    kind: 'translate_libretranslate',
    secret,
  });
  assert.equal(res.body.ok, true, res.text);
  assert.equal(JSON.parse(net.seen[0]?.body ?? '{}').q, 'Hello');
  assert.ok(!res.text.includes('libre-key-123'));
});

// ---------------------------------------------------------------------------------------------
// Auto mode

const syncOnce = async (t: Boot) => {
  const res = await t.call(t.owner, 'POST', `/apps/${t.appId}/reviews/sync`);
  assert.equal(res.status, 200, res.text);
  return res.body.sync as {
    translation?: {
      mode: string;
      attempted: number;
      translated: number;
      chars: number;
      error?: string;
    };
  };
};

dbTest(
  'auto mode: new reviews in another language are translated after a sync, at most 20, others are not',
  async (db) => {
    const t = await bootTranslation(db);
    // Not auto (the default is on demand): a sync never calls a provider.
    await t.enable();
    t.store.reviews = [storeReview(1, { language: 'de' }, 'ios')];
    assert.equal((await syncOnce(t)).translation, undefined);
    assert.equal(t.google.requests.length, 0);

    await t.put(t.owner, { 'translation.mode': 'auto' });
    const many = Array.from({ length: 25 }, (_, i) =>
      storeReview(i + 10, { language: 'de' }, 'ios'),
    );
    t.store.reviews = [
      ...t.store.reviews,
      ...many,
      storeReview(40, { language: 'en' }, 'ios'),
      storeReview(41, {}, 'ios'),
    ];
    const sync = await syncOnce(t);
    assert.equal(sync.translation?.mode, 'auto');
    assert.equal(sync.translation?.attempted, 20, 'a per sync cap of 20');
    assert.equal(sync.translation?.translated, 20);
    assert.equal(sync.translation?.error, undefined);
    assert.equal((await rows(db, 'SELECT DISTINCT review_id FROM review_translations')).length, 20);
    const english = await rows(
      db,
      "SELECT id FROM app_reviews WHERE store_review_id LIKE '%rev-40'",
    );
    assert.equal(
      (await rows(db, `SELECT id FROM review_translations WHERE review_id = '${english[0]?.id}'`))
        .length,
      0,
      'English is not sent',
    );
    // The reviews that were not translated stay for on-demand translation; a second sync adds nothing.
    const before = t.google.requests.length;
    const again = await syncOnce(t);
    assert.equal(again.translation, undefined, 'nothing new, nothing attempted');
    assert.equal(t.google.requests.length, before);
    // Audited by counts only.
    const audit = (await t.auditActions()).filter((a) => a.action === 'review.translate');
    assert.equal(audit.length, 1);
    const detail = JSON.parse(String(audit[0]?.detail));
    assert.deepEqual(Object.keys(detail).sort(), [
      'chars',
      'fromCache',
      'ok',
      'provider',
      'reviews',
      'target',
      'trigger',
    ]);
    assert.equal(detail.trigger, 'auto');
  },
);

dbTest(
  'auto mode: a failure or an exhausted budget is recorded and never fails the sync',
  async (db) => {
    const t = await bootTranslation(db);
    await t.enable({ 'translation.mode': 'auto' });
    t.store.reviews = [storeReview(1, { language: 'de' }, 'ios')];
    await syncOnce(t); // baseline, translated
    t.google.mode = { status: 403, body: { error: { message: 'API key not valid' } } };
    t.store.reviews = [...t.store.reviews, storeReview(2, { language: 'de' }, 'ios')];
    let sync = await syncOnce(t);
    assert.equal(sync.translation?.error, 'translation_auth');
    assert.equal(sync.translation?.translated, 0);
    const state = (await t.call(t.owner, 'GET', `/apps/${t.appId}/reviews/summary`)).body.sync;
    assert.equal(state.lastError, null, 'the sync itself succeeded');
    assert.equal((await rows(db, 'SELECT id FROM app_reviews')).length, 2);

    t.google.mode = {};
    await t.put(t.owner, { 'translation.dailyCharBudget': 5 });
    t.store.reviews = [...t.store.reviews, storeReview(3, { language: 'de' }, 'ios')];
    sync = await syncOnce(t);
    assert.equal(sync.translation?.error, 'translation_budget');
    const failures = (await t.auditActions()).filter(
      (a) => a.action === 'review.translate' && JSON.parse(String(a.detail)).ok === false,
    );
    assert.equal(failures.length, 2);
  },
);

// ---------------------------------------------------------------------------------------------
// Privacy

dbTest('review and reply text never reaches the logs, the audit log or the events', async (db) => {
  const spy = captureConsole();
  try {
    const t = await bootTranslation(db);
    await t.enable({ 'translation.mode': 'auto' });
    const marker = 'ZZ-PRIVATE-REVIEW-TEXT-ZZ';
    t.store.reviews = [
      storeReview(1, { language: 'de', body: `${marker} one`, title: `${marker} title` }, 'ios'),
    ];
    await syncOnce(t);
    t.store.reviews = [
      ...t.store.reviews,
      storeReview(2, { language: 'fr', body: `${marker} two`, rating: 1 }, 'ios'),
    ];
    await syncOnce(t);
    const id = await t.seed(3, { language: 'es', body: `${marker} three` });
    await t.translate(t.owner, [id]);
    t.google.mode = { status: 500 };
    const other = await t.seed(4, { language: 'es', body: `${marker} four` });
    await t.translate(t.owner, [other]);
    await t.put(t.owner, { 'translation.dailyCharBudget': 1 });
    await t.translate(t.owner, [other]);

    const everything = JSON.stringify([
      await rows(db, 'SELECT * FROM audit_events'),
      await rows(db, 'SELECT * FROM events'),
      await rows(db, 'SELECT * FROM workspace_settings'),
      await rows(db, 'SELECT * FROM translation_usage'),
      spy.lines,
    ]);
    assert.ok(!everything.includes(marker), 'review text leaked');
    assert.ok(!everything.includes('[en] '), 'translated text leaked');
    assert.ok(!everything.includes(GOOGLE_KEY), 'the key leaked');
    assert.ok((await t.auditActions()).some((a) => a.action === 'review.translate'));
    // The text is stored only in the review itself and in its cached translation.
    assert.ok(
      JSON.stringify(await rows(db, 'SELECT translated_text FROM review_translations')).includes(
        '[en] ',
      ),
    );
  } finally {
    spy.restore();
  }
});

// ---------------------------------------------------------------------------------------------
// The API description

type OpenApi = {
  paths: Record<
    string,
    Record<
      string,
      {
        operationId: string;
        requestBody?: {
          content: Record<string, { schema: { properties?: Record<string, unknown> } }>;
        };
      }
    >
  >;
};

dbTest(
  'OpenAPI describes the settings and translation operations with real schemas',
  async (db) => {
    const t = await bootTranslation(db);
    const doc = (await (
      await t.app.request('/api/openapi.json', { headers: { cookie: t.owner } })
    ).json()) as OpenApi;
    const w = '/api/workspaces/{workspaceId}';
    assert.equal(doc.paths[`${w}/settings`]?.get?.operationId, 'getWorkspaceSettings');
    const put = doc.paths[`${w}/settings`]?.put;
    assert.equal(put?.operationId, 'updateWorkspaceSettings');
    const props = put?.requestBody?.content['application/json']?.schema.properties ?? {};
    assert.deepEqual(Object.keys(props).sort(), [
      'aso.rankMoveThreshold',
      'reviews.lowRatingThreshold',
      'translation.dailyCharBudget',
      'translation.enabled',
      'translation.libretranslate.url',
      'translation.mode',
      'translation.provider',
      'translation.targetLanguage',
    ]);
    const translate = doc.paths[`${w}/apps/{id}/reviews/translate`]?.post;
    assert.equal(translate?.operationId, 'translateReviews');
    const tprops = translate?.requestBody?.content['application/json']?.schema.properties ?? {};
    assert.deepEqual(Object.keys(tprops).sort(), ['reviewIds', 'target']);
    assert.equal(doc.paths[`${w}/translate/test`]?.post?.operationId, 'testTranslation');
    assert.ok(JSON.stringify(doc).includes('translation_budget'));
    const { operations } = await import('./services/api-operations.ts');
    const byId = new Map(operations.map((o) => [o.id, o]));
    assert.deepEqual(byId.get('translateReviews')?.access, { action: 'reviews.translate' });
    assert.deepEqual(byId.get('translateReviews')?.appScope, { kind: 'param', name: 'id' });
    assert.deepEqual(byId.get('updateWorkspaceSettings')?.access, { action: 'settings.write' });
    assert.deepEqual(byId.get('getWorkspaceSettings')?.access, { action: 'settings.read' });
  },
);

dbTest(
  'a provider that was never configured is not called by a plain sync or by the settings screen',
  async (db) => {
    const google = fakeGoogle();
    const t = await bootTranslation(db, { google });
    t.store.reviews = [storeReview(1, { language: 'de' }, 'ios')];
    await syncOnce(t);
    await t.call(t.owner, 'GET', '/settings');
    assert.equal(google.requests.length, 0);
  },
);

dbTest('translations of reviews that are gone are purged by the review upkeep', async (db) => {
  const t = await bootTranslation(db);
  await t.enable();
  const id = await t.seed(1, { language: 'de' });
  await t.translate(t.owner, [id]);
  assert.equal((await rows(db, 'SELECT id FROM review_translations')).length, 2);
  await db.execute('DELETE FROM app_reviews WHERE id = ?', [id]);
  const { reviewUpkeep } = await import('./modules/reviews/schedule.ts');
  await reviewUpkeep(db, { now: Date.now(), retentionDays: 0 });
  assert.equal((await rows(db, 'SELECT id FROM review_translations')).length, 0);
});
