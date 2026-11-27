import assert from 'node:assert/strict';
import { test } from 'node:test';
import { factsOf, SCENARIOS, type World } from './consistency-world.ts';
import { deriveAppState } from './derive.ts';
import { ANDROID, running } from './fixtures.ts';
import { type FactValue, SURFACES } from './projections.ts';

/**
 * The bugs this project was reported with, pinned BY VALUE and across ALL surfaces (the harness says the surfaces agree; this says what they
 * agree on). Each scenario is a world of `consistency-world.ts` (the facts that caused the bug); every surface of `projections.ts` draws
 * from it, and the assertions name the value every surface that shows the fact must show. A bug fixed once stays fixed on every screen.
 */
type Facts = Record<string, Record<string, FactValue>>;

const worldOf = (name: string): World => {
  const make = SCENARIOS[name];
  assert.ok(make, `scenario ${name}`);
  return make();
};
const project = (world: World): Facts => {
  const out: Facts = {};
  for (const surface of SURFACES) out[surface.id] = surface.project(world);
  return out;
};
const projected = (name: string): Facts => project(worldOf(name));

/** The surfaces that show `key`, with what each shows. */
const shown = (facts: Facts, key: string): [string, FactValue][] =>
  Object.keys(facts).flatMap((id) => (key in (facts[id] ?? {}) ? [[id, facts[id]?.[key] as FactValue] as [string, FactValue]] : []));

/** Every surface that shows `key` shows `want`, and at least `mustShow` do. */
function everywhere(facts: Facts, key: string, want: FactValue, mustShow: readonly string[]): void {
  const rows = shown(facts, key);
  const ids = rows.map(([id]) => id);
  for (const id of mustShow) assert.ok(ids.includes(id), `${id} does not show ${key} (shown by: ${ids.join(', ')})`);
  for (const [id, value] of rows) assert.deepEqual(value, want, `${id}: ${key}`);
}

/** No fact has two different values on two surfaces. */
function allAgree(facts: Facts): void {
  const seen = new Map<string, { id: string; value: string }>();
  for (const [id, f] of Object.entries(facts))
    for (const [key, value] of Object.entries(f)) {
      const text = JSON.stringify(value);
      const first = seen.get(key);
      if (first === undefined) seen.set(key, { id, value: text });
      else assert.equal(text, first.value, `${key}: ${id} says ${text}, ${first.id} says ${first.value}`);
    }
}

test('(a) screenshots 10 + 2 siblings: 12 is never one set; readiness, Graphics, Assets, the cart and the release step agree', () => {
  for (const name of ['ipad-siblings-10-2', 'ipad-siblings-10-2-staged-removal']) {
    const facts = projected(name);
    allAgree(facts);
    // The two groups of one device keep their own counts on every surface that names them; none is ever 12.
    everywhere(facts, 'imageGroupCount:en-US/ipad_13/APP_IPAD_PRO_3GEN_129', 10, ['graphicsTab', 'assetsTab', 'releaseStepAssets']);
    everywhere(facts, 'imageGroupCount:en-US/ipad_13/APP_IPAD_PRO_129', 2, ['graphicsTab', 'releaseStepAssets']);
    for (const [key, rows] of Object.entries(facts).flatMap(([id, f]) => Object.entries(f).map(([k, v]) => [k, [[id, v]]] as const)))
      if (key.startsWith('imageGroupCount:')) for (const [id, v] of rows) assert.ok(Number(v) <= 10, `${id}: a set of ${String(v)} screenshots in ${key}`);
    // The device total, where it is shown (Graphics, the cart), is the 12 the two sets add up to.
    everywhere(facts, 'imageCount:en-US/ipad_13', 12, [name.endsWith('removal') ? 'pendingCartGraphics' : 'graphicsTab']);
  }
  // The staged removal of one file is ONE change everywhere: the count, the set, the files the removal leaves.
  const staged = projected('ipad-siblings-10-2-staged-removal');
  everywhere(staged, 'pendingCount', 1, ['topBar', 'sidebarBadge', 'nextStep', 'pendingCartDrawer', 'pendingHeader', 'workspacePending']);
  everywhere(staged, 'stagedAssetSets', 1, ['stagedTray', 'releaseStepStaged', 'pendingCartGraphics', 'graphicsTab']);
  everywhere(staged, 'stagedSetFiles:en-US/ipad_13', 11, ['pendingCartGraphics', 'graphicsTab']);
});

