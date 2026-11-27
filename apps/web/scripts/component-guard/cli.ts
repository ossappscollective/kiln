import { writeFileSync } from 'node:fs';
import {
  ALLOWLIST_FILE,
  EXEMPTIONS_FILE,
  MAX_EXEMPTIONS,
  serializeExemptions,
  compare,
  DOMAINS,
  groupViolations,
  loadAllowlist,
  nextAllowlist,
  RULES,
  type RuleId,
  scanTree,
  serializeAllowlist,
} from './scan.ts';

/**
 * The component guard on the command line (docs/state-model.md, "Consistency contract").
 *
 *   node scripts/component-guard/cli.ts                 print the allowlist grouped by domain (the burn-down list), with counts
 *   node scripts/component-guard/cli.ts --files         ... with every file and snippet
 *   node scripts/component-guard/cli.ts --report        rewrite component-guard.exemptions.json (every inline `guard-ok Rn: reason`)
 *   node scripts/component-guard/cli.ts --check         compare the tree with the allowlist (what the test does), exit 1 on a difference
 *   node scripts/component-guard/cli.ts --prune         drop the entries that no longer match (never adds one): run it after a migration
 *   node scripts/component-guard/cli.ts --regenerate    rebuild the allowlist from the tree (adds EVERYTHING it finds: Wave 1 only)
 */
const arg = process.argv.slice(2);
const scan = scanTree();
if (scan.errors.length > 0) {
  console.error(`parse errors:\n${scan.errors.join('\n')}`);
  process.exitCode = 1;
}
if (arg.includes('--report')) {
  writeFileSync(EXEMPTIONS_FILE, serializeExemptions(scan.exemptions));
  console.log(`wrote ${EXEMPTIONS_FILE}: ${scan.exemptions.length} exemptions (max ${MAX_EXEMPTIONS})`);
  process.exit(process.exitCode ?? 0);
}
const groups = groupViolations(scan.violations);
const list = loadAllowlist();

if (arg.includes('--regenerate') || arg.includes('--prune')) {
  const next = nextAllowlist(groups, list, arg.includes('--regenerate') ? 'regenerate' : 'prune');
  writeFileSync(ALLOWLIST_FILE, serializeAllowlist(next));
  console.log(`wrote ${ALLOWLIST_FILE}: ${list.entries.length} -> ${next.entries.length} entries`);
  process.exit(process.exitCode ?? 0);
}

if (arg.includes('--check')) {
  const diff = compare(groups, list);
  for (const a of diff.added) console.log(`NEW   ${a.group.rule} ${a.group.file}:${a.group.line}  ${a.group.snippet}`);
  for (const s of diff.stale)
    console.log(`STALE ${s.entry.rule} ${s.entry.file}  ${s.entry.snippet} (allowed ${s.entry.count}, found ${s.actual})`);
  process.exit(diff.added.length + diff.stale.length === 0 ? 0 : 1);
}

const showFiles = arg.includes('--files');
const entries = list.entries;
const occurrences = entries.reduce((n, e) => n + e.count, 0);
console.log(
  `component guard allowlist: ${entries.length} entries (${occurrences} occurrences) in ${new Set(entries.map((e) => e.file)).size} files${list.strict ? ' [STRICT: allowlist ignored]' : ''}\n`,
);
const rules = Object.keys(RULES) as RuleId[];
const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(`${'domain'.padEnd(10)}${rules.map((r) => pad(r, 6)).join('')}${pad('total', 8)}${pad('files', 7)}`);
for (const domain of DOMAINS) {
  const mine = entries.filter((e) => e.domain === domain);
  const cells = rules.map((r) => mine.filter((e) => e.rule === r).length);
  console.log(
    `${domain.padEnd(10)}${cells.map((c) => pad(c, 6)).join('')}${pad(mine.length, 8)}${pad(new Set(mine.map((e) => e.file)).size, 7)}`,
  );
}
if (showFiles)
  for (const domain of DOMAINS) {
    const mine = entries.filter((e) => e.domain === domain);
    console.log(`\n== ${domain} (${mine.length})`);
    for (const e of mine) console.log(`  ${e.rule} x${e.count}  ${e.file}  ${e.snippet}`);
  }
console.log('\nrules:');
for (const r of rules) console.log(`  ${r} ${RULES[r].name}: ${RULES[r].message}`);
