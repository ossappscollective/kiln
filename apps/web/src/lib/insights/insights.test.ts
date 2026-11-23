import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InsightCard } from '@kiln/core';
import { t } from '../i18n/t.ts';
import { useLocale } from '../i18n/test-setup.ts';
import {
  actionHref,
  activeCategory,
  categoryChips,
  countIsFresh,
  emptyKind,
  evidenceLine,
  explainOf,
  filterCards,
  headlineOf,
  insightsBadgeText,
  issueText,
  languageBars,
  localesByScore,
  navBadgeCount,
  scoreBand,
  skipNotes,
  sortCards,
  sortIssues,
  topBars,
  withCardBack,
  withoutCard,
} from './insights.ts';

useLocale('en');

const card = (id: string, category: InsightCard['category'], severity: InsightCard['severity'], extra: Partial<InsightCard> = {}): InsightCard => ({
  id,
  fingerprint: id,
  category,
  severity,
  code: 'conversion.down',
  params: { now: 12.3, before: 15 },
  evidence: [],
  actions: [],
  weight: 50,
  ...extra,
});

test('cards are ordered problems, warnings, information, good news, keeping the server order inside a severity', () => {
  const sorted = sortCards([card('a', 'visibility', 'good'), card('b', 'reviews', 'warning'), card('c', 'listing', 'problem'), card('d', 'keywords', 'warning'), card('e', 'markets', 'info')]);
  assert.deepEqual(sorted.map((c) => c.id), ['c', 'b', 'd', 'e', 'a']);
});

test('chips: All first, then only the categories that have cards, with their counts', () => {
  const cards = [card('a', 'reviews', 'warning'), card('b', 'visibility', 'good'), card('c', 'reviews', 'problem')];
  assert.deepEqual(categoryChips(cards), [
    { id: 'all', count: 3 },
    { id: 'visibility', count: 1 },
    { id: 'reviews', count: 2 },
  ]);
  assert.deepEqual(categoryChips([]), [{ id: 'all', count: 0 }]);
});

test('a selected category that no longer has a card falls back to All; filtering keeps the order', () => {
  const cards = [card('a', 'reviews', 'warning'), card('b', 'visibility', 'good'), card('c', 'reviews', 'problem')];
  assert.equal(activeCategory('reviews', categoryChips(cards)), 'reviews');
  assert.equal(activeCategory('listing', categoryChips(cards)), 'all');
  assert.deepEqual(filterCards(cards, 'reviews').map((c) => c.id), ['a', 'c']);
  assert.equal(filterCards(cards, 'all').length, 3);
});

test('dismissing removes a card and undo puts it back where the server had it, once', () => {
  const original = [card('a', 'reviews', 'problem'), card('b', 'reviews', 'warning'), card('c', 'visibility', 'good')];
  const hidden = original[1] as InsightCard;
  const after = withoutCard(original, 'b');
  assert.deepEqual(after.map((c) => c.id), ['a', 'c']);
  assert.deepEqual(withCardBack(after, hidden, original).map((c) => c.id), ['a', 'b', 'c']);
  assert.deepEqual(withCardBack(original, hidden, original).map((c) => c.id), ['a', 'b', 'c']);
});

test('the badge of the navigation adds the records that were read and draws nothing for zero or unknown', () => {
  assert.equal(navBadgeCount(['a', 'b'], { a: 2, b: 3 }), 5);
  assert.equal(navBadgeCount(['a', 'b'], { a: 2 }), 2, 'a record not read counts nothing');
  assert.equal(navBadgeCount(['a'], {}), null);
  assert.equal(navBadgeCount(['a'], { a: -4 }), 0);
  assert.equal(navBadgeCount([], { a: 1 }), null);
  assert.equal(insightsBadgeText(0), null);
  assert.equal(insightsBadgeText(null), null);
  assert.equal(insightsBadgeText(7), '7');
  assert.equal(insightsBadgeText(240), '99+');
});

