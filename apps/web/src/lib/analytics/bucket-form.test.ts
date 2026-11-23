import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BucketFormInput, bucketFormState, normalizeBucketInput } from './bucket-form.ts';

const base: BucketFormInput = { saved: null, useDefault: true, text: '', inherited: 'pubsite_prod_rev_999', saving: false, testing: false, canManage: true };

test('pasted forms of a bucket are reduced to the bare id', () => {
  for (const v of ['pubsite_prod_rev_123', ' gs://pubsite_prod_rev_123/ ', 'https://console.cloud.google.com/storage/browser/pubsite_prod_rev_123?project=p'])
    assert.equal(normalizeBucketInput(v), 'pubsite_prod_rev_123', v);
  assert.equal(normalizeBucketInput('nope'), undefined);
});

test('typing a valid id enables save and test, and sends the bare id', () => {
  const s = bucketFormState({ ...base, useDefault: false, text: 'gs://pubsite_prod_rev_123/' });
  assert.equal(s.canSave, true);
  assert.equal(s.canTest, true);
  assert.equal(s.saveValue, 'pubsite_prod_rev_123');
  assert.equal(s.testValue, 'pubsite_prod_rev_123');
  assert.equal(s.problem, null);
});

test('custom and empty or invalid: nothing to save or test, with a reason', () => {
  const e = bucketFormState({ ...base, useDefault: false, text: '  ' });
  assert.deepEqual([e.canSave, e.canTest, e.problem], [false, false, 'empty']);
  const b = bucketFormState({ ...base, useDefault: false, text: 'my-bucket' });
  assert.deepEqual([b.canSave, b.canTest, b.problem], [false, false, 'invalid']);
});

test('switching from the saved custom bucket to the workspace one is a change; the other way too', () => {
  const own = 'pubsite_prod_rev_123';
  assert.equal(bucketFormState({ ...base, saved: own, useDefault: true, text: own }).canSave, true);
  assert.equal(bucketFormState({ ...base, saved: own, useDefault: false, text: own }).dirty, false);
  assert.equal(bucketFormState({ ...base, saved: own, useDefault: false, text: `gs://${own}` }).dirty, false);
  assert.equal(bucketFormState({ ...base, saved: null, useDefault: true }).dirty, false);
  // custom chosen on an inheriting app but nothing typed yet: a change that cannot be saved
  const s = bucketFormState({ ...base, saved: null, useDefault: false, text: '' });
  assert.deepEqual([s.dirty, s.canSave], [true, false]);
});

test('test works on the unsaved value; the default is tested only when one is inherited; busy and read-only disable', () => {
  assert.equal(bucketFormState({ ...base, saved: null, useDefault: true }).canTest, true);
  assert.equal(bucketFormState({ ...base, inherited: null }).canTest, false);
  assert.equal(bucketFormState({ ...base, useDefault: true, saved: 'pubsite_prod_rev_1' }).testValue, undefined);
  const typed = { ...base, useDefault: false, text: 'pubsite_prod_rev_5' };
  assert.equal(bucketFormState({ ...typed, testing: true }).canTest, false);
  assert.equal(bucketFormState({ ...typed, saving: true }).canSave, false);
  assert.equal(bucketFormState({ ...typed, canManage: false }).canSave, false);
  assert.equal(bucketFormState({ ...typed, saved: undefined }).canSave, false);
});
