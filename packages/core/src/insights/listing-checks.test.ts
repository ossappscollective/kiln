import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkListing, type CheckLocaleText, scoreOf } from './listing-checks.ts';

const good = (locale: string, over: Record<string, string> = {}): CheckLocaleText => ({
  locale,
  fields: {
    name: 'Pocket Notes Pro',
    subtitle: 'Write, plan and remember',
    keywords: 'journal,diary,todo,checklist,memo,ideas,writing,planner,tasks',
    promotional_text: 'New this week.',
    description: 'A long description of the app. '.repeat(30),
    ...over,
  },
});
const codes = (out: ReturnType<typeof checkListing>, locale = 'en-US') =>
  (out.locales.find((l) => l.locale === locale)?.issues ?? []).map((i) => `${i.code}:${i.field}`);

test('a healthy App Store page has no problem and a high score', () => {
  const out = checkListing({ store: 'app_store', locales: [good('en-US')] });
  assert.deepEqual(codes(out).filter((c) => !c.startsWith('keywords_underused')), []);
  assert.ok(out.score >= 90);
});

test('a field over the limit of the spec is a problem, in characters and in bytes', () => {
  const out = checkListing({
    store: 'app_store',
    locales: [good('en-US', { name: 'N'.repeat(31), keywords: 'a,'.repeat(51) })],
  });
  const issues = out.locales[0]?.issues ?? [];
  const name = issues.find((i) => i.code === 'too_long' && i.field === 'name');
  assert.equal(name?.severity, 'problem');
  assert.equal(name?.params.limit, 30);
  assert.equal(name?.params.over, 1);
  assert.equal(issues.find((i) => i.code === 'too_long' && i.field === 'keywords')?.params.unit, 'bytes');
});

test('spaces after commas, duplicates and words of the name in the keywords are found, with one safe fix', () => {
  const out = checkListing({
    store: 'app_store',
    locales: [good('en-US', { keywords: 'journal, diary, Journal,notes,pocket,todo' })],
  });
  const issues = out.locales[0]?.issues ?? [];
  const spaces = issues.find((i) => i.code === 'keywords_spaces');
  assert.equal(spaces?.params.saved, 2);
  assert.equal(spaces?.fix?.field, 'keywords');
  assert.equal(spaces?.fix?.value, 'journal,diary,todo');
  assert.ok(issues.some((i) => i.code === 'keywords_duplicate'));
  const inTitle = issues.find((i) => i.code === 'keywords_in_title');
  assert.match(String(inTitle?.params.words), /notes/);
});

test('a subtitle that repeats the name, a missing subtitle, a missing promotional text', () => {
  const out = checkListing({
    store: 'app_store',
    locales: [
      good('en-US', { subtitle: 'Pocket Notes', promotional_text: '' }),
      good('fr-FR', { subtitle: '' }),
    ],
  });
  assert.ok(codes(out).includes('subtitle_repeats_name:subtitle'));
  assert.ok(codes(out).includes('promo_missing:promotional_text'));
  assert.ok(codes(out, 'fr-FR').includes('subtitle_missing:subtitle'));
});

test('text copied into another language is untranslated; the same language is not compared', () => {
  const out = checkListing({
    store: 'app_store',
    locales: [good('en-US'), good('de-DE'), good('en-GB', { name: 'Pocket Notes Pro' })],
  });
  const de = out.locales.find((l) => l.locale === 'de-DE')?.issues.find((i) => i.code === 'untranslated');
  assert.equal(de?.params.count, 3);
  assert.equal(de?.params.base, 'en-US');
  assert.ok(!codes(out, 'en-GB').includes('untranslated:null'));
});

test('screenshots are only flagged when the data says so and another locale has some', () => {
  const a = { ...good('en-US'), hasScreenshots: true };
  const b = { ...good('de-DE', { name: 'Taschennotizen Pro' }), hasScreenshots: false };
  const c = { ...good('fr-FR', { name: 'Notes de poche' }), hasScreenshots: null };
  const out = checkListing({ store: 'app_store', locales: [a, b, c] });
  assert.ok(codes(out, 'de-DE').includes('no_screenshots:null'));
  assert.ok(!codes(out, 'fr-FR').includes('no_screenshots:null'));
  const none = checkListing({ store: 'app_store', locales: [{ ...b }] });
  assert.ok(!codes(none, 'de-DE').includes('no_screenshots:null'));
});

test('Google Play: title, short and full description, no keyword field', () => {
  const play: CheckLocaleText = {
    locale: 'en-US',
    fields: { title: 'T'.repeat(31), short_description: '', full_description: 'Full text. '.repeat(20) },
  };
  const out = checkListing({ store: 'google_play', locales: [play] });
  const c = codes(out);
  assert.ok(c.includes('too_long:title'));
  assert.ok(c.includes('empty:short_description'));
  assert.ok(!c.some((x) => x.includes('keywords')));
  assert.equal(out.locales[0]?.score, 60);
});

test('score floors at 0 and an empty list scores 100', () => {
  assert.equal(scoreOf(Array.from({ length: 9 }, () => ({ severity: 'problem' }) as never)), 0);
  assert.deepEqual(checkListing({ store: 'app_store', locales: [] }), { locales: [], score: 100, issueCount: 0 });
});
