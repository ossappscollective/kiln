import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useLocale } from './i18n/test-setup.ts';
import {
  blockedStepReason,
  blockerCount,
  checklist,
  confirmButtonText,
  firstFix,
  isReadinessProblem,
  type PlanReadiness,
  readinessLine,
  readinessView,
  stepOfLine,
  submitChoice,
  unknownNote,
} from './publish-readiness.ts';

const blocker = (
  code: string,
  kind: 'listing' | 'screenshots' | 'notes' | 'build' | 'store' | 'push',
  over: { locale?: string; item?: string; href?: string; message?: string } = {},
) => ({
  code,
  message: over.message ?? `${code} message`,
  locale: over.locale,
  item: over.item,
  fix: { kind, href: over.href },
});

/** The user's case: three texts empty in fr-FR and 12 screenshots where 10 are allowed. */
const USER_BLOCKERS = [
  blocker('missing_text', 'listing', {
    locale: 'fr-FR',
    item: 'description',
    href: '#/portfolio/a/listing?platform=ios&view=text&locale=fr-FR',
    message: 'Description is empty in fr-FR',
  }),
  blocker('missing_text', 'listing', {
    locale: 'fr-FR',
    item: 'keywords',
    href: '#/portfolio/a/listing?platform=ios&view=text&locale=fr-FR',
    message: 'Keywords is empty in fr-FR',
  }),
  blocker('missing_text', 'listing', {
    locale: 'fr-FR',
    item: 'support_url',
    href: '#/portfolio/a/listing?platform=ios&view=text&locale=fr-FR',
    message: 'Support URL is empty in fr-FR',
  }),
  blocker('asset_spec', 'screenshots', {
    locale: 'en-US',
    item: 'apple.screenshot.count',
    href: '#/portfolio/a/listing?platform=ios&view=graphics&locale=en-US',
    message: 'At most 10 screenshots per device size. en-US iPad 13" / 12.9": 12 found.',
  }),
];

const readiness = (
  blockers: ReturnType<typeof blocker>[],
  unknown: string[] = [],
): PlanReadiness => ({
  submit: {
    ready: blockers.length === 0,
    blockers,
    unknown,
    predicted: true,
    checkedAt: 1,
  },
});

const iosApp = { id: 'a', name: 'Kiln', platform: 'ios' as const, store: 'appstore' };
const stepOf = (
  type: string,
  over: Partial<{ requested: boolean; included: boolean; availability: string }> = {},
) => ({ type, requested: false, included: true, availability: 'available', ...over });

test('the user case reads as "4 things to fix" with the server sentences, how to fix and where', () => {
  const v = readinessView({ app: iosApp, readiness: readiness(USER_BLOCKERS, ['image_not_ready']) });
  assert.ok(v);
  assert.equal(v.state, 'blocked');
  assert.equal(v.count, 4);
  assert.equal(v.title, 'Submit would not run yet: 4 things to fix');
  assert.deepEqual(
    v.lines.map((l) => l.message),
    [
      'Description is empty in fr-FR',
      'Keywords is empty in fr-FR',
      'Support URL is empty in fr-FR',
      'At most 10 screenshots per device size. en-US iPad 13" / 12.9": 12 found.',
    ],
  );
  assert.match(v.lines[0]?.fix ?? '', /Listing page/);
  assert.equal(v.lines[0]?.where, 'Open the listing texts');
  assert.equal(v.lines[3]?.where, 'Open the graphics');
  assert.equal(v.lines[3]?.external, false);
  assert.equal(v.note, 'Checked after the push: image processing.');
});

test('a draft with nothing in the way is ready and says so', () => {
  const v = readinessView({ app: iosApp, readiness: readiness([]) });
  assert.equal(v?.state, 'ready');
  assert.equal(v?.title, 'Ready to submit for review');
  assert.equal(v?.count, 0);
  assert.equal(v?.note, null);
});

