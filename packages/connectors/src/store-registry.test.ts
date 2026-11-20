import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appleScope, connectorFactory, type StoreConnectorInput } from './store-registry.ts';

const input = (
  kind: StoreConnectorInput['kind'],
  platform?: 'ios' | 'macos' | 'android',
): StoreConnectorInput => ({
  kind,
  secret: 's',
  identifier: 'com.example',
  storeAppId: null,
  ...(platform ? { platform } : {}),
  fetch,
});

test('connectorFactory calls the builder of the credential kind', () => {
  const make = connectorFactory<string>({
    app_store_connect: (i) => `apple:${i.identifier}`,
    google_play: (i) => `play:${i.identifier}`,
  });
  assert.equal(make(input('app_store_connect')), 'apple:com.example');
  assert.equal(make(input('google_play')), 'play:com.example');
});

test('appleScope reads macOS apps as macOS and everything else as iOS', () => {
  assert.equal(appleScope({ platform: 'macos' }), 'macos');
  assert.equal(appleScope({ platform: 'ios' }), 'ios');
  assert.equal(appleScope({}), 'ios');
});
