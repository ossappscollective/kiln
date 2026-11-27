import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareBuildNumbers, tryCompareBuildNumbers, tryCompareVersions } from '@kiln/core';
import { analyzeCandidates, type StoreBuildFact } from './candidates.ts';
import { deriveAppState } from './derive.ts';
import {
  ANDROID,
  facts,
  failedRun,
  IOS,
  internalTesting,
  iosPipeline,
  iosRelease,
  reportedIos,
  running,
  testflight,
} from './fixtures.ts';
import type { AppFacts } from './types.ts';

/**
 * The release candidate and the versions left behind (docs/state-model.md, "Candidates and obsolete versions"): the version compare with its
 * edge cases, the candidate picked from the TestFlight builds over every combination of live x prepared x TestFlight, and what the model
 * says for each, with the publish, failure, pending and scope dimensions on top.
 */

test('versions compare with the ONE comparator of @kiln/core: 2.00.1 is 2.0.1, 1.0 is 1.0.0, a fifth part or a word is unreadable', () => {
  const cases: [string, string, -1 | 0 | 1 | null][] = [
    ['1.11.6', '1.19.0', -1],
    ['2.00.1', '1.19.0', 1],
    ['2.00.1', '2.0.1', 0],
    ['1.0', '1.0.0', 0],
    ['1.26.2', '1.26.10', -1],
    ['v1.2.0', '1.2.0', 0],
    ['', '1.0.0', null],
    ['next', '1.0.0', null],
  ];
  for (const [a, b, want] of cases) {
    assert.equal(tryCompareVersions(a, b), want, `${a} vs ${b}`);
    if (want !== null) assert.equal(tryCompareVersions(b, a), want === 0 ? 0 : -want);
  }
  assert.equal(compareBuildNumbers('95', '88'), 1);
  assert.equal(tryCompareBuildNumbers('95', null), null);
  assert.equal(compareBuildNumbers('100', '99'), 1);
});

// ---------------------------------------------------------------------------------------------
// The table: live x prepared x TestFlight

type Live = 'none' | '1.19.0';
type Prepared =
  | 'none'
  | 'lower'
  | 'equal'
  | 'higher_no_build'
  | 'candidate_build_attached'
  | 'candidate_other_build';
type Flight =
  | 'none'
  | 'older'
  | 'newer'
  | 'same_version_higher_build'
  | 'same_version_same_build'
  | 'processing'
  | 'expired'
  | 'invalid'
  | 'unreadable';

const LIVES: Live[] = ['none', '1.19.0'];
const PREPARED: Prepared[] = [
  'none',
  'lower',
  'equal',
  'higher_no_build',
  'candidate_build_attached',
  'candidate_other_build',
];
const FLIGHTS: Flight[] = [
  'none',
  'older',
  'newer',
  'same_version_higher_build',
  'same_version_same_build',
  'processing',
  'expired',
  'invalid',
  'unreadable',
];

const draft = (version: string, build: string | null) =>
  iosRelease({
    id: `draft-${version}`,
    version,
    build,
    status: 'draft',
    rawState: 'PREPARE_FOR_SUBMISSION',
  });

const releasesFor = (live: Live, prepared: Prepared) => {
  const list = [];
  if (live !== 'none')
    list.push(iosRelease({ id: 'live', version: '1.19.0', build: '88', status: 'live' }));
  if (prepared === 'lower') list.push(draft('1.11.6', null));
  if (prepared === 'equal') list.push(draft('1.19.0', null));
  if (prepared === 'higher_no_build') list.push(draft('2.00.1', null));
  if (prepared === 'candidate_build_attached') list.push(draft('2.00.1', '95'));
  if (prepared === 'candidate_other_build') list.push(draft('2.0.1', '90'));
  return list;
};

const buildsFor = (flight: Flight): StoreBuildFact[] => {
  switch (flight) {
    case 'none':
      return [];
    case 'older':
      return [testflight({ version: '1.18.0', buildNumber: '80' })];
    case 'newer':
      return [testflight()];
    case 'same_version_higher_build':
      return [testflight({ version: '1.19.0', buildNumber: '89' })];
    case 'same_version_same_build':
      return [testflight({ version: '1.19.0', buildNumber: '88' })];
    case 'processing':
      return [testflight({ state: 'processing' })];
    case 'expired':
      return [testflight({ expired: true })];
    case 'invalid':
      return [testflight({ state: 'invalid' })];
    case 'unreadable':
      return [testflight({ version: '2.0.0-beta' })];
  }
};

