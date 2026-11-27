import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * The AST guard of the server (docs/state-model.md, "Consistency contract"): routes and modules compute counts, blockers and versions
 * with the pure rules of `@kiln/core`, never with a literal of their own, and keep no cache outside the registry.
 *
 *  - S1 `no-literal-limits`: a limit / TTL / threshold written as a number (`maxChars: 4000`, `PUBLISH_SILENT_AFTER_MS = 60_000`, a
 *    count compared with 10, 30, 100, 500, 4000, 8 MiB). The number belongs to `@kiln/core` (limits, specs, timings), imported by name.
 *  - S2 `no-cache-outside-registry`: `new Map(` or a cache factory outside `services/cache-registry.ts` / `services/timed-cache.ts`.
 *    Active only while the registry file exists (agent F creates it; the rule is skipped until then).
 *
 * `server-guard.allowlist.json` records what the tree does today and can only shrink (same contract as the component guard).
 * CLI: `node src/server-guard.ts [--report|--check|--prune|--regenerate]` from apps/server.
 */

export type ServerRuleId = 'S1' | 'S2';
export const SERVER_RULES: Readonly<Record<ServerRuleId, { name: string; message: string; instead: string }>> = {
  S1: {
    name: 'no-literal-limits',
    message: 'a limit, TTL or threshold is a literal number in server code',
    instead: 'import it from @kiln/core (listing specs, limits, timings): one number, one owner, shared with the browser',
  },
  S2: {
    name: 'no-cache-outside-registry',
    message: 'a cache (`new Map`, `timedCache`) outside the cache registry',
    instead: 'create it through services/cache-registry.ts (`timedCache(ttl, max, declaration)` / `registerMapCache`) and declare its events',
  },
};

export const ROOT = fileURLToPath(new URL('./', import.meta.url));
export const ALLOWLIST_FILE = join(ROOT, 'server-guard.allowlist.json');
export const REGISTRY_FILES = ['services/cache-registry.ts', 'services/timed-cache.ts'];

const LIMIT_LITERALS: readonly number[] = [8, 10, 30, 80, 100, 170, 500, 2000, 4000, 8192, 8 * 1024 * 1024];
const TIMING_LITERALS: readonly number[] = [
  20_000, 30_000, 45_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
];
const LIMITISH = /(?:max|limit|ttl|fresh|stuck|quiet|silent|cap|after)/i;
/** S1 watches the places that judge store facts (counts, blockers, versions, freshness); an AI prompt budget or a retry delay is not one. */
export const S1_SCOPE = /^(?:modules\/(?:listing|publish|planning|builds|testflight|timeline)\/|services\/(?!mail|credential|invitation|members|accounts|audit|events|event-types|local|clone|change-set))/;
const COUNTISH = /(?:\.length|count|total|size|chars|bytes|max|limit|rows|files|images|screenshots)\b/i;

export type Violation = { file: string; rule: ServerRuleId; hash: string; snippet: string; line: number };
export type Group = Violation & { count: number };

export const hashOf = (text: string) =>
  createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 8);
export const shorten = (text: string, max = 90) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
};

export function serverFiles(root = ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir)).sort()) {
      const path = dir === '' ? name : `${dir}/${name}`;
      if (statSync(join(root, path)).isDirectory()) {
        if (name === 'demo' || name === 'node_modules') continue;
        walk(path);
      } else if (
        /\.ts$/.test(name) &&
        !/\.test\.ts$/.test(name) &&
        !/(?:^testkit|-test-helpers|test-server|test-setup|^server-guard)/.test(name) &&
        !/^\.tmp/.test(name)
      )
        out.push(path);
    }
  };
  walk('');
  return out;
}

/** The value of a constant expression of literals (`60_000`, `60 * 1000`, `8 * 1024 * 1024`), or null. */
function constant(n: ts.Expression): number | null {
  if (ts.isNumericLiteral(n)) return Number(n.text.replace(/_/g, ''));
  if (ts.isParenthesizedExpression(n)) return constant(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
    const l = constant(n.left);
    const r = constant(n.right);
    return l !== null && r !== null ? l * r : null;
  }
  return null;
}

export const registryExists = (root = ROOT) => existsSync(join(root, REGISTRY_FILES[0] ?? ''));

