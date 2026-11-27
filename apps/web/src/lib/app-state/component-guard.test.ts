import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  compare,
  EXEMPTIONS_FILE,
  MAX_EXEMPTIONS,
  serializeExemptions,
  componentFiles,
  groupViolations,
  loadAllowlist,
  parseSource,
  READ_FACT_ENDPOINTS,
  RULES,
  type RuleId,
  scanFile,
  scanTree,
  SRC,
} from '../../../scripts/component-guard/scan.ts';

/**
 * The AST guard of the components (docs/state-model.md, "Consistency contract"; replaces the regex of wiring.test.ts step by step).
 *
 * A component reads the state from the model facade only. It does not read a fact endpoint, keep a cache or a clock, retype a limit,
 * compare versions, recount a list of facts, or call the listing/image readers. The rules R1-R7 are in
 * scripts/component-guard/scan.ts; `component-guard.allowlist.json` is what the tree does TODAY. This test fails when
 *   (a) a violation is NOT in the allowlist (a new one), or
 *   (b) an allowlist entry no longer matches (the list only shrinks: run `node scripts/component-guard/cli.ts --prune`).
 * Wave 3 sets `"strict": true` in the allowlist file: no entry is honoured.
 *
 * The burn-down list by domain: `node scripts/component-guard/cli.ts`.
 */

const scan = scanTree();
const groups = groupViolations(scan.violations);
const list = loadAllowlist();
const diff = compare(groups, list);

test('every component parses (the guard sees all of them)', () => {
  assert.deepEqual(scan.errors, []);
  assert.ok(scan.files > 300, `only ${scan.files} component files found`);
});

test('no NEW component violation of R1-R7 (not in component-guard.allowlist.json)', () => {
  const lines = diff.added.map(
    ({ group: g, allowed }) =>
      `  ${g.rule} ${RULES[g.rule].name}  ${g.file}:${g.line}  ${g.snippet}${allowed > 0 ? ` (allowlist grants ${allowed}, found ${g.count})` : ''}`,
  );
  assert.equal(
    lines.length,
    0,
    `new violations:\n${lines.join('\n')}\n\nThe rules:\n${(Object.keys(RULES) as RuleId[])
      .map((r) => `  ${r}: ${RULES[r].message}. Instead: ${RULES[r].instead}`)
      .join('\n')}\n\nDo NOT add the file to the allowlist: read the fact from the model (apps/web/src/lib/app-state/app-state-store.svelte.ts).`,
  );
});

test('every allowlist entry still matches (the list only shrinks)', () => {
  const lines = diff.stale.map(
    ({ entry: e, actual }) => `  ${e.rule} ${e.file}  ${e.snippet}  (allowed ${e.count}, found ${actual})`,
  );
  assert.equal(
    lines.length,
    0,
    `stale allowlist entries (migrated: good!). Remove them: node scripts/component-guard/cli.ts --prune\n${lines.join('\n')}`,
  );
});

test('every allowlist entry names a known rule, a domain and a reason', () => {
  for (const e of list.entries) {
    assert.ok(e.rule in RULES, `unknown rule ${e.rule} in ${e.file}`);
    assert.ok(['images', 'releases', 'listing', 'state'].includes(e.domain), `bad domain ${e.domain}`);
    assert.ok(e.reason.length > 0 && e.count >= 1 && e.hash.length === 8, `bad entry ${e.file} ${e.rule}`);
  }
  assert.ok(!list.entries.some((e) => !componentFiles().includes(e.file)), 'an entry names a file that is gone');
});