test('a single blocker uses the singular; no readiness from the server is no view', () => {
  const v = readinessView({ app: iosApp, readiness: readiness(USER_BLOCKERS.slice(0, 1)) });
  assert.equal(v?.title, 'Submit would not run yet: 1 thing to fix');
  assert.equal(readinessView({ app: iosApp, readiness: null }), null);
  assert.equal(readinessView({ app: iosApp }), null);
});

test('the codes only known after the push become a neutral note; unnamed codes are left out', () => {
  assert.equal(unknownNote(['image_not_ready']), 'Checked after the push: image processing.');
  assert.match(unknownNote(['image_not_ready', 'play_review_state_unknown']) ?? '', /image processing, whether/);
  assert.equal(unknownNote(['something_new']), null);
  assert.equal(unknownNote([]), null);
});

test('a store blocker opens the store console of its platform, in a new tab', () => {
  const ios = readinessLine('ios', blocker('already_submitted', 'store'));
  assert.equal(ios.external, true);
  assert.match(ios.href ?? '', /appstoreconnect\.apple\.com/);
  assert.equal(ios.where, 'Open App Store Connect');
  const play = readinessLine('android', blocker('already_submitted', 'store'));
  assert.match(play.href ?? '', /play\.google\.com\/console/);
  assert.equal(play.where, 'Open Play Console');
});

test('an unknown code gets the generic way to fix it, a push blocker has no place', () => {
  const line = readinessLine('ios', blocker('brand_new_code', 'push'));
  assert.equal(line.fix, 'Fix what the message says, then push the draft.');
  assert.equal(line.where, null);
  assert.equal(line.href, null);
});

test('a message is cleaned of control characters and cut', () => {
  const line = readinessLine(
    'ios',
    blocker('missing_text', 'listing', { message: `a\u0000b\n\n${'x'.repeat(400)}` }),
  );
  assert.ok(line.message.length <= 300);
  assert.ok(line.message.startsWith('a b x'));
});

test('the choice appears only when a requested submit is blocked and there are certain blockers', () => {
  const r = readiness(USER_BLOCKERS);
  const blockedPair = [
    stepOf('push_draft'),
    stepOf('submit', { requested: true, included: false, availability: 'blocked' }),
  ];
  assert.deepEqual(submitChoice({ readiness: r, steps: blockedPair }), { count: 4 });
  // The default plan leaves the submit out without being asked: nothing to choose.
  assert.equal(
    submitChoice({
      readiness: r,
      steps: [stepOf('push_draft'), stepOf('submit', { included: false, availability: 'blocked' })],
    }),
    null,
  );
  // Nothing blocks.
  assert.equal(submitChoice({ readiness: readiness([]), steps: blockedPair }), null);
  // The push_and_submit of one commit is the same.
  assert.deepEqual(
    submitChoice({
      readiness: r,
      steps: [stepOf('push_and_submit', { requested: true, included: false, availability: 'blocked' })],
    }),
    { count: 4 },
  );
});

test('"Submit left out" is set when the plan blocked a submit step', () => {
  const v = readinessView({
    app: iosApp,
    readiness: readiness(USER_BLOCKERS),
    steps: [stepOf('push_draft'), stepOf('submit', { availability: 'blocked', included: false })],
  });
  assert.equal(v?.submitLeftOut, true);
  const w = readinessView({ app: iosApp, readiness: readiness(USER_BLOCKERS), steps: [stepOf('push_draft')] });
  assert.equal(w?.submitLeftOut, false);
});

test('"Fix the blockers first" goes to the first place in Kiln, else the store, else nowhere', () => {
  const v = readinessView({ app: iosApp, readiness: readiness(USER_BLOCKERS) });
  assert.ok(v);
  assert.deepEqual(firstFix(v), {
    href: '#/portfolio/a/listing?platform=ios&view=text&locale=fr-FR',
    external: false,
  });
  const store = readinessView({ app: iosApp, readiness: readiness([blocker('already_submitted', 'store')]) });
  assert.equal(store && firstFix(store)?.external, true);
  const push = readinessView({ app: iosApp, readiness: readiness([blocker('x', 'push')]) });
  assert.equal(push && firstFix(push), null);
});

