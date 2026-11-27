import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svelte/compiler';
import ts from 'typescript';

/**
 * The AST guard of the components (docs/state-model.md, "Consistency contract").
 *
 * It parses every component (`.svelte`: svelte/compiler for the script blocks AND the template expressions; `.ts`: the TypeScript
 * compiler API), finds the SHAPES that make two screens disagree about one fact, and compares them with an allowlist
 * (`component-guard.allowlist.json`). The allowlist records what the tree does TODAY: it can only shrink. A new violation fails, and an
 * allowlist entry that no longer matches fails too. Wave 3 sets `"strict": true` (an empty allowlist).
 *
 * Plain TypeScript with erasable syntax only: it runs with `node scripts/component-guard/cli.ts` (no build step). Biome does not read it
 * and svelte-check does not include `scripts/`.
 */

export const RULE_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'] as const;
export type RuleId = (typeof RULE_IDS)[number];
export const DOMAINS = ['images', 'releases', 'listing', 'state'] as const;
export type Domain = (typeof DOMAINS)[number];

export type RuleInfo = {
  id: RuleId;
  name: string;
  /** The words of the failure. */
  message: string;
  /** What to do instead. */
  instead: string;
  /** Collapse every hit of one name in one file into ONE entry (presence), instead of counting positions. */
  byName: boolean;
};

export const RULES: Readonly<Record<RuleId, RuleInfo>> = {
  R1: {
    id: 'R1',
    name: 'no-fact-read-in-component',
    message: 'a component reads a state-bearing endpoint (`api.<read>`) by itself',
    instead:
      'read the fact from the model (`appStateStore`): one reader, one cache, one invalidation. A new fact gets a store entry, not a fetch in a component',
    byName: true,
  },
  R2: {
    id: 'R2',
    name: 'no-own-cache-or-clock',
    message:
      'a component keeps its own cache (`readCache`, `new Map`, a module-level cache) or its own freshness clock (`Date.now()`, `setInterval`)',
    instead: 'freshness and caching belong to the model; show `readAt`/ages the model hands over',
    byName: false,
  },
  R3: {
    id: 'R3',
    name: 'no-literal-limits',
    message:
      'a component compares a count/length with a literal store limit (10, 30, 100, 500, 4000, 8 MiB...) or imports a limit table',
    instead:
      'take the limit and the verdict from the facts layer (`problems`/`limit` of the model); never retype a limit',
    byName: false,
  },
  R4: {
    id: 'R4',
    name: 'no-own-version-logic',
    message:
      'a component compares/sorts versions or picks the live/latest/obsolete release by itself',
    instead: 'read `appState.candidates`, `.obsolete`, `.analysis[...]`: one comparator, one pick',
    byName: true,
  },
  R5: {
    id: 'R5',
    name: 'no-own-counts-over-facts',
    message: 'a component counts a fact collection by itself (`.filter().length`, `.reduce`, `.length` shown as a label)',
    instead: 'read the count the model derives (a number with one definition), never recount a list',
    byName: false,
  },
  R6: {
    id: 'R6',
    name: 'no-direct-listing-or-image-read',
    message:
      'a component calls `getLiveListing`/`getDrift`/`appListingLive`/`appListingDrift`/`checkStoreImages`/`stalledApps` directly',
    instead: 'those answers are read by the model only; components read the projected fact',
    byName: true,
  },
  R7: {
    id: 'R7',
    name: 'no-low-level-store-import',
    message:
      'a component imports a state store (`*-store`, `nav-signals`, `cart-summary`...) instead of the model facade',
    instead: 'import only `appStateStore` (and presentational libs); the model reads the stores',
    byName: true,
  },
};

