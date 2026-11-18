import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  checkLocale,
  doneBy,
  dueText,
  findSibling,
  formatTargetDate,
  knownVersions,
  limitNote,
  moveId,
  noteCounter,
  parseReleaseRoute,
  planErrorMessage,
  planPlatformChoices,
  planPlatformLabel,
  releaseHref,
  releasesOfVersion,
  rolloutView,
} from './release.ts';
import type { AppSummary, ReleaseSummary } from './types.ts';

const app = (partial: Partial<AppSummary>): AppSummary => ({
  id: 'a1',
  name: 'Acme',
  platform: 'ios',
  identifier: 'com.acme.app',
  storeAppId: null,
  credentialId: 'c',
  repositoryId: null,
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncAttemptAt: null,
  lastSyncError: null,
  ...partial,
});

const rel = (partial: Partial<ReleaseSummary>): ReleaseSummary => ({
  id: 'r',
  appId: 'a1',
  platform: 'ios',
  version: '1.0.0',
  track: null,
  build: null,
  status: 'live',
  rawState: 'X',
  rolloutFraction: null,
  versionCodes: null,
  storeUpdatedAt: null,
  syncedAt: 0,
  ...partial,
});

test('the release route round trips and rejects everything else', () => {
  assert.equal(releaseHref('a 1', '2.0.0+5'), '#/portfolio/a%201/release/2.0.0%2B5');
  assert.deepEqual(parseReleaseRoute('#/portfolio/a%201/release/2.0.0%2B5'), { appId: 'a 1', version: '2.0.0+5' });
  assert.deepEqual(parseReleaseRoute('#/portfolio/x/release/1.0/'), { appId: 'x', version: '1.0' });
  assert.deepEqual(parseReleaseRoute('portfolio/x/release/1.0?tab=notes'), { appId: 'x', version: '1.0' });
  const bad = ['', '#/portfolio', '#/portfolio/x', '#/portfolio/x/release', '#/portfolio/x/release/', '#/portfolio/x/releases/1', '#/portfolio/x/release/1/extra', '#/portfolio/%E0%A4%A/release/1', '#/audit/x/release/1'];
  for (const hash of bad) assert.equal(parseReleaseRoute(hash), null, hash);
});

test('the sibling is the other platform with the same identifier, else the same name, never a guess', () => {
  const ios = app({ id: 'i', platform: 'ios' });
  const android = app({ id: 'g', platform: 'android' });
  assert.equal(findSibling([ios, android], ios)?.id, 'g');
  assert.equal(findSibling([ios, android], android)?.id, 'i');
  assert.equal(findSibling([ios], ios), null);
  const renamed = app({ id: 'g2', platform: 'android', identifier: 'com.acme.android', name: 'ACME ' });
  assert.equal(findSibling([ios, renamed], ios)?.id, 'g2');
  const other = app({ id: 'g3', platform: 'android', identifier: 'com.other', name: 'Other' });
  assert.equal(findSibling([ios, other], ios), null);
  const twin = app({ id: 'g4', platform: 'android' });
  assert.equal(findSibling([ios, android, twin], ios), null);
  assert.equal(findSibling([ios, app({ id: 'i2', platform: 'ios' })], ios), null);
});

test('releases of a version and the known versions', () => {
  const list = [
    rel({ id: '1', version: '1.0.0', track: 'beta', platform: 'android' }),
    rel({ id: '2', version: '1.0.0', track: 'production', platform: 'android' }),
    rel({ id: '3', version: '1.10.0' }),
    rel({ id: '4', version: '1.9.0' }),
  ];
  assert.deepEqual(releasesOfVersion(list, '1.0.0').map((r) => r.id), ['1', '2']);
  assert.deepEqual(releasesOfVersion(list, '9').map((r) => r.id), []);
  assert.deepEqual(knownVersions(list, ['2.0.0', '1.9.0']), ['2.0.0', '1.10.0', '1.9.0', '1.0.0']);
});

test('rollout is described as observed, with a share only when the store gave one', () => {
  const android = rolloutView({ platform: 'android', status: 'rolling_out', rolloutFraction: 0.2 });
  assert.deepEqual([android.title, android.fraction], ['Staged rollout', 0.2]);
  assert.match(android.text, /20%/);
  assert.match(rolloutView({ platform: 'android', status: 'rolling_out', rolloutFraction: 0.005 }).text, /0\.5%/);
  const ios = rolloutView({ platform: 'ios', status: 'rolling_out', rolloutFraction: null });
  assert.equal(ios.title, 'Phased release');
  assert.equal(ios.fraction, null);
  assert.match(ios.text, /not read from Apple yet/);
  assert.match(rolloutView({ platform: 'ios', status: 'live', rolloutFraction: null }).text, /Live for everyone/);
  assert.match(rolloutView({ platform: 'android', status: 'draft', rolloutFraction: null }).text, /Not rolling out/);
  assert.equal(rolloutView({ platform: 'android', status: 'halted', rolloutFraction: 7 }).fraction, 1);
  assert.equal(rolloutView({ platform: 'android', status: 'live', rolloutFraction: Number.NaN }).fraction, null);
});

