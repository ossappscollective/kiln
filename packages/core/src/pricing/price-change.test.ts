import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changeBp,
  minorToDecimal,
  minorToPlayMoney,
  nearestPricePoints,
  parseDecimalMinor,
  percentLabel,
  playMoneyToMinor,
  type PriceChange,
  type PriceContext,
  priceConfirmationPhrase,
  requiredAcknowledgements,
  samePhrase,
  staleLines,
  summarizePriceChange,
  validatePriceChange,
} from './price-change.ts';

const points = [
  { id: 'p1', territory: 'USA', currency: 'USD', amount: '499' },
  { id: 'p2', territory: 'USA', currency: 'USD', amount: '599' },
  { id: 'p3', territory: 'USA', currency: 'USD', amount: '699' },
  { id: 'p4', territory: 'USA', currency: 'USD', amount: '999' },
  { id: 'j1', territory: 'JPN', currency: 'JPY', amount: '600' },
];
const apple = (over: Partial<PriceChange> = {}): PriceChange => ({
  store: 'appstoreconnect',
  productId: 'pro.monthly',
  kind: 'subscription',
  planId: null,
  baseTerritory: 'USA',
  lines: [
    {
      territory: 'USA',
      currency: 'USD',
      currentAmount: '499',
      newAmount: '599',
      pricePointId: 'p2',
    },
  ],
  effectiveDate: '2026-12-01',
  existingSubscribers: 'preserve',
  acknowledgements: [],
  ...over,
});
const ctx: PriceContext = {
  current: [
    { territory: 'USA', currency: 'USD', amount: '499' },
    { territory: 'JPN', currency: 'JPY', amount: '500' },
  ],
  pricePoints: points,
  today: '2026-11-24',
};
const codes = (c: PriceChange, x: PriceContext = ctx) =>
  validatePriceChange(c, x).map((i) => i.code);

test('a clean Apple change has no issue', () => assert.deepEqual(codes(apple()), []));

test('amounts are exact: no rounding, no float', () => {
  assert.equal(parseDecimalMinor('4.99', 'USD'), '499');
  assert.equal(parseDecimalMinor('4.999', 'USD'), undefined);
  assert.equal(parseDecimalMinor('500', 'JPY'), '500');
  assert.equal(parseDecimalMinor('500.5', 'JPY'), undefined);
  assert.equal(parseDecimalMinor('1.234', 'KWD'), '1234');
  assert.equal(parseDecimalMinor('4,99', 'USD'), undefined);
  assert.equal(parseDecimalMinor('-1', 'USD'), undefined);
  assert.equal(minorToDecimal('499', 'USD'), '4.99');
  assert.equal(minorToDecimal('5', 'USD'), '0.05');
  assert.equal(minorToDecimal('500', 'JPY'), '500');
});

test('Play Money round trips and refuses extra precision', () => {
  assert.deepEqual(minorToPlayMoney('499', 'USD'), {
    currencyCode: 'USD',
    units: '4',
    nanos: 990000000,
  });
  assert.deepEqual(minorToPlayMoney('500', 'JPY'), { currencyCode: 'JPY', units: '500', nanos: 0 });
  assert.equal(playMoneyToMinor({ currencyCode: 'USD', units: '4', nanos: 990000000 }), '499');
  assert.equal(playMoneyToMinor({ currencyCode: 'USD', units: '4', nanos: 995000000 }), undefined);
  assert.equal(playMoneyToMinor({ currencyCode: 'JPY', units: '500', nanos: 1 }), undefined);
  assert.equal(playMoneyToMinor({ currencyCode: 'USD', units: '-1', nanos: 0 }), undefined);
});

test('percent change in basis points rounds half away from zero', () => {
  assert.equal(changeBp('499', '599'), 2004);
  assert.equal(changeBp('500', '250'), -5000);
  assert.equal(changeBp('0', '5'), undefined);
  assert.equal(percentLabel(2004), '+20.04%');
  assert.equal(percentLabel(-5000), '-50%');
  assert.equal(percentLabel(250), '+2.5%');
});

test('Apple: an amount that is not a price point is refused with the nearest points, never rounded', () => {
  const c = apple({
    lines: [
      {
        territory: 'USA',
        currency: 'USD',
        currentAmount: '499',
        newAmount: '610',
        pricePointId: 'p2',
      },
    ],
  });
  const issues = validatePriceChange(c, ctx);
  assert.ok(issues.some((i) => i.code === 'price_point_mismatch'));
  const miss = issues.find((i) => i.code === 'amount_not_price_point');
  assert.deepEqual(
    miss?.detail?.nearest?.map((p) => p.id),
    ['p2', 'p3', 'p1', 'p4'],
  );
  assert.deepEqual(
    nearestPricePoints(points, 'USA', '600', 2).map((p) => p.id),
    ['p2', 'p3'],
  );
});

