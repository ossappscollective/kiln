import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { ADS_ACCOUNT_ID, ADS_ADAM, ADS_IDS, ADS_PEM, bootAds, json } from './test-helpers.ts';

/** Apple Ads, read only (docs/adr/0058-apple-ads.md). The Apple Ads API is a fake: nothing is contacted, no real account was called. */

const noKeyAnywhere = async (t: Awaited<ReturnType<typeof bootAds>>) => {
  const all = await t.everything();
  for (const needle of ['PRIVATE KEY', ADS_PEM.split('\n')[1] ?? 'zzz', 'access-token-1', 'client_secret']) assert.ok(!all.includes(needle), `leaked ${needle}`);
};

dbTest('an Apple Ads key is tested by signing in and listing the accounts; the answer names the accounts, never the key', async (db) => {
  const t = await bootAds(db);
  const res = await t.call(t.owner, 'POST', '/credentials/test', { kind: 'apple_ads', secret: JSON.stringify({ ...ADS_IDS, privateKey: ADS_PEM }) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.ok, true);
  assert.match(res.body.message, /Connected to Apple Ads/);
  assert.ok(res.body.details.some((d: string) => d.includes('AwayFinder')));
  assert.deepEqual(t.ads.calls.map((c) => `${c.method} ${c.path}`), ['POST /auth/oauth2/token', 'GET /v1/acls']);
  assert.deepEqual([...new Set(t.ads.calls.map((c) => c.host))].sort(), ['api.ads.apple.com', 'appleid.apple.com']);
  const list = await t.call(t.owner, 'GET', '/credentials');
  assert.ok(!list.text.includes('PRIVATE KEY'));
  await noKeyAnywhere(t);
  t.ads.tokenStatus = 401;
  const refused = await t.call(t.owner, 'POST', '/credentials/test', { kind: 'apple_ads', secret: JSON.stringify({ ...ADS_IDS, privateKey: ADS_PEM }) });
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.message, /did not accept the key/);
  const bad = await t.call(t.owner, 'POST', '/credentials', { kind: 'apple_ads', label: 'x', secret: JSON.stringify({ ...ADS_IDS, privateKey: 'nope' }) });
  assert.equal(bad.status, 400);
});

dbTest('linking: the accounts of the key, one saved with what Apple said, the wrong ones refused, rights checked', async (db) => {
  const t = await bootAds(db);
  const appId = await t.addApp('ios');
  const accounts = await t.call(t.owner, 'GET', `${t.base(appId, '/accounts')}?credentialId=${t.adsCredential}`);
  assert.equal(accounts.status, 200, accounts.text);
  assert.deepEqual(accounts.body.accounts.map((a: { id: string }) => a.id), [ADS_ACCOUNT_ID, '987654321']);
  assert.equal((await t.get(appId, '')).body.link, null);
  const saved = await t.link(appId);
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(
    [saved.body.link.adAccountName, saved.body.link.currency, saved.body.link.timezone, saved.body.link.adamId, saved.body.link.credentialAvailable, saved.body.link.orgId],
    ['AwayFinder Ad Account', 'EUR', 'America/New_York', ADS_ADAM, true, '27154130'],
  );
  // The store id of the record is the default for the Apple id.
  const noAdam = await t.call(t.owner, 'PUT', t.base(appId), { credentialId: t.adsCredential, adAccountId: ADS_ACCOUNT_ID });
  assert.equal(noAdam.body.link.adamId, '1234567890');
  assert.equal((await t.link(appId, { adAccountId: '555' })).body.error, 'ads_account_missing');
  assert.equal((await t.link(appId, { adamId: 'abc' })).status, 400);
  const github = await t.addCredential('github_token');
  assert.equal((await t.link(appId, { credentialId: github })).body.error, 'credential_kind');
  assert.equal((await t.link(appId, { credentialId: 'nope' })).body.error, 'credential_not_found');
  const android = await t.addApp('android');
  assert.equal((await t.link(android)).body.error, 'ads_not_supported');
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  assert.equal((await t.link(appId, {}, viewer)).status, 403);
  assert.equal((await t.link(appId, {}, member)).status, 403);
  assert.equal((await t.get(appId, '', viewer)).status, 200);
  assert.deepEqual(t.ads.api.map((c) => c.method), t.ads.api.map(() => 'GET'), 'linking only reads');
  assert.ok(t.ads.api.every((c) => c.path === '/v1/acls' || c.path === `/v1/ad-accounts/${ADS_ACCOUNT_ID}`));
  const actions = (await t.auditActions()).map((a) => a.action);
  assert.ok(actions.includes('ads.link_set') && actions.includes('credential.use'));
  assert.equal((await t.call(t.owner, 'DELETE', t.base(appId))).status, 204);
  assert.equal((await t.call(t.owner, 'DELETE', t.base(appId))).status, 404);
  await noKeyAnywhere(t);
});

