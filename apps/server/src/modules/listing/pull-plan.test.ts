import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldKey, hashListingValue } from './drift.ts';
import { canonicalLocale, equivalentLocales, matchRepoLocale, newRepoLocale } from './locales.ts';
import { type PullHistory, type PullPlanInput, planPull } from './pull.ts';

// The pure parts of the store pull: locale codes and the plan. No database, no network.

// ---------------------------------------------------------------------------------------------
// Locale mapping

test('locale codes: separator and case are not differences', () => {
  assert.equal(canonicalLocale('en_US'), 'en-us');
  assert.equal(canonicalLocale(' zh-Hans '), 'zh-hans');
  assert.deepEqual(matchRepoLocale('en-US', ['de-DE', 'en-US']), {
    kind: 'match',
    repoLocale: 'en-US',
    how: 'exact',
  });
  assert.deepEqual(matchRepoLocale('en_US', ['en-US']), {
    kind: 'match',
    repoLocale: 'en-US',
    how: 'normalized',
  });
  assert.deepEqual(matchRepoLocale('en-us', ['en-US']), {
    kind: 'match',
    repoLocale: 'en-US',
    how: 'normalized',
  });
  assert.deepEqual(
    matchRepoLocale('en-US', ['en-GB']),
    { kind: 'none' },
    'a variant of the language is another locale',
  );
  assert.deepEqual(matchRepoLocale('en-US', ['en']), { kind: 'none' }, 'en is not en-US');
});

test('locale codes: the same language written the way the other store writes it', () => {
  // App Store codes against Play style folders, and back.
  assert.deepEqual(matchRepoLocale('zh-Hans', ['zh-CN']), {
    kind: 'match',
    repoLocale: 'zh-CN',
    how: 'equivalent',
  });
  assert.deepEqual(matchRepoLocale('zh-CN', ['zh-Hans']), {
    kind: 'match',
    repoLocale: 'zh-Hans',
    how: 'equivalent',
  });
  assert.deepEqual(matchRepoLocale('zh-Hant', ['zh-TW']), {
    kind: 'match',
    repoLocale: 'zh-TW',
    how: 'equivalent',
  });
  assert.deepEqual(matchRepoLocale('ja', ['ja-JP']), {
    kind: 'match',
    repoLocale: 'ja-JP',
    how: 'equivalent',
  });
  assert.deepEqual(matchRepoLocale('ja-JP', ['ja']), {
    kind: 'match',
    repoLocale: 'ja',
    how: 'equivalent',
  });
  assert.deepEqual(matchRepoLocale('he', ['iw-IL']), {
    kind: 'match',
    repoLocale: 'iw-IL',
    how: 'equivalent',
  });
  assert.deepEqual(matchRepoLocale('no', ['no-NO']), {
    kind: 'match',
    repoLocale: 'no-NO',
    how: 'equivalent',
  });
  assert.deepEqual(matchRepoLocale('es-MX', ['es-419']), {
    kind: 'match',
    repoLocale: 'es-419',
    how: 'equivalent',
  });
  // An exact code always wins over an equivalent one.
  assert.deepEqual(matchRepoLocale('ja', ['ja-JP', 'ja']), {
    kind: 'match',
    repoLocale: 'ja',
    how: 'exact',
  });
  // Two equivalent folders and no exact one: not guessed.
  assert.deepEqual(matchRepoLocale('no', ['nb', 'no-NO']), {
    kind: 'ambiguous',
    candidates: ['nb', 'no-NO'],
  });
  assert.deepEqual(matchRepoLocale('en-US', ['en_US', 'en-us']), {
    kind: 'ambiguous',
    candidates: ['en-us', 'en_US'],
  });
  assert.deepEqual(equivalentLocales('ja'), ['ja', 'ja-jp']);
  assert.deepEqual(equivalentLocales('fr-FR'), ['fr-fr']);
});

test('locale codes: a folder is only created with a name the reader sees, and Expo only with a known one', () => {
  assert.deepEqual(newRepoLocale('ios', 'fr-FR', 'fastlane'), { ok: true, repoLocale: 'fr-FR' });
  assert.deepEqual(newRepoLocale('ios', 'fr_FR', 'fastlane'), { ok: true, repoLocale: 'fr-FR' });
  assert.deepEqual(newRepoLocale('android', 'es-419', 'fastlane'), {
    ok: true,
    repoLocale: 'es-419',
  });
  assert.deepEqual(newRepoLocale('android', 'FR', 'fastlane'), { ok: false, reason: 'invalid' });
  assert.deepEqual(newRepoLocale('android', '../x', 'fastlane'), { ok: false, reason: 'invalid' });
  assert.deepEqual(newRepoLocale('ios', 'de-DE', 'expo-store-config'), {
    ok: true,
    repoLocale: 'de-DE',
  });
  assert.deepEqual(newRepoLocale('ios', 'de-de', 'expo-store-config'), {
    ok: true,
    repoLocale: 'de-DE',
  });
  assert.deepEqual(newRepoLocale('ios', 'sw', 'expo-store-config'), {
    ok: false,
    reason: 'unsupported',
  });
});