/** The state-bearing read endpoints (names of `createApi()` in lib/api.ts). The test checks each still exists. */
export const READ_FACT_ENDPOINTS: readonly string[] = [
  'apps',
  'app',
  'appBuilds',
  'buildArtifacts',
  'appStaged',
  'appStoreImages',
  'appAssets',
  'appAssetDiff',
  'appStoreSubmit',
  'appStoreRelease',
  'releaseCandidates',
  'releaseEditable',
  'releaseNotesHistory',
  'releasePipeline',
  'releasePipelineSummary',
  'releaseAssetProposal',
  'releaseAssetProposalSummary',
  'appPlans',
  'plan',
  'appPendingCart',
  'appPendingCartDetail',
  'appPendingItemDetail',
  'appPending',
  'pendingCartSummary',
  'pendingSummary',
  'pendingPublishing',
  'publishReadiness',
  'listingFixes',
  'appListingChecks',
  'appListingHistory',
  'appInsightsCount',
  'syncActivity',
  'appTestflight',
];

/** R6: the names that only the model may call. */
export const R6_NAMES: readonly string[] = [
  'getLiveListing',
  'getDrift',
  'appListingLive',
  'appListingDrift',
  'checkStoreImages',
  'stalledApps',
];

/** R3: limit tables of core that a component must not import (the facts layer hands over the limit). */
export const LIMIT_TABLES: readonly string[] = [
  'APP_STORE_FIELD_SPECS',
  'PLAY_FIELD_SPECS',
  'PLAY_CHANGELOG_SPEC',
  'APP_STORE_COPYRIGHT_SPEC',
  'RELEASE_FIELD_SPECS',
  'STAGED_LIMITS',
  'ASSET_SYNC_LIMITS',
  'ASSET_RULES',
  'APP_STORE_KEYWORD_BYTES',
  'PLAY_NOTES_LIMIT',
  'slotMaxFiles',
  'releaseNotesLimit',
];

/** R3: numbers that are store limits somewhere (name 30, subtitle 30, short 80, keywords 100, promo 170, notes 500/4000, screenshots 10/8...). */
export const LIMIT_LITERALS: readonly number[] = [8, 10, 30, 80, 100, 170, 500, 2000, 4000, 8192];
/** R3: a `maxlength` that is a store text limit (name/subtitle 30, short description 80, promo 170, notes 500/4000...). Form fields (a token name) are not limits. */
const MAXLENGTH_LIMITS: readonly number[] = [30, 80, 170, 500, 2000, 4000];
/** R3: what a typed secret is called (its length is a format rule, not a store limit). */
const SECRET_INPUT = /\b(?:code|password|passcode|otp|pin|secret)\b/i;
const COUNTISH = /(?:\.length|count|total|size|chars|bytes|max|limit|rows|files|images|screenshots)\b/i;

/** R5: what a fact collection is called. */
const FACT_COLLECTION =
  /\b(?:staged|blockers?|releases?|builds?|locales?|images?|screenshots?|assets?|pending|failures|problems|groups|sets|candidates)\b/i;

const R4_NAMES =
  /^(?:compareVersion\w*|compareBuildNumbers|liveRelease|latestRelease|newestLive\w*|latestLive\w*|obsoleteVersions|pipelineIsObsolete|analyzeCandidates|latestVersion|newestVersion)$/;

const R7_SPECIFIER =
  /(?:-store(?:\.svelte)?|\/store\.svelte|nav-signals(?:\.svelte)?|cart-summary(?:\.svelte)?|cart-button(?:\.svelte)?|cart-preview(?:\.svelte)?|store-cache)(?:\.ts)?$/;

export type Violation = {
  file: string;
  rule: RuleId;
  hash: string;
  /** Short, whitespace-collapsed text of the offending code. */
  snippet: string;
  line: number;
  domain: Domain;
};

export type Group = Violation & { count: number };

export const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
export const EXEMPTIONS_FILE = fileURLToPath(
  new URL('../../src/lib/app-state/component-guard.exemptions.json', import.meta.url),
);
export function serializeExemptions(list: readonly Exemption[]): string {
  const rows = list.map((e) => `    ${JSON.stringify(e)}`).join(',\n');
  return `{\n  "generated": "node scripts/component-guard/cli.ts --report",\n  "exemptions": [\n${rows}\n  ]\n}\n`;
}
export const ALLOWLIST_FILE = fileURLToPath(
  new URL('../../src/lib/app-state/component-guard.allowlist.json', import.meta.url),
);

