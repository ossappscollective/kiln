import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CartItem, markBeingPublished, reasonText, toRows } from './pending-cart.ts';
import type { PublishResult } from './pending.ts';
import {
  byText,
  createPublishingLoader,
  detailText,
  disabledReason,
  elapsedOf,
  failureNote,
  finishedApps,
  HIDDEN_POLL_MS,
  headlineText,
  MAX_POLL_MS,
  OPTIMISTIC_GRACE_MS,
  POLL_MS,
  type Publishing,
  type PublishingList,
  pollDelay,
  stepProgress,
} from './publishing.ts';

const MIN = 60_000;
const running = (over: Partial<Publishing> = {}): Publishing => ({
  startedAt: 1_000_000,
  steps: ['push_draft', 'submit'],
  currentStep: 'push_draft',
  stepStartedAt: 1_000_000,
  by: { id: 'u1', name: 'Alex' },
  ...over,
});

test('which step is current: the running one, with its place in the list', () => {
  assert.deepEqual(stepProgress(running()), {
    index: 1,
    total: 2,
    step: 'push_draft',
    name: 'Push the draft',
  });
  assert.deepEqual(stepProgress(running({ currentStep: 'submit' })), {
    index: 2,
    total: 2,
    step: 'submit',
    name: 'Submit for review',
  });
  // Between steps, and before the first one: no running step, the count is still known.
  assert.deepEqual(stepProgress(running({ currentStep: null })), {
    index: null,
    total: 2,
    step: null,
    name: null,
  });
  // A claim of an older server has no list: the step is named without a position.
  assert.deepEqual(stepProgress(running({ steps: [], currentStep: 'release' })), {
    index: null,
    total: 0,
    step: 'release',
    name: 'Release',
  });
});

test('the status row words: store, when it started, step n of m, who, elapsed time', () => {
  assert.equal(headlineText('android'), 'Publishing to Google Play…');
  assert.equal(headlineText('ios'), 'Publishing to App Store…');
  const now = 1_000_000 + 3 * MIN + 12_000;
  assert.equal(
    detailText(running(), now),
    'started 3 minutes ago · step 1 of 2: Push the draft',
  );
  assert.equal(
    detailText(running({ currentStep: 'submit' }), 1_000_000 + 20_000),
    'started just now · step 2 of 2: Submit for review',
  );
  assert.equal(detailText(running({ currentStep: null }), now), 'started 3 minutes ago · 2 steps');
  assert.equal(detailText(running({ steps: [], currentStep: null }), now), 'started 3 minutes ago');
  assert.equal(
    detailText(running({ steps: ['release'], currentStep: null }), now),
    'started 3 minutes ago · 1 step',
  );
  assert.equal(elapsedOf(running(), now), '3:12');
  assert.equal(elapsedOf(running(), 1_000_000 - 5000), '0:00', 'never negative');
  assert.equal(byText(running(), 'u2'), 'started by Alex');
  assert.equal(byText(running(), 'u1'), null, 'not one’s own name');
  assert.equal(byText(running({ by: { id: 'u3', name: null } }), null), null);
  assert.equal(byText(running({ by: null }), null), null);
});

test('the reason a button is off while it runs names when it started', () => {
  assert.equal(
    disabledReason(running(), 1_000_000 + 3 * MIN),
    'A publish of this app is running (started 3 minutes ago). Wait for it to finish, then try again.',
  );
});

test('polling: nothing when no publish runs; 5 s while one does; 30 s in a hidden tab; backs off on failures', () => {
  assert.equal(pollDelay({ publishing: false, hidden: false, failures: 0 }), null);
  assert.equal(pollDelay({ publishing: false, hidden: true, failures: 3 }), null);
  assert.equal(pollDelay({ publishing: true, hidden: false, failures: 0 }), POLL_MS);
  assert.equal(POLL_MS, 5000);
  assert.equal(pollDelay({ publishing: true, hidden: true, failures: 0 }), HIDDEN_POLL_MS);
  assert.equal(pollDelay({ publishing: true, hidden: false, failures: 1 }), 10_000);
  assert.equal(pollDelay({ publishing: true, hidden: false, failures: 2 }), 20_000);
  assert.equal(pollDelay({ publishing: true, hidden: false, failures: 20 }), MAX_POLL_MS);
  assert.equal(pollDelay({ publishing: true, hidden: true, failures: 5 }), MAX_POLL_MS);
});