dbTest('a sync stores the days of the campaigns of the linked app, merged and in micro-units, and is idempotent', async (db) => {
  const t = await bootAds(db);
  const appId = await t.linked();
  const first = await t.runSync(appId);
  assert.equal(first.res.status, 202, first.res.text);
  const sync = (await t.get(appId, '')).body.sync;
  assert.equal(sync.failureStreak, 0);
  assert.equal(sync.lastError, null);
  assert.deepEqual([sync.rangeStart, sync.rangeEnd, sync.campaigns, sync.complete], ['2026-10-24', '2026-11-22', 1, true]);
  // The range of a first sync is 30 days ending yesterday.
  const reads = t.ads.api.filter((c) => c.path.startsWith('/v1/reports'));
  assert.deepEqual(reads.map((c) => c.path), ['/v1/reports/apps/campaigns/query', '/v1/reports/apps/searchterms/query', '/v1/reports/apps/keywords/query']);
  assert.deepEqual((reads[0]?.body as { timeRange: unknown }).timeRange, { start: '2026-10-24', end: '2026-11-22', timeZone: 'ORTZ', granularity: 'DAILY' });
  assert.ok(t.ads.api.every((c) => c.context === `adAccountId=${ADS_ACCOUNT_ID}` || c.path === '/v1/acls'));
  const campaign = await db.query('SELECT campaign_id, day, impressions, taps, installs, spend_micros, currency FROM ads_campaign_daily ORDER BY day');
  assert.deepEqual(campaign.map((r) => [r.campaign_id, r.day, Number(r.impressions), Number(r.taps), Number(r.installs), Number(r.spend_micros), r.currency]), [
    ['444555666', '2026-11-01', 1000, 50, 12, 10_250_000, 'EUR'],
    ['444555666', '2026-11-02', 2000, 100, 30, 20_250_000, 'EUR'],
  ]);
  const terms = await db.query("SELECT term_key, country, term, keyword_text, impressions, spend_micros FROM ads_term_daily WHERE kind = 'term' ORDER BY country");
  assert.deepEqual(terms.map((r) => [r.term_key, r.country, r.term, r.keyword_text, Number(r.impressions), Number(r.spend_micros)]), [
    ['photo editor', 'gb', 'Photo Editor', 'photo editor', 40, 500_000],
    ['photo editor', 'us', 'Photo Editor', 'photo editor', 400, 3_500_000],
  ]);
  assert.equal(await t.count('ads_term_daily'), 3, 'two terms rows and one keyword row');
  const before = [await t.count('ads_campaign_daily'), await t.count('ads_term_daily')];
  await t.runSync(appId);
  assert.deepEqual([await t.count('ads_campaign_daily'), await t.count('ads_term_daily')], before, 'the same read twice is the same rows');
  // Later syncs re-read the last 14 days only: an empty answer for those days does not touch older rows.
  t.ads.terms = { result: { rows: [] }, pagination: { totalCount: 0 } };
  await t.runSync(appId);
  assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM ads_term_daily WHERE kind = 'term'"))[0]?.n), 2);
  const audit = (await t.auditActions()).filter((a) => a.action === 'ads.synced');
  assert.equal(audit.length, 3);
  assert.ok(!audit[0]?.detail.includes('Photo') && !audit[0]?.detail.includes('AwayFinder'), 'counts only');
  // Reads only: the token, then GETs for the link and POST .../query for reports.
  assert.ok(t.ads.api.every((c) => c.method === 'GET' || c.path.endsWith('/query')));
  await noKeyAnywhere(t);
});

dbTest('a failed sync keeps the last good rows, says why in a fixed sentence and counts the streak; a 429 is not a failure', async (db) => {
  const t = await bootAds(db);
  const appId = await t.linked();
  await t.runSync(appId);
  const rows = await t.count('ads_campaign_daily');
  t.ads.tokenStatus = 401;
  await t.runSync(appId);
  let state = (await t.get(appId, '')).body.sync;
  assert.equal(state.failureStreak, 1);
  assert.match(state.lastError, /did not accept the key/);
  assert.equal(state.lastErrorCode, 'ads.auth');
  assert.equal(await t.count('ads_campaign_daily'), rows);
  t.ads.tokenStatus = 200;
  t.ads.next = [json({}, 429, { 'retry-after': '600' })];
  // The token request is the first call and answers 429 here: the key is fine, Apple asks to wait.
  await t.runSync(appId);
  state = (await t.get(appId, '')).body.sync;
  assert.equal(state.failureStreak, 1, 'a 429 is not a failure of the key');
  await t.runSync(appId);
  state = (await t.get(appId, '')).body.sync;
  assert.equal(state.failureStreak, 0);
  assert.equal(state.lastError, null);
  // A shape this server does not know is reported, not guessed at.
  t.ads.campaigns = { result: { nope: true } };
  await t.runSync(appId);
  assert.match((await t.get(appId, '')).body.sync.lastError, /could not read/);
  assert.equal(await t.count('ads_campaign_daily'), rows);
  await noKeyAnywhere(t);
});