test('a count is read again only when it is older than five minutes (no polling)', () => {
  assert.equal(countIsFresh(undefined, 1_000), false);
  assert.equal(countIsFresh(1_000, 1_000 + 4 * 60_000), true);
  assert.equal(countIsFresh(1_000, 1_000 + 5 * 60_000), false);
  assert.equal(countIsFresh(5_000, 1_000), false, 'a clock that went back reads again');
});

test('actions open Kiln pages only: the target is data, never an address', () => {
  assert.equal(actionHref('a1', { code: 'openOverview', target: { section: 'insights', view: 'overview' } }), '#/portfolio/a1/insights');
  assert.equal(actionHref('a1', { code: 'openCountries', target: { section: 'insights', view: 'countries' } }, 'ios'), '#/portfolio/a1/insights?platform=ios&view=countries');
  assert.equal(actionHref('a1', { code: 'openChecks', target: { section: 'listing', view: 'text', locale: 'de-DE' } }), '#/portfolio/a1/listing?view=text&locale=de-DE&panel=de-DE');
  assert.equal(actionHref('a1', { code: 'addLocale', target: { section: 'listing', view: 'text', locale: 'de' } }), '#/portfolio/a1/listing?view=text', 'a language the page lacks is no locale to open');
  assert.equal(actionHref('a1', { code: 'openRank', target: { section: 'insights', view: 'keywords', term: 'timer' } }), '#/portfolio/a1/insights?view=rank');
  assert.equal(actionHref('a1', { code: 'openReviews', target: { section: 'reviews', view: 'reviews' } }), '#/portfolio/a1/reviews?view=reviews');
});

test('the sentence of a card is in the active language with its numbers formatted', () => {
  const c = card('conversion', 'conversion', 'warning');
  assert.equal(headlineOf(c), 'Fewer people who see the page get the app');
  assert.match(explainOf(c), /12\.3% of the people .* down from 15%/);
  const loc = card('localize:de', 'markets', 'warning', { code: 'localize', params: { percent: 31, language: 'de', countries: 'DE,AT' } });
  assert.match(headlineOf(loc), /^31% of downloads come from countries that mainly speak German/);
  assert.match(explainOf(loc), /Germany and Austria/);
  const comp = card('complaints:crash', 'reviews', 'problem', { code: 'complaints.crash', params: { count: 7, total: 20, days: 30 } });
  assert.equal(headlineOf(comp), 'Complaints in reviews: crashes');
  assert.match(explainOf(comp), /7 of the 20 complaints in the last 30 days/);
  const unknown = card('x', 'listing', 'info', { code: 'from.the.future' });
  assert.equal(headlineOf(unknown), 'Something changed');
});

test('a card is written in the other languages too', () => {
  useLocale('fr');
  const c = card('conversion', 'conversion', 'warning');
  assert.notEqual(headlineOf(c), 'Fewer people who see the page get the app');
  assert.match(explainOf(c), /12,3\s%/);
  useLocale('en');
});

test('evidence is formatted by its kind; a keyword evidence key is shown as written', () => {
  assert.deepEqual(evidenceLine({ key: 'share', value: 0.314, format: 'percent' }), { label: 'Share of downloads', value: '31.4%' });
  assert.deepEqual(evidenceLine({ key: 'ratingNow', value: 3.4, format: 'rating' }), { label: 'Rating now', value: '3.4' });
  assert.deepEqual(evidenceLine({ key: 'timer (US)', value: 12, format: 'rank' }), { label: 'timer (US)', value: '#12' });
  assert.equal(evidenceLine({ key: 'timer (US)', value: 0, format: 'rank' }).value, 'Not ranked');
  assert.equal(evidenceLine({ key: 'downloads', value: 12345, format: 'count' }).value, '12,345');
  assert.equal(evidenceLine({ key: 'day', value: '2026-11-02', format: 'day' }).value, 'Nov 2, 2026');
});