test('Apple: price point must exist, belong to the territory and be named', () => {
  const line = { territory: 'USA', currency: 'USD', currentAmount: '499', newAmount: '599' };
  assert.ok(codes(apple({ lines: [line] })).includes('price_point_missing'));
  assert.ok(
    codes(apple({ lines: [{ ...line, pricePointId: 'nope' }] })).includes('price_point_unknown'),
  );
  assert.ok(
    codes(apple({ lines: [{ ...line, pricePointId: 'j1' }] })).includes('price_point_territory'),
  );
});

test('amounts must be positive, whole digits, and below the cap', () => {
  const mk = (n: string) =>
    apple({
      lines: [
        {
          territory: 'USA',
          currency: 'USD',
          currentAmount: '499',
          newAmount: n,
          pricePointId: 'p2',
        },
      ],
    });
  assert.ok(codes(mk('0')).includes('not_positive'));
  assert.ok(codes(mk('-5')).includes('bad_amount'));
  assert.ok(codes(mk('4.99')).includes('bad_amount'));
  assert.ok(codes(mk('99999999')).includes('too_high'));
});

test('currency must match the territory, and no change is not a change', () => {
  const c = apple({
    lines: [
      {
        territory: 'USA',
        currency: 'EUR',
        currentAmount: '499',
        newAmount: '599',
        pricePointId: 'p2',
      },
    ],
  });
  assert.ok(codes(c).includes('currency_mismatch'));
  const same = apple({
    lines: [
      {
        territory: 'USA',
        currency: 'USD',
        currentAmount: '499',
        newAmount: '499',
        pricePointId: 'p1',
      },
    ],
  });
  assert.ok(codes(same).includes('no_change'));
  assert.ok(
    codes(
      apple({
        lines: [
          {
            territory: 'FRA',
            currency: 'EUR',
            currentAmount: '499',
            newAmount: '599',
            pricePointId: 'p2',
          },
        ],
      }),
    ).includes('unknown_territory'),
  );
});

test('a stale current price is refused (at staging and with the live read)', () => {
  const stale = { ...ctx, current: [{ territory: 'USA', currency: 'USD', amount: '399' }] };
  assert.ok(codes(apple(), stale).includes('stale_price'));
  assert.deepEqual(
    staleLines(apple(), [{ territory: 'USA', currency: 'USD', amount: '399' }]).map((i) => i.code),
    ['stale_price'],
  );
  assert.deepEqual(
    staleLines(apple(), [{ territory: 'USA', currency: 'EUR', amount: '499' }]).map((i) => i.code),
    ['currency_mismatch'],
  );
  assert.deepEqual(staleLines(apple(), [{ territory: 'USA', currency: 'USD', amount: '499' }]), []);
});

test('guard rails: over 50% either way, or over the absolute amount, need an acknowledgement', () => {
  const big = apple({
    lines: [
      {
        territory: 'USA',
        currency: 'USD',
        currentAmount: '499',
        newAmount: '999',
        pricePointId: 'p4',
      },
    ],
  });
  assert.deepEqual(requiredAcknowledgements(big), ['large_change']);
  assert.ok(codes(big).includes('ack_required'));
  assert.deepEqual(codes({ ...big, acknowledgements: ['large_change'] }), []);
  const exactly50 = apple({
    lines: [
      {
        territory: 'USA',
        currency: 'USD',
        currentAmount: '500',
        newAmount: '750',
        pricePointId: 'x',
      },
    ],
  });
  assert.deepEqual(requiredAcknowledgements(exactly50), []);
  const down = apple({
    lines: [
      {
        territory: 'USA',
        currency: 'USD',
        currentAmount: '999',
        newAmount: '499',
        pricePointId: 'p1',
      },
    ],
  });
  assert.deepEqual(requiredAcknowledgements(down), ['large_change']);
  const abs = apple({
    lines: [
      {
        territory: 'USA',
        currency: 'USD',
        currentAmount: '10000',
        newAmount: '20001',
        pricePointId: 'x',
      },
    ],
  });
  assert.ok(requiredAcknowledgements(abs).includes('large_absolute'));
  // JPY has a larger default so a 5000 yen change is not flagged
  const jpy = apple({
    lines: [
      {
        territory: 'JPN',
        currency: 'JPY',
        currentAmount: '10000',
        newAmount: '14000',
        pricePointId: 'x',
      },
    ],
  });
  assert.deepEqual(requiredAcknowledgements(jpy), []);
});

