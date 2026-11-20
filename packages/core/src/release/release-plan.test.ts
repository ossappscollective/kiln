import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_STORE_FIELD_SPECS, PLAY_CHANGELOG_SPEC } from '../listing/listing.ts';
import {
  computeReadiness,
  DEFAULT_CHECKLIST_TEMPLATES,
  DUE_SOON_DAYS,
  defaultTemplate,
  dueFlags,
  isBuiltinTemplateId,
  isPlanLocale,
  isPlanVersion,
  isTargetDate,
  releaseNotesLimit,
} from './release-plan.ts';

const at = (iso: string) => Date.parse(iso);

test('release notes limits come from the listing rules, the stricter one for both platforms', () => {
  assert.equal(releaseNotesLimit('ios'), APP_STORE_FIELD_SPECS.release_notes.maxLength);
  assert.equal(releaseNotesLimit('android'), PLAY_CHANGELOG_SPEC.maxLength);
  assert.equal(releaseNotesLimit(null), 500);
  assert.equal(releaseNotesLimit('ios'), 4000);
});

test('versions, locales and dates are checked strictly', () => {
  for (const v of ['1.2.3', '2.0.0-beta.1', '2024.11', '10'])
    assert.equal(isPlanVersion(v), true, v);
  for (const v of ['', ' 1.0', '-1', '1/2', 'a'.repeat(65)])
    assert.equal(isPlanVersion(v), false, v);
  for (const l of ['default', 'en-US', 'de', 'pt_BR', 'zh-Hans-CN', 'fil'])
    assert.equal(isPlanLocale(l), true, l);
  for (const l of ['', 'e', 'en US', 'en-', '../x', 'english-united-states-of-america-long-long']) {
    assert.equal(isPlanLocale(l), false, l);
  }
  assert.equal(isTargetDate('2026-12-01'), true);
  for (const d of [
    '2026-02-30',
    '2026-13-01',
    '2026-1-1',
    '12/01/2026',
    '',
    '2026-12-01T00:00:00Z',
  ]) {
    assert.equal(isTargetDate(d), false, d);
  }
});

test('due flags: soon from three days out, overdue once the target day is over, UTC', () => {
  const date = '2026-12-10';
  assert.deepEqual(dueFlags(null, at('2026-12-01T00:00:00Z')), {
    dueSoon: false,
    overdue: false,
    daysLeft: null,
  });
  assert.equal(DUE_SOON_DAYS, 3);
  const flags = (iso: string) => dueFlags(date, at(iso));
  assert.deepEqual(flags('2026-12-06T23:59:59Z'), { dueSoon: false, overdue: false, daysLeft: 4 });
  assert.deepEqual(flags('2026-12-07T00:00:00Z'), { dueSoon: true, overdue: false, daysLeft: 3 });
  assert.deepEqual(flags('2026-12-10T00:00:00Z'), { dueSoon: true, overdue: false, daysLeft: 0 });
  assert.deepEqual(flags('2026-12-10T23:59:59.999Z'), {
    dueSoon: true,
    overdue: false,
    daysLeft: 0,
  });
  assert.deepEqual(flags('2026-12-11T00:00:00Z'), { dueSoon: false, overdue: true, daysLeft: -1 });
  assert.equal(flags('2027-02-01T00:00:00Z').overdue, true);
});

test('a release that is already out is never due soon or overdue', () => {
  const late = dueFlags('2026-12-10', at('2026-12-20T00:00:00Z'), { released: true });
  assert.deepEqual(late, { dueSoon: false, overdue: false, daysLeft: -10 });
  assert.equal(
    dueFlags('2026-12-10', at('2026-12-09T00:00:00Z'), { released: true }).dueSoon,
    false,
  );
  assert.equal(dueFlags('2026-12-10', at('2026-12-01T00:00:00Z'), { soonDays: 10 }).dueSoon, true);
});

test('readiness needs every required item done and release notes for every locale', () => {
  const none = computeReadiness({ items: [], notes: [], platform: 'ios' });
  assert.equal(none.ready, false);
  assert.match(none.reasons.join(' '), /No release notes yet/);

  const items = [
    { required: true, done: true },
    { required: true, done: false },
    { required: false, done: false },
  ];
  const r = computeReadiness({
    items,
    notes: [
      { locale: 'en-US', text: 'Fixes.' },
      { locale: 'de-DE', text: '   ' },
    ],
    platform: 'ios',
  });
  assert.deepEqual(r.required, { total: 2, done: 1, open: 1 });
  assert.equal(r.notes.filled, 1);
  assert.deepEqual(r.notes.missing, ['de-DE']);
  assert.equal(r.ready, false);
  assert.equal(r.reasons.length, 2);

  const ok = computeReadiness({
    items: items.map((i) => ({ ...i, done: true })),
    notes: [{ locale: 'en-US', text: 'Fixes.' }],
    platform: 'android',
  });
  assert.equal(ok.ready, true);
  assert.deepEqual(ok.reasons, []);
});

test('readiness flags notes over the limit of the plan platform, counting code points', () => {
  const text = '😀'.repeat(501);
  const android = computeReadiness({
    items: [],
    notes: [{ locale: 'en-US', text }],
    platform: 'android',
  });
  assert.deepEqual(android.notes.tooLong, ['en-US']);
  assert.equal(android.ready, false);
  const ios = computeReadiness({ items: [], notes: [{ locale: 'en-US', text }], platform: 'ios' });
  assert.deepEqual(ios.notes.tooLong, []);
  assert.equal(ios.ready, true);
  const both = computeReadiness({ items: [], notes: [{ locale: 'en-US', text }], platform: null });
  assert.deepEqual(both.notes.tooLong, ['en-US']);
});

test('the shipped templates cover the first release checklists', () => {
  const ios = defaultTemplate('builtin:first-ios');
  const android = defaultTemplate('builtin:first-android');
  assert.ok(ios && android);
  const text = (t: typeof ios) => t.items.map((i) => i.text.toLowerCase()).join('\n');
  for (const needle of [
    'privacy policy',
    'screenshots',
    'export compliance',
    'age rating',
    'test account',
    'release notes',
    'what’s new',
  ]) {
    assert.match(text(ios), new RegExp(needle), `ios ${needle}`);
  }
  for (const needle of [
    'privacy policy',
    'screenshots',
    'content rating',
    'data safety',
    'test account',
    'release notes',
    'what’s new',
  ]) {
    assert.match(text(android), new RegExp(needle), `android ${needle}`);
  }
  for (const template of DEFAULT_CHECKLIST_TEMPLATES) {
    assert.equal(isBuiltinTemplateId(template.id), true);
    assert.ok(template.items.length > 0 && template.items.some((i) => i.required));
    assert.equal(
      new Set(template.items.map((i) => i.text)).size,
      template.items.length,
      'no repeats',
    );
  }
  assert.equal(defaultTemplate('builtin:nope'), undefined);
  assert.equal(isBuiltinTemplateId('3f2a'), false);
});