test('dates and deadlines are said in words', () => {
  assert.equal(formatTargetDate('2026-12-01', 'en-US'), 'Tue, Dec 1, 2026');
  assert.equal(formatTargetDate('nonsense'), 'nonsense');
  const d = (daysLeft: number | null, dueSoon = false, overdue = false) => ({ daysLeft, dueSoon, overdue });
  assert.equal(dueText(d(null)), null);
  assert.deepEqual(dueText(d(0, true)), { text: 'Due today', tone: 'warn' });
  assert.deepEqual(dueText(d(1, true)), { text: 'Due in 1 day', tone: 'warn' });
  assert.deepEqual(dueText(d(9)), { text: 'Due in 9 days', tone: 'neutral' });
  assert.deepEqual(dueText(d(-1, false, true)), { text: 'Overdue by 1 day', tone: 'bad' });
  assert.deepEqual(dueText(d(-5, false, true)), { text: 'Overdue by 5 days', tone: 'bad' });
  assert.deepEqual(dueText(d(-5), true), { text: 'Released', tone: 'ok' });
});

test('the note counter uses the limit of the platform and counts code points', () => {
  assert.deepEqual(noteCounter('abc', 'ios'), { count: 3, limit: 4000, over: false, remaining: 3997, label: '3 of 4000 characters' });
  const over = noteCounter('x'.repeat(503), 'android');
  assert.equal(over.over, true);
  assert.equal(over.label, '3 characters over the limit of 500');
  assert.equal(noteCounter('😀'.repeat(500), null).over, false);
  assert.equal(noteCounter('😀'.repeat(501), null).over, true);
  assert.equal(noteCounter('x'.repeat(501), 'android').label, '1 character over the limit of 500');
  assert.match(limitNote(null), /stricter limit applies: 500/);
  assert.match(limitNote('ios'), /4000/);
  assert.match(limitNote('android'), /500/);
});

test('a typed locale is checked and compared without regard to case', () => {
  assert.deepEqual(checkLocale(' de-DE ', []), { ok: true, locale: 'de-DE' });
  assert.equal(checkLocale('', []).ok, false);
  assert.equal(checkLocale('english', ['x']).ok, false);
  assert.deepEqual(checkLocale('EN-us', ['en-US']), { ok: false, message: 'EN-us is already on this plan.' });
  assert.deepEqual(checkLocale('default', []), { ok: true, locale: 'default' });
});

test('moving a checklist item changes the order and stays inside the list', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(moveId(order, 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(moveId(order, 1, 1), ['a', 'c', 'b']);
  assert.deepEqual(moveId(order, 0, -1), order);
  assert.deepEqual(moveId(order, 2, 1), order);
  assert.deepEqual(moveId(order, 9, 1), order);
  assert.deepEqual(order, ['a', 'b', 'c'], 'the input is not changed');
  assert.equal(doneBy({ done: false, doneBy: null }), '');
  assert.equal(doneBy({ done: true, doneBy: { name: 'Ada' } }), 'Done by Ada');
  assert.equal(doneBy({ done: true, doneBy: null }), 'Done');
});

test('plan platform labels and choices', () => {
  assert.equal(planPlatformLabel(null), 'Both platforms');
  assert.equal(planPlatformLabel('android'), 'Android');
  assert.deepEqual(planPlatformChoices({ platform: 'ios' }).map((c) => c.value), [null, 'ios']);
});

test('plan errors become sentences', () => {
  const err = (status: number, code: string, body: Record<string, unknown> = {}) => new ApiError(status, code, 'generic', undefined, body);
  assert.equal(planErrorMessage(err(422, 'notes_too_long', { message: 'Too long: 600.' })), 'Too long: 600.');
  assert.match(planErrorMessage(err(404, 'not_found')), /no longer exists/);
  assert.match(planErrorMessage(err(404, 'template_not_found')), /template no longer exists/);
  assert.equal(planErrorMessage(err(409, 'already_exists', { message: 'This app already has a plan for that version.' })), 'This app already has a plan for that version.');
  assert.equal(planErrorMessage(err(500, 'boom')), 'generic');
  assert.equal(planErrorMessage(new Error('x'), 'Fallback'), 'Fallback');
});