const analyze = (live: Live, prepared: Prepared, flight: Flight) =>
  analyzeCandidates({
    appId: IOS.id,
    platform: 'ios',
    releases: releasesFor(live, prepared),
    builds: buildsFor(flight),
  });

test('candidates over every combination: never an old build, never an obsolete version, the plan follows the version in preparation', () => {
  let n = 0;
  for (const live of LIVES)
    for (const prepared of PREPARED)
      for (const flight of FLIGHTS) {
        n++;
        const where = `live=${live} prepared=${prepared} testflight=${flight}`;
        const a = analyze(live, prepared, flight);
        // The versions left behind are exactly the preparable ones that are not newer than what is live.
        const wantObsolete =
          live === '1.19.0' && (prepared === 'lower' || prepared === 'equal')
            ? [prepared === 'lower' ? '1.11.6' : '1.19.0']
            : [];
        assert.deepEqual(
          a.obsolete.map((o) => o.version),
          wantObsolete,
          where,
        );
        // The best candidate is ready, not obsolete, and newer than what is live.
        if (a.best !== null) {
          assert.equal(a.best.ready, true, where);
          assert.notEqual(a.best.obsolete, true, where);
          if (live === '1.19.0') {
            const cmp = tryCompareVersions(a.best.version, '1.19.0');
            assert.ok(
              cmp === 1 || (cmp === 0 && Number(a.best.buildNumber) > 88),
              `${where}: ${a.best.version}`,
            );
          }
        }
        // Which flights produce a candidate at all.
        const withLive =
          flight === 'newer' ||
          // A pre-release (2.0.0-beta) is judged by the shared comparator: newer than 1.19.0, so a candidate (its create is refused below).
          flight === 'unreadable' ||
          (flight === 'same_version_higher_build' && live === '1.19.0');
        const withoutLive =
          live === 'none' &&
          (flight === 'older' ||
            flight === 'same_version_same_build' ||
            flight === 'same_version_higher_build' ||
            flight === 'unreadable' ||
            flight === 'newer');
        assert.equal(a.best !== null, withLive || withoutLive, where);
        // A build still processing is said, never the candidate; an expired, invalid or unreadable one is nothing.
        if (flight === 'processing') {
          assert.equal(a.best, null, where);
          assert.ok(a.processing !== null, where);
        }
        if (flight === 'expired' || flight === 'invalid') assert.equal(a.best, null, where);
        // A pre-release is a candidate, but the store cannot create it (invalid_version): the plan is `blocked`, never offered.
        if (flight === 'unreadable' && a.plan !== null && prepared === 'none')
          assert.equal(a.plan.kind, 'blocked', where);
        // The plan.
        if (a.best === null) assert.equal(a.plan, null, where);
        else {
          assert.ok(a.plan !== null, where);
          assert.equal(a.plan?.candidate, a.best, where);
          // An obsolete version is never what the plan is about.
          if (a.plan?.release)
            assert.ok(!a.obsolete.some((o) => o.releaseId === a.plan?.release?.id), where);
          // A draft takes the candidate when its version is the candidate's (and it is not left behind by what is live).
          const draftVersion =
            prepared === 'higher_no_build' || prepared === 'candidate_build_attached'
              ? '2.00.1'
              : prepared === 'candidate_other_build'
                ? '2.0.1'
                : live === 'none' && prepared === 'equal'
                  ? '1.19.0'
                  : live === 'none' && prepared === 'lower'
                    ? '1.11.6'
                    : null;
          const prepares =
            draftVersion !== null && tryCompareVersions(draftVersion, a.best.version) === 0;
          // The store refuses to create a version while another is editable, or one that is not 1-3 numbers: said (`blocked`), never offered.
          // A new build of the version that is live cannot become a version either (it exists already).
          const refused =
            prepared !== 'none' ||
            flight === 'unreadable' ||
            (flight === 'same_version_higher_build' && live === '1.19.0');
          const want = !prepares
            ? refused
              ? 'blocked'
              : 'create_release'
            : prepared === 'candidate_build_attached'
              ? 'submit'
              : 'attach_build';
          assert.equal(a.plan?.kind, want, where);
        }
      }
  assert.equal(n, LIVES.length * PREPARED.length * FLIGHTS.length);
});