dbTest('the views: totals against the period before, campaigns, and search terms sorted, filtered, paged and flagged when tracked', async (db) => {
  const t = await bootAds(db);
  const appId = await t.linked();
  assert.equal((await t.get(appId, '/overview')).status, 200);
  await t.runSync(appId);
  const o = (await t.get(appId, '/overview?from=2026-11-01&to=2026-11-10')).body.overview;
  assert.equal(o.currency, 'EUR');
  assert.deepEqual([o.totals.impressions, o.totals.taps, o.totals.installs, o.totals.spendMicros], [3000, 150, 42, 30_500_000]);
  assert.deepEqual([o.totals.cptMicros, o.totals.cpiMicros], [203_333, 726_190]);
  assert.ok(Math.abs(o.totals.ttr - 0.05) < 1e-9 && Math.abs(o.totals.conversion - 0.28) < 1e-9);
  assert.deepEqual(o.previousWindow, { from: '2026-10-22', to: '2026-10-31' });
  assert.deepEqual([o.previous.impressions, o.previous.cptMicros, o.previous.ttr], [0, null, null]);
  assert.deepEqual(o.daily.map((d: { day: string }) => d.day), ['2026-11-01', '2026-11-02']);
  assert.equal(o.daysWithData, 2);
  const c = (await t.get(appId, '/campaigns?from=2026-11-01&to=2026-11-10')).body;
  assert.deepEqual(c.campaigns.map((x: { campaignId: string; name: string }) => [x.campaignId, x.name]), [['444555666', 'AwayFinder US']]);
  const terms = (await t.get(appId, '/terms?from=2026-11-01&to=2026-11-10&sort=impressions&dir=desc&limit=1')).body;
  assert.equal(terms.total, 2);
  assert.deepEqual(terms.rows.map((r: { country: string; impressions: number; tracked: boolean }) => [r.country, r.impressions, r.tracked]), [['us', 400, false]]);
  assert.equal(terms.rows.length, 1);
  const page2 = (await t.get(appId, '/terms?from=2026-11-01&to=2026-11-10&limit=1&offset=1')).body;
  assert.deepEqual(page2.rows.map((r: { country: string }) => r.country), ['gb']);
  assert.equal((await t.get(appId, '/terms?from=2026-11-01&to=2026-11-10&q=EDIT&country=gb')).body.total, 1);
  assert.equal((await t.get(appId, '/terms?from=2026-11-01&to=2026-11-10&q=zzz')).body.total, 0);
  assert.equal((await t.get(appId, '/terms?from=2026-11-01&to=2026-11-10&q=%25')).body.total, 0, 'a % is text, not a wildcard');
  assert.equal((await t.get(appId, '/terms?sort=nope')).status, 400);
  assert.equal((await t.get(appId, '/terms?from=2026-11-10&to=2026-11-01')).status, 400);
  const kw = (await t.get(appId, '/terms?kind=keyword&from=2026-11-01&to=2026-11-10')).body;
  assert.deepEqual(kw.rows.map((r: { term: string; matchType: string }) => [r.term, r.matchType]), [['photo', 'BROAD']]);
  const add = await t.call(t.owner, 'POST', `/apps/${appId}/aso/keywords`, { keywords: [{ term: 'Photo editor', country: 'us' }] });
  assert.equal(add.status, 201, add.text);
  const flagged = (await t.get(appId, '/terms?from=2026-11-01&to=2026-11-10&sort=term&dir=asc')).body.rows;
  assert.deepEqual(flagged.map((r: { country: string; tracked: boolean }) => [r.country, r.tracked]), [['gb', false], ['us', true]]);
  const viewer = await t.addMember('viewer');
  assert.equal((await t.get(appId, '/terms', viewer)).status, 200);
});

