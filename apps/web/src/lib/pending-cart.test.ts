import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allState,
  announceCartAdded,
  CART_ADDED_EVENT,
  type CartItem,
  type CartRow,
  countsOf,
  discardRequests,
  failAll,
  groupRows,
  mergeResults,
  noSelection,
  outcomeRows,
  placeOf,
  prune,
  publishRequests,
  reasonKey,
  resultKey,
  rowKey,
  selectAll,
  tally,
  toRows,
  toggle,
} from './pending-cart.ts';

const item = (id: string, over: Partial<CartItem> = {}): CartItem => ({
  id,
  kind: 'listing',
  title: id,
  summary: null,
  before: null,
  platform: 'ios',
  store: 'appstoreconnect',
  locale: 'en-US',
  createdAt: 1,
  author: null,
  risk: 'store_draft',
  needsApproval: false,
  publishable: true,
  reason: null,
  canDiscard: true,
  bundle: 'push:a',
  version: `v-${id}`,
  counts: {},
  problems: [],
  ref: {},
  ...over,
});
const reply = (id: string, over: Partial<CartItem> = {}) =>
  item(id, { kind: 'review_reply', risk: 'public_reply', bundle: null, store: 'googleplay', platform: 'android', ...over });

const rows: CartRow[] = [
  ...toRows('a', [reply('review_reply:1'), item('listing:1'), item('graphics:x', { kind: 'graphics' }), item('listing:2')]),
  ...toRows('b', [item('listing:1', { bundle: 'push:b' })]),
];

test('groups follow the order of the kinds and drop the empty ones', () => {
  assert.deepEqual(groupRows(rows).map((g) => [g.kind, g.rows.length]), [['listing', 3], ['graphics', 1], ['review_reply', 1]]);
  assert.deepEqual(groupRows([]), []);
});

test('the same item id in two records stays two rows', () => {
  assert.notEqual(rowKey('a', 'listing:1'), rowKey('b', 'listing:1'));
  assert.equal(rows.filter((r) => r.id === 'listing:1').length, 2);
});

test('toggling a bundle member selects the whole bundle of its record only, and again clears it', () => {
  const on = toggle(rows, noSelection, rowKey('a', 'listing:1'));
  assert.deepEqual([...on].sort(), [rowKey('a', 'graphics:x'), rowKey('a', 'listing:1'), rowKey('a', 'listing:2')].sort());
  assert.equal(on.has(rowKey('b', 'listing:1')), false);
  assert.equal(toggle(rows, on, rowKey('a', 'graphics:x')).size, 0);
});

test('a reply toggles alone; a row that cannot be published cannot be selected', () => {
  assert.deepEqual([...toggle(rows, noSelection, rowKey('a', 'review_reply:1'))], [rowKey('a', 'review_reply:1')]);
  const blocked = toRows('a', [item('listing:1', { publishable: false, reason: { code: 'no_right' } })]);
  assert.equal(toggle(blocked, noSelection, rowKey('a', 'listing:1')).size, 0);
  assert.equal(selectAll(blocked).size, 0);
  assert.equal(allState(blocked, noSelection), 'none');
});

test('select all, tri-state and prune after a refresh', () => {
  const all = selectAll(rows);
  assert.equal(all.size, rows.length);
  assert.equal(allState(rows, all), 'all');
  assert.equal(allState(rows, toggle(rows, noSelection, rowKey('a', 'review_reply:1'))), 'some');
  assert.equal(prune(rows.slice(0, 2), all).size, 2);
});

test('counts say how many, which stores and what each kind does', () => {
  const sel = new Set([...toggle(rows, noSelection, rowKey('a', 'listing:1')), rowKey('a', 'review_reply:1')]);
  const c = countsOf(rows, sel);
  assert.deepEqual([c.selected, c.drafts, c.replies, c.total, c.selectable], [4, 3, 1, 5, 5]);
  assert.deepEqual(c.stores, ['googleplay', 'appstoreconnect']);
  assert.deepEqual(c.byKind, { listing: 2, graphics: 1, release: 0, review_reply: 1 });
  assert.equal(c.needsApproval, false);
  assert.equal(countsOf(toRows('a', [item('x', { needsApproval: true })]), new Set([rowKey('a', 'x')])).needsApproval, true);
});

