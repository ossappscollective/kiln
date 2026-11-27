import { writeFileSync } from 'node:fs';
import {
  ALLOWLIST_FILE,
  compare,
  loadAllowlist,
  nextAllowlist,
  registryExists,
  scanTree,
  SERVER_RULES,
  type ServerRuleId,
  serializeAllowlist,
} from './server-guard.ts';

/** `node src/server-guard-cli.ts [--files|--check|--prune|--regenerate]` from apps/server. */
const arg = process.argv.slice(2);
const { groups } = scanTree();
const list = loadAllowlist();
if (arg.includes('--regenerate') || arg.includes('--prune')) {
  const next = nextAllowlist(groups, list, arg.includes('--regenerate') ? 'regenerate' : 'prune');
  writeFileSync(ALLOWLIST_FILE, serializeAllowlist(next));
  console.log(`wrote ${ALLOWLIST_FILE}: ${list.entries.length} -> ${next.entries.length} entries`);
} else if (arg.includes('--check')) {
  const d = compare(groups, list, (r) => r !== 'S2' || registryExists());
  for (const a of d.added) console.log(`NEW   ${a.group.rule} ${a.group.file}:${a.group.line}  ${a.group.snippet}`);
  for (const s of d.stale) console.log(`STALE ${s.entry.rule} ${s.entry.file}  ${s.entry.snippet}`);
  process.exitCode = d.added.length + d.stale.length === 0 ? 0 : 1;
} else {
  console.log(`server guard allowlist: ${list.entries.length} entries${registryExists() ? '' : ' (S2 inactive: no registry yet)'}`);
  for (const r of Object.keys(SERVER_RULES) as ServerRuleId[]) {
    const mine = list.entries.filter((e) => e.rule === r);
    console.log(`  ${r} ${SERVER_RULES[r].name}: ${mine.length} entries, ${new Set(mine.map((e) => e.file)).size} files`);
    if (arg.includes('--files')) for (const e of mine) console.log(`     x${e.count} ${e.file}  ${e.snippet}`);
  }
}
