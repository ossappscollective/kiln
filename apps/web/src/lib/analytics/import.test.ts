import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EnablePreview, ImportPlan, ImportPreview } from './analytics.ts';
import {
  canConfirmEnable,
  canConfirmImport,
  checkImportFile,
  classifyEnableError,
  confirmationMatches,
  describeStep,
  ENABLE_PHRASE,
  enableDecision,
  type ImportState,
  idleImport,
  importErrorText,
  importedText,
  importStep,
  MAX_IMPORT_BYTES,
  previewFacts,
  previewNotes,
  sampleTable,
} from './import.ts';
import { ApiError } from '../api.ts';

const preview = (
  steps: EnablePreview['plan']['steps'],
  over: Partial<EnablePreview> = {},
  roleCheck = 'ok',
): EnablePreview => ({
  plan: { roleCheck, steps, willSend: [], notes: [] },
  confirmHash: 'hash-1',
  canCreate: true,
  ...over,
});

const plan = (over: Partial<ImportPlan> = {}): ImportPlan => ({
  source: 'apple_analytics',
  report: { kind: 'app_store_engagement', label: 'App Store engagement' },
  platform: 'ios',
  stats: { rowsRead: 1200, rowsUsed: 1100, rowsUnreadable: 3, rowsFiltered: 97 },
  dateFrom: '2026-10-01',
  dateTo: '2026-10-31',
  days: 31,
  points: 62,
  metrics: [
    { metric: 'impressions', label: 'Impressions', days: 31, total: 51234 },
    { metric: 'product_page_conversion', label: 'Conversion', days: 31, total: null },
  ],
  sample: [],
  notes: [],
  ...over,
});

const previewed = (p: ImportPlan = plan(), confirmHash = 'h-9'): ImportPreview => ({
  plan: p,
  confirmHash,
});

// ---- enable ----

test('the enable flow shows what will be created and needs a ticked box and the typed word', () => {
  const create = preview([
    { accessType: 'ONGOING', action: 'create' },
    { accessType: 'ONE_TIME_SNAPSHOT', action: 'create' },
  ]);
  assert.deepEqual(enableDecision(create), { kind: 'confirm', creates: 2, adopts: 0 });
  assert.equal(canConfirmEnable(create, false, ENABLE_PHRASE), false);
  assert.equal(canConfirmEnable(create, true, ''), false);
  assert.equal(canConfirmEnable(create, true, 'enabled'), false);
  assert.equal(canConfirmEnable(create, true, ' enable '), true);
  assert.equal(canConfirmEnable(create, true, ENABLE_PHRASE), true);
  assert.equal(canConfirmEnable(null, true, ENABLE_PHRASE), false);
  assert.equal(canConfirmEnable({ ...create, confirmHash: '' }, true, ENABLE_PHRASE), false);
  assert.equal(confirmationMatches('Enable'), false);
});

test('adopting an existing request still needs a confirmation; nothing to do needs none', () => {
  assert.deepEqual(enableDecision(preview([{ accessType: 'ONGOING', action: 'adopt' }])), {
    kind: 'confirm',
    creates: 0,
    adopts: 1,
  });
  assert.deepEqual(enableDecision(preview([{ accessType: 'ONGOING', action: 'exists' }])), {
    kind: 'nothing',
  });
  assert.equal(
    canConfirmEnable(preview([{ accessType: 'ONGOING', action: 'exists' }]), true, ENABLE_PHRASE),
    false,
  );
});

test('a key without the role is offered the file import instead of a button that cannot work', () => {
  const noRole = preview(
    [{ accessType: 'ONGOING', action: 'create' }],
    { canCreate: false },
    'role_required',
  );
  assert.deepEqual(enableDecision(noRole), { kind: 'import_instead' });
  assert.equal(canConfirmEnable(noRole, true, ENABLE_PHRASE), false);
  assert.deepEqual(
    enableDecision(preview([{ accessType: 'ONGOING', action: 'create' }], {}, 'role_required')),
    { kind: 'import_instead' },
  );
});

test('steps are described in words that say whether anything is created at Apple', () => {
  assert.match(
    describeStep({ accessType: 'ONGOING', action: 'create' }),
    /Create an ongoing report request/,
  );
  assert.match(describeStep({ accessType: 'ONE_TIME_SNAPSHOT', action: 'create' }), /one a month/);
  assert.match(describeStep({ accessType: 'ONGOING', action: 'adopt' }), /Nothing is created/);
  assert.match(describeStep({ accessType: 'ONGOING', action: 'exists' }), /Nothing to do/);
  assert.match(
    describeStep({ accessType: 'ONGOING', action: 'whatever' }),
    /ongoing report request step/,
  );
});