test('the stepper checklist ties each blocker to the step that fixes it', () => {
  const v = readinessView({
    app: iosApp,
    readiness: readiness([
      ...USER_BLOCKERS,
      blocker('no_build', 'build'),
      blocker('already_submitted', 'store'),
    ]),
  });
  assert.ok(v);
  assert.deepEqual(
    checklist(v).map((i) => i.step),
    ['notes', 'notes', 'notes', 'assets', 'build', null],
  );
  assert.equal(stepOfLine({ kind: 'notes' }), 'notes');
  assert.equal(stepOfLine({ kind: 'push' }), null);
});

test('the last button says what happens: with blockers the submit is not part of it', () => {
  assert.equal(confirmButtonText(0, 'Review and push'), 'Review and push');
  assert.equal(confirmButtonText(1, 'Review and push'), 'Review and push the draft (1 thing blocks the submit)');
  assert.equal(confirmButtonText(4, 'x'), 'Review and push the draft (4 things block the submit)');
});

test('the blocked step sentence and the problem codes that are listed once', () => {
  assert.equal(blockedStepReason(4), 'Blocked: 4 things to fix before it can be submitted.');
  assert.equal(blockedStepReason(1), 'Blocked: 1 thing to fix before it can be submitted.');
  assert.equal(isReadinessProblem('submit_blocked_missing_text'), true);
  assert.equal(isReadinessProblem('push_failed'), false);
  assert.equal(blockerCount({ readiness: readiness(USER_BLOCKERS) }), 4);
  assert.equal(blockerCount({}), 0);
});

test('French is used when it is the active language', () => {
  useLocale('fr');
  try {
    const v = readinessView({ app: iosApp, readiness: readiness(USER_BLOCKERS) });
    assert.match(v?.title ?? '', /4/);
    assert.notEqual(v?.title, 'Submit would not run yet: 4 things to fix');
  } finally {
    useLocale('en');
  }
});

test('the App Review Information blockers: the server sentence, how to fix it, the console to open and the version it can be copied from', () => {
  const review = {
    code: 'no_review_contact',
    message: 'The App Review contact information is incomplete: phone number, email address are missing.',
    params: { missing: 'contactPhone,contactEmail', from: '1.19.0' },
    fix: { kind: 'review' as const, href: null },
  };
  const demo = {
    code: 'no_review_demo_account',
    message: 'App Review information says a demo account is required, but its user name or password is empty.',
    params: { missing: 'demoAccountPassword' },
    fix: { kind: 'review' as const, href: null },
  };
  const v = readinessView({ app: iosApp, readiness: readiness([review as never, demo as never]) });
  assert.ok(v);
  assert.equal(v.count, 2);
  const [a, b] = v.lines;
  assert.match(a?.fix ?? '', /copy it from the previous version here, or fill it in App Store Connect/);
  assert.equal(a?.where, 'Open App Review Information in App Store Connect');
  assert.equal(a?.href, 'https://appstoreconnect.apple.com/apps');
  assert.equal(a?.external, true);
  assert.equal(a?.reviewFrom, '1.19.0');
  assert.equal(a?.kind, 'review');
  assert.match(b?.fix ?? '', /demo account/);
  assert.equal(b?.reviewFrom, null);
  // fixed in the store's console or by copying, never a step of the stepper
  assert.equal(stepOfLine(a as never), null);
  assert.deepEqual(firstFix(v), { href: 'https://appstoreconnect.apple.com/apps', external: true });
  // no value in what a person reads
  assert.ok(!JSON.stringify(v).includes('@'));
});
