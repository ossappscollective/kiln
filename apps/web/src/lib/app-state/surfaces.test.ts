import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveAppState } from './derive.ts';
import { ANDROID, facts, failedRun, failingAndroid, IOS, internalTesting, pipelineOf, running } from './fixtures.ts';
import { BADGE_HANDLERS, BADGE_SURFACE, MODEL_ONLY, OFFER_SURFACES, VERDICT_SURFACES } from './surfaces.ts';
import { GUARDED_ACTIONS, PRIMARY_ACTIONS } from './types.ts';

/**
 * Every surface that draws what the state model decides handles every action the model can offer (docs/state-model.md, "Enforcement").
 * The registry is lib/app-state/surfaces.ts. These tests read the source of the screens (no DOM runs here), so adding an action, a badge
 * or a screen that asks the model without saying what it does with it fails here, with the line to fix.
 */
const SRC = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string): string => readFileSync(join(SRC, file), 'utf8');

function sourcesUnder(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(SRC, dir))) {
    const path = join(dir, name);
    if (statSync(join(SRC, path)).isDirectory()) out.push(...sourcesUnder(path, ext));
    else if (name.endsWith(ext)) out.push(path.split(sep).join('/'));
  }
  return out;
}

const FIX = 'Register the surface in apps/web/src/lib/app-state/surfaces.ts (and make it handle the action), or draw it through NextStep.';

test('every offer the model can make is handled by every surface that draws offers', () => {
  assert.ok(OFFER_SURFACES.length > 0);
  for (const surface of OFFER_SURFACES) {
    const source = read(surface.file);
    for (const action of PRIMARY_ACTIONS) {
      const handler = surface.handlers[action];
      assert.ok(handler !== undefined, `${surface.id} does not say what it does with the action "${action}". ${FIX}`);
      if (handler === 'not_drawn') continue;
      assert.match(source, handler, `${surface.file} claims to handle "${action}" but its source has no ${handler}`);
    }
  }
});

test('a component that draws the model\'s offers is in the registry', () => {
  const registered = new Set(OFFER_SURFACES.map((s) => s.file));
  for (const file of sourcesUnder('components', '.svelte')) {
    if (file.startsWith('components/app-state/')) continue;
    const source = read(file);
    if (/\.(primaryAction|secondaryActions)\b/.test(source) || /\bdata-action=/.test(source))
      assert.ok(registered.has(file), `${file} draws the offers of the state model but is not in the registry of surfaces. ${FIX}`);
  }
});

test('every offer the model makes, in every state, is either a link or one the card opens itself', () => {
  const opens = PRIMARY_ACTIONS.filter((a) => a === 'show_pending' || a === 'publish_again' || a === 'start_release' || a === 'prepare_release');
  const all = [
    facts({}),
    facts({ pending: { [ANDROID.id]: { count: 29, blocking: 0 } } }),
    failingAndroid(),
    facts({ pending: { [ANDROID.id]: { count: 3, blocking: 1 }, [IOS.id]: { count: 2, blocking: 0 } } }),
    facts({ publishing: { [ANDROID.id]: running() } }),
    facts({ lastRun: { [IOS.id]: failedRun('ios') } }),
    facts({ releases: { [ANDROID.id]: [internalTesting()] }, pipelines: { [ANDROID.id]: pipelineOf(ANDROID, 'needs_you'), [IOS.id]: pipelineOf(IOS, 'in_review') } }),
  ];
  for (const f of all)
    for (const scope of ['both', 'ios', 'android'] as const) {
      const state = deriveAppState(f, scope);
      for (const offer of [state.primaryAction, ...state.secondaryActions]) {
        assert.ok(PRIMARY_ACTIONS.indexOf(offer.action) >= 0, `an offer outside the closed set: ${offer.action}`);
        if (offer.action !== 'none' && offer.href === null)
          assert.ok(opens.indexOf(offer.action) >= 0, `"${offer.action}" has no href, and the card does not open it itself`);
      }
    }
});

test('every kind of the top bar badge is handled by the button', () => {
  const source = read(BADGE_SURFACE);
  const kinds = Object.keys(BADGE_HANDLERS);
  assert.deepEqual(kinds.slice().sort(), ['failed', 'idle', 'pending', 'publishing']);
  for (const kind of kinds) assert.match(source, BADGE_HANDLERS[kind as keyof typeof BADGE_HANDLERS], `${BADGE_SURFACE} does not handle the badge "${kind}"`);
});

test('every action that changes something is asked of the model by a screen (or is model only, with a reason)', () => {
  for (const action of GUARDED_ACTIONS) {
    const surfaces = VERDICT_SURFACES.filter((s) => s.action === action);
    const modelOnly = MODEL_ONLY[action];
    assert.ok(surfaces.length > 0 || (modelOnly !== undefined && modelOnly.length > 0), `no screen asks the model about "${action}", and it is not listed as model only. ${FIX}`);
  }
});

test('each screen in the registry asks the model for the action it claims', () => {
  for (const s of VERDICT_SURFACES) assert.match(read(s.file), s.evidence, `${s.file} claims to ask the model about "${s.action}", but its source does not`);
});

test('a component that asks the model for a verdict is in the registry, for that action', () => {
  const ask = /(?:appStateStore\.verdict\([^)]*?,\s*|\bcanDo\(|\bcan\()'([a-z_]+)'/g;
  for (const file of sourcesUnder('components', '.svelte')) {
    const source = read(file);
    for (const m of source.matchAll(ask)) {
      const action = m[1] as string;
      if (GUARDED_ACTIONS.indexOf(action as (typeof GUARDED_ACTIONS)[number]) < 0) continue; // a right of @kiln/core, not an action of the model
      assert.ok(
        VERDICT_SURFACES.some((s) => s.file === file && s.action === action),
        `${file} asks the model about "${action}" but is not registered for it. ${FIX}`,
      );
    }
  }
});

test('the registry only names files that exist', () => {
  const files = [...OFFER_SURFACES.map((s) => s.file), BADGE_SURFACE, ...VERDICT_SURFACES.map((s) => s.file)];
  for (const file of files) assert.ok(read(file).length > 0, `${relative(SRC, join(SRC, file))} is empty or missing`);
});
