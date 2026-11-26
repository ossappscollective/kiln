import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offersChannelSwitch, storeVersionLabel } from './store-version.ts';

const view = (version: { versionString: string | null; editable: boolean } | null) => ({
  version: version ? { id: 'v', state: 'X', ...version } : null,
});

test('the draft version is what Kiln edits and shows by default', () => {
  assert.deepEqual(storeVersionLabel(view({ versionString: '2.00.1', editable: true })), {
    kind: 'draft',
    version: '2.00.1',
    editable: true,
  });
});

test('the live version asked for with the switch is read only', () => {
  assert.deepEqual(storeVersionLabel(view({ versionString: '1.19.0', editable: false }), 'live'), {
    kind: 'live',
    version: '1.19.0',
    editable: false,
  });
});

test('with no draft the live version is shown and says so (live_only), never as editable', () => {
  assert.deepEqual(storeVersionLabel(view({ versionString: '1.19.0', editable: false })), {
    kind: 'live_only',
    version: '1.19.0',
    editable: false,
  });
});

test('Google Play and an unread store have no version label', () => {
  assert.equal(storeVersionLabel(view(null)), null);
  assert.equal(storeVersionLabel(null), null);
});

test('the switch is offered for the Apple stores only', () => {
  assert.equal(offersChannelSwitch({ platform: 'ios' }), true);
  assert.equal(offersChannelSwitch({ platform: 'macos' }), true);
  assert.equal(offersChannelSwitch({ platform: 'android' }), false);
  assert.equal(offersChannelSwitch(null), false);
});
