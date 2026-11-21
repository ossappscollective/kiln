import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  changeSummary,
  classifyProductFailure,
  groupPrices,
  kindLabel,
  MAX_PRODUCT_DESCRIPTION,
  MAX_PRODUCT_NAME,
  normalizeText,
  periodLabel,
  priceCountText,
  priceText,
  stateBadge,
  syncLine,
  textsDiffer,
  validateTexts,
} from './products.ts';
import type {
  ProductLocalizationPreview,
  ProductPrice,
  ProductState,
  ProductSyncStatus,
} from './types.ts';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const price = (over: Partial<ProductPrice> = {}): ProductPrice => ({
  planId: null,
  territory: 'USA',
  currency: 'USD',
  amount: '499',
  display: '4.99',
  ...over,
});
const sync = (over: Partial<ProductSyncStatus> = {}): ProductSyncStatus => ({
  lastAttemptAt: NOW - 60_000,
  lastSyncedAt: NOW - 60_000,
  lastError: null,
  failures: 0,
  productCount: 3,
  complete: true,
  warnings: [],
  ...over,
});

test('every kind and every state has words, and a state is never a tone alone', () => {
  assert.equal(kindLabel('consumable'), 'Consumable');
  assert.equal(kindLabel('non_consumable'), 'Non-consumable');
  assert.equal(kindLabel('subscription'), 'Subscription');
  const states: ProductState[] = [
    'draft',
    'in_review',
    'action_needed',
    'active',
    'inactive',
    'removed',
    'unknown',
  ];
  const labels = states.map((s) => stateBadge(s).label);
  assert.equal(new Set(labels).size, states.length, 'each state reads differently');
  for (const s of states) assert.ok(stateBadge(s).label.length > 0);
  assert.equal(stateBadge('active').tone, 'ok');
  assert.equal(stateBadge('action_needed').tone, 'bad');
  assert.equal(stateBadge('nonsense' as ProductState).label, 'Unknown');
});

test('billing periods read as words from both stores; an unknown one is shown as written', () => {
  assert.equal(periodLabel('ONE_MONTH'), 'Monthly');
  assert.equal(periodLabel('P1M'), 'Monthly');
  assert.equal(periodLabel('P1Y'), 'Yearly');
  assert.equal(periodLabel('P5D'), 'P5D');
  assert.equal(periodLabel(null), null);
  assert.equal(periodLabel(''), null);
});

test('prices read with their currency, and no price says so', () => {
  assert.equal(priceText(price()), '4.99 USD');
  assert.equal(priceText(null), 'No price yet');
  assert.equal(priceCountText(0), 'No territories');
  assert.equal(priceCountText(1), '1 territory');
  assert.equal(priceCountText(175), '175 territories');
});

test('prices group by plan in the order the plans first appear', () => {
  const groups = groupPrices([
    price({ planId: 'monthly', territory: 'US' }),
    price({ planId: 'yearly', territory: 'US' }),
    price({ planId: 'monthly', territory: 'DE' }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.planId, g.label, g.prices.length]),
    [
      ['monthly', 'Plan monthly', 2],
      ['yearly', 'Plan yearly', 1],
    ],
  );
  const apple = groupPrices([price(), price({ territory: 'DEU' })]);
  assert.equal(apple.length, 1);
  assert.equal(apple[0]?.label, 'Prices');
  assert.deepEqual(groupPrices([]), []);
});

test('the sync line says whether it was read, when, and what a failure left in place', () => {
  assert.equal(syncLine(null, NOW).text, 'Not read from the store yet.');
  assert.equal(syncLine(sync({ lastSyncedAt: null, lastAttemptAt: null }), NOW).tone, 'neutral');
  const good = syncLine(sync(), NOW);
  assert.equal(good.text, 'Read 1 minute ago.');
  assert.equal(good.tone, 'neutral');
  const partial = syncLine(sync({ complete: false }), NOW);
  assert.equal(partial.tone, 'warn');
  assert.match(partial.text, /not complete/);
  const failed = syncLine(sync({ lastError: 'No access.', failures: 3 }), NOW);
  assert.equal(failed.tone, 'bad');
  assert.match(failed.text, /3 syncs in a row failed/);
  assert.match(failed.text, /Showing what was read 1 minute ago\./);
  assert.match(failed.text, /No access\./);
  const first = syncLine(sync({ lastError: 'No access.', failures: 1, lastSyncedAt: null }), NOW);
  assert.match(first.text, /Nothing was read yet\./);
  assert.doesNotMatch(first.text, /in a row/);
});

