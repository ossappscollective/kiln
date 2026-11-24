import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { bootTranslation } from './translation-test-helpers.ts';

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const resolve = async (host: string) =>
  host === 'meta.example.com'
    ? [{ address: '169.254.169.254', family: 4 }]
    : host === 'lan.example.com'
      ? [{ address: '10.0.0.5', family: 4 }]
      : PUBLIC;

dbTest('settings: defaults, who may read and write, 404 for outsiders', async (db) => {
  const t = await bootTranslation(db, { translation: { resolve } });
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  const admin = await t.addMember('admin');

  // Reading needs member or better (settings.read); a viewer has no settings screen.
  assert.equal((await t.call(viewer, 'GET', '/settings')).status, 403);
  const read = await t.call(member, 'GET', '/settings');
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.values, {
    'reviews.lowRatingThreshold': 2,
    'aso.rankMoveThreshold': 5,
    'prices.writeEnabled': false,
    'translation.enabled': false,
    'translation.provider': 'google',
    'translation.targetLanguage': 'en',
    'translation.mode': 'on_demand',
    'translation.dailyCharBudget': 50000,
    'translation.libretranslate.url': '',
    'release.stalledAfterHours': 6,
    'release.stalledRepeatHours': 24,
    'sync.enabled': true,
    'sync.intervalMinutes': 30,
    'reviews.unansweredReminderHours': 0,
    'reviews.unansweredMaxRating': 5,
    'analytics.enabled': false,
    'analytics.appleVendorNumber': '',
    'analytics.playBucketId': '',
  });
  assert.deepEqual(read.body.defaults, read.body.values);
  assert.deepEqual(read.body.overridden, []);
  assert.deepEqual(read.body.writable, []);
  assert.equal((await t.call(admin, 'GET', '/settings')).body.writable.length, 18);
  assert.equal(read.body.translation.credentialConfigured, false);
  assert.equal(
    read.body.translation.credential,
    undefined,
    'a member does not see which credential',
  );

  for (const cookie of [viewer, member]) {
    assert.equal((await t.put(cookie, { 'reviews.lowRatingThreshold': 3 })).status, 403);
    assert.equal((await t.call(cookie, 'POST', '/translate/test')).status, 403);
  }
  assert.equal((await t.put(admin, { 'reviews.lowRatingThreshold': 3 })).status, 200);
  assert.equal(
    (await t.call(member, 'GET', '/settings')).body.values['reviews.lowRatingThreshold'],
    3,
  );

  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  for (const [method, path, body] of [
    ['GET', '/settings'],
    ['PUT', '/settings', {}],
    ['POST', '/translate/test'],
  ] as const) {
    const res = await t.call(outsider, method, path, body);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.deepEqual(res.body, { error: 'not_found' });
  }
  // The other workspace has its own settings, untouched by this one.
  assert.equal(
    (await t.call(outsider, 'GET', '/settings', undefined, 'other')).body.values[
      'reviews.lowRatingThreshold'
    ],
    2,
  );
  assert.equal(
    (await t.call(outsider, 'PUT', '/settings', { 'reviews.lowRatingThreshold': 4 }, 'other'))
      .status,
    200,
  );
  assert.equal(
    (await t.call(t.owner, 'GET', '/settings')).body.values['reviews.lowRatingThreshold'],
    3,
  );
});

dbTest(
  'settings: partial update, null resets, unknown and invalid keys change nothing',
  async (db) => {
    const t = await bootTranslation(db, { translation: { resolve } });
    const ok = await t.put(t.owner, {
      'reviews.lowRatingThreshold': 3,
      'translation.targetLanguage': 'pt_br',
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.changed.sort(), [
      'reviews.lowRatingThreshold',
      'translation.targetLanguage',
    ]);
    assert.equal(ok.body.values['translation.targetLanguage'], 'pt-BR');
    assert.deepEqual(ok.body.overridden.sort(), [
      'reviews.lowRatingThreshold',
      'translation.targetLanguage',
    ]);

    const unknown = await t.put(t.owner, { 'reviews.lowRatingThreshold': 1, 'nope.key': 1 });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, 'unknown_setting');
    assert.equal(
      (await t.call(t.owner, 'GET', '/settings')).body.values['reviews.lowRatingThreshold'],
      3,
      'all or nothing',
    );

    const bad: [string, unknown][] = [
      ['reviews.lowRatingThreshold', 0],
      ['reviews.lowRatingThreshold', 5],
      ['reviews.lowRatingThreshold', '2'],
      ['reviews.lowRatingThreshold', 2.5],
      ['translation.enabled', 'yes'],
      ['translation.provider', 'bing'],
      ['translation.targetLanguage', 'not a tag'],
      ['translation.mode', 'always'],
      ['translation.dailyCharBudget', -1],
      ['translation.dailyCharBudget', 1e12],
    ];
    for (const [key, value] of bad) {
      const res = await t.put(t.owner, { 'reviews.lowRatingThreshold': 4, [key]: value });
      assert.equal(res.status, 400, `${key}=${String(value)}`);
      assert.equal(res.body.error, 'invalid_setting');
      assert.equal(
        res.body.issues[0].path === key ||
          res.body.issues.some((i: { path: string }) => i.path === key),
        true,
      );
    }
    assert.equal(
      (await t.call(t.owner, 'GET', '/settings')).body.values['reviews.lowRatingThreshold'],
      3,
      'nothing changed',
    );
    for (const body of [[], 'x', null, 3]) assert.equal((await t.put(t.owner, body)).status, 400);

    const reset = await t.put(t.owner, { 'reviews.lowRatingThreshold': null });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.values['reviews.lowRatingThreshold'], 2);
    assert.ok(!reset.body.overridden.includes('reviews.lowRatingThreshold'));
  },
);

