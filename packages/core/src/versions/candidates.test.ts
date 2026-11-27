import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Platform } from '../platform.ts';
import type { ReleaseState } from '../release/lifecycle.ts';
import {
  analyzeCandidates,
  pipelineIsObsolete,
  promoteOptionsOf,
  type StoreBuildFact,
  stallLeftBehind,
} from './candidates.ts';
import type { ReleaseFact } from './live.ts';

/**
 * The candidate model, ported from apps/web/src/lib/app-state/candidates.ts (live x prepared x TestFlight), plus what the audit asked
 * for: the server's refusals (editable_version_exists, not_higher, 4-part version) make the plan `blocked`, a pre-release is judged.
 */

type R = ReleaseFact & { id: string; appId: string; platform: Platform };

const rel = (id: string, version: string, status: ReleaseState, build: string | null = null, extra: Partial<R> = {}): R => ({
  id,
  appId: 'app',
  platform: 'ios',
  version,
  track: null,
  build,
  status,
  versionCodes: null,
  ...extra,
});
const play = (id: string, version: string, track: string, status: ReleaseState, codes: string[]): R =>
  rel(id, version, status, null, { platform: 'android', track, versionCodes: codes });

const flight = (buildNumber: string, version: string | null, extra: Partial<StoreBuildFact> = {}): StoreBuildFact => ({
  buildNumber,
  version,
  state: 'processed',
  expired: false,
  uploadedAt: 1_000 + Number(buildNumber),
  channel: 'testflight',
  tracks: [],
  ...extra,
});

const ios = (releases: R[], builds: StoreBuildFact[]) =>
  analyzeCandidates({ appId: 'app', platform: 'ios', releases, builds });

test('no live version: the newest processed build is the first release', () => {
  const a = ios([], [flight('1', '1.0.0'), flight('2', '1.0.0')]);
  assert.equal(a.live, null);
  assert.equal(a.best?.buildNumber, '2');
  assert.equal(a.best?.reason, 'first_release');
  assert.equal(a.plan?.kind, 'create_release');
});

test('1.19.0 live, TestFlight 1.19.0 build 90 > live build 88: a newer build of the live version', () => {
  const a = ios([rel('l', '1.19.0', 'live', '88')], [flight('90', '1.19.0'), flight('85', '1.19.0')]);
  assert.equal(a.best?.buildNumber, '90');
  assert.equal(a.best?.reason, 'newer_build');
  const old = a.candidates.find((c) => c.buildNumber === '85');
  assert.equal(old?.obsolete, true);
  assert.equal(old?.reason, 'same_as_live');
});

test('phased 1.19.0 (rolling_out) is live: a 1.18.x build and a 1.18.x draft are left behind (three screens, one answer)', () => {
  const releases = [rel('p', '1.19.0', 'rolling_out', '88'), rel('d', '1.18.5', 'draft'), rel('o', '1.11.6', 'draft')];
  const a = ios(releases, [flight('70', '1.18.5'), flight('99', '2.0.0')]);
  assert.equal(a.live?.version, '1.19.0');
  assert.deepEqual(a.obsolete.map((o) => o.version), ['1.18.5', '1.11.6']);
  assert.equal(a.obsolete[0]?.reason, 'older_than_live');
  assert.equal(a.candidates.find((c) => c.buildNumber === '70')?.obsolete, true);
  assert.equal(a.best?.version, '2.0.0');
});

test('an obsolete draft blocks creating the next version: the plan says why, it never offers a refused create', () => {
  const a = ios([rel('l', '1.19.0', 'live', '88'), rel('o', '1.11.6', 'draft')], [flight('95', '2.0.1')]);
  assert.equal(a.best?.version, '2.0.1');
  assert.equal(a.plan?.kind, 'blocked');
  if (a.plan?.kind === 'blocked') assert.deepEqual(a.plan.refusal, ['editable_version_exists']);
});

test('a candidate lower than an in-review version is blocked not_higher (newer than live, refused by the server)', () => {
  const a = ios([rel('l', '1.19.0', 'live', '88'), rel('r', '2.5.0', 'in_review', '1')], [flight('95', '2.0.1')]);
  assert.equal(a.best?.version, '2.0.1');
  assert.equal(a.plan?.kind, 'blocked');
  if (a.plan?.kind === 'blocked') assert.deepEqual(a.plan.refusal, ['not_higher']);
});

test('a four-part version is a candidate but the store cannot create it: blocked invalid_version', () => {
  const a = ios([rel('l', '2.00.1', 'live', '88')], [flight('95', '2.00.1.90')]);
  assert.equal(a.best?.version, '2.00.1.90');
  assert.equal(a.plan?.kind, 'blocked');
  if (a.plan?.kind === 'blocked') assert.deepEqual(a.plan.refusal, ['invalid_version']);
});

test('the plan: create, attach the build, submit', () => {
  const live = rel('l', '1.19.0', 'live', '88');
  const create = ios([live], [flight('95', '2.0.1')]);
  assert.equal(create.plan?.kind, 'create_release');
  const attach = ios([live, rel('d', '2.00.1', 'draft', '90')], [flight('95', '2.0.1')]);
  assert.equal(attach.plan?.kind, 'attach_build');
  const noBuild = ios([live, rel('d', '2.0.1', 'draft', null)], [flight('95', '2.0.1')]);
  assert.equal(noBuild.plan?.kind, 'attach_build');
  const submit = ios([live, rel('d', '2.0.1', 'build_chosen', '95')], [flight('95', '2.0.1')]);
  assert.equal(submit.plan?.kind, 'submit');
  if (submit.plan?.kind === 'submit') assert.equal(submit.plan.release.id, 'd');
  const text = ios([live, rel('d', '2.0.1', 'ready', 'b12')], [flight('b12', '2.0.1')]);
  assert.equal(text.plan?.kind, 'submit');
});

