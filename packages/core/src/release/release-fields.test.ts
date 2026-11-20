import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkReleaseField,
  checkReleaseSet,
  isStageableReleaseField,
  normalizeReleaseValue,
  releaseItemKey,
  STAGEABLE_RELEASE_FIELDS,
  versionCodesOf,
} from './release-fields.ts';
import { STAGED_KINDS } from '../listing/staged-changes.ts';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const codes = (list: { code: string; severity: string }[], severity?: string) =>
  list.filter((p) => severity === undefined || p.severity === severity).map((p) => p.code);

test('release fields are a staged kind of their own; macOS stages what iOS does, Android has its own', () => {
  assert.ok(STAGED_KINDS.includes('release_field'));
  assert.deepEqual(STAGEABLE_RELEASE_FIELDS.macos, STAGEABLE_RELEASE_FIELDS.ios);
  assert.equal(isStageableReleaseField('ios', 'build'), true);
  assert.equal(isStageableReleaseField('ios', 'track'), false);
  assert.equal(isStageableReleaseField('android', 'build'), false);
  assert.equal(isStageableReleaseField('android', 'release_notes'), true);
});

test('normalizing: codes are unique and ascending, the share is plain, the date is UTC, the switches are canonical', () => {
  assert.equal(normalizeReleaseValue('version_codes', ' 241, 240;240 9 '), '9,240,241');
  assert.equal(normalizeReleaseValue('version_codes', ['300', '20']), '20,300');
  assert.deepEqual(versionCodesOf('9,240'), ['9', '240']);
  assert.deepEqual(versionCodesOf(''), []);
  assert.equal(normalizeReleaseValue('user_fraction', '0.10'), '0.1');
  assert.equal(normalizeReleaseValue('user_fraction', 0.25), '0.25');
  assert.equal(normalizeReleaseValue('user_fraction', '10%'), '0.1');
  assert.equal(
    normalizeReleaseValue('earliest_release_date', '2026-12-01T11:00:00+01:00'),
    '2026-12-01T10:00:00Z',
  );
  assert.equal(
    normalizeReleaseValue('earliest_release_date', '2026-12-01'),
    '2026-12-01',
    'not a date and time: left for the check to refuse',
  );
  assert.equal(normalizeReleaseValue('phased_release', true), 'on');
  assert.equal(normalizeReleaseValue('phased_release', ' OFF '), 'off');
  assert.equal(normalizeReleaseValue('release_type', 'manual'), 'MANUAL');
  assert.equal(normalizeReleaseValue('release_notes', '\r\nFixes  \r\n\r\n'), 'Fixes');
  assert.equal(normalizeReleaseValue('copyright', '  2026 Acme '), '2026 Acme');
});

test('App Store fields: version format, release type, date in the future, phased release, build id', () => {
  const check = (field: Parameters<typeof checkReleaseField>[1], value: string) =>
    checkReleaseField('ios', field, '', value, NOW);
  assert.deepEqual(check('version_string', '2.4.0'), []);
  assert.deepEqual(codes(check('version_string', '2.4.0.1')), ['invalid_version_string']);
  assert.deepEqual(codes(check('version_string', 'v2')), ['invalid_version_string']);
  assert.deepEqual(codes(check('version_string', '2.4.0'), 'error'), []);
  assert.deepEqual(check('release_type', 'MANUAL'), []);
  assert.deepEqual(codes(check('release_type', 'SOMETIMES')), ['invalid_release_type']);
  assert.deepEqual(
    codes(check('release_type', 'AFTER_APPROVAL'), 'warning'),
    ['submit_needs_manual'],
    'it works, but submit from here stays blocked',
  );
  assert.deepEqual(check('earliest_release_date', '2026-12-01T10:00:00Z'), []);
  assert.deepEqual(codes(check('earliest_release_date', '2026-11-19T11:00:00Z')), ['date_in_past']);
  assert.deepEqual(
    codes(check('earliest_release_date', '2026-11-19T12:00:00Z')),
    ['date_in_past'],
    'now is not the future',
  );
  assert.deepEqual(codes(check('earliest_release_date', 'tomorrow')), ['invalid_date']);
  assert.deepEqual(check('phased_release', 'on'), []);
  assert.deepEqual(codes(check('phased_release', 'maybe')), ['invalid_phased_release']);
  assert.deepEqual(check('build', 'a1b2-c3'), []);
  assert.deepEqual(codes(check('build', 'a b')), ['invalid_build']);
  assert.deepEqual(codes(check('copyright', '')), ['empty_value']);
  // An unverified limit is a warning, never an error.
  const long = check('copyright', 'x'.repeat(250));
  assert.deepEqual([codes(long, 'error'), codes(long, 'warning')], [[], ['too_long']]);
  assert.match(long[0]?.message ?? '', /UNVERIFIED/);
  // A locale where there is none, and a Play field on an App Store app.
  assert.deepEqual(codes(checkReleaseField('ios', 'copyright', 'en-US', '2026 Acme', NOW)), [
    'invalid_locale',
  ]);
  assert.deepEqual(codes(checkReleaseField('ios', 'track', '', 'production', NOW)), [
    'field_not_stageable',
  ]);
  assert.deepEqual(codes(checkReleaseField('macos', 'build', '', 'b1', NOW)), []);
});

