import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayRange } from './days.ts';
import { compare, finding, steady, versionHealth, type HealthData, type VersionDay } from './health.ts';

const apple = (days: Array<[string, string, number, number | undefined]>): HealthData => {
  const points: VersionDay[] = days.map(([day, version, sessions, crashes]) => ({ day, version, sessions, ...(crashes === undefined ? {} : { crashes }) }));
  return { store: 'appstoreconnect', points, crashDays: new Set(points.filter((p) => p.crashes !== undefined).map((p) => p.day)) };
};
const spread = (version: string, from: string, to: string, sessions: number, crashes: number | undefined): Array<[string, string, number, number | undefined]> =>
  dayRange(from, to).map((d) => [d, version, sessions, crashes]);

test('App Store: crashes per session over the days a crash file answered for; versions newest first by number', () => {
  const data = apple([...spread('1.9.0', '2026-11-01', '2026-11-05', 100, 1), ...spread('1.10.0', '2026-11-06', '2026-11-10', 100, 4)]);
  const [newest, older] = versionHealth(data);
  assert.equal(newest!.version, '1.10.0', 'numeric order, not alphabetical');
  assert.equal(older!.crash.rate, 0.01);
  assert.equal(newest!.crash.rate, 0.04);
});

test('regression rule: at least 1.5 times and 1 per 1,000 sessions more, both versions steady', () => {
  const data = apple([...spread('1.0', '2026-11-01', '2026-11-05', 100, 1), ...spread('1.1', '2026-11-06', '2026-11-10', 100, 4)]);
  const f = finding('appstoreconnect', versionHealth(data))!;
  assert.equal(f.kind, 'worse');
  assert.equal(f.version, '1.1');
  assert.equal(f.previous, '1.0');
  // 1.4 times is not enough
  const slight = apple([...spread('1.0', '2026-11-01', '2026-11-05', 100, 5), ...spread('1.1', '2026-11-06', '2026-11-10', 100, 7)]);
  assert.equal(finding('appstoreconnect', versionHealth(slight)), null);
  // 1.5 times but under 1 per 1,000 sessions more is noise
  const tiny = apple([...spread('1.0', '2026-11-01', '2026-11-05', 1000, 0.2), ...spread('1.1', '2026-11-06', '2026-11-10', 1000, 0.4)]);
  assert.equal(finding('appstoreconnect', versionHealth(tiny)), null);
  // better is reported as better
  const better = apple([...spread('1.0', '2026-11-01', '2026-11-05', 100, 4), ...spread('1.1', '2026-11-06', '2026-11-10', 100, 1)]);
  assert.equal(finding('appstoreconnect', versionHealth(better))!.kind, 'better');
});

test('a version with too few sessions, or crash numbers for too few of its days, is not compared', () => {
  const thin = apple([...spread('1.0', '2026-11-01', '2026-11-05', 100, 1), ...spread('1.1', '2026-11-06', '2026-11-07', 50, 5)]);
  assert.equal(finding('appstoreconnect', versionHealth(thin)), null, '100 sessions is under the 200 line');
  // Apple sends no crash file for days under five crashing users: 1.1 has sessions on 8 days and crash numbers on 2.
  const days = dayRange('2026-11-06', '2026-11-13').map((d, i): [string, string, number, number | undefined] => [d, '1.1', 100, i < 2 ? 9 : undefined]);
  const partial = apple([...spread('1.0', '2026-11-01', '2026-11-05', 100, 1), ...days]);
  // crashDays of a day is "any version had crash numbers": here only the two days
  const v = versionHealth(partial)[0]!;
  assert.equal(v.crash.coveredDays, 2);
  assert.equal(v.crash.days, 8);
  assert.equal(steady(v.crash), false);
  assert.equal(finding('appstoreconnect', versionHealth(partial)), null);
});

test('Google Play: user-weighted rates, Google’s line counts as a regression, freezes are compared after crashes', () => {
  const g = (version: string, crash: number, anr: number): VersionDay[] =>
    dayRange('2026-11-01', '2026-11-03').map((day) => ({ day, version, crashRate: crash, users: 100, anrRate: anr, anrUsers: 100 }));
  const data: HealthData = { store: 'googleplay', points: [...g('100', 0.005, 0.001), ...g('101', 0.012, 0.001)], crashDays: new Set() };
  const vs = versionHealth(data);
  assert.equal(vs[0]!.version, '101', 'the highest build is the newest');
  const f = finding('googleplay', vs)!;
  assert.equal(f.measure, 'crash');
  assert.equal(f.overLine, true, '1.2% is over the 1.09% line, 0.5% was not');
  const flat: HealthData = { store: 'googleplay', points: [...g('100', 0.005, 0.001), ...g('101', 0.0055, 0.004)], crashDays: new Set() };
  const frozen = finding('googleplay', versionHealth(flat))!;
  assert.equal(frozen.measure, 'freeze');
  assert.equal(compare('googleplay', 'crash', versionHealth(flat)[0]!, versionHealth(flat)[1]!), null);
});