test('an older TestFlight build is flagged obsolete, not dropped (the Builds page and the model agree it is ignored)', () => {
  const a = analyze('1.19.0', 'none', 'older');
  assert.equal(a.best, null);
  assert.equal(a.candidates.length, 1);
  assert.equal(a.candidates[0]?.obsolete, true);
  assert.equal(a.candidates[0]?.reason, 'older_than_live');
  const same = analyze('1.19.0', 'none', 'same_version_same_build');
  assert.equal(same.candidates[0]?.reason, 'same_as_live');
});

test('the newest build wins: the highest version, then the highest build number; a build already in review is not a candidate', () => {
  const a = analyzeCandidates({
    appId: IOS.id,
    platform: 'ios',
    releases: [iosRelease({ version: '1.19.0', build: '88', status: 'live' })],
    builds: [
      testflight({ version: '2.00.1', buildNumber: '95' }),
      testflight({ version: '2.00.1', buildNumber: '97' }),
      testflight({ version: '2.00.0', buildNumber: '99' }),
      testflight({ version: '1.26.2', buildNumber: '165' }),
    ],
  });
  assert.equal(a.best?.version, '2.00.1');
  assert.equal(a.best?.buildNumber, '97');
  const inReview = analyzeCandidates({
    appId: IOS.id,
    platform: 'ios',
    releases: [
      iosRelease({ version: '1.19.0', build: '88', status: 'live' }),
      iosRelease({ id: 'r2', version: '2.00.1', build: '95', status: 'in_review' }),
    ],
    builds: [testflight()],
  });
  assert.equal(inReview.best, null, 'the version is past Prepare: the release pipeline owns it');
});

test('Google Play: a testing-track release is a candidate only when its codes are newer than production; a draft below production is obsolete', () => {
  const prod = (codes: string[], status: 'live' | 'draft') => ({
    ...internalTesting(ANDROID),
    id: `prod-${codes.join('-')}-${status}`,
    version: '2.8.0',
    track: 'production',
    status,
    versionCodes: codes,
    build: codes[0] ?? null,
  });
  const newer = analyzeCandidates({
    appId: ANDROID.id,
    platform: 'android',
    releases: [prod(['160'], 'live'), internalTesting()],
    builds: [],
  });
  assert.equal(newer.promote[0]?.codes[0], '167');
  assert.equal(newer.best?.buildNumber, '167');
  assert.equal(newer.best?.channel, 'play_internal');
  const older = analyzeCandidates({
    appId: ANDROID.id,
    platform: 'android',
    releases: [prod(['170'], 'live'), internalTesting()],
    builds: [],
  });
  assert.equal(older.promote.length, 0, 'codes 167 are not newer than production 170');
  assert.equal(older.best, null);
  const stale = analyzeCandidates({
    appId: ANDROID.id,
    platform: 'android',
    releases: [prod(['170'], 'live'), prod(['150'], 'draft')],
    builds: [],
  });
  assert.deepEqual(
    stale.obsolete.map((o) => o.build),
    ['150'],
  );
});

// ---------------------------------------------------------------------------------------------
// The model: the exact scenario of the report, and the priority around it

test('the report: 1.19.0 (88) is live, 1.11.6 is still in Prepare, TestFlight has 2.00.1 (95): the store would refuse the create, so the card says why and links to the store instead of a button that ends in a refusal', () => {
  const s = deriveAppState(reportedIos(), 'ios');
  assert.equal(s.phase, 'candidate_blocked');
  assert.equal(s.headline, 'Build 95 (2.00.1) cannot start a release');
  assert.match(s.reason, /1\.11\.6/);
  assert.match(s.reason, /Edit or remove it in App Store Connect/);
  assert.equal(s.primaryAction.action, 'follow_review');
  assert.equal(s.primaryAction.label, 'Open App Store Connect');
  assert.match(s.primaryAction.href ?? '', /appstoreconnect\.apple\.com/);
  assert.equal(s.primaryAction.external, true);
  assert.doesNotMatch(`${s.headline} ${s.reason}`, /build 92/);
  assert.ok(![s.primaryAction, ...s.secondaryActions].some((a) => a.action === 'create_release'));
  assert.deepEqual(
    s.obsolete.map((o) => [o.version, o.liveVersion]),
    [['1.11.6', '1.19.0']],
  );
  assert.equal(s.candidates.length, 1);
  assert.equal(s.candidates[0]?.plan.candidate.buildNumber, '95');
  assert.equal(s.candidates[0]?.plan.kind, 'blocked');
  // The old version is also a quiet notice with advice.
  const notice = s.notices.find((x) => x.kind === 'obsolete_version');
  assert.match(notice?.text ?? '', /unused older version 1\.11\.6/);
  assert.match(notice?.href ?? '', /appstoreconnect\.apple\.com/);
  assert.ok(![s.primaryAction, ...s.secondaryActions].some((a) => /1\.11\.6/.test(a.label)));
});

