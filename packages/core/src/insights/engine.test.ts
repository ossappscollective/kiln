import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyDismissals,
  buildInsights,
  categoryCounts,
  compareVersions,
  type DayValue,
  type InsightsInput,
  rateDiffers,
} from './engine.ts';

const TODAY = '2026-06-30';
const day = (back: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
/** 56 days ending today: the first `split` back-days (newest) get `recent`, the older ones `older`. */
const series = (recent: number, older: number, split = 14, n = 56): DayValue[] =>
  Array.from({ length: n }, (_, i) => ({ day: day(i), value: i < split ? recent : older }));
const base = (over: Partial<InsightsInput> = {}): InsightsInput => ({ store: 'app_store', today: TODAY, ...over });
const ids = (input: InsightsInput) => buildInsights(input).cards.map((c) => c.id);
const skipped = (input: InsightsInput) => buildInsights(input).skipped.map((s) => `${s.rule}:${s.reason}`);

test('no data at all: no cards, every data rule skipped with its reason', () => {
  const out = buildInsights(base());
  assert.deepEqual(out.cards, []);
  assert.ok(out.skipped.some((s) => s.rule === 'visibility' && s.reason === 'no_data'));
  assert.ok(out.skipped.some((s) => s.rule === 'complaints' && s.reason === 'no_reviews'));
  assert.ok(out.skipped.some((s) => s.rule === 'listing' && s.reason === 'no_listing'));
  assert.ok(out.skipped.some((s) => s.rule === 'localize' && s.reason === 'no_countries'));
});

test('visibility: a quarter more or less, with enough volume', () => {
  const up = buildInsights(base({ seen: series(200, 100) })).cards.find((c) => c.id === 'visibility');
  assert.equal(up?.code, 'visibility.up.seen');
  assert.equal(up?.params.percent, 100);
  assert.equal(up?.severity, 'good');
  const down = buildInsights(base({ store: 'google_play', seen: series(100, 200) })).cards.find((c) => c.id === 'visibility');
  assert.equal(down?.code, 'visibility.down.visits');
  assert.equal(down?.severity, 'warning');
  assert.ok(!ids(base({ seen: series(110, 100) })).includes('visibility'));
});

test('visibility: noise on small numbers and short data are not cards, and say why', () => {
  assert.ok(!ids(base({ seen: series(14, 10) })).includes('visibility'));
  assert.ok(skipped(base({ seen: series(14, 10) })).includes('visibility:too_little_data'));
  assert.ok(skipped(base({ seen: series(200, 100, 14, 20) })).includes('visibility:too_little_data'));
});

test('the fingerprint holds for a small drift and changes for a new finding', () => {
  const a = buildInsights(base({ seen: series(200, 100) })).cards[0];
  const b = buildInsights(base({ seen: series(202, 100) })).cards[0];
  const c = buildInsights(base({ seen: series(300, 100) })).cards[0];
  assert.equal(a?.fingerprint, b?.fingerprint);
  assert.notEqual(a?.fingerprint, c?.fingerprint);
});

test('conversion: needs a significant change of the download rate', () => {
  const seen = series(1000, 1000);
  const worse = buildInsights(base({ seen, acquired: series(20, 40) })).cards.find((c) => c.id === 'conversion');
  assert.equal(worse?.code, 'conversion.down');
  assert.equal(worse?.severity, 'problem');
  const better = buildInsights(base({ seen, acquired: series(40, 20) })).cards.find((c) => c.id === 'conversion');
  assert.equal(better?.code, 'conversion.up');
  // 5% more is below the threshold; a big relative change on tiny counts is not significant.
  assert.ok(!ids(base({ seen, acquired: series(42, 40) })).includes('conversion'));
  assert.equal(rateDiffers(3, 100, 2, 100), false);
  assert.equal(rateDiffers(300, 1000, 200, 1000), true);
  assert.equal(rateDiffers(0, 0, 1, 1), false);
});

test('downloads: 20% and at least 50 before', () => {
  assert.ok(ids(base({ downloads: series(10, 5) })).includes('downloads'));
  assert.ok(!ids(base({ downloads: series(1, 3) })).includes('downloads'), 'under 50 before');
  assert.ok(!ids(base({ downloads: series(11, 10) })).includes('downloads'));
});

test('featured: a browse spike in the last ten days only, App Store only', () => {
  const browse = series(100, 100);
  browse[3] = { day: day(3), value: 900 };
  const card = buildInsights(base({ browse })).cards.find((c) => c.id === 'featured');
  assert.equal(card?.fingerprint, day(3));
  assert.equal(card?.params.times, 9);
  const old = series(100, 100);
  old[20] = { day: day(20), value: 900 };
  assert.ok(!ids(base({ browse: old })).includes('featured'));
  assert.ok(skipped(base({ store: 'google_play', browse })).includes('featured:not_for_store'));
  assert.ok(skipped(base({ browse: series(100, 100, 14, 15) })).includes('featured:too_little_data'));
});

test('localize: a language of 15% of downloads with no store page', () => {
  const countries = [
    { country: 'US', count: 700 },
    { country: 'DE', count: 120 },
    { country: 'AT', count: 30 },
    { country: 'JP', count: 10 },
  ];
  const card = buildInsights(base({ countries, storeLocales: ['en-US'] })).cards.find((c) => c.id === 'localize:de');
  assert.equal(card?.params.percent, 17);
  assert.equal(card?.params.language, 'de');
  assert.equal(card?.params.countries, 'DE,AT');
  assert.equal(card?.actions[1]?.target.section, 'listing');
  // JP is 1%: below the share. A page with German is not a card.
  assert.ok(!ids(base({ countries, storeLocales: ['en-US', 'de-DE'] })).includes('localize:de'));
  assert.ok(!ids(base({ countries, storeLocales: ['en-US'] })).includes('localize:ja'));
  assert.ok(skipped(base({ countries })).includes('localize:no_listing'));
  assert.ok(skipped(base({ countries: [{ country: 'DE', count: 20 }], storeLocales: ['en'] })).includes('localize:too_little_data'));
});

const review = (rating: number, text: string, d = 1, version: string | null = null) => ({ rating, text, day: day(d), version });

test('complaints: a theme repeated in the last 30 days, in any of the four languages', () => {
  const reviews = [
    review(1, 'It crashes'),
    review(2, "L'application plante"),
    review(1, 'Absturz beim Start', 5),
    review(5, 'Great'),
    review(1, 'crashes', 45),
  ];
  const card = buildInsights(base({ reviews })).cards.find((c) => c.id === 'complaints:crash');
  assert.equal(card?.params.count, 3);
  assert.equal(card?.params.total, 3);
  assert.equal(card?.severity, 'warning');
  assert.ok(skipped(base({ reviews: [review(1, 'crash')] })).includes('complaints:too_little_data'));
  const many = Array.from({ length: 10 }, () => review(1, 'crash'));
  assert.equal(buildInsights(base({ reviews: many })).cards.find((c) => c.id === 'complaints:crash')?.severity, 'problem');
});

test('version rating: the newest version with enough reviews against the one before', () => {
  const many = (v: string, rating: number, n = 8) => Array.from({ length: n }, () => review(rating, 'x', 2, v));
  const drop = buildInsights(base({ reviews: [...many('2.0.0', 2), ...many('1.9.0', 5), ...many('1.10.0', 3, 2)] })).cards.find((c) => c.id === 'version_rating');
  assert.equal(drop?.params.version, '2.0.0');
  assert.equal(drop?.params.previous, '1.9.0');
  assert.equal(drop?.severity, 'problem');
  assert.ok(!ids(base({ reviews: [...many('2.0.0', 4), ...many('1.9.0', 4)] })).includes('version_rating'));
  assert.ok(skipped(base({ reviews: many('2.0.0', 2) })).includes('version_rating:too_little_data'));
  assert.ok(compareVersions('1.10.0', '1.9.2') > 0);
  assert.equal(compareVersions('2', '2.0.0'), 0);
});

test('keywords: big moves only, down and up apart', () => {
  const k = (term: string, from: number | null, to: number | null, kind: 'up' | 'down' | 'dropped' | 'entered' | 'same') => ({
    term,
    country: 'us',
    rank: to,
    change: { kind, from, to, ...(from !== null && to !== null ? { delta: from - to } : {}) },
  });
  const out = buildInsights(base({ keywords: [k('notes', 4, 18, 'down'), k('todo', 30, 12, 'up'), k('memo', 10, 11, 'down'), k('diary', 5, null, 'dropped')] }));
  const down = out.cards.find((c) => c.id === 'keywords:down');
  assert.equal(down?.params.count, 2);
  assert.equal(down?.params.term, 'diary');
  assert.equal(out.cards.find((c) => c.id === 'keywords:up')?.params.count, 1);
  assert.ok(skipped(base({ keywords: [] })).includes('keywords:no_keywords'));
});

test('listing: problems found by the checks become one card, tips do not', () => {
  const fields = { name: 'App', subtitle: 'Does things well enough', keywords: 'a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z,aa,bb,cc,dd,ee,ff,gg,hh,ii,jj,kk,ll,mm,nn', promotional_text: 'Hi', description: 'Text. '.repeat(40) };
  const card = buildInsights(base({ listing: { locales: [{ locale: 'en-US', fields: { ...fields, name: 'N'.repeat(40) } }] } })).cards.find((c) => c.id === 'listing');
  assert.equal(card?.severity, 'problem');
  assert.equal(card?.code, 'listing.issues');
  assert.equal(card?.params.problems, 1);
  assert.equal(card?.params.count, 1);
  assert.equal(card?.actions[0]?.target.locale, 'en-US');
  const none = buildInsights(base({ listing: { locales: [{ locale: 'en-US', fields }] } })).cards.find((c) => c.id === 'listing');
  assert.equal(none, undefined);
});

test('listing: advice alone is a warning card with its own words and never says problem', () => {
  const fields = { name: 'App', subtitle: 'Does things well enough', keywords: 'one, two, three', promotional_text: 'Hi', description: 'Text. '.repeat(40) };
  const card = buildInsights(base({ listing: { locales: [{ locale: 'en-US', fields }] } })).cards.find((c) => c.id === 'listing');
  assert.equal(card?.code, 'listing.review');
  assert.equal(card?.severity, 'warning');
  assert.equal(card?.params.problems, 0);
  assert.ok(Number(card?.params.warnings) >= 1);
});

test('cards are ordered problem first, then by weight; counts and dismissals', () => {
  const out = buildInsights(base({ seen: series(100, 200), acquired: series(10, 40), downloads: series(20, 10) }));
  assert.deepEqual(out.cards.map((c) => c.severity), ['problem', 'warning', 'good']);
  const counts = categoryCounts(out.cards);
  assert.equal(counts.conversion, 1);
  assert.equal(counts.visibility, 1);
  const first = out.cards[0];
  assert.ok(first);
  const hidden = applyDismissals(out.cards, new Map([[first.id, first.fingerprint]]));
  assert.equal(hidden.hidden.length, 1);
  assert.equal(hidden.visible.length, 2);
  // The finding changed: the dismissal no longer holds.
  const again = applyDismissals(out.cards, { [first.id]: 'another' });
  assert.equal(again.visible.length, 3);
});