test('texts are normalized the way the server does, and checked before a round trip', () => {
  assert.equal(normalizeText('  a\r\nb  '), 'a\nb');
  assert.deepEqual(validateTexts('Coins', 'A pile'), {});
  assert.deepEqual(validateTexts('Coins', ''), {}, 'an empty description is for the store to judge');
  assert.ok(validateTexts('   ', 'x').name);
  assert.ok(validateTexts('a\nb', 'x').name);
  assert.ok(validateTexts('a\u0000b', 'x').name);
  assert.ok(validateTexts('n'.repeat(MAX_PRODUCT_NAME + 1), 'x').name);
  assert.deepEqual(validateTexts('n'.repeat(MAX_PRODUCT_NAME), 'x'), {});
  assert.ok(validateTexts('ok', 'd'.repeat(MAX_PRODUCT_DESCRIPTION + 1)).description);
  assert.ok(validateTexts('ok', 'a\u0007b').description);
  assert.deepEqual(validateTexts('ok', 'line one\nline two'), {}, 'a description may hold line breaks');
});

test('a draft differs from the stored texts only after normalizing', () => {
  const stored = { name: 'Coins', description: 'A pile' };
  assert.equal(textsDiffer({ name: ' Coins ', description: 'A pile\r\n' }, stored), false);
  assert.equal(textsDiffer({ name: 'Coins', description: 'Two piles' }, stored), true);
  assert.equal(textsDiffer({ name: 'More coins', description: 'A pile' }, stored), true);
});

test('a preview is summarized in one sentence', () => {
  const preview = (changes: { name: boolean; description: boolean }) =>
    ({ locale: 'de-DE', changes }) as ProductLocalizationPreview;
  assert.equal(changeSummary(preview({ name: true, description: false })), 'Changes the display name for de-DE.');
  assert.equal(
    changeSummary(preview({ name: true, description: true })),
    'Changes the display name and the description for de-DE.',
  );
  assert.equal(
    changeSummary(preview({ name: false, description: false })),
    'The store already shows these texts.',
  );
});

test('failures: each fixed code has its own kind and says whether anything changed', () => {
  const err = (status: number, code: string, body: Record<string, unknown> = {}, retry?: number) =>
    new ApiError(status, code, String(body.message ?? 'Server words.'), retry, { error: code, ...body });
  const off = classifyProductFailure(err(409, 'store_product_write_disabled'), 'change');
  assert.equal(off.kind, 'disabled');
  assert.match(off.message, /KILN_STORE_PRODUCT_WRITE_ENABLED=true/);
  assert.match(off.message, /Nothing was changed/);
  assert.equal(classifyProductFailure(err(403, 'forbidden'), 'change').kind, 'forbidden');
  assert.equal(classifyProductFailure(err(409, 'write_in_progress'), 'change').kind, 'busy');
  assert.equal(classifyProductFailure(err(422, 'no_change'), 'change').kind, 'no_change');
  const missing = classifyProductFailure(err(422, 'locale_not_found'), 'read');
  assert.equal(missing.kind, 'locale_missing');
  assert.doesNotMatch(missing.message, /Nothing was changed/, 'a read changes nothing to report');
  const unknown = classifyProductFailure(err(409, 'outcome_unknown'), 'change');
  assert.equal(unknown.kind, 'outcome_unknown');
  assert.match(unknown.message, /Look at the product in the store/);

  const drift = classifyProductFailure(
    err(409, 'state_changed', {
      current: { name: 'Now', description: 'Edited' },
      previewHash: 'a'.repeat(64),
    }),
    'change',
  );
  assert.equal(drift.kind, 'state_changed');
  if (drift.kind === 'state_changed') {
    assert.deepEqual(drift.current, { name: 'Now', description: 'Edited' });
    assert.equal(drift.previewHash, 'a'.repeat(64));
  }
  const bare = classifyProductFailure(err(409, 'state_changed'), 'change');
  if (bare.kind === 'state_changed') {
    assert.equal(bare.current, null);
    assert.equal(bare.previewHash, null);
  }

  const step = classifyProductFailure(err(403, 'step_up_required'), 'change');
  assert.match(step.message, /confirmation/);
  const timeout = classifyProductFailure(err(504, 'timeout'), 'change');
  assert.match(timeout.message, /not known whether/);
  assert.match(classifyProductFailure(err(504, 'timeout'), 'read').message, /Try again/);
  assert.equal(classifyProductFailure(err(422, 'store_rejected', { message: 'Name too long.' }), 'change').message, 'Name too long. Nothing was changed.');
  assert.equal(classifyProductFailure(err(502, 'store_unavailable', { message: 'Down.' }), 'change').message, 'Down.');
  const offline = classifyProductFailure(new Error('x'), 'change');
  assert.match(offline.message, /not known whether anything was changed/);
  assert.match(classifyProductFailure(new Error('x'), 'read').message, /try again/);
});
