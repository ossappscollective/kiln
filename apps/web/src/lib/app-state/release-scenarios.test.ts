import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCENARIOS } from './consistency-world.ts';
import { type FactValue, SURFACES } from './projections.ts';

/**
 * The scenarios of the releases audit, pinned by VALUE (the consistency harness only says the surfaces agree; this says what they agree on).
 *
 * (i) iOS 1.19.0 phased (rolling out), the obsolete draft 1.11.6, TestFlight 2.00.1 build 95: every surface that names the live version says
 * 1.19.0, the obsolete version is 1.11.6 and not a release to finish, the newest build is the TestFlight build 2.00.1 (95) wherever a build
 * is named, and the version left behind is not counted as a release left unfinished (sidebar badge, Overview, Portfolio).
 */
const projected = (name: string): Record<string, Record<string, FactValue>> => {
  const make = SCENARIOS[name];
  assert.ok(make, `scenario ${name}`);
  const world = make();
  const out: Record<string, Record<string, FactValue>> = {};
  for (const surface of SURFACES) out[surface.id] = surface.project(world);
  return out;
};

const surfacesShowing = (facts: Record<string, Record<string, FactValue>>, key: string): string[] =>
  Object.keys(facts).filter((id) => key in (facts[id] ?? {}));

test('iOS 1.19.0 phased: every surface that names the live version names 1.19.0', () => {
  const facts = projected('ios-phased-obsolete-testflight');
  const shows = surfacesShowing(facts, 'liveVersion:ios-1');
  for (const id of [
    'portfolioCard',
    'appDashboardTiles',
    'nextStep',
    'releasesTable',
    'releasesObsoleteBadge',
  ])
    assert.ok(shows.includes(id), `${id} names the live version`);
  for (const id of shows) assert.equal(facts[id]?.['liveVersion:ios-1'], '1.19.0', id);
});

test('iOS: the newest version of the app is 1.19.0 in the sidebar status, the Overview and the dashboard tile', () => {
  const facts = projected('ios-phased-obsolete-testflight');
  for (const id of ['shellStatus', 'portfolioCard', 'appDashboardTiles'])
    assert.equal(facts[id]?.['latestVersion:ios-1'], '1.19.0', id);
});

test('iOS: the obsolete 1.11.6 is named obsolete by the next step and by the releases table, and it is not a release left unfinished', () => {
  const facts = projected('ios-phased-obsolete-testflight');
  for (const id of ['nextStep', 'releasesObsoleteBadge'])
    assert.deepEqual(facts[id]?.['obsoleteVersions:ios-1'], ['1.11.6'], id);
  for (const id of ['sidebarBadge', 'portfolioCard'])
    assert.equal(facts[id]?.unfinishedReleases, undefined, `${id} counts no unfinished release`);
});

test('iOS: the newest build is TestFlight 2.00.1 (95) on every surface that names a build, never the obsolete pipeline build 1.11.6 (92)', () => {
  const facts = projected('ios-phased-obsolete-testflight');
  const shows = surfacesShowing(facts, 'newestBuild:ios-1');
  for (const id of ['appDashboardTiles', 'nextStep', 'buildsPanel', 'pipelineCard'])
    assert.ok(shows.includes(id), `${id} names the newest build`);
  for (const id of shows) assert.equal(facts[id]?.['newestBuild:ios-1'], '2.00.1#95', id);
  // The one date of that build, wherever a build date is drawn.
  const dates = new Set(
    surfacesShowing(facts, 'buildDate:ios-1').map((id) => facts[id]?.['buildDate:ios-1']),
  );
  assert.equal(dates.size, 1);
});

test('Google Play: a draft in review and a build in internal testing: the promotion and the live version are the same on every surface', () => {
  const facts = projected('play-draft-review-promotion');
  const live = new Set<FactValue | undefined>();
  for (const id of Object.keys(facts))
    for (const [key, value] of Object.entries(facts[id] ?? {}))
      if (key.startsWith('liveVersion:')) live.add(`${key}=${String(value)}`);
  const perApp = new Map<string, Set<string>>();
  for (const entry of live) {
    const [key, value] = String(entry).split('=');
    perApp.set(key as string, (perApp.get(key as string) ?? new Set()).add(value as string));
  }
  for (const [key, values] of perApp) assert.equal(values.size, 1, `${key} has one value`);
});