// ---------------------------------------------------------------------------------------------
// The plan

const h = hashListingValue;
const noHistory: PullHistory = { repo: new Map(), store: new Map() };
const history = (entries: { key: string; repo?: string[]; store?: string[] }[]): PullHistory => ({
  repo: new Map(entries.filter((e) => e.repo).map((e) => [e.key, (e.repo as string[]).map(h)])),
  store: new Map(
    entries.filter((e) => e.store).map((e) => [e.key, new Set((e.store as string[]).map(h))]),
  ),
});
const plan = (over: Partial<PullPlanInput> & Pick<PullPlanInput, 'store'>) =>
  planPull({
    platform: 'ios',
    source: 'fastlane',
    repo: { locales: { 'en-US': { name: 'Acme', subtitle: 'Old' } } },
    history: noHistory,
    selection: { addLocales: false },
    ...over,
  });

test('plan: store-ahead and diverged are pulled, repo-ahead and identical are not', () => {
  const p = plan({
    store: {
      'en-US': { name: 'Acme', subtitle: 'New', description: 'The store description text.' },
    },
    repo: {
      locales: {
        'en-US': { name: 'Acme', subtitle: 'Old', description: 'Another description text.' },
      },
    },
    history: history([
      { key: fieldKey('en-US', 'subtitle'), repo: ['Old'], store: ['Old', 'New'] },
      // The repository moved on from what the store shows: repo-ahead.
      {
        key: fieldKey('en-US', 'description'),
        repo: ['Another description text.', 'The store description text.'],
        store: ['The store description text.'],
      },
    ]),
  });
  assert.deepEqual(
    p.changes.map((c) => [c.field, c.status, c.before, c.after]),
    [['subtitle', 'store-ahead', 'Old', 'New']],
  );
  assert.deepEqual(
    p.skipped.map((s) => [s.field, s.reason]),
    [['description', 'repo_ahead']],
  );
  // The listing to write is the repository's, with the one value changed.
  assert.deepEqual(p.desired.appStore?.locales, {
    'en-US': { name: 'Acme', subtitle: 'New', description: 'Another description text.' },
  });
  // Without any shared history the two sides diverged, and the store value is pulled.
  const diverged = plan({ store: { 'en-US': { subtitle: 'Other' } } });
  assert.deepEqual(
    diverged.changes.map((c) => [c.field, c.status]),
    [['subtitle', 'diverged']],
  );
});

test('plan: a value the store does not have, or has blank, never replaces the repository value', () => {
  const p = plan({ store: { 'en-US': { name: 'New name', subtitle: '   ', keywords: '' } } });
  assert.deepEqual(
    p.changes.map((c) => c.field),
    ['name'],
  );
  assert.equal(p.desired.appStore?.locales['en-US']?.subtitle, 'Old', 'kept');
  // Named on purpose, it is reported instead of silently kept.
  const named = plan({
    store: { 'en-US': { name: 'New name' } },
    selection: { addLocales: false, fields: ['subtitle'] },
  });
  assert.deepEqual(named.changes, []);
  assert.deepEqual(
    named.skipped.map((s) => [s.field, s.reason]),
    [['subtitle', 'missing_in_store']],
  );
});

test('plan: a field the repository has no value for is pulled only when it is named', () => {
  const store = { 'en-US': { name: 'Acme', promotional_text: 'Fresh news' } };
  assert.deepEqual(plan({ store }).changes, []);
  const named = plan({ store, selection: { addLocales: false, fields: ['promotional_text'] } });
  assert.deepEqual(
    named.changes.map((c) => [c.field, c.status, c.before]),
    [['promotional_text', 'missing-in-repo', null]],
  );
  const pair = plan({
    store,
    selection: { addLocales: false, items: [{ locale: 'en-US', field: 'promotional_text' }] },
  });
  assert.equal(pair.changes.length, 1);
  // A named item that is identical is reported as such.
  const same = plan({
    store,
    selection: { addLocales: false, items: [{ locale: 'en-US', field: 'name' }] },
  });
  assert.deepEqual(
    same.skipped.map((s) => s.reason),
    ['identical'],
  );
});

test('plan: a value over the limit is reported and not pulled, never shortened', () => {
  const long = 'x'.repeat(31);
  const p = plan({ store: { 'en-US': { name: long, subtitle: 'Fine' } } });
  assert.deepEqual(
    p.changes.map((c) => c.field),
    ['subtitle'],
  );
  assert.deepEqual(
    p.skipped.map((s) => [s.field, s.reason]),
    [['name', 'over_limit']],
  );
  assert.match(p.skipped[0]?.message ?? '', /not shortened/);
  const problem = p.problems.find((x) => x.field === 'name');
  assert.deepEqual(
    [problem?.code, problem?.limit, problem?.actual, problem?.locale],
    ['too_long', 30, 31, 'en-US'],
  );
  assert.equal(p.desired.appStore?.locales['en-US']?.name, 'Acme');
  // Apple's keyword limit is in bytes.
  const keywords = plan({
    store: { 'en-US': { keywords: 'é'.repeat(51) } },
    selection: { addLocales: false, fields: ['keywords'] },
  });
  assert.deepEqual(
    keywords.skipped.map((s) => [s.field, s.reason]),
    [['keywords', 'over_limit']],
  );
  // A limit that no official page confirms is only a warning: the value is pulled and flagged.
  const url = `https://example.com/${'a'.repeat(260)}`;
  const flagged = plan({
    store: { 'en-US': { marketing_url: url } },
    selection: { addLocales: false, fields: ['marketing_url'] },
  });
  assert.equal(flagged.changes.length, 1);
  assert.equal(flagged.problems[0]?.severity, 'warning');
});