test('the same report with the draft ahead of live (2.0.0, not left behind): the right action is to attach the build THERE', () => {
  const s = deriveAppState(
    reportedIos({
      releases: {
        [IOS.id]: [
          iosRelease({ id: 'live', version: '1.19.0', build: '88', status: 'live' }),
          iosRelease({
            id: 'd',
            version: '2.0.0',
            build: null,
            status: 'draft',
            rawState: 'PREPARE_FOR_SUBMISSION',
          }),
        ],
      },
    }),
    'ios',
  );
  assert.equal(s.phase, 'version_in_prep');
  assert.equal(s.primaryAction.action, 'attach_build');
  assert.match(s.headline, /2\.0\.0/);
});

test('the report, without the TestFlight build: the old draft says nothing, the card is quiet and offers Start release', () => {
  const s = deriveAppState(reportedIos({ builds: { [IOS.id]: [] } }), 'ios');
  assert.equal(s.phase, 'ready_to_release');
  assert.doesNotMatch(`${s.headline} ${s.reason}`, /1\.11\.6|build 92/);
  assert.equal(s.obsolete.length, 1);
});

test('the report with the old build 92 only (not newer than live): it is ignored, however ready it is', () => {
  const s = deriveAppState(
    reportedIos({ builds: { [IOS.id]: [testflight({ buildNumber: '92', version: '1.11.6' })] } }),
    'ios',
  );
  assert.notEqual(s.phase, 'candidate_ready');
  assert.equal(s.candidates.length, 0);
});

test('with only the pipeline (no builds read, no releases loaded): the newest build of the pipeline is the candidate', () => {
  const f = reportedIos({
    builds: undefined,
    releases: {},
    pipelines: {
      [IOS.id]: iosPipeline(
        'live',
        { version: '1.19.0', build: '88', status: 'live' },
        { buildNumber: '95', version: '2.00.1' },
      ),
    },
  });
  const s = deriveAppState(f, 'ios');
  assert.equal(s.headline, 'Create release 2.00.1 from TestFlight build 95');
});

test('a version already in preparation for the candidate: attach the build, then submit', () => {
  const base = reportedIos();
  const live = iosRelease({ id: 'rel-1.19.0', version: '1.19.0', build: '88', status: 'live' });
  const attach = deriveAppState(
    {
      ...base,
      releases: { [IOS.id]: [live, draft('2.0.1', null)] },
      pipelines: {
        [IOS.id]: iosPipeline('draft', { version: '2.0.1', build: null, status: 'draft' }, null),
      },
    },
    'ios',
  );
  assert.equal(attach.phase, 'version_in_prep');
  assert.equal(attach.headline, 'Attach build 95 to 2.00.1');
  assert.equal(attach.primaryAction.action, 'attach_build');
  const submit = deriveAppState(
    {
      ...base,
      releases: { [IOS.id]: [live, draft('2.0.1', '95')] },
      pipelines: {
        [IOS.id]: iosPipeline('draft', { version: '2.0.1', build: '95', status: 'draft' }, null),
      },
    },
    'ios',
  );
  assert.equal(submit.phase, 'version_in_prep');
  assert.equal(submit.headline, 'Submit 2.00.1 for review');
  assert.match(submit.primaryAction.href ?? '', /step=confirm/);
});

/** The report without the old draft: nothing is in preparation, so creating 2.00.1 is allowed and the card offers it. */
const cleanIos = (over: Partial<AppFacts> = {}): AppFacts =>
  reportedIos({
    releases: {
      [IOS.id]: [iosRelease({ id: 'rel-1.19.0', version: '1.19.0', build: '88', status: 'live' })],
    },
    pipelines: { [IOS.id]: null },
    ...over,
  });