test('finished apps: the ones that were publishing and are not any more', () => {
  assert.deepEqual(finishedApps(['a', 'b'], ['b', 'c']), ['a']);
  assert.deepEqual(finishedApps([], ['a']), []);
  assert.deepEqual(finishedApps(['a'], ['a']), []);
});

const result = (over: Partial<PublishResult>): PublishResult => ({
  app: { id: 'a', name: 'Shop', platform: 'android', store: 'googleplay' },
  planHash: 'h',
  completed: false,
  applied: 1,
  skipped: 0,
  failed: 1,
  stoppedAt: 'submit',
  steps: [],
  pending: { items: 1, actionable: 1, blocking: 0 },
  publishedAt: 1,
  ...over,
});

test('a publish that did not go through leaves one line with the reason; one that did leaves none', () => {
  assert.equal(failureNote(result({ completed: true, failed: 0, stoppedAt: null })), null);
  const note = failureNote(result({}));
  assert.ok(note?.startsWith('Last publish failed: '), String(note));
  assert.match(String(note), /Submit for review/);
});

test('the rows of an app that publishes are marked: not selectable, not removable, with the reason', () => {
  const cart = (id: string): CartItem => ({
    id,
    kind: 'listing',
    title: id,
    summary: null,
    before: null,
    platform: 'android',
    store: 'googleplay',
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
  });
  const rows = [...toRows('a', [cart('listing:1'), cart('listing:2')]), ...toRows('b', [cart('listing:3')])];
  const marked = markBeingPublished(rows, new Set(['a']));
  assert.deepEqual(
    marked.map((r) => [r.appId, r.publishable, r.canDiscard, r.reason?.code ?? null]),
    [
      ['a', false, false, 'publishing'],
      ['a', false, false, 'publishing'],
      ['b', true, true, null],
    ],
  );
  assert.equal(markBeingPublished(rows, new Set()).every((r) => r.publishable), true);
  assert.equal(rows[0]?.publishable, true, 'the input is not changed');
  assert.match(reasonText('publishing'), /Being published right now/);
});

// ----- the loader ---------------------------------------------------------------------------------------------

const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness(reads: (call: number) => PublishingList | Error) {
  let clock = 5_000_000;
  let call = 0;
  let changes = 0;
  let hidden = false;
  const timers: { fn: () => void; ms: number }[] = [];
  const finished: [string, string[]][] = [];
  const loader = createPublishingLoader({
    read: async () => {
      const out = reads(call++);
      if (out instanceof Error) throw out;
      return out;
    },
    onChange: () => void (changes += 1),
    onFinished: (ws, ids) => void finished.push([ws, ids]),
    hidden: () => hidden,
    now: () => clock,
    timer: (fn, ms) => {
      // A timer that fires is gone (like setTimeout): only the ones still waiting are listed.
      const t = {
        fn: () => {
          timers.splice(timers.indexOf(t), 1);
          fn();
        },
        ms,
      };
      timers.push(t);
      return () => void timers.splice(timers.indexOf(t), 1);
    },
  });
  return {
    loader,
    timers,
    finished,
    calls: () => call,
    changes: () => changes,
    advance: (ms: number) => void (clock += ms),
    hide: (h: boolean) => void (hidden = h),
  };
}
const list = (...ids: string[]): PublishingList => ({
  apps: ids.map((appId) => ({ appId, publishing: running() })),
  generatedAt: 1,
});

test('loader: reads on start, polls every 5 s while a publish runs, reports the finish once, then stops polling', async () => {
  const h = harness((n) => (n < 2 ? list('a') : list()));
  const stop = h.loader.start('w');
  await settle();
  assert.equal(h.calls(), 1);
  assert.equal(h.loader.of('w', 'a')?.currentStep, 'push_draft');
  assert.deepEqual(h.loader.ids('w'), ['a']);
  assert.deepEqual(h.timers.map((t) => t.ms), [POLL_MS]);
  h.timers[0]?.fn();
  await settle();
  assert.equal(h.calls(), 2);
  assert.equal(h.loader.of('w', 'a')?.currentStep, 'push_draft', 'still running');
  assert.deepEqual(h.finished, []);
  h.timers[0]?.fn();
  await settle();
  assert.equal(h.calls(), 3);
  assert.equal(h.loader.of('w', 'a'), null, 'the claim is gone');
  assert.deepEqual(h.finished, [['w', ['a']]], 'reported once');
  assert.equal(h.timers.length, 0, 'nothing publishes: nothing is polled');
  stop();
});