test('enable errors are sorted into what the dialog does next', () => {
  const body = {
    plan: {
      roleCheck: 'ok',
      steps: [{ accessType: 'ONGOING', action: 'exists' }],
      willSend: [],
      notes: [],
    },
    confirmHash: 'new',
    canCreate: true,
  };
  const changed = classifyEnableError(new ApiError(409, 'plan_changed', 'x', undefined, body));
  assert.equal(changed.kind, 'plan_changed');
  assert.equal(changed.kind === 'plan_changed' && changed.preview?.confirmHash, 'new');
  const noBody = classifyEnableError(new ApiError(409, 'plan_changed', 'x'));
  assert.equal(noBody.kind === 'plan_changed' && noBody.preview, null);
  assert.equal(
    classifyEnableError(new ApiError(422, 'analytics_role_required', 'RAW')).kind,
    'role_required',
  );
  assert.equal(
    classifyEnableError(new ApiError(409, 'analytics_disabled', 'RAW')).kind,
    'disabled',
  );
  const other = classifyEnableError(new ApiError(502, 'apple_failed', 'RAW STORE TEXT'));
  assert.equal(other.kind, 'other');
  assert.equal(other.message.includes('RAW STORE TEXT'), false);
  assert.equal(classifyEnableError(new Error('boom')).kind, 'other');
});

// ---- import ----

test('a file is checked before upload: empty, too big, a very long name', () => {
  assert.equal(checkImportFile({ name: 'a.csv', size: 1000 }), '');
  assert.equal(checkImportFile({ name: 'a.csv', size: 0 }), 'The file is empty.');
  assert.equal(
    checkImportFile({ name: 'a.csv', size: MAX_IMPORT_BYTES + 1 }),
    'The file is larger than 10 MiB.',
  );
  assert.equal(checkImportFile({ name: 'a.csv', size: MAX_IMPORT_BYTES }), '');
  assert.match(checkImportFile({ name: 'x'.repeat(201), size: 5 }), /200 characters/);
});

test('import goes idle, checking, preview, importing, done, and a late answer cannot jump a step', () => {
  let s: ImportState = idleImport;
  s = importStep(s, { type: 'previewed', preview: previewed() });
  assert.equal(s.phase, 'idle');
  s = importStep(s, { type: 'confirm' });
  assert.equal(s.phase, 'idle');
  s = importStep(s, { type: 'pick', fileName: 'a.csv' });
  assert.deepEqual(s, { phase: 'checking', fileName: 'a.csv' });
  s = importStep(s, { type: 'pick', fileName: 'b.csv' });
  assert.equal(s.phase === 'checking' && s.fileName, 'a.csv');
  s = importStep(s, { type: 'confirm' });
  assert.equal(s.phase, 'checking');
  s = importStep(s, { type: 'previewed', preview: previewed() });
  assert.equal(s.phase, 'preview');
  assert.equal(s.phase === 'preview' && s.confirmHash, 'h-9');
  s = importStep(s, {
    type: 'imported',
    result: { source: 'x', points: 1, written: 1, unchanged: 0, dateFrom: null, dateTo: null },
  });
  assert.equal(s.phase, 'preview');
  s = importStep(s, { type: 'confirm' });
  assert.equal(s.phase, 'importing');
  s = importStep(s, { type: 'reset' });
  assert.equal(s.phase, 'importing');
  s = importStep(s, { type: 'pick', fileName: 'c.csv' });
  assert.equal(s.phase, 'importing');
  s = importStep(s, {
    type: 'imported',
    result: {
      source: 'apple_analytics',
      points: 62,
      written: 62,
      unchanged: 0,
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
    },
  });
  assert.equal(s.phase, 'done');
  assert.equal(importStep(s, { type: 'reset' }).phase, 'idle');
});

test('a file with nothing to store cannot be confirmed', () => {
  const empty: ImportState = importStep(
    importStep(idleImport, { type: 'pick', fileName: 'a.csv' }),
    { type: 'previewed', preview: previewed(plan({ points: 0 })) },
  );
  assert.equal(empty.phase, 'preview');
  assert.equal(canConfirmImport(empty), false);
  assert.equal(importStep(empty, { type: 'confirm' }).phase, 'preview');
  const noHash = importStep(importStep(idleImport, { type: 'pick', fileName: 'a.csv' }), {
    type: 'previewed',
    preview: previewed(plan(), ''),
  });
  assert.equal(canConfirmImport(noHash), false);
  assert.equal(canConfirmImport(idleImport), false);
});

