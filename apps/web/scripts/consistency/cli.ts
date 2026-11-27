import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  allDisagreements,
  diffExpected,
  type ExpectedFile,
  nextExpected,
  serializeExpected,
  summaryTable,
} from '../../src/lib/app-state/consistency-report.ts';

/**
 * The consistency harness on the command line (docs/state-model.md, "Consistency contract"). Run from apps/web:
 *
 *   node --import ./src/lib/i18n/test-setup.ts scripts/consistency/cli.ts               the burn-down list: disagreements by domain
 *   node --import ./src/lib/i18n/test-setup.ts scripts/consistency/cli.ts --check       compare with consistency.expected.json (exit 1 on a difference)
 *   node --import ./src/lib/i18n/test-setup.ts scripts/consistency/cli.ts --prune       drop the entries that no longer disagree (never adds one)
 *   node --import ./src/lib/i18n/test-setup.ts scripts/consistency/cli.ts --regenerate  rebuild the list from the code (adds everything: Wave 1 only)
 */
const FILE = fileURLToPath(new URL('../../src/lib/app-state/consistency.expected.json', import.meta.url));
const arg = process.argv.slice(2);
const expected = JSON.parse(readFileSync(FILE, 'utf8')) as ExpectedFile;
const current = allDisagreements();

if (arg.includes('--prune') || arg.includes('--regenerate')) {
  const next = nextExpected(current, expected, arg.includes('--regenerate') ? 'regenerate' : 'prune');
  writeFileSync(FILE, serializeExpected(next));
  console.log(`wrote ${FILE}: ${expected.entries.length} -> ${next.entries.length} entries`);
} else if (arg.includes('--check')) {
  const d = diffExpected(current, expected);
  for (const a of d.added) console.log(`NEW     ${a.scenario} :: ${a.factKey}  [${a.surfaces.join(', ')}]`);
  for (const f of d.fixed) console.log(`FIXED   ${f.scenario} :: ${f.factKey}`);
  for (const c of d.changed) console.log(`CHANGED ${c.entry.scenario} :: ${c.entry.factKey}`);
  process.exitCode = d.added.length + d.fixed.length + d.changed.length === 0 ? 0 : 1;
} else {
  console.log(summaryTable(current));
}
