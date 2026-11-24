import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipboardPlan, downloadName, pixelText, stepIndex } from './viewer.ts';

test('arrow keys stay inside the set', () => {
  assert.equal(stepIndex(0, -1, 3), 0);
  assert.equal(stepIndex(2, 1, 3), 2);
  assert.equal(stepIndex(1, 1, 3), 2);
  assert.equal(stepIndex(0, 1, 0), 0);
});

test('a saved file keeps its original name and gets the extension of its bytes', () => {
  const base = { locale: 'en-US', setName: 'Phone', position: 2 };
  assert.equal(
    downloadName({ ...base, name: 'hero shot.png', mime: 'image/png' }),
    'hero shot.png',
  );
  assert.equal(downloadName({ ...base, name: 'hero.png', mime: 'image/jpeg' }), 'hero.jpg');
  assert.equal(
    downloadName({ ...base, name: '../../etc/passwd', mime: 'image/png' }),
    'passwd.png',
  );
  assert.equal(downloadName({ ...base, name: null, mime: 'image/png' }), 'en-US-Phone-2.png');
  assert.equal(downloadName({ ...base, name: '', mime: 'text/html' }), 'en-US-Phone-2.png');
});

test('the clipboard takes a PNG as it is, converts others, and falls back to saving', () => {
  assert.equal(clipboardPlan(true, 'image/png'), 'png');
  assert.equal(clipboardPlan(true, 'image/jpeg'), 'convert');
  assert.equal(clipboardPlan(false, 'image/png'), 'save');
});

test('pixel size text', () => {
  assert.equal(pixelText(1242, 2688), '1242 × 2688');
  assert.equal(pixelText(null, 5), '');
});
