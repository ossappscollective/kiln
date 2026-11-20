import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareDottedVersions,
  isDottedVersion,
  newestDottedVersion,
  nextVersion,
} from './store-version.ts';

test('nextVersion raises the patch number', () => {
  assert.equal(nextVersion('3.1.1'), '3.1.2');
  assert.equal(nextVersion('3.1'), '3.1.1');
  assert.equal(nextVersion('2'), '2.0.1');
  assert.equal(nextVersion('1.9.9'), '1.9.10');
  assert.equal(nextVersion(' 4.0.0 '), '4.0.1');
});

test('nextVersion: no version yet is 1.0, an unreadable one is left to the person', () => {
  assert.equal(nextVersion(null), '1.0');
  assert.equal(nextVersion(undefined), '1.0');
  assert.equal(nextVersion(''), '1.0');
  assert.equal(nextVersion('2.0-beta'), '');
  assert.equal(nextVersion('1.2.3.4'), '');
});

test('isDottedVersion accepts one to three numbers only', () => {
  for (const ok of ['1', '1.0', '10.20.30', '0.0.1']) assert.equal(isDottedVersion(ok), true, ok);
  for (const bad of ['', '1.', '.1', '1..2', '1.2.3.4', 'v1.0', '1.0-beta', '1 .0', '-1', '1234567890'])
    assert.equal(isDottedVersion(bad), false, bad);
});

test('compareDottedVersions compares numbers, a missing part is 0', () => {
  assert.equal(compareDottedVersions('3.1', '3.1.0'), 0);
  assert.equal(compareDottedVersions('3.10', '3.9'), 1);
  assert.equal(compareDottedVersions('2', '2.0.1'), -1);
  assert.equal(compareDottedVersions('1.0.0', '2'), -1);
  assert.ok(Number.isNaN(compareDottedVersions('1.0-beta', '1.0')));
});

test('newestDottedVersion ignores what is not a dotted version', () => {
  assert.equal(newestDottedVersion(['1.2', '1.10', null, 'x', '1.9.9']), '1.10');
  assert.equal(newestDottedVersion([]), null);
});