test('Google Play fields: track, version codes, the intended share, notes per language', () => {
  const check = (field: Parameters<typeof checkReleaseField>[1], value: string, locale = '') =>
    checkReleaseField('android', field, locale, value, NOW);
  assert.deepEqual(check('track', 'production'), []);
  assert.deepEqual(codes(check('track', 'prod uction')), ['invalid_track']);
  assert.deepEqual(check('version_codes', '240,241'), []);
  assert.deepEqual(codes(check('version_codes', '')), ['invalid_version_codes']);
  assert.deepEqual(codes(check('version_codes', '240,abc')), ['invalid_version_codes']);
  assert.deepEqual(codes(check('version_codes', '0')), ['invalid_version_codes']);
  assert.deepEqual(codes(check('version_codes', '2100000001')), ['invalid_version_codes']);
  assert.deepEqual(
    codes(check('version_codes', Array.from({ length: 21 }, (_, i) => String(i + 1)).join(','))),
    ['too_many_version_codes'],
  );
  assert.deepEqual(check('user_fraction', '0.1'), []);
  assert.deepEqual(
    check('user_fraction', '1'),
    [],
    'the intended share may be everyone: the release step still needs it typed',
  );
  assert.deepEqual(codes(check('user_fraction', '0')), ['invalid_user_fraction']);
  assert.deepEqual(codes(check('user_fraction', '1.5')), ['invalid_user_fraction']);
  assert.deepEqual(codes(check('user_fraction', '0.12345')), ['invalid_user_fraction']);
  assert.deepEqual(codes(check('user_fraction', 'half')), ['invalid_user_fraction']);
  assert.deepEqual(check('release_notes', 'Fixes', 'en-US'), []);
  assert.deepEqual(
    codes(check('release_notes', 'Fixes', '')),
    ['invalid_locale'],
    'notes need a language',
  );
  assert.deepEqual(codes(check('release_notes', 'Fixes', 'english')), ['invalid_locale']);
  const long = check('release_notes', 'x'.repeat(501), 'en-US');
  assert.deepEqual(
    [codes(long, 'error'), codes(long, 'warning')],
    [[], ['too_long']],
    'the 500 limit is UNVERIFIED: a warning',
  );
  assert.deepEqual(codes(check('release_name', 'x'.repeat(60)), 'warning'), ['too_long']);
});

test('cross field: SCHEDULED needs a date, a date needs SCHEDULED, Play fields need a track', () => {
  const item = (field: Parameters<typeof checkReleaseField>[1], value: string, locale = '') => ({
    field,
    locale,
    value,
  });
  const key = (field: string, locale = '') => releaseItemKey(field, locale);
  const a = checkReleaseSet('ios', [item('release_type', 'SCHEDULED')]);
  assert.deepEqual(
    a[key('release_type')]?.map((p) => p.code),
    ['scheduled_needs_date'],
  );
  assert.deepEqual(
    checkReleaseSet('ios', [
      item('release_type', 'SCHEDULED'),
      item('earliest_release_date', '2026-12-01T10:00:00Z'),
    ]),
    {},
  );
  const b = checkReleaseSet('ios', [
    item('release_type', 'MANUAL'),
    item('earliest_release_date', '2026-12-01T10:00:00Z'),
  ]);
  assert.deepEqual(
    b[key('earliest_release_date')]?.map((p) => p.code),
    ['date_without_schedule'],
  );
  assert.deepEqual(
    checkReleaseSet('ios', [item('earliest_release_date', '2026-12-01T10:00:00Z')]),
    {},
    'what the store holds for the type is checked at preview',
  );
  const c = checkReleaseSet('android', [
    item('version_codes', '240'),
    item('release_notes', 'Fixes', 'en-US'),
  ]);
  assert.deepEqual(
    c[key('version_codes')]?.map((p) => p.code),
    ['track_required'],
  );
  assert.deepEqual(
    checkReleaseSet('android', [item('track', 'production'), item('version_codes', '240')]),
    {},
  );
  assert.deepEqual(checkReleaseSet('android', []), {});
});
