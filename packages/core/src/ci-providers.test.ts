import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CI_PROVIDER_META, CI_PROVIDERS, ciProviderMeta, ciProviderOf, isCiProvider } from './ci-providers.ts';

test('every provider has words, and the ids match', () => {
  for (const id of CI_PROVIDERS) {
    assert.equal(CI_PROVIDER_META[id].id, id);
    assert.ok(CI_PROVIDER_META[id].label.length > 0);
    assert.ok(CI_PROVIDER_META[id].host.length > 0);
  }
});

test('an unknown or missing provider reads as GitHub, so old rows and old servers keep working', () => {
  assert.equal(ciProviderOf(undefined), 'github');
  assert.equal(ciProviderOf(null), 'github');
  assert.equal(ciProviderOf('circleci'), 'github');
  assert.equal(ciProviderOf('eas-workflows'), 'eas-workflows');
  assert.equal(isCiProvider('eas-workflows'), true);
  assert.equal(isCiProvider('x'), false);
  assert.equal(ciProviderMeta('eas-workflows').host, 'Expo');
  assert.equal(ciProviderMeta(undefined).label, 'GitHub Actions');
});