test('processing, expired, invalid builds wait; a build already in flight is taken; unreadable version is never judged', () => {
  const live = rel('l', '1.19.0', 'live', '88');
  const a = ios(
    [live],
    [
      flight('96', '2.0.2', { state: 'processing' }),
      flight('95', '2.0.1'),
      flight('94', '2.0.0', { expired: true }),
      flight('93', '1.99.0', { state: 'invalid' }),
      flight('92', 'next'),
    ],
  );
  assert.equal(a.best?.buildNumber, '95');
  assert.equal(a.processing?.buildNumber, '96');
  const by = (n: string) => a.candidates.find((c) => c.buildNumber === n);
  assert.equal(by('94')?.reason, 'expired');
  assert.equal(by('93')?.reason, 'invalid');
  assert.equal(by('92')?.reason, 'unreadable_version');
  assert.equal(by('92')?.obsolete, true);
  const taken = ios([live, rel('r', '2.0.1', 'in_review', '95')], [flight('95', '2.0.1'), flight('97', '2.0.1')]);
  assert.equal(taken.best, null);
  assert.equal(taken.candidates.every((c) => c.reason === 'in_flight' && c.obsolete === true), true);
});

test('a pre-release build of the live version is judged (2.0.0-beta is older than live 2.0.0), no longer unknown', () => {
  const a = ios([rel('l', '2.0.0', 'live', '88')], [flight('95', '2.0.0-beta')]);
  assert.equal(a.candidates[0]?.reason, 'older_than_live');
  assert.equal(a.best, null);
});

test('candidates sort newest version first, then build, then upload', () => {
  const a = ios([], [flight('5', '1.0.0'), flight('2', '1.10.0'), flight('3', '1.9.0'), flight('4', '1.10.0')]);
  assert.deepEqual(a.candidates.map((c) => `${c.version}/${c.buildNumber}`), ['1.10.0/4', '1.10.0/2', '1.9.0/3', '1.0.0/5']);
});

test('Android: promote only what is newer than production; a halted internal release is not promotable', () => {
  const releases = [
    play('p', '1.9.0', 'production', 'live', ['190']),
    play('a', '1.9.1', 'internal', 'live', ['195', '196']),
    play('b', '1.8.0', 'internal', 'live', ['180']),
    play('h', '2.0.0', 'alpha', 'halted', ['200']),
    play('c', '1.9.0', 'beta', 'live', ['190']),
  ];
  const a = analyzeCandidates({ appId: 'app', platform: 'android', releases, builds: [] });
  assert.deepEqual(a.promote.map((o) => o.from), ['internal']);
  assert.deepEqual(a.promote[0]?.codes, ['195', '196']);
  assert.equal(a.promote[0]?.to, 'production');
  assert.equal(a.best?.buildNumber, '196');
  assert.equal(a.candidates.find((c) => c.codes?.[0] === '180')?.obsolete, true);
  assert.equal(a.plan, null);
});

test('promoteOptionsOf: one rule, newest codes first, production holding all the codes hides it', () => {
  const releases = [
    play('a', '1.0', 'internal', 'rolling_out', ['10']),
    play('b', '1.1', 'beta', 'live', ['11']),
    play('c', '1.1', 'production', 'in_review', ['11']),
  ];
  assert.deepEqual(promoteOptionsOf(releases, { appId: 'x' }).map((o) => o.version), ['1.0']);
  const none = promoteOptionsOf([play('a', '1.0', 'internal', 'live', ['5'])], {
    appId: 'x',
    live: { version: '1.0', build: null, codes: ['9'] },
  });
  assert.deepEqual(none, []);
  assert.deepEqual(promoteOptionsOf([play('a', '1.0', 'internal', 'live', [])], { appId: 'x' }), []);
});

test('patches over a pipeline read: the obsolete draft is not the flow, a stall about it is not news', () => {
  const a = ios([rel('l', '1.19.0', 'live', '88'), rel('o', '1.11.6', 'draft')], [flight('70', '1.18.0')]);
  const pipeline = { pipeline: { state: 'draft', latest: { version: { version: '1.11.6', track: null }, build: null } } };
  assert.equal(pipelineIsObsolete(pipeline, a), true);
  assert.equal(pipelineIsObsolete({ pipeline: { state: 'draft', latest: { version: { version: '2.0.0' }, build: null } } }, a), false);
  assert.equal(
    pipelineIsObsolete({ pipeline: { state: 'build_ready', latest: { version: null, build: { buildNumber: '70' } } } }, a),
    true,
  );
  assert.equal(stallLeftBehind({ evidence: [{ kind: 'version', id: '1.11.6@' }] }, a), true);
  assert.equal(stallLeftBehind({ evidence: [{ kind: 'version', id: '2.0.0' }] }, a), false);
  assert.equal(stallLeftBehind({ evidence: [{ kind: 'build', id: '70' }] }, a), true);
  assert.equal(stallLeftBehind({ evidence: [{ kind: 'run', id: '1' }] }, a), false);
});