export function hashOf(text: string): string {
  return createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 8);
}

export function shorten(text: string, max = 90): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

export function domainOf(file: string, rule: RuleId, snippet: string): Domain {
  if (rule === 'R4') return 'releases';
  if (rule === 'R6') {
    if (/checkStoreImages/.test(snippet)) return 'images';
    if (/stalledApps/.test(snippet)) return 'releases';
    return 'listing';
  }
  const text = `${file} ${snippet}`;
  if (/asset|graphic|image|screenshot|storegraphics/i.test(text)) return 'images';
  if (/listing|locale|aso|keyword|metadata/i.test(file)) return 'listing';
  if (/release|build|version|candidate|stepper|testflight|promot|pipeline|obsolete|train/i.test(text))
    return 'releases';
  if (/listing|locale/i.test(snippet)) return 'listing';
  return 'state';
}

// ---------------------------------------------------------------------------------------------
// Files

export function componentFiles(root = SRC): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir)).sort()) {
      const path = dir === '' ? name : `${dir}/${name}`;
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (/\.(svelte|ts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
    }
  };
  walk('components');
  if (existsSync(join(root, 'routes'))) walk('routes');
  out.push('App.svelte');
  if (existsSync(join(root, 'main.ts'))) out.push('main.ts');
  return out.map((p) => p.split(sep).join('/'));
}

// ---------------------------------------------------------------------------------------------
// Units: pieces of code parsed by the TypeScript compiler API

type Unit = {
  sf: ts.SourceFile;
  /** Offset of the unit's text in the original file, minus any wrapper added. */
  origin: number;
  template: boolean;
  /** Top level of a module/ts file (for the module-level cache check). */
  moduleLevel: boolean;
};

const SVELTE_TYPES = new Set([
  'Root',
  'Fragment',
  'Text',
  'Comment',
  'ExpressionTag',
  'HtmlTag',
  'ConstTag',
  'DebugTag',
  'RenderTag',
  'AttachTag',
  'IfBlock',
  'EachBlock',
  'AwaitBlock',
  'KeyBlock',
  'SnippetBlock',
  'RegularElement',
  'Component',
  'SvelteElement',
  'SvelteComponent',
  'SvelteSelf',
  'SvelteHead',
  'SvelteBody',
  'SvelteWindow',
  'SvelteDocument',
  'SvelteFragment',
  'SvelteBoundary',
  'SlotElement',
  'TitleElement',
  'Attribute',
  'SpreadAttribute',
  'BindDirective',
  'OnDirective',
  'ClassDirective',
  'StyleDirective',
  'UseDirective',
  'TransitionDirective',
  'AnimateDirective',
  'LetDirective',
  'Script',
  'StyleSheet',
]);

export type ParsedFile = {
  file: string;
  text: string;
  units: Unit[];
  /** `maxlength="4000"` and friends, found in the template. */
  attributeHits: { snippet: string; start: number }[];
  error: string | null;
};

