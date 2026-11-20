import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { credentialWord, testWord } from './readable-forms.ts';

describe('credentialWord', () => {
  it('is Added when a credential exists, even if none is required', () => {
    assert.deepEqual(credentialWord({ configured: true, required: true }), { tone: 'ok', label: 'Added' });
    assert.deepEqual(credentialWord({ configured: true, required: false }), { tone: 'ok', label: 'Added' });
  });

  it('is Missing only when one is required and absent', () => {
    assert.deepEqual(credentialWord({ configured: false, required: true }), { tone: 'warn', label: 'Missing' });
  });

  it('says Optional or the given word when none is required', () => {
    assert.equal(credentialWord({ configured: false, required: false }).label, 'Optional');
    assert.equal(credentialWord({ configured: false, required: false, optionalLabel: 'Not needed' }).label, 'Not needed');
  });

  it('asks to save first when the provider changed, whatever the old credential says', () => {
    assert.deepEqual(credentialWord({ configured: true, required: true, changed: true }), { tone: 'neutral', label: 'Save first' });
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