test('loader: with nothing publishing it reads once and sets no timer (a focus reads again)', async () => {
  const h = harness(() => list());
  h.loader.start('w');
  await settle();
  assert.equal(h.timers.length, 0);
  await h.loader.refresh('w');
  assert.equal(h.calls(), 2);
  assert.equal(h.timers.length, 0);
});

test('loader: a hidden tab polls slowly; failures back off and keep what was shown; letting go stops the timer', async () => {
  let fail = false;
  const h = harness(() => (fail ? new Error('offline') : list('a')));
  const stop = h.loader.start('w');
  await settle();
  h.hide(true);
  h.timers[0]?.fn();
  await settle();
  assert.equal(h.timers[0]?.ms, HIDDEN_POLL_MS);
  h.hide(false);
  fail = true;
  h.timers[0]?.fn();
  await settle();
  assert.equal(h.loader.of('w', 'a')?.currentStep, 'push_draft', 'a failed read keeps what was shown');
  assert.equal(h.timers[0]?.ms, 10_000, 'backed off');
  h.timers[0]?.fn();
  await settle();
  assert.equal(h.timers[0]?.ms, 20_000);
  fail = false;
  h.timers[0]?.fn();
  await settle();
  assert.equal(h.timers[0]?.ms, POLL_MS, 'back to normal after an answer');
  stop();
  assert.equal(h.timers.length, 0);
});

test('loader: a publish this browser started shows at once, is confirmed by the server and ends with the answer', async () => {
  const h = harness((n) => (n === 0 ? list() : n === 1 ? list('a') : list()));
  h.loader.start('w');
  await settle();
  h.loader.mark('w', 'a', ['push_draft', 'submit']);
  const mine = h.loader.of('w', 'a');
  assert.equal(mine?.optimistic, true);
  assert.deepEqual(mine?.steps, ['push_draft', 'submit']);
  assert.equal(h.timers.length, 1, 'a publish is shown, so it is polled');
  await h.loader.refresh('w');
  assert.equal(h.loader.of('w', 'a')?.optimistic, undefined, 'the server’s claim replaces it');
  assert.equal(h.loader.of('w', 'a')?.currentStep, 'push_draft');
  // The answer arrives before the next poll: the screens must not wait for it.
  h.loader.settle('w', 'a');
  assert.equal(h.loader.of('w', 'a'), null);
  assert.deepEqual(h.finished, [['w', ['a']]]);
});

test('loader: a marked publish the server has not shown yet is kept for a while, then dropped without a report', async () => {
  const h = harness(() => list());
  h.loader.start('w');
  await settle();
  h.loader.mark('w', 'a', ['release']);
  await h.loader.refresh('w');
  assert.notEqual(h.loader.of('w', 'a'), null, 'the request may not have taken its claim yet');
  h.advance(OPTIMISTIC_GRACE_MS + 1);
  await h.loader.refresh('w');
  assert.equal(h.loader.of('w', 'a'), null);
  assert.deepEqual(h.finished, [], 'it never ran as far as the server says');
});

test('loader: another workspace drops everything; a slow older answer is ignored', async () => {
  const slow: { resolve: (l: PublishingList) => void }[] = [];
  let calls = 0;
  const finished: string[][] = [];
  const loader = createPublishingLoader({
    read: (ws) =>
      ws === 'w1' && calls++ === 0
        ? new Promise((resolve) => slow.push({ resolve }))
        : Promise.resolve(list('z')),
    onChange: () => undefined,
    onFinished: (_ws, ids) => void finished.push(ids),
    timer: () => () => undefined,
  });
  const first = loader.refresh('w1');
  await loader.refresh('w2');
  assert.deepEqual(loader.ids('w2'), ['z']);
  slow[0]?.resolve(list('old'));
  await first;
  assert.deepEqual(loader.ids('w1'), [], 'not the workspace in view');
  assert.deepEqual(loader.ids('w2'), ['z']);
  assert.deepEqual(finished, []);
});
