import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SERVER_LOCALES } from '../../i18n/runtime.ts';
import { alertCatalog, type AlertData } from './catalog.ts';
import { alertText, camelKey, hasAlertText } from './text.ts';

const catalog = (ns: string, lang: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../locales/${ns}/${lang}.json`, import.meta.url), 'utf8'),
  ) as Record<string, string>;

const full: AlertData = {
  appId: 'app1',
  appName: 'Lyynk',
  version: '2.1',
  from: 'in_review',
  to: 'rolling_out',
  track: 'production',
  build: '7',
  step: 'review',
  daysOverdue: 3,
  targetDate: '2026-03-04',
  openRequiredItems: 2,
  blocked: true,
  index: 2,
  total: 4,
  percent: 10,
  minutesLate: 5,
  rating: 2,
  store: 'Google Play',
  grouped: true,
  baseline: true,
  count: 12,
  failures: 3,
  code: 'smtp_timeout',
  waitingHours: 24,
  appsTotal: 2,
  territory: 'US',
  windowDays: 7,
  kind: 'google_play',
  label: 'Prod',
  credentialId: 'c1',
  fields: 2,
  runId: 'r1',
  conclusion: 'failure',
  changeSetId: 'cs1',
  reason: 'conflict',
  oldest: '2026-02-01',
  days: 7,
  keywordId: 'kw1',
  country: 'US',
  competitorId: 'x1',
  suggestionId: 's1',
  task: 'translate',
  userId: 'u1',
  action: 'credential.delete',
  failedCount: 3,
  remaining: 2,
  name: 'CI token',
  tokenId: 't1',
  role: 'admin',
  createdBy: 'u2',
  channel: 'email',
};
const variants: AlertData[] = [
  full,
  {},
  { appId: 'a' },
  {
    ...full,
    grouped: false,
    baseline: false,
    blocked: false,
    to: 'live',
    conclusion: 'timed_out',
    channel: 'webhook',
    rating: 5,
  },
  { ...full, store: null, platform: 'ios' },
  { ...full, store: null, platform: null },
  {
    ...full,
    conclusion: 'weird',
    channel: 'x',
    role: 'zzz',
    from: 'odd',
    kind: 'odd_kind',
    appName: null,
  },
  {
    ...full,
    failures: 1,
    count: 1,
    remaining: 1,
    failedCount: 1,
    openRequiredItems: 1,
    minutesLate: 1,
    fields: 1,
    rating: 1,
  },
  {
    ...full,
    track: null,
    step: null,
    label: null,
    country: null,
    territory: null,
    store: null,
    version: null,
    channel: 'in_app',
  },
  { ...full, channel: 'desktop', appId: null, remaining: null, rating: null, daysOverdue: null },
];

test('every alert type has sentences in every language, for every shape of data', () => {
  for (const def of alertCatalog) {
    assert.ok(hasAlertText(def.id), `${def.id} has an entry`);
    for (const lang of SERVER_LOCALES) {
      for (const data of variants) {
        const text = alertText(def.id, data, lang);
        assert.ok(text, `${def.id} ${lang}`);
        for (const part of [text.title, text.body]) {
          assert.ok(part.length > 0, `${def.id} ${lang} is empty`);
          assert.doesNotMatch(
            part,
            /\{\{|\}\}/,
            `${def.id} ${lang}: a placeholder is left: ${part}`,
          );
          assert.doesNotMatch(
            part,
            /\balerts:|\bundefined\b|\bnull\b|\[object/,
            `${def.id} ${lang}: ${part}`,
          );
        }
      }
    }
  }
});

test('the English text is what the catalog definition says (the stored alert reads the same catalog)', () => {
  for (const def of alertCatalog)
    for (const data of variants) {
      const en = alertText(def.id, data, 'en');
      assert.equal(def.title(data), en?.title);
      assert.equal(def.body(data), en?.body);
    }
});

test('names and ids pass through untouched; numbers, dates and durations follow the language', () => {
  const d = {
    appId: 'a1',
    appName: 'Lyynk',
    version: '2.1',
    targetDate: '2026-03-04',
    daysOverdue: 3,
    openRequiredItems: 1,
  };
  const en = alertText('plan.deadline_overdue', d, 'en');
  const fr = alertText('plan.deadline_overdue', d, 'fr');
  const de = alertText('plan.deadline_overdue', d, 'de');
  assert.equal(en?.title, 'Lyynk 2.1 is 3 days past its target date');
  assert.match(en?.body ?? '', /March 4, 2026/);
  assert.match(en?.body ?? '', /1 required checklist item is still open/);
  assert.match(fr?.title ?? '', /^Lyynk 2\.1 dépasse sa date cible de 3\sjours$/);
  assert.match(fr?.body ?? '', /4 mars 2026/);
  assert.match(de?.body ?? '', /4\. März 2026/);
  const rating = alertText(
    'rating.dropped',
    { appName: 'Lyynk', from: 4.25, to: 3.9, windowDays: 7, store: 'App Store', territory: 'FR' },
    'fr',
  );
  assert.match(rating?.title ?? '', /3,9/);
  assert.match(rating?.body ?? '', /4,25/);
});

test('plurals follow the language', () => {
  const one = alertText('review.unanswered', { count: 1, waitingHours: 24 }, 'en');
  const many = alertText('review.unanswered', { count: 12, waitingHours: 24 }, 'en');
  assert.equal(one?.title, '1 review is waiting for an answer');
  assert.equal(many?.title, '12 reviews are waiting for an answer');
  assert.equal(
    alertText('review.unanswered', { count: 1, waitingHours: 24 }, 'fr')?.title,
    '1 avis attend une réponse',
  );
  assert.equal(
    alertText('review.unanswered', { count: 2, waitingHours: 24 }, 'fr')?.title,
    '2 avis attendent une réponse',
  );
});

test('an unknown type has no entry; an unknown language answers in English', () => {
  assert.equal(alertText('no.such.type', {}), undefined);
  assert.equal(hasAlertText('no.such.type'), false);
  assert.equal(
    alertText('release.approved', { appName: 'Lyynk' }, 'pt')?.title,
    'Lyynk was approved',
  );
});

test('the alerts and digest catalogs have the same keys and placeholders in every language', () => {
  const base = (k: string) => k.replace(/_(one|many|other)$/, '');
  const places = (s: string) =>
    [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)]
      .map((m) => m[1])
      .sort()
      .join(',');
  for (const ns of ['alerts', 'digest']) {
    const en = catalog(ns, 'en');
    for (const lang of ['fr', 'es', 'de']) {
      const other = catalog(ns, lang);
      assert.deepEqual(
        [...new Set(Object.keys(other).map(base))].sort(),
        [...new Set(Object.keys(en).map(base))].sort(),
        `${ns}/${lang}`,
      );
      for (const [key, value] of Object.entries(other)) {
        const source = en[key] ?? en[`${base(key)}_other`] ?? en[`${base(key)}_one`];
        assert.equal(places(value), places(source as string), `${ns}/${lang}:${key}`);
        assert.ok(value.trim().length > 0, `${ns}/${lang}:${key}`);
      }
    }
  }
});

test('catalog keys of alert ids are camelCase', () => {
  assert.equal(camelKey('release.in_review.title'), 'release.inReview.title');
  assert.equal(camelKey('plan.rollout_step_due.body_one'), 'plan.rolloutStepDue.body_one');
});
