import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CartSummary } from '../cart-summary.ts';
import type { PendingSummary } from '../pending.ts';
import { deriveAppState } from './derive.ts';
import { assembleFacts, countOf, type FactSources, lineOfRecords } from './facts.ts';
import { ANDROID, failedRun, IOS, NOW, running } from './fixtures.ts';
import { stepsToRepeat } from './actions.ts';

const cart = (counts: Record<string, number>): CartSummary => ({
  apps: Object.keys(counts).map((appId) => ({
    appId,
    id: appId,
    app: { id: appId, name: 'Weather', platform: appId === ANDROID.id ? 'android' : 'ios', store: 'x' },
    count: counts[appId] as number,
    kinds: {},
  })),
  totals: { apps: Object.keys(counts).length, count: Object.values(counts).reduce((a, b) => a + b, 0) },
  generatedAt: NOW,
});
const summary = (lines: Record<string, { blocking: number; waiting: number }>): PendingSummary =>
  ({
    apps: Object.keys(lines).map((appId) => ({ appId, id: appId, ...(lines[appId] as object), count: 0, kinds: [], nextSteps: [], app: { id: appId, name: 'W', platform: 'ios', store: 'x' } })),
    totals: { apps: 0, count: 0, blocking: 0 },
    generatedAt: NOW,
  }) as unknown as PendingSummary;
const sources = (over: Partial<FactSources> = {}): FactSources => ({
  cart: cart({}),
  pendingSummary: null,
  publishing: () => null,
  failure: () => null,
  pipeline: () => null,
  publishBatchEnabled: true,
  ...over,
});
const input = { role: 'owner' as const, records: [IOS, ANDROID], now: NOW };

test('the pending count of a record is the cart count; a record the cart does not list has nothing', () => {
  const c = cart({ [ANDROID.id]: 29 });
  assert.equal(countOf(c, ANDROID.id), 29);
  assert.equal(countOf(c, IOS.id), 0);
  assert.equal(countOf(null, ANDROID.id), 0);
});

test('facts: the count comes from the cart, what blocks from the pending summary (never more than the count), the claims from the store', () => {
  const f = assembleFacts(
    input,
    sources({
      cart: cart({ [ANDROID.id]: 29, [IOS.id]: 2 }),
      pendingSummary: summary({ [ANDROID.id]: { blocking: 40, waiting: 1 }, [IOS.id]: { blocking: 1, waiting: 0 } }),
      publishing: (id) => (id === IOS.id ? running() : null),
      failure: (id) => (id === ANDROID.id ? failedRun('android') : null),
    }),
  );
  assert.deepEqual(f.pending[ANDROID.id], { count: 29, blocking: 29 });
  assert.deepEqual(f.pending[IOS.id], { count: 2, blocking: 1 });
  assert.equal(f.pendingKnown, true);
  assert.ok(f.publishing[IOS.id]);
  assert.equal(f.publishing[ANDROID.id], null);
  assert.equal(f.lastRun[ANDROID.id]?.id, 'run-android');
});

test('an unread cart is not "nothing pending": the facts say so and the model will not claim it', () => {
  const f = assembleFacts(input, sources({ cart: null }));
  assert.equal(f.pendingKnown, false);
  assert.equal(deriveAppState(f, 'both').phase, 'unknown');
});

test('every surface that counts gets the same number: the model, the line of the chips and the top bar', () => {
  const src = sources({ cart: cart({ [ANDROID.id]: 29, [IOS.id]: 2 }) });
  const state = deriveAppState(assembleFacts(input, src), 'both');
  const line = lineOfRecords(src, [IOS.id, ANDROID.id]);
  assert.equal(state.pendingCount, 31);
  assert.equal(line?.count, 31);
  assert.deepEqual(state.badge, { kind: 'pending', count: 31, blocking: false });
  const android = deriveAppState(assembleFacts(input, src), 'android');
  assert.equal(android.pendingCount, lineOfRecords(src, [ANDROID.id])?.count);
});

test('the chip line is null while the cart is unread, and when nothing waits at all', () => {
  assert.equal(lineOfRecords(sources({ cart: null }), [IOS.id]), null);
  assert.equal(lineOfRecords(sources(), [IOS.id]), null);
  assert.deepEqual(lineOfRecords(sources({ pendingSummary: summary({ [IOS.id]: { blocking: 0, waiting: 2 } }) }), [IOS.id]), { count: 0, blocking: 0, waiting: 2 });
});

test('"publish again" repeats a draft-only run as the draft alone, and anything else as the whole plan', () => {
  assert.deepEqual(stepsToRepeat({ steps: ['push_draft'] }), ['push_draft']);
  assert.equal(stepsToRepeat({ steps: ['push_draft', 'submit'] }), null);
  assert.equal(stepsToRepeat(null), null);
});