test('priority: publishing, a failed publish and pending changes stay above the candidate; it returns when they are gone', () => {
  const pending = deriveAppState(
    cleanIos({ pending: { [IOS.id]: { count: 4, blocking: 0 } } }),
    'ios',
  );
  assert.equal(pending.phase, 'changes_pending');
  assert.equal(pending.primaryAction.action, 'show_pending');
  assert.equal(
    pending.secondaryActions[0]?.action,
    'create_release',
    'the candidate is the quiet second button',
  );
  const publishing = deriveAppState(cleanIos({ publishing: { [IOS.id]: running() } }), 'ios');
  assert.equal(publishing.phase, 'publishing');
  assert.equal(
    publishing.candidates[0]?.offer.enabled,
    false,
    'nothing writes while a publish runs',
  );
  const failed = deriveAppState(cleanIos({ lastRun: { [IOS.id]: failedRun('ios') } }), 'ios');
  assert.equal(failed.phase, 'publish_failed');
  assert.equal(failed.candidates[0]?.offer.enabled, false);
  assert.equal(failed.candidates[0]?.offer.disabledReason, 'Resolve the failed publish first.');
});

test('scope: Android never shows the iOS candidate; Both names the platform; Android keeps its promote', () => {
  const f = cleanIos({
    records: [IOS, ANDROID],
    releases: { ...cleanIos().releases, [ANDROID.id]: [internalTesting()] },
  });
  const android = deriveAppState(f, 'android');
  assert.equal(android.candidates.length, 0);
  assert.equal(android.promotion?.option.codes[0], '167');
  assert.doesNotMatch(android.headline, /2\.00\.1/);
  const ios = deriveAppState(f, 'ios');
  assert.equal(ios.headline, 'Create release 2.00.1 from TestFlight build 95');
  assert.equal(ios.promotion, null);
  const both = deriveAppState(f, 'both');
  assert.equal(both.candidates.length, 1);
  assert.equal(both.promotion?.option.codes[0], '167');
  assert.match(`${both.headline} ${both.reason}`, /2\.00\.1/);
});

test('the viewer cannot create a release: the offer is there, off, with the reason', () => {
  const s = deriveAppState(cleanIos({ role: 'viewer' }), 'ios');
  assert.equal(s.primaryAction.action, 'create_release');
  assert.equal(s.primaryAction.enabled, false);
  assert.equal(s.primaryAction.disabledReason, 'Your role cannot do this.');
});

test('every combination of the table, through the model: the card never names a version that is left behind, and the priority holds', () => {
  for (const live of LIVES)
    for (const prepared of PREPARED)
      for (const flight of FLIGHTS)
        for (const publishing of [false, true])
          for (const failed of [false, true])
            for (const pending of [0, 3]) {
              const f: AppFacts = facts({
                records: [IOS],
                releases: { [IOS.id]: releasesFor(live, prepared) },
                builds: { [IOS.id]: buildsFor(flight) },
                pending: { [IOS.id]: { count: pending, blocking: 0 } },
                publishing: { [IOS.id]: publishing ? running() : null },
                lastRun: { [IOS.id]: failed ? failedRun('ios') : null },
                pipelines: {
                  [IOS.id]:
                    prepared === 'lower'
                      ? iosPipeline(
                          'draft',
                          { version: '1.11.6', build: null, status: 'draft' },
                          null,
                        )
                      : null,
                },
              });
              const where = `live=${live} prepared=${prepared} flight=${flight} publishing=${publishing} failed=${failed} pending=${pending}`;
              const s = deriveAppState(f, 'ios');
              // 1.11.6 is left behind only relative to a live 1.19.0 (with nothing live it is a plain draft).
              // The headline never names it; only a refused create may name it, as the reason (an editable version is in the way).
              if (live === '1.19.0' || prepared !== 'lower')
                assert.doesNotMatch(s.headline, /1\.11\.6/, where);
              if ((live === '1.19.0' || prepared !== 'lower') && s.phase !== 'candidate_blocked')
                assert.doesNotMatch(`${s.headline} ${s.reason}`, /1\.11\.6/, where);
              if (publishing) assert.equal(s.phase, 'publishing', where);
              else if (failed) assert.equal(s.phase, 'publish_failed', where);
              else if (pending > 0) assert.equal(s.phase, 'changes_pending', where);
              // The candidate's button is off exactly while a publish runs or has failed.
              for (const c of s.candidates)
                assert.equal(c.offer.enabled, !publishing && !failed, where);
            }
});