export function parseSource(file: string, text: string): ParsedFile {
  const out: ParsedFile = { file, text, units: [], attributeHits: [], error: null };
  const make = (code: string, origin: number, template: boolean, moduleLevel: boolean) => {
    const sf = ts.createSourceFile(
      `${file}.unit.ts`,
      code,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    out.units.push({ sf, origin, template, moduleLevel });
  };
  if (!file.endsWith('.svelte')) {
    make(text, 0, false, true);
    return out;
  }
  let root: any;
  try {
    root = parse(text, { modern: true } as never);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  }
  for (const [script, moduleLevel] of [
    [root.instance, false],
    [root.module, true],
  ] as const) {
    if (script?.content === undefined) continue;
    make(text.slice(script.content.start, script.content.end), script.content.start, false, moduleLevel);
  }
  const walk = (node: any): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const type = node.type;
    if (typeof type === 'string' && !SVELTE_TYPES.has(type)) {
      if (typeof node.start === 'number' && typeof node.end === 'number') {
        const slice = text.slice(node.start, node.end);
        if (type === 'VariableDeclaration') make(`${slice};`, node.start, true, false);
        else make(`(${slice});`, node.start - 1, true, false);
      }
      return;
    }
    if (type === 'Script' || type === 'StyleSheet') return;
    if (type === 'Attribute' && String(node.name).toLowerCase() === 'maxlength') {
      const v = node.value;
      const raw = Array.isArray(v)
        ? v.map((p: any) => (p.type === 'Text' ? p.data : (p.expression?.value ?? ''))).join('')
        : v?.expression?.value;
      if (/^\d+$/.test(String(raw ?? '')) && MAXLENGTH_LIMITS.includes(Number(raw)))
        out.attributeHits.push({ snippet: `maxlength="${raw}"`, start: node.start });
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'metadata' || key === 'loc' || key.endsWith('_loc')) continue;
      walk(node[key]);
    }
  };
  walk(root.fragment);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The rules

type Raw = { rule: RuleId; snippet: string; start: number };

const text = (n: ts.Node, sf: ts.SourceFile) => n.getText(sf);
const nameOf = (n: ts.Node | undefined, sf: ts.SourceFile) => (n === undefined ? '' : text(n, sf));
const num = (n: ts.Node): number | null =>
  ts.isNumericLiteral(n) ? Number(n.text.replace(/_/g, '')) : null;

/** `list.length === 0` / `> 0` / `!== 0` / `>= 1` / `< 1`: "is there anything to draw", not a count that is shown. */
function isEmptinessCheck(length: ts.PropertyAccessExpression): boolean {
  const parent = length.parent;
  if (parent === undefined || !ts.isBinaryExpression(parent)) return false;
  const other = parent.left === length ? parent.right : parent.left;
  if (!ts.isNumericLiteral(other)) return false;
  const value = Number(other.text);
  const op = parent.operatorToken.kind;
  const K = ts.SyntaxKind;
  if (value === 0) return [K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.GreaterThanToken].includes(op);
  return value === 1 && (op === K.GreaterThanEqualsToken || op === K.LessThanToken);
}

function receiverOf(call: ts.CallExpression): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : undefined;
}

