import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  allDisagreements,
  diffExpected,
  type ExpectedFile,
  summaryTable,
} from './consistency-report.ts';
import { SCENARIOS } from './consistency-world.ts';
import { disagreementsOf, FACTS, familyOf, SURFACES, type Surface } from './projections.ts';

/**
 * The consistency harness (docs/state-model.md, "Consistency contract"): ONE fixture of everything about an app, parameterised over the
 * scenarios of the audits, projected by EVERY display surface; any fact key that two surfaces both show must have the same value.
 *
 * The surfaces that disagree TODAY are listed in consistency.expected.json (the migration burn-down list). This test passes now and fails
 *   (a) when a NEW disagreement appears (a surface changed, a scenario was added...),
 *   (b) when a listed disagreement STOPS (remove the entry: the list only shrinks) or involves other surfaces than listed.
 * Wave 2 migrates a surface onto the model's one fact, runs `node --import ./src/lib/i18n/test-setup.ts scripts/consistency/cli.ts --prune`
 * and commits the shorter list. Wave 3 turns it strict (an empty list).
 */
const expected = JSON.parse(
  readFileSync(fileURLToPath(new URL('./consistency.expected.json', import.meta.url)), 'utf8'),
) as ExpectedFile;
const current = allDisagreements();

test('the surfaces named by the contract are all registered', () => {
  const ids = SURFACES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'a surface id is used twice');
  for (const want of [
    'sidebarBadge',
    'portfolioCard',
    'appDashboardTiles',
    'nextStep',
    'topBar',
    'pendingHeader',
    'pendingChangesStaged',
    'releasesTable',
    'graphicsTab',
    'assetsTab',
    'releaseStepAssets',
    'publishSummary',
    'publishFailure',
    'listingGrid',
    'insightsChecks',
    'fixBar',
  ])
    assert.ok(ids.includes(want), `surface ${want} is not registered in projections.ts`);
  // A surface says its components; `mirrors` lists the places that still compute the fact their own way (none once the surface calls the owner its components call).
  for (const s of SURFACES) assert.ok(s.components.length > 0, `${s.id} must say its components`);
});

test('every projected fact key belongs to a registered fact family', () => {
  for (const name of Object.keys(SCENARIOS)) {
    const w = (SCENARIOS[name] as () => never)();
    for (const s of SURFACES)
      for (const key of Object.keys(s.project(w)))
        assert.ok(
          FACTS[familyOf(key)] !== undefined,
          `${s.id} shows fact ${key}: register its family in FACTS (projections.ts)`,
        );
  }
});

test('every surface shows something in some scenario, and every scenario is projected by several surfaces', () => {
  const shows = new Map<string, number>();
  for (const name of Object.keys(SCENARIOS)) {
    const w = (SCENARIOS[name] as () => never)();
    let any = 0;
    for (const s of SURFACES) {
      const n = Object.keys(s.project(w)).length;
      shows.set(s.id, (shows.get(s.id) ?? 0) + n);
      if (n > 0) any += 1;
    }
    assert.ok(any >= 5, `scenario ${name}: only ${any} surfaces show a fact`);
  }
  for (const s of SURFACES)
    assert.ok(
      (shows.get(s.id) ?? 0) > 0,
      `surface ${s.id} never shows a fact: its projection is dead`,
    );
});

test('the control scenario ("quiet") has no disagreement: the harness itself is sound', () => {
  assert.deepEqual(disagreementsOf((SCENARIOS.quiet as () => never)()), []);
});

test('no NEW disagreement between two surfaces (not in consistency.expected.json)', () => {
  const diff = diffExpected(current, expected);
  const lines = diff.added.map(
    (d) =>
      `  ${d.scenario} :: ${d.factKey}\n${d.shown.map((s) => `      ${s.surface} shows ${JSON.stringify(s.value)}`).join('\n')}\n      logic: ${d.mirrors.join(' | ')}`,
  );
  assert.equal(
    lines.length,
    0,
    `two surfaces show different values for one fact:\n${lines.join('\n')}\n\nRead the fact from the model (one definition) instead of recomputing it. Do not add it to the expected list.`,
  );
});