test('requests are per record with the listed version; discard skips rows without the right', () => {
  const sel = new Set([rowKey('a', 'review_reply:1'), rowKey('b', 'listing:1')]);
  const req = publishRequests(rows, sel);
  assert.deepEqual([...req.keys()], ['a', 'b']);
  assert.deepEqual(req.get('b'), [{ id: 'listing:1', version: 'v-listing:1' }]);
  const none = toRows('a', [item('x', { canDiscard: false }), item('y')]);
  assert.deepEqual([...discardRequests(none, selectAll(none)).get('a') ?? []], ['y']);
});

test('merging results keeps the earlier records, and a failed request fails its rows', () => {
  const first = mergeResults({}, 'a', [{ id: 'listing:1', status: 'ok', reason: null }, { id: 'review_reply:1', status: 'failed', reason: 'store_forbidden' }]);
  const both = mergeResults(first, 'b', [{ id: 'listing:1', status: 'skipped', reason: 'not_pending' }]);
  assert.deepEqual(tally(both), { ok: 1, failed: 1, skipped: 1 });
  const failed = failAll(both, 'b', ['listing:1'], 'network');
  assert.deepEqual(failed[rowKey('b', 'listing:1')], { status: 'failed', reason: 'network' });
  assert.equal(both[rowKey('b', 'listing:1')]?.status, 'skipped', 'the input is not changed');
  assert.deepEqual(outcomeRows(rows, first).map((x) => x.row.key), [rowKey('a', 'review_reply:1'), rowKey('a', 'listing:1')]);
});

test('every row of an app links to the page that holds it', () => {
  const r = rows.find((x) => x.id === 'graphics:x') as CartRow;
  assert.match(placeOf(r, 'app1', null), /^#\/portfolio\/app1\/assets/);
  assert.match(placeOf(rows[0] as CartRow, 'app1', 'android'), /reviews\?platform=android$/);
});

test('reason and result codes map to known messages, unknown ones to the generic one', () => {
  assert.equal(reasonKey('no_right'), 'app:cart.reason.noRight');
  assert.equal(reasonKey('weird'), 'app:cart.reason.other');
  assert.equal(resultKey('no_right'), 'app:cart.reason.noRight');
  assert.equal(resultKey('changed_since_review'), 'app:cart.result.changedSinceReview');
  assert.equal(resultKey(null), 'app:cart.result.other');
});

test('announcing dispatches one event and never throws without a window', () => {
  const target = new EventTarget();
  let n = 0;
  target.addEventListener(CART_ADDED_EVENT, () => (n += 1));
  announceCartAdded(target);
  assert.equal(n, 1);
  assert.doesNotThrow(() => announceCartAdded(undefined));
});

// The floating button once turned white on hover (the global `button:hover:not(:disabled)` out-ranked its scoped rule) and the
// label and icon vanished. Guard: every state rule of the button is `button.cart-fab...` and none paints a surface behind the label.
test('the cart button keeps its gradient and label colour in every state', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../components/app/PendingCart.svelte', import.meta.url), 'utf8');
  const css = src.slice(src.indexOf('<style>') + 7).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].filter((m) => /cart-fab/.test(m[1] as string) && !/\.count/.test(m[1] as string));
  assert.ok(rules.length >= 6);
  for (const m of rules) {
    const sel = (m[1] as string).trim();
    for (const part of sel.split(',').map((x) => x.trim())) {
      assert.match(part, /^(:global\(body:has\(\.savebar\)\) )?button\.cart-fab/, `selector needs the element for specificity: ${part}`);
    }
    const body = m[2] as string;
    assert.doesNotMatch(body, /background(-color)?:\s*var\(--(surface|raised|chip|field|ground)/, sel);
    const color = /(^|[\s;])color:\s*([^;]+)/.exec(body);
    if (color) assert.equal((color[2] as string).trim(), 'var(--accent-ink)', sel);
  }
  for (const state of [':hover', ':focus-visible', ':active', "[aria-expanded='true']", ':disabled'])
    assert.ok(rules.some((m) => (m[1] as string).includes(state)), state);
});