export function scanUnit(unit: Unit, report: (r: Raw) => void): void {
  const { sf } = unit;
  const add = (rule: RuleId, snippet: string, node: ts.Node) =>
    report({ rule, snippet, start: unit.origin + node.getStart(sf) });
  const inImport = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n; p !== undefined; p = p.parent)
      if (ts.isImportDeclaration(p)) return true;
    return false;
  };

  // Module-level caches.
  if (unit.moduleLevel) {
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        const name = nameOf(d.name, sf);
        const init = d.initializer;
        if (
          /cache|memo|inflight|registry/i.test(name) &&
          init !== undefined &&
          !ts.isArrowFunction(init) &&
          !ts.isFunctionExpression(init)
        )
          add('R2', `module-level cache: ${name}`, d);
      }
    }
  }

  const visit = (n: ts.Node): void => {
    // ---- imports (R2 readCache, R3 limit tables, R6/R4 names, R7 stores)
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      const clause = n.importClause;
      const names: string[] = [];
      if (clause?.name !== undefined) names.push(clause.name.text);
      if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings))
        for (const el of clause.namedBindings.elements)
          names.push((el.propertyName ?? el.name).text);
      if (!(clause?.isTypeOnly ?? false)) {
        for (const nm of names) {
          if (nm === 'readCache') add('R2', 'readCache', n);
          if (LIMIT_TABLES.includes(nm)) add('R3', `import ${nm}`, n);
          if (R6_NAMES.includes(nm)) add('R6', nm, n);
          if (R4_NAMES.test(nm)) add('R4', nm, n);
        }
        if (/\/read-cache(?:\.ts)?$/.test(spec)) add('R2', 'readCache', n);
        else if (R7_SPECIFIER.test(spec) && !spec.includes('app-state/'))
          add('R7', `import ${spec.replace(/^(?:\.\.?\/)+/, '')}`, n);
      }
      return;
    }

    // ---- identifiers (not inside an import)
    if (ts.isIdentifier(n) && !inImport(n)) {
      const id = n.text;
      if (id === 'readCache') add('R2', 'readCache', n);
      if (R6_NAMES.includes(id)) add('R6', id, n);
      if (R4_NAMES.test(id)) add('R4', id, n);
    }

    // ---- calls
    if (ts.isCallExpression(n)) {
      const callee = text(n.expression, sf);
      if (callee === 'Date.now') add('R2', 'Date.now()', n);
      if (callee === 'setInterval') add('R2', 'setInterval(...)', n);
      // R1: api.<read>(...) / props.api.<read>(...)
      if (ts.isPropertyAccessExpression(n.expression)) {
        const m = n.expression.name.text;
        const rcv = text(n.expression.expression, sf);
        if ((rcv === 'api' || rcv.endsWith('.api')) && READ_FACT_ENDPOINTS.includes(m)) {
          if (!R6_NAMES.includes(m)) add('R1', `api.${m}`, n);
        }
        // R4: parseInt/Number of a version, .sort(version), localeCompare numeric
        if (m === 'localeCompare' && /numeric/.test(text(n, sf))) add('R4', 'localeCompare numeric', n);
        if (m === 'sort' && /version/i.test(n.arguments.map((a) => text(a, sf)).join(' ')))
          add('R4', 'sort by version', n);
        // R5: .reduce( over a fact collection
        if (m === 'reduce' && FACT_COLLECTION.test(rcv)) add('R5', shorten(text(n, sf)), n);
      }
      if (
        (callee === 'parseInt' || callee === 'parseFloat') &&
        /version/i.test(n.arguments.map((a) => text(a, sf)).join(' '))
      )
        add('R4', 'parseInt of a version', n);
    }

    // ---- new Map
    if (ts.isNewExpression(n)) {
      const c = text(n.expression, sf);
      // A cache is an EMPTY map that lives as long as the component (or the module). A map built from a list (`new Map(rows.map(...))`)
      // is a lookup index, and a map inside a function / `$derived` is an accumulator: neither remembers anything between reads.
      const empty = n.arguments === undefined || n.arguments.length === 0;
      let inFunction = false;
      for (let p: ts.Node | undefined = n.parent; p !== undefined; p = p.parent)
        if (ts.isFunctionLike(p)) inFunction = true;
      if ((c === 'Map' || c === 'WeakMap') && empty && !inFunction) add('R2', shorten(text(n, sf), 60), n);
    }

    // ---- comparisons with literal limits (R3)
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      const cmp =
        op === ts.SyntaxKind.LessThanToken ||
        op === ts.SyntaxKind.LessThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanToken ||
        op === ts.SyntaxKind.GreaterThanEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      if (cmp) {
        const l = num(n.left);
        const r = num(n.right);
        const lit = r ?? l;
        const other = r !== null ? n.left : n.right;
        if (
          lit !== null &&
          LIMIT_LITERALS.includes(lit) &&
          COUNTISH.test(text(other, sf)) &&
          !SECRET_INPUT.test(text(other, sf)) // the length of a typed code / password is a format, not a store limit
        )
          add('R3', shorten(text(n, sf), 70), n);
      }
      if (op === ts.SyntaxKind.AsteriskToken) {
        const t = text(n, sf);
        if (/^8\s*\*\s*(?:1024|MiB|MB)\b/.test(t)) add('R3', '8 MiB', n);
      }
    }

    // ---- fact collections counted by hand (R5)
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'length') {
      const inner = n.expression;
      if (
        ts.isCallExpression(inner) &&
        ts.isPropertyAccessExpression(inner.expression) &&
        inner.expression.name.text === 'filter' &&
        FACT_COLLECTION.test(text(inner.expression.expression, sf))
      )
        add('R5', shorten(text(n, sf)), n);
      else if (
        unit.template &&
        FACT_COLLECTION.test(text(inner, sf)) &&
        !ts.isCallExpression(inner) &&
        !isEmptinessCheck(n)
      )
        add('R5', shorten(text(n, sf)), n);
    }
    if (ts.isVariableDeclaration(n) && n.initializer !== undefined) {
      const nm = nameOf(n.name, sf);
      const init = n.initializer;
      if (
        /(?:count|total|num[A-Z]|^n[A-Z])/.test(nm) &&
        /\.length\b/.test(text(init, sf)) &&
        FACT_COLLECTION.test(text(init, sf)) &&
        !/\.filter\(/.test(text(init, sf)) // (the filter shape is reported above)
      )
        add('R5', shorten(`${nm} = ${text(init, sf)}`), n);
    }

    ts.forEachChild(n, visit);
  };
  visit(sf);
}