test('(b) a failed run with stale blockers and a resolved store: ready to submit, no blocker, nothing pending, on every surface', () => {
  const facts = projected('failed-run-stale-blockers-resolved');
  allAgree(facts);
  everywhere(facts, 'phase', 'ready_to_submit', ['topBar', 'nextStep']);
  everywhere(facts, 'blockerCount', 0, ['nextStep', 'publishFailure', 'publishDialogFailure']);
  everywhere(facts, 'blockingCount', 0, ['nextStep', 'pendingHeader', 'pendingChangesStaged']);
  everywhere(facts, 'pendingCount', 0, ['topBar', 'nextStep', 'pendingCartDrawer', 'pendingCartRows', 'pendingHeader', 'workspacePending']);
  const state = deriveAppState(factsOf(worldOf('failed-run-stale-blockers-resolved')), 'ios');
  assert.equal(state.phase, 'ready_to_submit');
});

test('(c) iOS 1.19.0 phased + obsolete 1.11.6 + TestFlight 2.0.1: live and candidate agree, and creating the next release is proposed', () => {
  const facts = projected('ios-phased-obsolete-testflight');
  allAgree(facts);
  everywhere(facts, 'liveVersion:ios-1', '1.19.0', ['portfolioCard', 'appDashboardTiles', 'nextStep', 'releasesTable', 'releasesObsoleteBadge']);
  everywhere(facts, 'latestVersion:ios-1', '1.19.0', ['portfolioCard', 'appDashboardTiles', 'shellStatus']);
  everywhere(facts, 'candidate:ios-1', '2.00.1#95', ['appDashboardTiles', 'nextStep', 'releasesTable']);
  everywhere(facts, 'obsoleteVersions:ios-1', ['1.11.6'], ['nextStep', 'releasesObsoleteBadge']);
  const state = deriveAppState(factsOf(worldOf('ios-phased-obsolete-testflight')), 'ios');
  assert.equal(state.canDo('create_version', 'ios').enabled, true, 'creating the next release is offered');
  assert.equal(state.phase, 'candidate_blocked');
});

test('(d) a Play promotion in flight: no promote is offered, and the top bar, the card and the Pending page show the run', () => {
  const world = worldOf('play-draft-review-promotion');
  world.publishing[ANDROID.id] = running();
  const facts = project(world);
  allAgree(facts);
  everywhere(facts, 'phase', 'publishing', ['topBar', 'nextStep']);
  const state = deriveAppState(factsOf(world), 'android');
  assert.equal(state.badge.kind, 'publishing');
  assert.equal(state.promotion?.offer.enabled, false, 'promote is not offered while it runs');
  assert.match(state.promotion?.offer.disabledReason ?? '', /publish/i, 'the reason names the run');
  assert.equal(state.canDo('promote', 'android').enabled, false);
  // The same promotion, not in flight, IS offered: the run is the only reason.
  const idle = deriveAppState(factsOf(worldOf('play-draft-review-promotion')), 'android');
  assert.equal(idle.canDo('promote', 'android').enabled, true);
});

test('(e) an empty fr-FR draft locale is a locale on every listing surface (grid, checks, fix bar, release notes), per platform', () => {
  const facts = projected('locales-fr-empty-zh');
  allAgree(facts);
  everywhere(facts, 'localeList:ios-1', ['en-US', 'fr-FR', 'zh-Hans'], ['listingGrid', 'insightsChecks', 'fixBar', 'releaseStepNotes']);
  everywhere(facts, 'localeList:android-1', ['en-US', 'zh-CN'], ['listingGrid', 'insightsChecks', 'fixBar', 'releaseStepNotes']);
  everywhere(facts, 'defaultLocale:ios-1', 'en-US', ['publishSummary', 'insightsChecks']);
});

test('(f) a staged removal that is already pushed: 0 pending, 1 waiting to be submitted, on every surface', () => {
  const facts = projected('staged-removal-already-pushed');
  allAgree(facts);
  everywhere(facts, 'pendingCount', 0, ['nextStep', 'pendingCartDrawer', 'pendingCartRows', 'pendingHeader', 'workspacePending']);
  everywhere(facts, 'stagedUnpushed', 0, ['appDashboardAttention', 'pendingChangesStaged', 'releaseStepStaged']);
  everywhere(facts, 'awaitingSubmit', 1, ['pendingHeader']);
  everywhere(facts, 'stagedAssetSets', 0, ['graphicsTab']);
  const state = deriveAppState(factsOf(worldOf('staged-removal-already-pushed')), 'ios');
  assert.equal(state.phase, 'ready_to_release');
  assert.equal(state.badge.kind === 'pending' ? state.badge.count : 0, 0);
});
