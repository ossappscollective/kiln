import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReleaseTable, liveRowKeys, splitCurrent } from '../releases-table.ts';
import { IOS, iosRelease } from './fixtures.ts';
import { releaseFactsOf } from './release-facts.ts';

// iOS: 1.19.0 phased over a live 1.18.0, an old draft 1.11.6 in preparation.
const phased = [
  iosRelease({
    id: 'a',
    version: '1.19.0',
    build: '88',
    status: 'rolling_out',
    rawState: 'READY_FOR_SALE',
    rolloutFraction: 0.2,
  }),
  iosRelease({
    id: 'b',
    version: '1.18.0',
    build: '80',
    status: 'live',
    rawState: 'READY_FOR_SALE',
  }),
  iosRelease({
    id: 'c',
    version: '1.11.6',
    build: null,
    status: 'draft',
    rawState: 'PREPARE_FOR_SUBMISSION',
  }),
];

test('a phased 1.19.0 is live; the old draft is never the latest release', () => {
  const facts = releaseFactsOf(phased, 'ios');
  assert.equal(facts.live?.version, '1.19.0');
  assert.equal(facts.latest?.version, '1.19.0');
  // It is the release in flight (rolling out), not a settled live one.
  assert.equal(facts.inFlight?.version, '1.19.0');
});

test('with only the old draft and a live release, the latest is the live one and nothing is in flight', () => {
  const facts = releaseFactsOf(
    [phased[1] as (typeof phased)[number], phased[2] as (typeof phased)[number]],
    'ios',
  );
  assert.equal(facts.live?.version, '1.18.0');
  assert.equal(facts.latest?.version, '1.18.0');
  assert.equal(facts.inFlight, null);
});

test('the releases table calls the phased release live too', () => {
  const groups = buildReleaseTable({
    releases: { [IOS.id]: phased },
    plans: null,
    builds: {},
    appIds: [IOS.id],
  });
  const keys = liveRowKeys(groups);
  assert.equal(keys.get('ios'), `${IOS.id}:a`);
  const current = splitCurrent(groups)
    .current.flatMap((g) => g.rows)
    .map((r) => r.version);
  assert.ok(current.includes('1.19.0'));
});

test('Google Play: only the production track is live', () => {
  const play = (over: Record<string, unknown>) => ({
    ...iosRelease({}),
    platform: 'android' as const,
    appId: 'android-1',
    ...over,
  });
  const list = [
    play({
      id: 'p',
      version: '3.0.0',
      track: 'production',
      status: 'live',
      versionCodes: ['30'],
      build: '30',
    }),
    play({
      id: 'i',
      version: '3.1.0',
      track: 'internal',
      status: 'live',
      versionCodes: ['31'],
      build: '31',
    }),
  ];
  const facts = releaseFactsOf(list as never, 'android');
  assert.equal(facts.live?.version, '3.0.0');
});