/** An inline exemption: a line comment `guard-ok R5: <reason>` (also in a block comment or an HTML comment), on the line of the code or the line above. */
export type Exemption = { file: string; line: number; rule: RuleId; reason: string };
export const MAX_EXEMPTIONS = 25;
const GUARD_OK = /guard-ok\b([^\n]*)/;
const GUARD_OK_FULL = /guard-ok\s+(R[1-7])\s*:\s*(\S[^\n]*?)\s*(?:-->|\*\/)?\s*$/;

export type ScanResult = { violations: Violation[]; errors: string[]; files: number; exemptions: Exemption[] };

export function scanFile(
  file: string,
  source: string,
): { raws: Violation[]; error: string | null; exemptions: Exemption[]; problems: string[] } {
  const parsed = parseSource(file, source);
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const raws: Violation[] = [];
  const push = (r: Raw) => {
    const snippet = shorten(r.snippet);
    raws.push({
      file,
      rule: r.rule,
      hash: hashOf(r.snippet),
      snippet,
      line: lineOf(Math.max(0, r.start)),
      domain: domainOf(file, r.rule, r.snippet),
    });
  };
  for (const u of parsed.units) scanUnit(u, push);
  for (const a of parsed.attributeHits) push({ rule: 'R3', snippet: a.snippet, start: a.start });

  // Inline exemptions: honoured only with a rule AND a non-empty reason, only for a hit on the same or the next line, and only while
  // they still exempt something.
  const lines = source.split('\n');
  const marks = new Map<number, Exemption>();
  const problems: string[] = [];
  lines.forEach((text, i) => {
    if (!GUARD_OK.test(text)) return;
    const m = GUARD_OK_FULL.exec(text);
    if (m === null) problems.push(`${file}:${i + 1}: guard-ok needs a rule and a reason: \`guard-ok R5: <why this is not a fact>\``);
    else marks.set(i + 1, { file, line: i + 1, rule: m[1] as RuleId, reason: m[2] ?? '' });
  });
  const used = new Set<number>();
  const kept = raws.filter((v) => {
    for (const at of [v.line, v.line - 1]) {
      const mark = marks.get(at);
      if (mark !== undefined && mark.rule === v.rule) {
        used.add(at);
        return false;
      }
    }
    return true;
  });
  const exemptions: Exemption[] = [];
  for (const [at, mark] of marks) {
    if (used.has(at)) exemptions.push(mark);
    else problems.push(`${file}:${at}: guard-ok ${mark.rule} exempts nothing (stale: remove it)`);
  }
  return { raws: kept, error: parsed.error, exemptions, problems };
}

/** Group by (file, rule, hash): the key of the allowlist. Name rules count once per name. */
export function groupViolations(raws: readonly Violation[]): Group[] {
  const map = new Map<string, Group>();
  for (const v of raws) {
    const key = `${v.file}\u0000${v.rule}\u0000${v.hash}`;
    const g = map.get(key);
    if (g === undefined) map.set(key, { ...v, count: 1 });
    else if (!RULES[v.rule].byName) g.count += 1;
  }
  return [...map.values()].sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.hash.localeCompare(b.hash),
  );
}

