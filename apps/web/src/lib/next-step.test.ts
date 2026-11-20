import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttentionItem } from './app-attention.ts';
import { chooseNextStep, orderTrains } from './next-step.ts';
import { releaseTrains, releaseTrainsByPlatform, type TrainInput } from './release-trains.ts';

const rows = (statuses: string[]) =>
  ['ci', 'build', 'prepare', 'review', 'release'].map((id, i) => ({
    id,
    status: statuses[i],
    detail: null,
  })) as TrainInput['steps'];
const base: TrainInput = {
  appId: 'ios',
  platform: 'ios',
  state: 'draft',
  waitingOn: 'you',
  summary: 's',
  version: '3.1.1',
  steps: rows(['done', 'done', 'current', 'todo', 'todo']),
  build: { number: '168', version: '3.1.1', processed: true, attached: true },
};
const inReview: TrainInput = {
  ...base,
  state: 'in_review',
  waitingOn: 'store',
  steps: rows(['done', 'done', 'done', 'current', 'todo']),
};
const rejected: TrainInput = {
  ...base,
  state: 'rejected',
  waitingOn: 'you',
  steps: rows(['done', 'done', 'done', 'failed', 'todo']),
};
const approved: TrainInput = {
  ...base,
  state: 'approved',
  waitingOn: 'you',
  steps: rows(['done', 'done', 'done', 'done', 'current']),
};

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  id: 'a1:reviews',
  tone: 'info',
  icon: 'message',
  text: '3 new reviews',
  detail: null,
  href: '#/portfolio/a1/reviews',
  action: 'Open reviews',
  ...over,
});
const input = (over: Partial<Parameters<typeof chooseNextStep>[0]> = {}) => ({
  trains: [],
  attention: [],
  scope: null,
  canStart: true,
  canPrepare: true,
  ...over,
});

test('nothing on its way: one primary button, Start release', () => {
  const s = chooseNextStep(input());
  assert.equal(s.kind, 'start');
  assert.deepEqual(s.primary, { label: 'Start release', action: 'start-release' });
  assert.equal(s.train, null);
  assert.equal(s.offerStart, false);
});

test('without a linked repository or the right to start, the step is Prepare release; without that, no button', () => {
  assert.deepEqual(chooseNextStep(input({ canStart: false })).primary, {
    label: 'Prepare release',
    action: 'prepare-release',
  });
  const none = chooseNextStep(input({ canStart: false, canPrepare: false }));
  assert.equal(none.kind, 'idle');
  assert.equal(none.primary, null);
});

test('a release that waits for you leads, with the button of its train and a link to its step', () => {
  const s = chooseNextStep(input({ trains: releaseTrains([base]), scope: 'ios' }));
  assert.equal(s.kind, 'train');
  assert.equal(s.tone, 'warn');
  assert.equal(s.title, 'Version 3.1.1');
  assert.equal(s.waiting?.who, 'you');
  assert.deepEqual(s.primary, {
    label: 'Finish the release',
    href: '#/portfolio/ios/releases?platform=ios&version=3.1.1&step=confirm',
  });
  assert.equal(s.offerStart, false);
  assert.ok(s.train);
});

test('a release in store review waits on the store: a link to follow it, and a quiet Start release', () => {
  const s = chooseNextStep(input({ trains: releaseTrains([inReview]) }));
  assert.equal(s.kind, 'train');
  assert.equal(s.tone, 'info');
  assert.equal(s.waiting?.who, 'store');
  assert.ok(s.primary && 'href' in s.primary);
  assert.equal(s.offerStart, true);
  assert.equal(
    chooseNextStep(input({ trains: releaseTrains([inReview]), canStart: false })).offerStart,
    false,
  );
});

test('a rejection comes before an approval, and an approval before a release in review', () => {
  const trains = releaseTrains([
    { ...inReview, appId: 'a', version: '1.0.0' },
    { ...approved, appId: 'b', version: '2.0.0' },
    { ...rejected, appId: 'c', version: '3.0.0' },
  ]);
  assert.deepEqual(
    orderTrains(trains).map((t) => t.version),
    ['3.0.0', '2.0.0', '1.0.0'],
  );
  const s = chooseNextStep(input({ trains }));
  assert.equal(s.tone, 'bad');
  // Several releases: none is chosen over the others; each is a row with its own button.
  assert.equal(s.primary, null);
  assert.equal(s.train, null);
  assert.deepEqual(
    s.rows.map((r) => [r.title, r.urgent]),
    [
      ['Version 3.0.0', true],
      ['Version 2.0.0', true],
      ['Version 1.0.0', false],
    ],
  );
});