test('moving existing subscribers needs its own acknowledgement; the default preserves them', () => {
  assert.deepEqual(requiredAcknowledgements(apple()), []);
  const apply = apple({ existingSubscribers: 'apply' });
  assert.deepEqual(requiredAcknowledgements(apply), ['existing_subscribers']);
  assert.ok(codes(apply).includes('ack_required'));
  assert.deepEqual(codes({ ...apply, acknowledgements: ['existing_subscribers'] }), []);
  assert.ok(codes(apple({ existingSubscribers: 'opt_in' })).includes('subscriber_rule_invalid'));
  assert.ok(
    codes(apple({ kind: 'consumable', existingSubscribers: 'preserve' })).includes(
      'subscriber_rule_invalid',
    ),
  );
});

test('effective date: valid, not in the past, Apple only', () => {
  assert.ok(codes(apple({ effectiveDate: '2026-11-23' })).includes('effective_date_past'));
  assert.ok(codes(apple({ effectiveDate: '2026-02-30' })).includes('effective_date_invalid'));
  assert.deepEqual(codes(apple({ effectiveDate: null })), []);
  assert.deepEqual(codes(apple({ effectiveDate: '2026-11-24' })), []);
});

const play = (over: Partial<PriceChange> = {}): PriceChange => ({
  store: 'googleplay',
  productId: 'pro_monthly',
  kind: 'subscription',
  planId: 'monthly',
  baseTerritory: null,
  lines: [{ territory: 'US', currency: 'USD', currentAmount: '499', newAmount: '549' }],
  effectiveDate: null,
  existingSubscribers: 'preserve',
  acknowledgements: [],
  ...over,
});
const playCtx: PriceContext = {
  current: [{ territory: 'US', currency: 'USD', amount: '499' }],
  today: '2026-11-24',
};

test('Google Play: plan needed for a subscription, no price point, no future date, opt-in or opt-out', () => {
  assert.deepEqual(codes(play(), playCtx), []);
  assert.ok(codes(play({ planId: null }), playCtx).includes('plan_missing'));
  assert.ok(
    codes(play({ effectiveDate: '2026-12-01' }), playCtx).includes('effective_date_unsupported'),
  );
  assert.ok(
    codes(
      play({
        lines: [
          {
            territory: 'US',
            currency: 'USD',
            currentAmount: '499',
            newAmount: '549',
            pricePointId: 'p',
          },
        ],
      }),
      playCtx,
    ).includes('price_point_not_allowed'),
  );
  assert.ok(codes(play({ existingSubscribers: 'opt_out' }), playCtx).includes('ack_required'));
  assert.ok(
    codes(play({ existingSubscribers: 'apply' }), playCtx).includes('subscriber_rule_invalid'),
  );
  assert.ok(
    codes(
      play({
        lines: [{ territory: 'USA', currency: 'USD', currentAmount: '499', newAmount: '549' }],
      }),
      playCtx,
    ).includes('bad_territory'),
  );
});

test('territory count and duplicates', () => {
  const lines = Array.from({ length: 3 }, () => ({
    territory: 'US',
    currency: 'USD',
    currentAmount: '499',
    newAmount: '549',
  }));
  assert.ok(codes(play({ lines }), playCtx).includes('duplicate_territory'));
  assert.ok(
    codes(play({ lines }), {
      ...playCtx,
      limits: {
        relativeBp: 5000,
        absoluteMajor: 100,
        absoluteMajorByCurrency: {},
        maxTerritories: 2,
        maxPriceMajor: 1000,
      },
    }).includes('too_many_territories'),
  );
  assert.ok(codes(play({ lines: [] }), playCtx).includes('no_lines'));
});

test('summary: percent per territory, never a sum across currencies', () => {
  const s = summarizePriceChange(
    apple({
      lines: [
        {
          territory: 'USA',
          currency: 'USD',
          currentAmount: '500',
          newAmount: '600',
          pricePointId: 'x',
        },
        {
          territory: 'JPN',
          currency: 'JPY',
          currentAmount: '500',
          newAmount: '400',
          pricePointId: 'y',
        },
      ],
    }),
  );
  assert.deepEqual(s.currencies, ['JPY', 'USD']);
  assert.equal(s.lines[0]?.percentBp, 2000);
  assert.equal(s.lines[1]?.percentBp, -2000);
  assert.equal(s.largestBp, 2000);
  assert.equal(s.increases, 1);
  assert.equal(s.decreases, 1);
  assert.equal('total' in s, false);
});

test('the confirmation phrase names the count and the largest change', () => {
  assert.equal(priceConfirmationPhrase(3, 4200), 'CHANGE 3 PRICES MAX 42%');
  assert.equal(priceConfirmationPhrase(1, 4201), 'CHANGE 1 PRICE MAX 43%');
  assert.ok(samePhrase('  CHANGE 3  PRICES MAX 42% ', 'CHANGE 3 PRICES MAX 42%'));
  assert.ok(!samePhrase('change 3 prices max 42%', 'CHANGE 3 PRICES MAX 42%'));
});