test('the endpoints R1 watches still exist in lib/api.ts (a renamed endpoint must not silently leave the rule)', () => {
  const api = readFileSync(join(SRC, 'lib/api.ts'), 'utf8');
  const missing = READ_FACT_ENDPOINTS.filter((name) => !new RegExp(`\\n    ${name}: `).test(api));
  assert.deepEqual(missing, [], `R1 watches endpoints that lib/api.ts no longer defines: ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------
// The rules themselves (what each one sees), on small inputs.

const rulesOf = (file: string, source: string) =>
  scanFile(file, source).raws.map((v) => `${v.rule}:${v.snippet}`);

test('R1 sees a read of a fact endpoint, not a write', () => {
  const src = `<script lang="ts">
  let { api }: { api: Api } = $props();
  async function load() { const a = await api.appBuilds('w', 'a'); await api.stagePending('x'); }
</script>`;
  assert.deepEqual(rulesOf('components/X.svelte', src), ['R1:api.appBuilds']);
});

test('R2 sees readCache, new Map, Date.now, setInterval and a module-level cache', () => {
  const src = `<script lang="ts" module>
  const viewCache = {};
</script>
<script lang="ts">
  import { readCache } from '../lib/read-cache.ts';
  const m = new Map<string, number>();
  const now = Date.now();
  setInterval(() => {}, 1000);
</script>`;
  const got = rulesOf('components/X.svelte', src);
  for (const want of ['R2:module-level cache: viewCache', 'R2:readCache', 'R2:Date.now()', 'R2:setInterval(...)'])
    assert.ok(got.includes(want), `${want} not in ${got.join(' | ')}`);
  assert.ok(got.some((g) => g.startsWith('R2:new Map')));
});

test('R3 sees a literal limit against a count, in the script AND in the template, and a maxlength', () => {
  const src = `<script lang="ts">
  let { rows }: { rows: string[] } = $props();
  const full = rows.length >= 10;
</script>
<textarea maxlength="4000"></textarea>
{#if rows.length > 100}<p>many</p>{/if}
{#if rows.length > 3}<p>few</p>{/if}`;
  assert.deepEqual(rulesOf('components/X.svelte', src).sort(), [
    'R3:maxlength="4000"',
    'R3:rows.length > 100',
    'R3:rows.length >= 10',
  ]);
});

test('R4 sees a version comparator, a version sort and a live pick by name', () => {
  const src = `<script lang="ts">
  import { compareVersionStrings } from '../lib/x.ts';
  const live = releases.find((r) => r.live);
  const latestRelease = releases.slice().sort((a, b) => compare(a.version, b.version))[0];
</script>`;
  const got = rulesOf('components/X.svelte', src);
  assert.ok(got.includes('R4:compareVersionStrings'));
  assert.ok(got.includes('R4:latestRelease'));
  assert.ok(got.includes('R4:sort by version'));
});

test('R5 sees a hand count over a fact collection and a count shown in the template', () => {
  const src = `<script lang="ts">
  const n = staged.filter((s) => !s.pushed).length;
  const total = blockers.reduce((a, b) => a + b.count, 0);
</script>
<span>{releases.length}</span>`;
  const got = rulesOf('components/X.svelte', src).filter((g) => g.startsWith('R5'));
  assert.equal(got.length, 3, got.join(' | '));
});

test('R6 sees the listing and image readers, R7 a low-level store import', () => {
  const src = `<script lang="ts">
  import { stalledApps } from '../lib/app-state/derive.ts';
  import { stagedStore } from '../lib/staged-store.svelte.ts';
  import { appStateStore } from '../lib/app-state/app-state-store.svelte.ts';
  const v = checkStoreImages(view);
  const d = api.appListingDrift('w', 'a');
</script>`;
  const got = rulesOf('components/X.svelte', src);
  for (const want of ['R6:stalledApps', 'R6:checkStoreImages', 'R6:appListingDrift'])
    assert.ok(got.includes(want), `${want} not in ${got.join(' | ')}`);
  assert.equal(got.filter((g) => g.startsWith('R7')).length, 1);
});

test('a clean component raises nothing', () => {
  const src = `<script lang="ts">
  import { appStateStore } from '../lib/app-state/app-state-store.svelte.ts';
  let { workspaceId }: { workspaceId: string } = $props();
  const state = $derived(appStateStore.of({ workspaceId }));
</script>
<p>{state.pendingCount}</p>`;
  assert.deepEqual(rulesOf('components/X.svelte', src), []);
  assert.equal(parseSource('components/X.svelte', src).error, null);
});

test('the allowlist comparison: a new violation, a bigger count and a stale entry fail; strict mode honours no entry', () => {
  const found = groupViolations(
    scanFile('components/X.svelte', `<script lang="ts">\n  const a = Date.now(); const b = Date.now();\n</script>`).raws,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.count, 2);
  const entry = {
    file: 'components/X.svelte',
    rule: 'R2' as const,
    hash: found[0]?.hash ?? '',
    snippet: 'Date.now()',
    count: 2,
    domain: 'state' as const,
    reason: 'test',
  };
  assert.deepEqual(compare(found, { strict: false, entries: [entry] }), { added: [], stale: [] });
  // a third Date.now() is new
  assert.equal(compare(found, { strict: false, entries: [{ ...entry, count: 1 }] }).added.length, 1);
  // fewer found than allowed: the entry is stale
  assert.equal(compare(found, { strict: false, entries: [{ ...entry, count: 3 }] }).stale.length, 1);
  // an entry for something that is gone
  assert.equal(compare([], { strict: false, entries: [entry] }).stale.length, 1);
  // a violation that is not listed
  assert.equal(compare(found, { strict: false, entries: [] }).added.length, 1);
  // strict: no entry is honoured
  assert.equal(compare(found, { strict: true, entries: [entry] }).added.length, 1);
});

test('STRICT: the allowlist is empty and strict (the burn-down is complete: nothing is grandfathered)', () => {
  assert.equal(list.strict, true, 'component-guard.allowlist.json must be "strict": true');
  assert.deepEqual(list.entries, []);
});

test('heuristics: emptiness checks, lookup maps, accumulators and typed-code lengths are not violations', () => {
  const src = `<script lang="ts">
  let { locales, rows, code }: { locales: string[]; rows: { id: string }[]; code: string } = $props();
  const byId = $derived(new Map(rows.map((r) => [r.id, r])));
  const tally = $derived.by(() => { const m = new Map<string, number>(); return m; });
  const ok = code.trim().length >= 8;
</script>
{#if locales.length === 0}<p>none</p>{/if}
{#if locales.length > 0}<p>some</p>{/if}`;
  assert.deepEqual(rulesOf('components/X.svelte', src), []);
});

test('guard-ok: honoured only with the rule AND a reason, only next to the hit, and only while it exempts something', () => {
  const hit = (comment: string) =>
    scanFile('components/X.svelte', `<script lang="ts">\n  ${comment}\n  const now = Date.now();\n</script>`);
  const ok = hit('// guard-ok R2: the instant of a keystroke, not a drawn age');
  assert.deepEqual(ok.raws, []);
  assert.equal(ok.exemptions.length, 1);
  assert.deepEqual(ok.problems, []);
  // no reason, or no rule: not honoured, and reported
  for (const bad of ['// guard-ok R2:', '// guard-ok R2', '// guard-ok: because']) {
    const r = hit(bad);
    assert.equal(r.raws.length, 1, bad);
    assert.ok(r.problems.length >= 1, bad);
  }
  // the wrong rule exempts nothing (and is stale)
  const wrong = hit('// guard-ok R5: not this rule');
  assert.equal(wrong.raws.length, 1);
  assert.ok(wrong.problems.some((p) => p.includes('exempts nothing')));
  // the HTML comment form works in a template
  const tpl = scanFile(
    'components/X.svelte',
    `<script lang="ts">\n  let { groups }: { groups: unknown[] } = $props();\n</script>\n<!-- guard-ok R5: layout, a badge for more than one group -->\n{#if groups.length > 1}<b>x</b>{/if}`,
  );
  assert.deepEqual(tpl.raws, []);
  assert.deepEqual(tpl.problems, []);
});

test(`inline exemptions: at most ${MAX_EXEMPTIONS}, each names its rule and a reason, and the generated report is current`, () => {
  assert.ok(scan.exemptions.length <= MAX_EXEMPTIONS, `${scan.exemptions.length} exemptions: a fact is not an exemption, migrate it`);
  for (const e of scan.exemptions) assert.ok(e.rule in RULES && e.reason.trim().length >= 10, `${e.file}:${e.line} needs a rule and a real reason`);
  assert.equal(
    readFileSync(EXEMPTIONS_FILE, 'utf8'),
    serializeExemptions(scan.exemptions),
    'component-guard.exemptions.json is out of date: node scripts/component-guard/cli.ts --report',
  );
});