test('each platform with a release on its way has its own row and its own button, Android in review included', () => {
  const trains = releaseTrainsByPlatform([
    { ...inReview, appId: 'ios', platform: 'ios', version: '2.0.1' },
    { ...inReview, appId: 'mac', platform: 'macos', version: '2.0.1' },
    { ...inReview, appId: 'and', platform: 'android', version: '2.0.1' },
  ]);
  const s = chooseNextStep(input({ trains }));
  assert.equal(s.rows.length, 3);
  assert.deepEqual(
    s.rows.map((r) => r.platforms),
    [['ios'], ['macos'], ['android']],
  );
  assert.ok(s.rows.every((r) => r.waiting?.who === 'store' && !r.urgent && r.href.length > 0));
  assert.equal(new Set(s.rows.map((r) => r.key)).size, 3);
  assert.equal(s.offerStart, true);
});

test('one release on its way stays the big card, with no rows', () => {
  const s = chooseNextStep(input({ trains: releaseTrains([inReview]) }));
  assert.equal(s.rows.length, 0);
  assert.ok(s.train);
  assert.ok(s.primary);
});

test('the release left unfinished is the train, not a second line; the other items stay', () => {
  const unfinished = item({
    id: 'ios:unfinished',
    tone: 'warn',
    text: 'Release left unfinished',
    href: '#/portfolio/ios/releases?step=notes',
    action: 'Open the notes',
  });
  const reviews = item({});
  const withTrain = chooseNextStep(
    input({ trains: releaseTrains([base]), attention: [unfinished, reviews] }),
  );
  assert.deepEqual(
    withTrain.items.map((i) => i.id),
    ['a1:reviews'],
  );
});

test('with no release that could be read, an unfinished release or a bad item leads', () => {
  const unfinished = item({
    id: 'ios:unfinished',
    tone: 'warn',
    text: 'Release left unfinished',
    detail: 'Notes are missing',
    href: '#/x',
    action: 'Open the notes',
  });
  const a = chooseNextStep(input({ attention: [item({}), unfinished] }));
  assert.equal(a.kind, 'attention');
  assert.equal(a.title, 'Release left unfinished');
  assert.deepEqual(a.primary, { label: 'Open the notes', href: '#/x' });
  assert.deepEqual(
    a.items.map((i) => i.id),
    ['a1:reviews'],
  );

  const bad = item({
    id: 'a1:ci',
    tone: 'bad',
    text: 'The last CI build failed',
    action: 'See the run',
  });
  const b = chooseNextStep(input({ attention: [item({}), bad] }));
  assert.equal(b.kind, 'attention');
  assert.equal(b.tone, 'bad');
  assert.equal(b.primary && 'href' in b.primary ? b.primary.label : '', 'See the run');
});

test('a quiet item (new reviews) does not take the button: the step stays Start release, and the item is listed once', () => {
  const s = chooseNextStep(input({ attention: [item({})] }));
  assert.equal(s.kind, 'start');
  assert.deepEqual(
    s.items.map((i) => i.id),
    ['a1:reviews'],
  );
  // The submit control is a control, not a link: it never becomes the primary button.
  const submit = item({
    id: 'a1:submit',
    tone: 'bad',
    href: null,
    submitAppId: 'a1',
    text: 'Draft pushed',
  });
  assert.equal(chooseNextStep(input({ attention: [submit] })).kind, 'start');
});

test('exactly one primary action per state', () => {
  const states = [
    input(),
    input({ canStart: false }),
    input({ trains: releaseTrains([base]) }),
    input({ trains: releaseTrains([inReview]) }),
    input({ trains: releaseTrains([rejected]) }),
    input({ attention: [item({ id: 'ios:unfinished', tone: 'warn', href: '#/x' })] }),
  ];
  for (const s of states) assert.ok(chooseNextStep(s).primary !== null);
});
