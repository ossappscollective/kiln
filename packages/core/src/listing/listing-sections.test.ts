import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanSection,
  sectionFromText,
  sectionOfField,
  sectionToText,
} from './listing-sections.ts';

test('the locales section keeps the store codes as they are: fr-FR and fr-CA stay two languages', () => {
  const text = sectionToText('locales', { codes: ['fr-FR', 'en-US', 'fr-CA', 'fr-FR'] });
  assert.equal(text, '{"codes":["en-US","fr-CA","fr-FR"]}');
  assert.deepEqual(sectionFromText('locales', text), { codes: ['en-US', 'fr-CA', 'fr-FR'] });
  assert.equal(sectionOfField('section:locales'), 'locales');
});

test('the locales section is tolerant: wrong members are dropped, a non-object is not read', () => {
  assert.deepEqual(cleanSection('locales', { codes: ['de-DE', 3, null] }), { codes: ['de-DE'] });
  assert.deepEqual(cleanSection('locales', {}), { codes: [] }, 'read, and there is no language');
  assert.equal(cleanSection('locales', 'fr-FR'), undefined);
  assert.equal(sectionFromText('locales', 'not json'), undefined);
});