test('a failure belongs to the step it happened in; an answer for another step is ignored', () => {
  const checking = importStep(idleImport, { type: 'pick', fileName: 'a.csv' });
  const failed = importStep(checking, {
    type: 'failed',
    during: 'preview',
    code: 'unsupported_report',
    message: 'This report cannot be read.',
  });
  assert.deepEqual(failed, {
    phase: 'error',
    fileName: 'a.csv',
    during: 'preview',
    code: 'unsupported_report',
    message: 'This report cannot be read.',
  });
  assert.equal(
    importStep(checking, { type: 'failed', during: 'import', code: 'x', message: 'x' }).phase,
    'checking',
  );
  assert.equal(
    importStep(idleImport, { type: 'failed', during: 'preview', code: 'x', message: 'x' }).phase,
    'idle',
  );
  assert.equal(importStep(failed, { type: 'reset' }).phase, 'idle');
  const again = importStep(failed, { type: 'pick', fileName: 'b.csv' });
  assert.equal(again.phase, 'checking');
});

test('import errors are fixed sentences and carry the code', () => {
  const e = importErrorText(new ApiError(413, 'payload_too_large', 'RAW'));
  assert.deepEqual(e, { code: 'payload_too_large', message: 'The file is larger than 10 MiB.' });
  assert.equal(
    importErrorText(new ApiError(409, 'confirm_mismatch', 'RAW')).message,
    'This is not the file that was checked. Choose the file again.',
  );
  assert.equal(importErrorText(new Error('boom')).code, '');
});

test('the preview says which report, which dates, how many rows were read, left out and unreadable, and what would be stored', () => {
  const f = previewFacts(plan());
  assert.equal(f.report, 'App Store engagement');
  assert.equal(f.range, 'Oct 1, 2026 to Oct 31, 2026');
  assert.deepEqual(f.rows, [
    '1,200 rows read, 1,100 used',
    '97 left out because they belong to another app or platform',
    '3 could not be read',
  ]);
  assert.equal(f.days, '31 days');
  assert.deepEqual(f.metrics, [
    { label: 'Impressions', days: 31, total: '51,234' },
    { label: 'Conversion', days: 31, total: 'Average, not a total' },
  ]);
  assert.equal(f.willStore, '62 values for 31 days can be stored.');
  const none = previewFacts(
    plan({
      points: 0,
      dateFrom: null,
      dateTo: null,
      days: 0,
      stats: { rowsRead: 5, rowsUsed: 0, rowsUnreadable: 0, rowsFiltered: 0 },
    }),
  );
  assert.equal(none.range, 'No dates found');
  assert.equal(none.willStore, 'Nothing in this file can be stored.');
  assert.deepEqual(none.rows, ['5 rows read, 0 used']);
  assert.equal(
    previewFacts(plan({ dateFrom: '2026-10-05', dateTo: '2026-10-05', days: 1 })).range,
    'Oct 5, 2026',
  );
});

test('the sample table keeps rows of the expected shape, labels them, and shows at most six', () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({
    date: `2026-10-0${i + 1}`,
    metric: 'impressions',
    value: 1000 + i,
  }));
  const t = sampleTable([
    ...rows,
    null,
    'text',
    { date: 1 },
    { date: '2026-10-01', metric: 'impressions', value: 'x' },
  ]);
  assert.deepEqual(t.columns, ['Date', 'Metric', 'Dimension', 'Value']);
  assert.equal(t.rows.length, 6);
  assert.deepEqual(t.rows[0]?.slice(2), ['Total', '1,000']);
  const dim = sampleTable([
    {
      date: '2026-10-01',
      metric: 'sessions',
      value: 2.5,
      dimension: { type: 'app_version', value: '2.4.1' },
    },
  ]);
  assert.deepEqual(dim.rows[0]?.slice(2), ['app version: 2.4.1', '2.5']);
  assert.deepEqual(sampleTable([]).rows, []);
});

test('preview notes are plain text, trimmed in length', () => {
  assert.deepEqual(previewNotes(['One.', '', 3, null, ' ']), ['One.']);
  assert.equal(previewNotes(['x'.repeat(400)])[0]?.length, 300);
});

test('the line after an import says what was stored, and that a repeat stores nothing', () => {
  assert.equal(
    importedText({
      source: 'a',
      points: 62,
      written: 62,
      unchanged: 0,
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
    }),
    'Stored 62 values for Oct 1, 2026 to Oct 31, 2026.',
  );
  assert.equal(
    importedText({
      source: 'a',
      points: 62,
      written: 40,
      unchanged: 22,
      dateFrom: null,
      dateTo: null,
    }),
    'Stored 40 values, 22 were already there.',
  );
  assert.match(
    importedText({
      source: 'a',
      points: 62,
      written: 0,
      unchanged: 62,
      dateFrom: null,
      dateTo: null,
    }),
    /^Nothing new was stored/,
  );
});