export function scanFile(file: string, source: string): Violation[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out: Violation[] = [];
  const add = (rule: ServerRuleId, snippet: string, node: ts.Node) =>
    out.push({
      file,
      rule,
      hash: hashOf(snippet),
      snippet: shorten(snippet),
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    });
  const inScope = S1_SCOPE.test(file);
  const isLimit = (v: number | null, name: string) =>
    inScope &&
    v !== null && (LIMIT_LITERALS.includes(v) || (TIMING_LITERALS.includes(v) && LIMITISH.test(name)));
  const isRegistry = REGISTRY_FILES.includes(file);
  const visit = (n: ts.Node): void => {
    // `const MAX = 4000`, `{ maxChars: 4000 }`, `max = 500` (default)
    if (
      (ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n) || ts.isParameter(n) || ts.isPropertyDeclaration(n)) &&
      n.name !== undefined
    ) {
      const init = n.initializer;
      const name = n.name.getText(sf);
      if (init !== undefined && LIMITISH.test(name)) {
        const v = constant(init);
        if (isLimit(v, name)) add('S1', `${name} = ${init.getText(sf)}`, n);
      }
    }
    // `x.length > 10`, `count >= 500`
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (
        k === ts.SyntaxKind.LessThanToken ||
        k === ts.SyntaxKind.LessThanEqualsToken ||
        k === ts.SyntaxKind.GreaterThanToken ||
        k === ts.SyntaxKind.GreaterThanEqualsToken
      ) {
        const l = constant(n.left);
        const r = constant(n.right);
        const lit = r ?? l;
        const other = r !== null ? n.left : n.right;
        if (inScope && lit !== null && LIMIT_LITERALS.includes(lit) && COUNTISH.test(other.getText(sf)))
          add('S1', n.getText(sf), n);
      }
    }
    // S2
    if (!isRegistry) {
      if (ts.isNewExpression(n) && (n.expression.getText(sf) === 'Map' || n.expression.getText(sf) === 'WeakMap')) {
        // A cache is a Map that lives at module level or is named like one; a Map built inside a function to group rows is not one.
        const decl = n.parent;
        const named =
          (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isPropertyAssignment(decl)) &&
          /cache|memo|inflight|recent|seen|lru/i.test(decl.name.getText(sf));
        let moduleLevel = true;
        for (let p: ts.Node | undefined = n.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent)
          if (ts.isFunctionLike(p) || ts.isClassLike(p)) moduleLevel = false;
        if (named || moduleLevel) add('S2', n.getText(sf), n);
      }
      if (ts.isCallExpression(n) && n.expression.getText(sf) === 'timedCache') add('S2', 'timedCache(...)', n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function groupViolations(raws: readonly Violation[]): Group[] {
  const map = new Map<string, Group>();
  for (const v of raws) {
    const key = `${v.file}\u0000${v.rule}\u0000${v.hash}`;
    const g = map.get(key);
    if (g === undefined) map.set(key, { ...v, count: 1 });
    else g.count += 1;
  }
  return [...map.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.hash.localeCompare(b.hash),
  );
}

export function scanTree(root = ROOT): { groups: Group[]; files: number } {
  const files = serverFiles(root);
  const raws: Violation[] = [];
  for (const f of files) raws.push(...scanFile(f, readFileSync(join(root, f), 'utf8')));
  return { groups: groupViolations(raws), files: files.length };
}

export type AllowEntry = { file: string; rule: ServerRuleId; hash: string; snippet: string; count: number; reason: string };
export type AllowlistFile = { $comment?: string; strict: boolean; entries: AllowEntry[] };

export const loadAllowlist = (path = ALLOWLIST_FILE): AllowlistFile =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as AllowlistFile) : { strict: false, entries: [] };

const keyOf = (e: { file: string; rule: string; hash: string }) => `${e.file}\u0000${e.rule}\u0000${e.hash}`;

export function compare(
  groups: readonly Group[],
  list: AllowlistFile,
  active: (rule: ServerRuleId) => boolean = () => true,
): { added: { group: Group; allowed: number }[]; stale: { entry: AllowEntry; actual: number }[] } {
  const allowed = new Map<string, AllowEntry>();
  if (!list.strict) for (const e of list.entries) if (active(e.rule)) allowed.set(keyOf(e), e);
  const added: { group: Group; allowed: number }[] = [];
  for (const g of groups) {
    if (!active(g.rule)) continue;
    const e = allowed.get(keyOf(g));
    if (e === undefined) added.push({ group: g, allowed: 0 });
    else if (g.count > e.count) added.push({ group: g, allowed: e.count });
  }
  const actual = new Map(groups.map((g) => [keyOf(g), g.count]));
  const stale: { entry: AllowEntry; actual: number }[] = [];
  for (const e of allowed.values()) {
    const a = actual.get(keyOf(e)) ?? 0;
    if (a < e.count) stale.push({ entry: e, actual: a });
  }
  return { added, stale };
}

const DEFAULT_REASON: Readonly<Record<ServerRuleId, string>> = {
  S1: 'literal limit/threshold: move to @kiln/core (limits, timings) and import it',
  S2: 'cache outside the registry: create it through services/cache-registry.ts',
};

export function nextAllowlist(groups: readonly Group[], list: AllowlistFile, mode: 'prune' | 'regenerate'): AllowlistFile {
  const old = new Map(list.entries.map((e) => [keyOf(e), e]));
  const entries: AllowEntry[] = [];
  for (const g of groups) {
    const e = old.get(keyOf(g));
    if (e === undefined && mode === 'prune') continue;
    entries.push({
      file: g.file,
      rule: g.rule,
      hash: g.hash,
      snippet: g.snippet,
      count: mode === 'prune' && e !== undefined ? Math.min(g.count, e.count) : g.count,
      reason: e?.reason ?? DEFAULT_REASON[g.rule],
    });
  }
  return { ...(list.$comment !== undefined ? { $comment: list.$comment } : {}), strict: list.strict, entries };
}

export function serializeAllowlist(list: AllowlistFile): string {
  const head = list.$comment !== undefined ? `  "$comment": ${JSON.stringify(list.$comment)},\n` : '';
  const rows = list.entries.map((e) => `    ${JSON.stringify(e)}`).join(',\n');
  return `{\n${head}  "strict": ${list.strict},\n  "entries": [\n${rows}\n  ]\n}\n`;
}