test('plan: locales that are not in the repository are skipped, or created on request', () => {
  const store = {
    'en-US': { subtitle: 'New' },
    'fr-FR': { name: 'Acme FR' },
    ja: { name: 'Acme JP' },
  };
  const repo = { locales: { 'en-US': { subtitle: 'Old' }, 'ja-JP': { name: 'Old JP' } } };
  const skip = planPull({
    platform: 'ios',
    source: 'fastlane',
    store,
    repo,
    history: noHistory,
    selection: { addLocales: false },
  });
  assert.deepEqual(
    skip.changes.map((c) => [c.locale, c.repoLocale, c.field]),
    [
      ['en-US', 'en-US', 'subtitle'],
      ['ja', 'ja-JP', 'name'],
    ],
  );
  assert.deepEqual(
    skip.skipped.map((s) => [s.locale, s.reason]),
    [['fr-FR', 'locale_not_in_repo']],
  );
  assert.deepEqual(
    skip.locales.map((l) => [l.locale, l.repoLocale, l.how]),
    [
      ['en-US', 'en-US', 'exact'],
      ['ja', 'ja-JP', 'equivalent'],
    ],
  );

  const add = planPull({
    platform: 'ios',
    source: 'fastlane',
    store,
    repo,
    history: noHistory,
    selection: { addLocales: true },
  });
  const created = add.changes.find((c) => c.locale === 'fr-FR');
  assert.deepEqual(
    [created?.status, created?.newLocale, created?.repoLocale, created?.before],
    ['new-locale', true, 'fr-FR', null],
  );
  assert.deepEqual(add.desired.appStore?.locales['fr-FR'], { name: 'Acme FR' });
  assert.deepEqual(add.skipped, []);
});

test('plan: the default folder fills what a locale does not set, and two store locales never share one folder', () => {
  const repo = { locales: { default: { subtitle: 'Shared' }, 'en-US': { name: 'Acme' } } };
  // The store has the shared text: the locale needs no file of its own.
  const same = planPull({
    platform: 'ios',
    source: 'fastlane',
    store: { 'en-US': { subtitle: 'Shared' } },
    repo,
    history: noHistory,
    selection: { addLocales: false, fields: ['subtitle'] },
  });
  assert.deepEqual(
    same.skipped.map((s) => s.reason),
    ['identical'],
  );
  const other = planPull({
    platform: 'ios',
    source: 'fastlane',
    store: { 'en-US': { subtitle: 'Different' } },
    repo,
    history: noHistory,
    selection: { addLocales: false },
  });
  assert.deepEqual(
    other.changes.map((c) => [c.field, c.before]),
    [['subtitle', 'Shared']],
  );
  // zh-Hans and zh-CN are one folder: the exact code keeps it.
  const clash = planPull({
    platform: 'ios',
    source: 'fastlane',
    store: { 'zh-CN': { name: 'A' }, 'zh-Hans': { name: 'B' } },
    repo: { locales: { 'zh-Hans': { name: 'C' } } },
    history: noHistory,
    selection: { addLocales: false },
  });
  assert.deepEqual(
    clash.changes.map((c) => [c.locale, c.after]),
    [['zh-Hans', 'B']],
  );
  assert.deepEqual(
    clash.skipped.map((s) => [s.locale, s.reason]),
    [['zh-CN', 'locale_conflict']],
  );
});

test('plan: Expo cannot hold a locale its schema does not know; Google Play keeps its release notes', () => {
  const expo = planPull({
    platform: 'ios',
    source: 'expo-store-config',
    store: { sw: { name: 'Acme SW' }, 'de-DE': { name: 'Acme DE' } },
    repo: { locales: { 'en-US': { name: 'Acme' } } },
    history: noHistory,
    selection: { addLocales: true },
  });
  assert.deepEqual(
    expo.changes.map((c) => c.locale),
    ['de-DE'],
  );
  assert.deepEqual(
    expo.skipped.map((s) => [s.locale, s.reason]),
    [['sw', 'locale_unsupported']],
  );
  const play = planPull({
    platform: 'android',
    source: 'fastlane',
    store: { 'en-US': { title: 'New' } },
    repo: { locales: { 'en-US': { title: 'Old' } }, changelogs: { 'en-US': { '100': 'Notes' } } },
    history: noHistory,
    selection: { addLocales: false },
  });
  assert.deepEqual(play.desired.googlePlay, {
    locales: { 'en-US': { title: 'New' } },
    changelogs: { 'en-US': { '100': 'Notes' } },
  });
});
