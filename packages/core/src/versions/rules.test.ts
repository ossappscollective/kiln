import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReleaseRules, newestNonEditableVersion, storeVersionsOf } from './rules.ts';

/**
 * The server's refusals (publish/store-version.ts `evaluateChecks`) asked before a button is offered (audit B6).
 */

const v = (version: string | null, editable = false) => ({ version, editable });

test('a free, higher version is fine', () => {
  assert.deepEqual(createReleaseRules('2.0.1', [v('2.0.0'), v('1.9.0')]), { ok: true });
  assert.deepEqual(createReleaseRules('1.0', []), { ok: true });
  assert.deepEqual(createReleaseRules('2.00.1', [v('2.0.0')]), { ok: true });
});

test('invalid_version: four parts, a v, a suffix', () => {
  for (const bad of ['2.0.1.90', 'v2.0', '2.0-beta', '']) {
    const r = createReleaseRules(bad, [v('1.0')]);
    assert.equal(r.ok, false, bad);
    if (!r.ok) assert.equal(r.reason, 'invalid_version', bad);
  }
});

test('editable_version_exists: an obsolete draft blocks creating another (no connector can delete a version)', () => {
  const r = createReleaseRules('1.20.0', [v('1.19.0'), v('1.11.6', true)]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'editable_version_exists');
    assert.equal(r.editableVersion, '1.11.6');
    assert.deepEqual(r.reasons, ['editable_version_exists']);
  }
});

test('version_exists: any state, written alike or not', () => {
  const r = createReleaseRules('2.0', [v('2.0.0')]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'version_exists');
});

test('not_higher: against the newest NON-EDITABLE version, which can be higher than live (in review)', () => {
  // 1.19.0 is live, 2.0.0 is in review (not editable): 1.20.0 is higher than live but refused
  const versions = [v('1.19.0'), v('2.0.0')];
  const r = createReleaseRules('1.20.0', versions);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'not_higher');
    assert.equal(r.newestFixed, '2.0.0');
  }
  assert.deepEqual(createReleaseRules('2.0.1', versions), { ok: true });
  // an editable version does not set the bar (it has to be used instead, which is the other refusal)
  assert.equal(newestNonEditableVersion([v('3.0.0', true), v('1.0.0')]), '1.0.0');
});

test('several refusals are all listed, in the server order', () => {
  const r = createReleaseRules('1.0.0.1', [v('2.0.0', true)]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.reasons, ['invalid_version', 'editable_version_exists']);
  const s = createReleaseRules('1.0.0', [v('2.0.0'), v('1.5.0', true)]);
  if (!s.ok) assert.deepEqual(s.reasons, ['editable_version_exists', 'not_higher']);
  else assert.fail('should refuse');
});

test('unreadable store versions never set the bar', () => {
  assert.deepEqual(createReleaseRules('1.0.0', [v(null), v('beta'), v('1.2.3.4')]), { ok: true });
});

test('storeVersionsOf: preparing and rejected are editable; in review, approved, live are not', () => {
  const rows = storeVersionsOf([
    { version: '1', status: 'draft' },
    { version: '2', status: 'build_chosen' },
    { version: '3', status: 'ready' },
    { version: '4', status: 'rejected' },
    { version: '5', status: 'in_review' },
    { version: '6', status: 'approved' },
    { version: '7', status: 'live' },
    { version: '8', status: null },
  ]);
  assert.deepEqual(
    rows.map((r) => r.editable),
    [true, true, true, true, false, false, false, false],
  );
});
