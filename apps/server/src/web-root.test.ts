import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { test } from 'node:test';
import { webRoot } from './web-root.ts';

test('web root: relative names get ./, dotted and absolute paths are kept', () => {
  assert.equal(webRoot('web'), './web');
  assert.equal(webRoot('./web'), './web');
  assert.equal(webRoot('../web'), '../web');
  if (process.platform === 'win32') {
    assert.equal(webRoot('D:\\a\\kiln\\web'), 'D:\\a\\kiln\\web');
    assert.equal(win32.isAbsolute('D:\\a\\kiln\\web'), true);
  } else {
    assert.equal(webRoot('/srv/kiln/web'), '/srv/kiln/web');
  }
});