test('every expected disagreement still disagrees (the list only shrinks)', () => {
  const diff = diffExpected(current, expected);
  assert.deepEqual(
    diff.fixed.map((e) => `${e.scenario} :: ${e.factKey} [${e.surfaces.join(', ')}]`),
    [],
    'these disagreements are fixed (good!). Remove them: node --import ./src/lib/i18n/test-setup.ts scripts/consistency/cli.ts --prune',
  );
  assert.deepEqual(
    diff.changed.map(
      (c) =>
        `${c.entry.scenario} :: ${c.entry.factKey}: listed ${c.entry.surfaces.join(', ')}; now ${c.now.surfaces.join(', ')}`,
    ),
    [],
    'the surfaces of these disagreements changed: update the list (--prune)',
  );
});

test('every expected entry names a known scenario, a domain and where the logic lives', () => {
  for (const e of expected.entries) {
    assert.ok(e.scenario in SCENARIOS, `unknown scenario ${e.scenario}`);
    assert.ok(
      ['state', 'releases', 'images', 'listing'].includes(e.domain),
      `bad domain ${e.domain}`,
    );
    assert.ok(
      e.mirrors.length > 0 && e.surfaces.length >= 2,
      `${e.scenario} :: ${e.factKey} is incomplete`,
    );
  }
});

test('the burn-down list by domain (printed)', (t) => {
  t.diagnostic(summaryTable(current));
  console.log(summaryTable(current));
});

// ---------------------------------------------------------------------------------------------
// The mechanism itself

const surface = (id: string, facts: Record<string, string | number | null>): Surface => ({
  id,
  components: ['x'],
  mirrors: ['x.ts:1'],
  project: () => facts,
});

test('a fact shown by two surfaces with different values is a disagreement; one surface alone, or equal values, is not', () => {
  const w = (SCENARIOS.quiet as () => never)();
  assert.equal(
    disagreementsOf(w, [surface('a', { pendingCount: 3 }), surface('b', { pendingCount: 3 })])
      .length,
    0,
  );
  assert.equal(disagreementsOf(w, [surface('a', { pendingCount: 3 })]).length, 0);
  assert.equal(
    disagreementsOf(w, [surface('a', { pendingCount: 3 }), surface('b', { stagedItems: 4 })])
      .length,
    0,
  );
  const d = disagreementsOf(w, [
    surface('a', { pendingCount: 3 }),
    surface('b', { pendingCount: 4 }),
    surface('c', { pendingCount: 3 }),
  ]);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0]?.surfaces, ['a', 'b', 'c']);
  assert.equal(d[0]?.domain, 'state');
  // a list is compared as a set
  assert.equal(
    disagreementsOf(w, [
      surface('a', { 'localeList:x': ['b', 'a'] as never }),
      surface('b', { 'localeList:x': ['a', 'b'] as never }),
    ]).length,
    0,
  );
});

test('the expected list fails on a new disagreement, on one that stopped, and on a changed set of surfaces', () => {
  const w = (SCENARIOS.quiet as () => never)();
  const now = disagreementsOf(w, [
    surface('a', { pendingCount: 3 }),
    surface('b', { pendingCount: 4 }),
  ]);
  const entry = {
    scenario: now[0]?.scenario ?? '',
    factKey: 'pendingCount',
    domain: 'state' as const,
    surfaces: ['a', 'b'],
    mirrors: ['x.ts:1'],
    note: '',
  };
  assert.deepEqual(diffExpected(now, { entries: [entry] }), { added: [], fixed: [], changed: [] });
  assert.equal(diffExpected(now, { entries: [] }).added.length, 1);
  assert.equal(diffExpected([], { entries: [entry] }).fixed.length, 1);
  assert.equal(
    diffExpected(now, { entries: [{ ...entry, surfaces: ['a', 'b', 'c'] }] }).changed.length,
    1,
  );
});
