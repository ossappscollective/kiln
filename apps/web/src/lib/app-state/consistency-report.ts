import { SCENARIOS } from './consistency-world.ts';
import {
  type Disagreement,
  type Domain,
  disagreementsOf,
  SURFACES,
  type Surface,
} from './projections.ts';

/**
 * The expected disagreements and the burn-down table of the consistency harness (docs/state-model.md, "Consistency contract").
 * `consistency.expected.json` lists every (scenario, fact key) on which two surfaces show different values TODAY. The list only shrinks:
 * the test fails when a disagreement appears that is not listed, and when a listed one stops disagreeing (remove it) or involves other
 * surfaces than listed (update it). Pure: the file is read and written by the test and the CLI.
 */

export type ExpectedEntry = {
  scenario: string;
  factKey: string;
  domain: Domain;
  /** The surfaces that show the key (all of them, sorted). */
  surfaces: string[];
  /** Where the divergent logic lives today (file:line). */
  mirrors: string[];
  /** Why they differ, in a sentence (hand-written; kept when the entry survives a regeneration). */
  note: string;
};
export type ExpectedFile = { $comment?: string; entries: ExpectedEntry[] };

export const keyOfEntry = (e: { scenario: string; factKey: string }) =>
  `${e.scenario}\u0000${e.factKey}`;

export function allDisagreements(surfaces: readonly Surface[] = SURFACES): Disagreement[] {
  return Object.keys(SCENARIOS).flatMap((name) =>
    disagreementsOf((SCENARIOS[name] as () => never)(), surfaces),
  );
}

export type Diff = {
  /** Disagreements that are not in the expected list. */
  added: Disagreement[];
  /** Expected entries that no longer disagree. */
  fixed: ExpectedEntry[];
  /** Expected entries whose set of surfaces changed. */
  changed: { entry: ExpectedEntry; now: Disagreement }[];
};

export function diffExpected(current: readonly Disagreement[], expected: ExpectedFile): Diff {
  const want = new Map(expected.entries.map((e) => [keyOfEntry(e), e]));
  const have = new Map(current.map((d) => [keyOfEntry(d), d]));
  const added = current.filter((d) => !want.has(keyOfEntry(d)));
  const fixed = expected.entries.filter((e) => !have.has(keyOfEntry(e)));
  const changed: Diff['changed'] = [];
  for (const e of expected.entries) {
    const d = have.get(keyOfEntry(e));
    if (d !== undefined && JSON.stringify(d.surfaces) !== JSON.stringify([...e.surfaces].sort()))
      changed.push({ entry: e, now: d });
  }
  return { added, fixed, changed };
}

export function nextExpected(
  current: readonly Disagreement[],
  expected: ExpectedFile,
  mode: 'prune' | 'regenerate',
): ExpectedFile {
  const old = new Map(expected.entries.map((e) => [keyOfEntry(e), e]));
  const entries: ExpectedEntry[] = [];
  for (const d of current) {
    const e = old.get(keyOfEntry(d));
    if (e === undefined && mode === 'prune') continue;
    entries.push({
      scenario: d.scenario,
      factKey: d.factKey,
      domain: d.domain,
      surfaces: d.surfaces,
      mirrors: d.mirrors,
      note: e?.note ?? '',
    });
  }
  return { ...(expected.$comment !== undefined ? { $comment: expected.$comment } : {}), entries };
}

export function serializeExpected(file: ExpectedFile): string {
  const head =
    file.$comment !== undefined ? `  "$comment": ${JSON.stringify(file.$comment)},\n` : '';
  const rows = file.entries.map((e) => `    ${JSON.stringify(e)}`).join(',\n');
  return `{\n${head}  "entries": [\n${rows}\n  ]\n}\n`;
}

/** The burn-down table: disagreements by domain and fact family, then the list. */
export function summaryTable(current: readonly Disagreement[]): string {
  const lines: string[] = [];
  const domains: Domain[] = ['state', 'releases', 'images', 'listing'];
  lines.push(
    `consistency: ${current.length} disagreement(s) over ${Object.keys(SCENARIOS).length} scenarios and ${SURFACES.length} surfaces`,
  );
  for (const domain of domains) {
    const mine = current.filter((d) => d.domain === domain);
    lines.push(`\n[${domain}] ${mine.length}`);
    for (const d of mine) {
      const shown = d.shown.map((s) => `${s.surface}=${JSON.stringify(s.value)}`).join('  ');
      lines.push(`  ${d.scenario} :: ${d.factKey}\n      ${shown}`);
    }
  }
  return lines.join('\n');
}
