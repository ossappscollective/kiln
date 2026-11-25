import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  amountProblemText,
  bpText,
  changedRows,
  classifyPriceFailure,
  confirmationPhrase,
  hasInvalid,
  issueText,
  limitsOf,
  moneyChange,
  neededAcks,
  type PriceResultDetail,
  perCurrency,
  priceBlock,
  readAmount,
  rowChange,
  samePhrase,
  stageLines,
  subscriberRules,
  verificationText,
} from './prices.ts';
import type { PriceWriteView, StagedPriceChange } from './types.ts';

const row = (over: Partial<Parameters<typeof rowChange>[0]> = {}) => ({
  territory: 'USA',
  currency: 'USD',
  current: '499',
  input: '',
  pricePointId: null,
  ...over,
});

test('an amount is read exactly as typed and never rounded', () => {
  assert.deepEqual(readAmount('4.99', 'USD'), { ok: true, minor: '499' });
  assert.deepEqual(readAmount('4,99', 'EUR'), { ok: true, minor: '499' });
  assert.deepEqual(readAmount('1,299.00', 'USD'), { ok: true, minor: '129900' });
  assert.deepEqual(readAmount('1,299', 'USD'), { ok: true, minor: '129900' });
  assert.deepEqual(readAmount('500', 'JPY'), { ok: true, minor: '500' });
  assert.deepEqual(readAmount('4.999', 'USD'), { ok: false, problem: 'precision' });
  assert.deepEqual(readAmount('4.5', 'JPY'), { ok: false, problem: 'precision' });
  assert.deepEqual(readAmount('', 'USD'), { ok: false, problem: 'empty' });
  assert.deepEqual(readAmount('abc', 'USD'), { ok: false, problem: 'format' });
  assert.deepEqual(readAmount('-1', 'USD'), { ok: false, problem: 'format' });
  assert.deepEqual(readAmount('0.00', 'USD'), { ok: false, problem: 'zero' });
  assert.match(amountProblemText('precision', 'USD'), /USD.*does not round/);
});

test('a row: empty and equal are unchanged, an invalid one is flagged, a change carries its percent and direction', () => {
  assert.deepEqual(rowChange(row()), { state: 'unchanged' });
  assert.deepEqual(rowChange(row({ input: '4.99' })), { state: 'unchanged' });
  assert.deepEqual(rowChange(row({ input: 'x' })), { state: 'invalid', problem: 'format' });
  const up = rowChange(row({ input: '5.99' }));
  assert.equal(up.state === 'changed' && up.minor, '599');
  assert.equal(up.state === 'changed' && up.bp, 2004);
  assert.equal(up.state === 'changed' && up.direction, 'increase');
  assert.equal(bpText(2004), '+20.04%');
  const down = rowChange(row({ input: '3.99' }));
  assert.equal(down.state === 'changed' && down.direction, 'decrease');
  const rows = [
    row({ input: '5.99' }),
    row({ territory: 'GBR', currency: 'GBP', current: '399' }),
    row({ territory: 'DEU', currency: 'EUR', input: 'z' }),
  ];
  assert.equal(changedRows(rows).length, 1);
  assert.equal(hasInvalid(rows), true);
});

test('only changed rows are staged; the price point travels for Apple and never for Google Play', () => {
  const rows = [
    row({ input: '5.99', pricePointId: 'pp1' }),
    row({ territory: 'GBR', currency: 'GBP', current: '399' }),
  ];
  assert.deepEqual(stageLines(rows, true), [
    { territory: 'USA', newAmount: '599', pricePointId: 'pp1' },
  ]);
  assert.deepEqual(stageLines(rows, false), [{ territory: 'USA', newAmount: '599' }]);
});

test('money text: each amount in its own currency, never a sum', () => {
  assert.equal(moneyChange('499', '599', 'USD'), '$4.99 to $5.99');
  const lines: StagedPriceChange['lines'] = [
    {
      territory: 'USA',
      currency: 'USD',
      before: '1',
      after: '2',
      percentBp: 10000,
      direction: 'increase',
      pricePointId: null,
    },
    {
      territory: 'DEU',
      currency: 'EUR',
      before: '2',
      after: '1',
      percentBp: -5000,
      direction: 'decrease',
      pricePointId: null,
    },
    {
      territory: 'CAN',
      currency: 'USD',
      before: '2',
      after: '1',
      percentBp: -5000,
      direction: 'decrease',
      pricePointId: null,
    },
  ];
  assert.deepEqual(perCurrency(lines), [
    { currency: 'USD', up: 1, down: 1 },
    { currency: 'EUR', up: 0, down: 1 },
  ]);
});

