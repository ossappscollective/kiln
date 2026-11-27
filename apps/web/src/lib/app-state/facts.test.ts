import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CartSummary } from '../cart-summary.ts';
import type { PendingSummary } from '../pending.ts';
import { stepsToRepeat } from './actions.ts';
import { deriveAppState } from './derive.ts';
import {
  assembleFacts,
  countOf,
  type FactSources,
  lineOfRecords,
  storeBuildFactOf,
} from './facts.ts';
import { ANDROID, failedRun, IOS, iosRelease, NOW, running, testflight } from './fixtures.ts';

const cart = (counts: Record<string, number>): CartSummary => ({
  apps: Object.keys(counts).map((appId) => ({
    appId,
    id: appId,
    app: {
      id: appId,
      name: 'Weather',
      platform: appId === ANDROID.id ? 'android' : 'ios',
      store: 'x',
    },
    count: counts[appId] as number,
    kinds: {},
  })),
  totals: {
    apps: Object.keys(counts).length,
    count: Object.values(counts).reduce((a, b) => a + b, 0),
  },
  generatedAt: NOW,
});
const summary = (
  lines: Record<string, { blocking: number; waiting: number; awaitingSubmit?: number }>,
): PendingSummary =>
  ({
    apps: Object.keys(lines).map((appId) => ({
      appId,
      id: appId,
      ...(lines[appId] as object),
      count: 0,
      kinds: [],
      nextSteps: [],
      app: { id: appId, name: 'W', platform: 'ios', store: 'x' },
    })),
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
      pendingSummary: summary({
        [ANDROID.id]: { blocking: 40, waiting: 1 },
        [IOS.id]: { blocking: 1, waiting: 0 },
      }),
      publishing: (id) => (id === IOS.id ? running() : null),
      failure: (id) => (id === ANDROID.id ? failedRun('android') : null),
    }),
  );
  assert.deepEqual(f.pending[ANDROID.id], {
    count: 29,
    blocking: 29,
    stagedUnpushed: 0,
    awaitingSubmit: 0,
    awaitingRelease: 0,
    waiting: 1,
  });
  assert.deepEqual(f.pending[IOS.id], {
    count: 2,
    blocking: 1,
    stagedUnpushed: 0,
    awaitingSubmit: 0,
    awaitingRelease: 0,
    waiting: 0,
  });
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
  assert.deepEqual(
    lineOfRecords(sources({ pendingSummary: summary({ [IOS.id]: { blocking: 0, waiting: 2 } }) }), [
      IOS.id,
    ]),
    { count: 0, blocking: 0, waiting: 2, stagedUnpushed: 0, awaitingSubmit: 0, awaitingRelease: 0 },
  );
  // A pushed draft that waits for its submit is a line of its own: never in the count, never lost.
  assert.deepEqual(
    lineOfRecords(
      sources({
        pendingSummary: summary({ [IOS.id]: { blocking: 0, waiting: 0, awaitingSubmit: 1 } }),
      }),
      [IOS.id],
    ),
    { count: 0, blocking: 0, waiting: 0, stagedUnpushed: 0, awaitingSubmit: 1, awaitingRelease: 0 },
  );
});

test('"publish again" repeats a single push as that push, and anything else as the whole plan', () => {
  assert.deepEqual(stepsToRepeat({ steps: ['push_draft'] }), [{ type: 'push_draft' }]);
  assert.deepEqual(stepsToRepeat({ steps: ['push_and_submit'] }), [{ type: 'push_and_submit' }]);
  assert.equal(stepsToRepeat({ steps: ['push_draft', 'submit'] }), null);
  assert.equal(stepsToRepeat(null), null);
});

test('the store builds are a fact of the snapshot: read by record, null while not read, and the candidate comes from them', () => {
  const read = [testflight(), testflight({ buildNumber: '88', version: '1.19.0' })];
  const f = assembleFacts(
    {
      role: 'owner',
      records: [IOS, ANDROID],
      releases: { [IOS.id]: [iosRelease({ version: '1.19.0', build: '88', status: 'live' })] },
      now: NOW,
    },
    sources({ builds: (id) => (id === IOS.id ? read : null) }),
  );
  assert.deepEqual(f.builds?.[IOS.id], read);
  assert.equal(f.builds?.[ANDROID.id], null);
  const s = deriveAppState(f, 'ios');
  assert.equal(s.headline, 'Create release 2.00.1 from TestFlight build 95');
  // A source that does not read builds leaves them unknown (the model then knows the pipeline's newest build only).
  const none = assembleFacts({ role: 'owner', records: [IOS], now: NOW }, sources());
  assert.equal(none.builds?.[IOS.id], null);
});

test('a store row of the Builds page becomes the build fact: only what decides a candidate', () => {
  const fact = storeBuildFactOf({
    platform: 'ios',
    buildNumber: '95',
    version: '2.00.1',
    state: 'processed',
    rawState: 'VALID',
    expired: false,
    uploadedAt: NOW,
    expiresAt: NOW + 1,
    expiresAtEstimated: true,
    channel: 'testflight',
    tracks: [],
    releaseStatus: null,
    optInUrl: null,
    runId: null,
    testflightGroupIds: null,
  });
  assert.deepEqual(fact, {
    buildNumber: '95',
    version: '2.00.1',
    state: 'processed',
    expired: false,
    uploadedAt: NOW,
    channel: 'testflight',
    tracks: [],
  });
});

test('facts: the reading of what blocks a submit comes from the readiness source, per record, null when nothing was asked', () => {
  const fact = {
    reading: { ready: true, blockers: [], unknown: [], versionString: '2.0.1', storeReadAt: NOW },
    checking: false,
    error: null,
  };
  const f = assembleFacts(
    input,
    sources({ cart: cart({}), readiness: (id: string) => (id === IOS.id ? fact : null) }),
  );
  assert.deepEqual(f.readiness?.[IOS.id], fact);
  assert.equal(f.readiness?.[ANDROID.id], null);
  assert.equal(assembleFacts(input, sources({ cart: cart({}) })).readiness?.[IOS.id], null);
});