test('empty states say why: quiet, hidden, or rules that could not run', () => {
  assert.equal(emptyKind({ cards: [card('a', 'reviews', 'info')], skipped: [], hiddenCount: 0 }), 'none');
  assert.equal(emptyKind({ cards: [], skipped: [], hiddenCount: 0 }), 'quiet');
  assert.equal(emptyKind({ cards: [], skipped: [{ rule: 'visibility', reason: 'no_data' }], hiddenCount: 0 }), 'nodata');
  assert.equal(emptyKind({ cards: [], skipped: [{ rule: 'visibility', reason: 'no_data' }], hiddenCount: 2 }), 'hidden');
});

test('skip notes name the rule and the reason, once per rule, in the order of the rules', () => {
  const notes = skipNotes([
    { rule: 'keywords', reason: 'no_keywords' },
    { rule: 'localize', reason: 'no_countries' },
    { rule: 'keywords', reason: 'no_access' },
    { rule: 'visibility', reason: 'too_little_data' },
    { rule: 'brand_new', reason: 'from_the_future' },
  ]);
  assert.deepEqual(notes.map((n) => n.rule), ['visibility', 'localize', 'keywords', 'brand_new']);
  assert.equal(notes[1]?.text, 'Languages of your countries: the store sends no downloads by country (Google Play does not), or none are stored yet.');
  assert.equal(notes[3]?.text, 'Another check: it could not run.');
});

test('store page findings: text with numbers and field names, problems first, weakest language first', () => {
  const tooLong = issueText({ code: 'too_long', field: 'subtitle', params: { used: 34, limit: 30, over: 4, unit: 'characters' } });
  assert.equal(tooLong.title, 'Subtitle is 4 characters too long');
  assert.match(tooLong.explain, /34 of 30 allowed characters/);
  const untranslated = issueText({ code: 'untranslated', field: null, params: { fields: 'name, description', count: 2, base: 'en-US' } });
  assert.equal(untranslated.title, 'Text is the same as in en-US');
  assert.match(untranslated.explain, /^Name and Description matches en-US/);
  assert.equal(issueText({ code: 'from_the_future', field: null, params: {} }).title, 'A check found something');
  const issue = (id: string, severity: 'problem' | 'warning' | 'tip') => ({ id, code: 'empty' as const, field: null, severity, params: {}, fix: null });
  assert.deepEqual(sortIssues([issue('a', 'tip'), issue('b', 'problem'), issue('c', 'warning'), issue('d', 'problem')]).map((i) => i.id), ['b', 'd', 'c', 'a']);
  assert.deepEqual(localesByScore([{ locale: 'fr-FR', score: 90, issues: [] }, { locale: 'de-DE', score: 60, issues: [] }, { locale: 'da-DK', score: 60, issues: [] }]).map((l) => l.locale), ['da-DK', 'de-DE', 'fr-FR']);
  assert.deepEqual([100, 85, 84, 60, 59, 0].map(scoreBand), ['good', 'good', 'fair', 'fair', 'poor', 'poor']);
});

test('language bars are relative to the biggest language and the long tail is counted, not drawn', () => {
  const lang = (language: string, count: number, coveredBy: string | null) => ({ language, count, share: count / 100, coveredBy, countries: [] });
  const bars = languageBars([lang('en', 60, 'en-US'), lang('de', 30, null), lang('is', 1, null)]);
  assert.deepEqual(bars.map((b) => b.width), [100, 50, 2]);
  assert.equal(bars[1]?.coveredBy, null);
  assert.deepEqual(languageBars([]), []);
  const many = languageBars(Array.from({ length: 15 }, (_, i) => lang(`l${i}`, 100 - i, null)));
  const top = topBars(many, 12);
  assert.equal(top.shown.length, 12);
  assert.equal(top.hidden, 3);
  assert.ok(t('insights:countries.notOnPage').length > 0);
});
