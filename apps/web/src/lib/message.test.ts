import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import { k } from './i18n/t.ts';
import { useLocale } from './i18n/test-setup.ts';
import { builtMsg, msg, msgText, rawMsg } from './message.ts';
import { classifyReleaseFailure } from './store-release.ts';
import { classifyFailure, parsePercent } from './store-rollout.ts';

test('a kept message is written in the language that is active when it is drawn', () => {
  const kept = msg(k('release-store:rollout.fail.timeout'));
  const withParams = msg(k('release-store:rollout.fail.disabled'), () => ({ env: 'KILN_X' }));
  const joined = builtMsg(() => `${msgText(kept)} | ${msgText(rawMsg('from the server'))}`);
  const english = msgText(kept);
  assert.notEqual(english, '');
  assert.match(msgText(withParams), /KILN_X/);
  assert.equal(msgText(rawMsg('from the server')), 'from the server');
  assert.equal(msgText(null), '');
  useLocale('fr');
  try {
    assert.notEqual(msgText(kept), english);
    assert.match(msgText(withParams), /KILN_X/);
    assert.ok(msgText(joined).endsWith('| from the server'));
  } finally {
    useLocale('en');
  }
});

test('failures and refused percentages keep a message that follows the language', () => {
  const rollout = classifyFailure(new ApiError(409, 'rollout_disabled', 'off', {}), null);
  const check = parsePercent('', null);
  const release = classifyReleaseFailure(new ApiError(403, 'forbidden', 'no', {}));
  assert.equal(rollout.kind, 'disabled');
  assert.equal(msgText(rollout.text), rollout.message);
  assert.equal(check.ok, false);
  if (!check.ok) assert.equal(msgText(check.text), check.message);
  assert.equal(msgText(release.text), release.message);
  useLocale('de');
  try {
    assert.notEqual(msgText(rollout.text), rollout.message);
    assert.notEqual(msgText(release.text), release.message);
    if (!check.ok) assert.notEqual(msgText(check.text), check.message);
  } finally {
    useLocale('en');
  }
});
