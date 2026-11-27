import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import { classifyVersionFailure, suggestedVersion, type VersionResult } from './store-version.ts';

const release = (platform: 'ios' | 'macos' | 'android', version: string) => ({ platform, version });

test('suggestedVersion: the next patch of the newest version of the platform', () => {
  assert.equal(
    suggestedVersion(
      [release('ios', '3.1.1'), release('ios', '3.0'), release('macos', '9.4')],
      'ios',
    ),
    '3.1.2',
  );
  assert.equal(
    suggestedVersion([release('ios', '3.1.1'), release('macos', '9.4')], 'macos'),
    '9.4.1',
  );
  assert.equal(
    suggestedVersion([release('ios', '3.10'), release('ios', '3.9.9')], 'ios'),
    '3.10.1',
  );
});

test('suggestedVersion: nothing to go on is empty, so the person types one', () => {
  assert.equal(suggestedVersion([], 'ios'), '');
  assert.equal(suggestedVersion([release('android', '3.1')], 'ios'), '');
  assert.equal(suggestedVersion([release('ios', '3.1-beta')], 'ios'), '');
});

test('classifyVersionFailure: the switch names the variable, a refusal of the role says who may', () => {
  const off = classifyVersionFailure(new ApiError(409, 'store_draft_disabled', 'off'));
  assert.equal(off.kind, 'disabled');
  assert.match(off.message, /KILN_STORE_DRAFT_WRITE_ENABLED=true/);
  assert.equal(classifyVersionFailure(new ApiError(403, 'forbidden', 'no')).kind, 'forbidden');
});

test('classifyVersionFailure: a block lists the checks, a lost answer sends the person to App Store Connect', () => {
  const blocked = classifyVersionFailure(
    new ApiError(409, 'blocked', 'x', undefined, {
      checks: { blocking: [{ code: 'not_higher', message: 'It must be higher than 3.1.1.' }] },
    }),
  );
  assert.equal(blocked.kind, 'blocked');
  assert.match(blocked.message, /higher than 3\.1\.1\. Nothing was created/);
  const unknown = classifyVersionFailure(new ApiError(409, 'outcome_unknown', 'It is not known.'));
  assert.equal(unknown.kind, 'outcome_unknown');
  assert.match(unknown.message, /App Store Connect/);
});

test("classifyVersionFailure: Apple's reasons are shown once", () => {
  const f = classifyVersionFailure(
    new ApiError(422, 'store_rejected', 'Apple refused (409).', undefined, {
      message: 'Apple refused (409).',
      details: [
        { detail: 'The version string is not valid.' },
        { detail: 'The version string is not valid.' },
        { title: 'Second' },
      ],
    }),
  );
  assert.equal(
    f.message,
    'Apple refused (409). The version string is not valid. Second Nothing was created.',
  );
});

test('classifyVersionFailure: a step-up answer gets its own sentence; a network failure says nothing is known to be created', () => {
  assert.match(
    classifyVersionFailure(new ApiError(403, 'step_up_not_enrolled', 'x')).message,
    /passkey/,
  );
  assert.match(classifyVersionFailure(new TypeError('fetch failed')).message, /Nothing is known/);
});

test('a version result and preview may carry the review information (older servers omit it)', () => {
  const result: VersionResult = {
    version: { id: 'v', versionString: '1.19.1', state: 'PREPARE_FOR_SUBMISSION' },
    confirmedByReread: false,
    warnings: [],
    reviewInformation: { outcome: 'created', from: '1.19.0', fieldsCopied: 8, summary: null },
    note: '',
  };
  assert.equal(result.reviewInformation?.from, '1.19.0');
  const old: VersionResult = { ...result };
  delete old.reviewInformation;
  assert.equal(old.reviewInformation, undefined);
});
