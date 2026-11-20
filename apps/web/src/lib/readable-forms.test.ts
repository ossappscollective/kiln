import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bucketTestWord, credentialWord, testWord } from './readable-forms.ts';

describe('credentialWord', () => {
  it('is Added when a credential exists, even if none is required', () => {
    assert.deepEqual(credentialWord({ configured: true, required: true }), {
      tone: 'ok',
      label: 'Added',
    });
    assert.deepEqual(credentialWord({ configured: true, required: false }), {
      tone: 'ok',
      label: 'Added',
    });
  });

  it('is Missing only when one is required and absent', () => {
    assert.deepEqual(credentialWord({ configured: false, required: true }), {
      tone: 'warn',
      label: 'Missing',
    });
  });

  it('says Optional or the given word when none is required', () => {
    assert.equal(credentialWord({ configured: false, required: false }).label, 'Optional');
    assert.equal(
      credentialWord({ configured: false, required: false, optionalLabel: 'Not needed' }).label,
      'Not needed',
    );
  });

  it('asks to save first when the provider changed, whatever the old credential says', () => {
    assert.deepEqual(credentialWord({ configured: true, required: true, changed: true }), {
      tone: 'neutral',
      label: 'Save first',
    });
  });
});

describe('testWord', () => {
  it('is Not tested before a result and Testing while one runs', () => {
    assert.equal(testWord({ ok: null }).label, 'Not tested');
    assert.equal(testWord({ testing: true, ok: true }).label, 'Testing');
  });

  it('is Works or Failed with a tone that is not only colour', () => {
    assert.deepEqual(testWord({ ok: true }), { tone: 'ok', label: 'Works' });
    assert.deepEqual(testWord({ ok: false }), { tone: 'bad', label: 'Failed' });
  });
});

describe('bucketTestWord', () => {
  it('is Not tested before a result and Testing while one runs', () => {
    assert.equal(bucketTestWord(null).label, 'Not tested');
    assert.equal(bucketTestWord({ code: 'ok', ok: true }, true).label, 'Testing');
  });

  it('is Works only for the ok code', () => {
    assert.deepEqual(bucketTestWord({ code: 'ok', ok: true }), { tone: 'ok', label: 'Works' });
  });

  it('is Reachable when the bucket can be read but holds nothing for the app yet', () => {
    assert.deepEqual(bucketTestWord({ code: 'no_reports_yet', ok: true }), {
      tone: 'neutral',
      label: 'Reachable',
    });
  });

  it('is Failed for a result that is not ok, whatever the code', () => {
    for (const code of [
      'bucket_forbidden',
      'bucket_not_found',
      'unreachable',
      'credential_problem',
    ]) {
      assert.deepEqual(
        bucketTestWord({ code, ok: false }),
        { tone: 'warn', label: 'Failed' },
        code,
      );
    }
  });
});
