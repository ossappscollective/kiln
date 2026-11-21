import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyticsErrorCodes, analyticsNextSteps, analyticsSetupCodes, coverageNoteCodes } from '@kiln/core';
import { useLocale } from '../i18n/test-setup.ts';
import { t } from '../i18n/t.ts';
import {
  deltaLine,
  formatDay,
  lagText,
  noteText,
  setupSentence,
  stepAction,
  storedErrorText,
} from './analytics.ts';
import { metricLabel, seriesLabel } from './view.ts';

test('every code of the fixed vocabularies has a sentence (never a bare key) in English', () => {
  useLocale('en');
  for (const code of analyticsErrorCodes) assert.ok(!storedErrorText(code).startsWith('analytics:'), code);
  for (const code of coverageNoteCodes) assert.ok(!noteText({ code, message: '' }).startsWith('analytics:'), code);
  for (const code of analyticsSetupCodes) assert.ok(!setupSentence(code).startsWith('analytics:'), code);
  for (const step of analyticsNextSteps) assert.ok(!stepAction(step).label.startsWith('analytics:'), step);
});

test('formatDay names a day, a day with its year and a month in the active language, from the text of the date', () => {
  useLocale('en');
  assert.equal(formatDay('2026-11-17'), 'Nov 17');
  assert.equal(formatDay('2026-11-17', true), 'Nov 17, 2026');
  assert.equal(formatDay('2026-10'), 'Oct 2026');
  assert.equal(formatDay('not a day'), 'not a day');
  useLocale('de');
  assert.match(formatDay('2026-11-17', true), /17\.? ?Nov\.? 2026/);
  assert.match(formatDay('2026-10'), /Okt\.? 2026/);
  useLocale('en');
});

test('sentences with a day count use the plural form of the language', () => {
  useLocale('en');
  assert.equal(deltaLine({ kind: 'flat' }, 1), 'About the same as the previous day');
  assert.equal(deltaLine({ kind: 'flat' }, 28), 'About the same as the previous 28 days');
  assert.match(lagText('play_vitals', 1), /up to 1 day$/);
  useLocale('fr');
  assert.equal(deltaLine({ kind: 'flat' }, 28), 'À peu près identique aux 28 jours précédents');
  assert.equal(deltaLine({ kind: 'flat' }, 1), 'À peu près identique au jour précédent');
  assert.equal(t('analytics:state.ready'), 'Prêt');
  useLocale('en');
});

test('a series is named by its metric in the active language, and by the API label when the metric is unknown', () => {
  useLocale('es');
  assert.equal(metricLabel('impressions', 'Impressions'), 'Impresiones');
  assert.equal(metricLabel('something_new', 'Something new'), 'Something new');
  assert.equal(seriesLabel({ id: 'product_page_conversion', metric: 'product_page_conversion', label: 'x', source: 'play_reports' }), 'Conversión de la ficha de la tienda');
  useLocale('en');
});