test('guard rails shown ahead of the server: a big change in percent, a big change in money, a changed subscriber rule', () => {
  const limits = limitsOf(null);
  const base = {
    store: 'appstoreconnect',
    productId: 'p',
    kind: 'subscription' as const,
    rule: 'preserve' as const,
    limits,
  };
  assert.deepEqual(neededAcks({ ...base, rows: [row({ input: '5.99' })] }), []);
  assert.deepEqual(neededAcks({ ...base, rows: [row({ input: '9.99' })] }), ['large_change']);
  assert.deepEqual(neededAcks({ ...base, rows: [row({ current: '49900', input: '699.00' })] }), [
    'large_absolute',
  ]);
  assert.deepEqual(neededAcks({ ...base, rule: 'apply', rows: [row({ input: '5.99' })] }), [
    'existing_subscribers',
  ]);
  assert.deepEqual(
    neededAcks({
      ...base,
      kind: 'consumable',
      rule: 'not_applicable',
      rows: [row({ input: '5.99' })],
    }),
    [],
  );
  const view = {
    limits: { relativeChangePercent: 10, absoluteChangeMajor: 100, maxTerritories: 5 },
  } as PriceWriteView;
  assert.deepEqual(
    neededAcks({ ...base, limits: limitsOf(view), rows: [row({ input: '5.99' })] }),
    ['large_change'],
  );
});

test('existing subscribers: preserve first; the choices depend on the store and on the kind', () => {
  assert.deepEqual(subscriberRules('appstoreconnect', 'subscription'), ['preserve', 'apply']);
  assert.deepEqual(subscriberRules('googleplay', 'subscription'), [
    'preserve',
    'opt_in',
    'opt_out',
  ]);
  assert.deepEqual(subscriberRules('googleplay', 'consumable'), ['not_applicable']);
});

test('the typed phrase names the number of products and the largest change, rounded up', () => {
  assert.equal(
    confirmationPhrase([{ largestBp: 2004 }, { largestBp: 100 }]),
    'CHANGE 2 PRICES MAX 21%',
  );
  assert.equal(confirmationPhrase([{ largestBp: 1000 }]), 'CHANGE 1 PRICE MAX 10%');
  assert.equal(samePhrase('  change 1 price max 10% ', 'CHANGE 1 PRICE MAX 10%'), false);
  assert.equal(samePhrase('CHANGE  1 PRICE   MAX 10%', 'CHANGE 1 PRICE MAX 10%'), true);
});

test('why editing is unavailable, in the order the server checks', () => {
  const view = (reason: PriceWriteView['reason']): PriceWriteView => ({
    enabled: reason === null,
    envName: 'KILN_PRICE_WRITES_ENABLED',
    workspaceEnabled: reason !== 'workspace_setting',
    reason,
    limits: { relativeChangePercent: 50, absoluteChangeMajor: 100, maxTerritories: 50 },
    staged: [],
  });
  assert.equal(priceBlock(view(null), 'admin'), null);
  assert.equal(priceBlock(null, 'owner'), null);
  assert.equal(priceBlock(view(null), 'viewer')?.kind, 'role');
  assert.equal(priceBlock(view(null), 'member')?.kind, 'role');
  assert.equal(priceBlock(view('server_switch'), 'admin')?.kind, 'server');
  assert.match(
    priceBlock(view('server_switch'), 'admin')?.message ?? '',
    /KILN_PRICE_WRITES_ENABLED/,
  );
  assert.equal(priceBlock(view('workspace_setting'), 'admin')?.kind, 'workspace');
  assert.match(
    priceBlock(view('workspace_setting'), 'admin')?.message ?? '',
    /prices\.writeEnabled/,
  );
});

test('failures: the stale snapshot, the switch, a refused change with its issues, and a network error', () => {
  assert.equal(classifyPriceFailure(new ApiError(409, 'stale_snapshot', 'x')).kind, 'stale');
  assert.equal(
    classifyPriceFailure(new ApiError(409, 'price_writes_disabled', 'Off')).kind,
    'disabled',
  );
  const refused = classifyPriceFailure(
    new ApiError(422, 'invalid_price', 'No.', undefined, {
      issues: [
        {
          code: 'amount_not_price_point',
          territory: 'USA',
          detail: { nearest: [{ id: 'a', territory: 'USA', currency: 'USD', amount: '499' }] },
        },
      ],
    }),
  );
  assert.equal(refused.kind, 'invalid');
  assert.equal(refused.issues.length, 1);
  assert.match(issueText(refused.issues[0]!, 'USD'), /^USA: .*\$4\.99/);
  assert.match(issueText({ code: 'brand_new_code' }), /error/);
  assert.equal(classifyPriceFailure(new Error('x')).kind, 'other');
});

test('after a send: "confirmed by the store" only when the read back agrees; otherwise what the store shows', () => {
  const lines = [
    { territory: 'USA', currency: 'USD', before: '499', after: '599', outcome: 'applied' },
  ];
  const base: PriceResultDetail = {
    productId: 'p',
    lines,
    verification: 'confirmed',
    mismatches: [],
  };
  assert.equal(verificationText(base), 'Confirmed by the store');
  assert.equal(
    verificationText({
      ...base,
      verification: 'store_shows',
      mismatches: [{ territory: 'USA', expected: '599', actual: '499' }],
    }),
    'Store shows $4.99 for USA, not $5.99.',
  );
  assert.match(verificationText({ ...base, verification: 'unverified' }), /Not verified/);
  assert.equal(verificationText({ ...base, verification: 'not_sent' }), 'Nothing was sent.');
});
