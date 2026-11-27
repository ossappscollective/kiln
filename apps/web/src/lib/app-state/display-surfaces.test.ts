import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './consistency-world.ts';
import { FACTS, familyOf, SURFACES } from './projections.ts';
import { DISPLAY_SURFACES } from './surfaces.ts';

/**
 * The display-only surfaces of the state domain (lib/app-state/surfaces.ts, DISPLAY_SURFACES) and the projections of the consistency
 * harness (projections.ts, SURFACES) are one list seen twice: this fails when one of them has a surface the other does not know.
 */
const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** The `state` families each projection shows across the scenarios (a projection that throws is another domain's to fix: skipped here). */
function stateFamiliesShown(): Map<string, Set<string>> {
  const shown = new Map<string, Set<string>>();
  for (const name of Object.keys(SCENARIOS)) {
    const w = (SCENARIOS[name] as () => never)();
    for (const s of SURFACES) {
      let keys: string[] = [];
      try {
        keys = Object.keys(s.project(w));
      } catch {
        continue;
      }
      for (const key of keys) {
        const family = familyOf(key);
        if (FACTS[family]?.domain !== 'state') continue;
        const set = shown.get(s.id) ?? new Set<string>();
        set.add(family);
        shown.set(s.id, set);
      }
    }
  }
  return shown;
}

test('every registered display surface has a projection, and every projection of a state fact is registered', () => {
  const projected = new Set(SURFACES.map((s) => s.id));
  for (const d of DISPLAY_SURFACES)
    assert.ok(
      projected.has(d.id),
      `${d.id} is registered in surfaces.ts but has no projection in projections.ts: add one (the harness compares it)`,
    );
  const registered = new Set(DISPLAY_SURFACES.map((d) => d.id));
  for (const id of stateFamiliesShown().keys())
    assert.ok(
      registered.has(id),
      `the projection ${id} shows a state fact: register the surface in DISPLAY_SURFACES (surfaces.ts)`,
    );
  assert.equal(registered.size, DISPLAY_SURFACES.length, 'a display surface is registered twice');
});

test('each registered display surface lists exactly the state facts its projection shows', () => {
  const shown = stateFamiliesShown();
  for (const d of DISPLAY_SURFACES) {
    const want = [...(shown.get(d.id) ?? [])].sort();
    assert.deepEqual(
      [...d.facts].sort(),
      want,
      `${d.id}: DISPLAY_SURFACES.facts must be the state families the projection shows`,
    );
    for (const f of d.facts)
      assert.equal(
        FACTS[f]?.domain,
        'state',
        `${d.id}: ${f} is not a registered state fact (FACTS)`,
      );
  }
});

test('the files of a display surface exist', () => {
  for (const d of DISPLAY_SURFACES) {
    const s = SURFACES.find((x) => x.id === d.id);
    for (const file of s?.components ?? [])
      assert.ok(existsSync(join(SRC, file)), `${d.id}: ${file} does not exist`);
  }
});