dbTest('settings: every change is audited with the keys and the old and new values', async (db) => {
  const t = await bootTranslation(db, { translation: { resolve } });
  await t.put(t.owner, { 'reviews.lowRatingThreshold': 3, 'translation.mode': 'auto' });
  await t.put(t.owner, { 'reviews.lowRatingThreshold': 3 }); // no change: no entry
  const rows = (await t.auditActions()).filter((a) => a.action === 'settings.update');
  assert.equal(rows.length, 1);
  const detail = JSON.parse(String(rows[0]?.detail));
  assert.deepEqual(detail.keys.sort(), ['reviews.lowRatingThreshold', 'translation.mode']);
  assert.deepEqual(
    detail.changes.find((c: { key: string }) => c.key === 'reviews.lowRatingThreshold'),
    { key: 'reviews.lowRatingThreshold', from: 2, to: 3 },
  );
  assert.equal(rows[0]?.actorType, 'user');
});

dbTest('settings: the LibreTranslate address is checked when it is saved', async (db) => {
  const t = await bootTranslation(db, { translation: { resolve } });
  const refused: [string, RegExp?][] = [
    ['http://translate.example.com'],
    ['ftp://translate.example.com'],
    ['https://user:pass@translate.example.com'],
    ['https://translate.example.com/?key=1'],
    ['https://127.0.0.1'],
    ['https://10.1.2.3'],
    ['https://192.168.1.10'],
    ['https://localhost'],
    ['https://169.254.169.254'],
    ['https://100.100.100.200'],
    ['https://[fd00:ec2::254]'],
    ['https://lan.example.com'],
    ['https://meta.example.com'],
    ['not a url'],
  ];
  for (const [url] of refused) {
    const res = await t.put(t.owner, { 'translation.libretranslate.url': url });
    assert.equal(res.status, 400, url);
    assert.equal(res.body.error, 'invalid_setting', url);
  }
  const good = await t.put(t.owner, {
    'translation.libretranslate.url': 'https://translate.example.com/libre/',
  });
  assert.equal(good.status, 200);
  assert.equal(
    good.body.values['translation.libretranslate.url'],
    'https://translate.example.com/libre',
  );
  assert.equal((await t.put(t.owner, { 'translation.libretranslate.url': '' })).status, 200);
});

dbTest(
  'settings: a private or loopback address needs KILN_TRANSLATE_ALLOW_PRIVATE_URLS, metadata never',
  async (db) => {
    const t = await bootTranslation(db, { translation: { resolve, allowPrivateUrls: true } });
    for (const url of [
      'https://lan.example.com',
      'https://10.0.0.5',
      'http://127.0.0.1:5000',
      'http://localhost:5000',
    ]) {
      assert.equal(
        (await t.put(t.owner, { 'translation.libretranslate.url': url })).status,
        200,
        url,
      );
    }
    // Plain http is for loopback only, even then.
    assert.equal(
      (await t.put(t.owner, { 'translation.libretranslate.url': 'http://10.0.0.5' })).status,
      400,
    );
    for (const url of [
      'https://169.254.169.254',
      'http://169.254.169.254',
      'https://meta.example.com',
      'https://100.100.100.200',
      'https://[fd00:ec2::254]',
    ]) {
      assert.equal(
        (await t.put(t.owner, { 'translation.libretranslate.url': url })).status,
        400,
        url,
      );
    }
  },
);

dbTest('settings: secrets are not settings', async (db) => {
  const t = await bootTranslation(db);
  for (const key of [
    'translation.apiKey',
    'translation.libretranslate.apiKey',
    'translation.credentialId',
    'translation.secret',
  ]) {
    const res = await t.put(t.owner, { [key]: 'AIza-should-not-be-stored' });
    assert.equal(res.status, 400, key);
    assert.equal(res.body.error, 'unknown_setting');
  }
  const stored = await db.query('SELECT value_json FROM workspace_settings');
  assert.equal(JSON.stringify(stored).includes('AIza'), false);
});
