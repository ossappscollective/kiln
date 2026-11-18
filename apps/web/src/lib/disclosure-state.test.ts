import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { expandedOr, forgetExpanded, recallExpanded, rememberExpanded, screenKey } from './disclosure-state.ts';

describe('disclosure state', () => {
  beforeEach(() => forgetExpanded());

  it('has no opinion until a choice is made', () => {
    assert.equal(recallExpanded('a.b'), undefined);
    assert.equal(expandedOr('a.b', true), true);
    assert.equal(expandedOr('a.b', false), false);
  });

  it('remembers the last choice, also a close', () => {
    rememberExpanded('a.b', true);
    assert.equal(expandedOr('a.b', false), true);
    rememberExpanded('a.b', false);
    assert.equal(expandedOr('a.b', true), false);
  });

  it('keeps keys apart and ignores an undefined key', () => {
    rememberExpanded('a.b', true);
    assert.equal(recallExpanded('a.c'), undefined);
    rememberExpanded(undefined, true);
    assert.equal(recallExpanded(undefined), undefined);
  });

  it('builds a screen key', () => {
    assert.equal(screenKey('listing', 'warnings'), 'listing.warnings');
  });
});