export function scanTree(root = SRC): ScanResult {
  const raws: Violation[] = [];
  const errors: string[] = [];
  const exemptions: Exemption[] = [];
  const files = componentFiles(root);
  for (const file of files) {
    const r = scanFile(file, readFileSync(join(root, file), 'utf8'));
    if (r.error !== null) errors.push(`${file}: ${r.error}`);
    errors.push(...r.problems);
    raws.push(...r.raws);
    exemptions.push(...r.exemptions);
  }
  return { violations: raws, errors, files: files.length, exemptions };
}

// ---------------------------------------------------------------------------------------------
// The allowlist

export type AllowEntry = {
  file: string;
  rule: RuleId;
  hash: string;
  snippet: string;
  count: number;
  domain: Domain;
  reason: string;
};

export type AllowlistFile = { $comment?: string; strict: boolean; entries: AllowEntry[] };

export const DEFAULT_REASON: Readonly<Record<RuleId, string>> = {
  R1: 'reads a fact endpoint by itself: move the read into the model (Wave 2)',
  R2: 'own cache or clock: the model owns freshness (Wave 2)',
  R3: 'literal limit or limit table in a component: take it from the facts layer (Wave 2)',
  R4: 'own version compare/pick: read the candidate analysis of the model (Wave 2)',
  R5: 'own count over a fact collection: read the derived count (Wave 2)',
  R6: 'direct read of listing/images/stalled: model only (Wave 2)',
  R7: 'imports a low-level store: read the model facade (Wave 2)',
};

export function loadAllowlist(path = ALLOWLIST_FILE): AllowlistFile {
  if (!existsSync(path)) return { strict: false, entries: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as AllowlistFile;
}

const keyOf = (e: { file: string; rule: string; hash: string }) => `${e.file}\u0000${e.rule}\u0000${e.hash}`;

export type Comparison = {
  /** Violations beyond what the allowlist grants. */
  added: { group: Group; allowed: number }[];
  /** Allowlist entries (or part of their count) that no longer match. */
  stale: { entry: AllowEntry; actual: number }[];
};

export function compare(groups: readonly Group[], list: AllowlistFile): Comparison {
  const allowed = new Map<string, AllowEntry>();
  if (!list.strict) for (const e of list.entries) allowed.set(keyOf(e), e);
  const added: Comparison['added'] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    const e = allowed.get(keyOf(g));
    seen.add(keyOf(g));
    if (e === undefined) added.push({ group: g, allowed: 0 });
    else if (g.count > e.count) added.push({ group: g, allowed: e.count });
  }
  const stale: Comparison['stale'] = [];
  const actual = new Map(groups.map((g) => [keyOf(g), g.count]));
  for (const e of allowed.values()) {
    const a = actual.get(keyOf(e)) ?? 0;
    if (a < e.count) stale.push({ entry: e, actual: a });
  }
  return { added, stale };
}

/** `prune`: only remove/reduce entries. `regenerate`: rebuild from the tree (keeps reason/domain of an entry that survives). */
export function nextAllowlist(
  groups: readonly Group[],
  list: AllowlistFile,
  mode: 'prune' | 'regenerate',
): AllowlistFile {
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
      domain: e?.domain ?? g.domain,
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

export function summarize(entries: readonly { rule: RuleId; domain: Domain; count: number }[]): {
  byDomain: Record<string, Record<string, number>>;
  byRule: Record<string, number>;
  total: number;
} {
  const byDomain: Record<string, Record<string, number>> = {};
  const byRule: Record<string, number> = {};
  let total = 0;
  for (const e of entries) {
    const d = (byDomain[e.domain] ??= {});
    d[e.rule] = (d[e.rule] ?? 0) + 1;
    byRule[e.rule] = (byRule[e.rule] ?? 0) + 1;
    total += 1;
  }
  return { byDomain, byRule, total };
}