dbTest('search term impressions are the "from your data (Apple Ads)" input of the estimate, and Apple’s own popularity sits beside it', async (db) => {
  const t = await bootAds(db);
  const appId = await t.linked();
  await t.call(t.owner, 'POST', `/apps/${appId}/aso/keywords`, { keywords: [{ term: 'Photo editor', country: 'us' }, { term: 'unseen term', country: 'us' }] });
  await t.runSync(appId);
  const est = (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keyword-estimates`)).body.estimates;
  const photo = est.find((e: { term: string }) => e.term === 'Photo editor').estimate;
  assert.equal(photo.popularity.origin, 'ads_data');
  assert.equal(photo.popularity.reasons[0].code, 'ads_impressions');
  assert.deepEqual(photo.popularity.reasons[0].params, { impressions: 400, taps: 25, installs: 6, days: 1 });
  const unseen = est.find((e: { term: string }) => e.term === 'unseen term').estimate;
  assert.equal(unseen.popularity.score, null, 'absence from the reports is not zero');
  const keywords = (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords`)).body.keywords;
  const id = keywords.find((k: { term: string }) => k.term === 'Photo editor').id;
  const detail = (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords/${id}/estimate`)).body;
  assert.deepEqual(detail.appleAds.campaigns, { impressions: 400, taps: 25, installs: 6, days: 1 });
  assert.deepEqual(detail.appleAds.popularity.map((p: { genre: string; popularity100: number }) => [p.genre, p.popularity100]), [['PHOTO_VIDEO', 84], ['PRODUCTIVITY_UTILITIES', 61]]);
  const pop = t.ads.api.find((c) => c.path.includes('search-term-popularity'));
  assert.ok(pop, 'the tracked terms were asked for');
  assert.deepEqual((pop?.body as { filters: unknown[] }).filters[0], { field: 'countryOrRegion', operator: 'EQUALS', value: 'US' });
  // A popularity failure is a warning, never a failed sync.
  t.ads.popularity = { result: {} };
  await t.runSync(appId);
  const state = (await t.get(appId, '')).body.sync;
  assert.equal(state.failureStreak, 0);
  assert.ok(state.warnings.includes('popularity_failed'));
});

dbTest('only campaigns that promote the linked app are read; another currency is never mixed in', async (db) => {
  const t = await bootAds(db);
  const appId = await t.linked();
  const mine = (t.ads.campaigns as { result: { rows: Array<{ granularMetrics: Array<{ localSpend: { currency: string } }> }> } }).result.rows[0];
  const usd = JSON.parse(JSON.stringify(t.ads.campaigns));
  usd.result.rows[0].granularMetrics[1].localSpend.currency = 'USD';
  t.ads.campaigns = usd;
  await t.runSync(appId);
  const rows = await db.query('SELECT day FROM ads_campaign_daily ORDER BY day');
  assert.deepEqual(rows.map((r) => r.day), ['2026-11-01'], 'the USD day is not stored in a EUR account');
  assert.ok((await t.get(appId, '')).body.sync.warnings.includes('currency_mismatch'));
  void mine;
  t.ads.campaigns = { result: { rows: [{ metadata: { id: 9, name: 'Other', promotedObjectType: 'APPSTORE_APP', promotedObjectId: '111' }, granularMetrics: [{ date: '2026-11-01', impressions: 5 }] }] } };
  await t.runSync(appId);
  assert.equal(await t.count('ads_term_daily'), 3, 'nothing of another app is stored, and nothing is deleted on a miss');
  assert.ok((await t.get(appId, '')).body.sync.warnings.includes('no_campaign'));
});

dbTest('the sync plan has an ads kind, last; an unlinked app skips it; deleting the app deletes its Apple Ads rows', async (db) => {
  const t = await bootAds(db);
  const appId = await t.linked();
  const plan = await t.call(t.owner, 'POST', `/apps/${appId}/sync-all?kinds=ads`);
  assert.equal(plan.status, 202, plan.text);
  assert.deepEqual(plan.body.plan.map((p: { kind: string; state: string }) => [p.kind, p.state]), [['ads', 'queued']]);
  const again = await t.call(t.owner, 'POST', `/apps/${appId}/sync-all?kinds=ads`);
  assert.equal(again.body.plan[0].reason, 'already_queued');
  const other = await t.addApp('ios');
  assert.equal((await t.call(t.owner, 'POST', `/apps/${other}/sync-all?kinds=ads`)).body.plan[0].reason, 'not_linked');
  await db.execute("UPDATE jobs SET status = 'done'");
  await t.runSync(appId);
  assert.ok((await t.count('ads_campaign_daily')) > 0);
  const gone = await t.call(t.owner, 'DELETE', `/apps/${appId}`);
  assert.ok(gone.status === 204 || gone.status === 200, gone.text);
  for (const table of ['app_ads_links', 'ads_sync', 'ads_campaign_daily', 'ads_term_daily']) assert.equal(await t.count(table), 0, table);
});
