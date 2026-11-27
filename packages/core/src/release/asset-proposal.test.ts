import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultSelection,
  graphicsItemId,
  orderIssues,
  type ProposalIssue,
  type ProposalItem,
  selectedWithErrors,
  summarizeProposal,
  textItemId,
} from './asset-proposal.ts';

const issue = (id: string, severity: ProposalIssue['severity']): ProposalIssue => ({
  id,
  itemId: null,
  source: 'listing_check',
  severity,
  code: id,
  locale: null,
  field: null,
  params: {},
  message: null,
});
const text = (field: string, hasErrors: boolean, locale = 'en-US'): ProposalItem => ({
  id: textItemId(locale, field),
  kind: 'text',
  locale,
  field,
  before: null,
  after: 'x',
  hasErrors,
});

test('ids are stable and say what they are', () => {
  assert.equal(textItemId('en-US', 'keywords'), 'text:en-US:keywords');
  assert.equal(
    graphicsItemId('de-DE', 'screenshot:iphone_6_5'),
    'graphics:de-DE:screenshot:iphone_6_5',
  );
});

test('errors come first and the order inside a severity is kept', () => {
  assert.deepEqual(
    orderIssues([
      issue('t', 'tip'),
      issue('w1', 'warning'),
      issue('e1', 'error'),
      issue('w2', 'warning'),
      issue('e2', 'error'),
    ]).map((i) => i.id),
    ['e1', 'e2', 'w1', 'w2', 't'],
  );
});

test('the default selection leaves the items with errors out; they need a confirmation', () => {
  const items = [
    text('keywords', true),
    text('description', false),
    text('promotional_text', false, 'de-DE'),
  ];
  assert.deepEqual(defaultSelection(items), [
    'text:en-US:description',
    'text:de-DE:promotional_text',
  ]);
  assert.deepEqual(selectedWithErrors(items, ['text:en-US:keywords', 'text:en-US:description']), [
    'text:en-US:keywords',
  ]);
});

test('the summary counts texts, languages, graphics and findings', () => {
  const s = summarizeProposal(
    [text('a', false), text('b', false, 'de-DE'), text('c', false)],
    [issue('e', 'error'), issue('w', 'warning'), issue('t', 'tip'), issue('t2', 'tip')],
  );
  assert.deepEqual(s, { texts: 3, locales: 2, graphics: 0, errors: 1, warnings: 1, tips: 2 });
});

test('defaultSelection never ticks an item that would add a language to the store draft', () => {
  const item = (id: string, newLanguage?: boolean): ProposalItem =>
    ({
      id,
      kind: 'text',
      locale: 'fr-FR',
      field: 'description',
      before: null,
      after: 'x',
      hasErrors: false,
      ...(newLanguage ? { newLanguage } : {}),
    }) as ProposalItem;
  assert.deepEqual(defaultSelection([item('a'), item('b', true)]), ['a']);
});
