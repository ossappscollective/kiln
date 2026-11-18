/**
 * Reads the `workflow_dispatch` inputs out of a GitHub Actions workflow file, so the dispatch
 * dialog can show real fields. GitHub's API does not return them; they live in the YAML.
 *
 * There is no YAML dependency, so this is a small reader for the block style GitHub workflows are
 * written in: maps, lists, quoted and plain scalars, `|` and `>` block scalars, flow lists such as
 * `[a, b]`, comments. It does not understand anchors, aliases, tags or multi-document files. When
 * the file uses something it cannot read, the result says `parsed: false` and the dialog falls
 * back to free-form inputs. It never throws.
 */

export type WorkflowInputType = 'string' | 'boolean' | 'choice' | 'number' | 'environment';

export type WorkflowInputSpec = {
  name: string;
  description?: string;
  required: boolean;
  /** Always text, as GitHub sends inputs: `true`, `1.2`, a branch name. */
  default?: string;
  type: WorkflowInputType;
  /** The allowed values of a `choice` input. */
  options?: string[];
};

export type WorkflowDispatchInfo = {
  /** True when the file has a `workflow_dispatch` trigger, false when it has none, null when unknown. */
  dispatchable: boolean | null;
  /** False when the file could not be read; `inputs` is then empty and means nothing. */
  parsed: boolean;
  inputs: WorkflowInputSpec[];
};

type Y = string | Y[] | { [key: string]: Y };
type Line = { indent: number; text: string; raw: string };

const isMap = (v: Y | undefined): v is { [key: string]: Y } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Cuts a trailing ` # comment`, leaving a `#` inside quotes alone. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    // A quote opens a string only where a value can start, so `don't` is plain text.
    if ((ch === '"' || ch === "'") && (i === 0 || /[\s:[{,-]/.test(text[i - 1] as string))) {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1] as string))) return text.slice(0, i);
  }
  return text;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v
      .slice(1, -1)
      .replace(/\\(["\\/nt])/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** `[a, "b, c", d]` as a list. Nested brackets are kept as text. */
function flowList(value: string): string[] {
  const inner = value.trim().slice(1, -1);
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') items.push(current);
  return items.map(unquote);
}

/** The key and the rest of a `key: rest` line, or undefined when the line is not one. */
function splitKey(text: string): { key: string; rest: string } | undefined {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+(.*)|)$/.exec(text);
  if (quoted) return { key: unquote(quoted[1] as string), rest: (quoted[2] ?? '').trim() };
  const plain = /^([^\s:#[\]{}"'&*!|>%@`-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*)|)$/.exec(text);
  if (plain) return { key: (plain[1] as string).trim(), rest: (plain[2] ?? '').trim() };
  return undefined;
}

const isItem = (text: string) => text === '-' || text.startsWith('- ');

class Reader {
  i = 0;
  readonly lines: Line[];
  constructor(lines: Line[]) {
    this.lines = lines;
  }

  /** Moves past blank and comment-only lines. */
  skip() {
    while (this.i < this.lines.length && (this.lines[this.i] as Line).text === '') this.i++;
  }

  peek(): Line | undefined {
    this.skip();
    return this.lines[this.i];
  }
}

class Unreadable extends Error {}

function scalarOrFlow(rest: string): Y {
  if (rest.startsWith('[')) {
    if (!rest.endsWith(']')) throw new Unreadable('multi-line flow list');
    return flowList(rest);
  }
  if (rest.startsWith('{')) return rest;
  if (rest.startsWith('&') || rest.startsWith('*') || rest.startsWith('!')) {
    throw new Unreadable('anchor, alias or tag');
  }
  return unquote(rest);
}

/** The lines of a `|` or `>` block under a key at `base`, folded or kept as the indicator says. */
function blockScalar(r: Reader, base: number, indicator: string): string {
  const body: string[] = [];
  let indent: number | undefined;
  while (r.i < r.lines.length) {
    const line = r.lines[r.i] as Line;
    const blank = line.raw.trim() === '';
    if (!blank && line.indent <= base) break;
    if (!blank) indent ??= line.indent;
    body.push(blank ? '' : line.raw.slice(Math.min(indent ?? 0, line.raw.length - line.raw.trimStart().length)));
    r.i++;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const folded = indicator.startsWith('>');
  return folded ? body.join(' ').replace(/ {2,}/g, ' ') : body.join('\n');
}

function parseBlock(r: Reader, minIndent: number): Y | undefined {
  const line = r.peek();
  if (!line || line.indent < minIndent) return undefined;
  if (isItem(line.text)) return parseList(r, line.indent);
  if (splitKey(line.text)) return parseMap(r, line.indent);
  r.i++;
  return unquote(line.text);
}

function parseList(r: Reader, base: number): Y[] {
  const out: Y[] = [];
  for (let line = r.peek(); line && line.indent === base && isItem(line.text); line = r.peek()) {
    const rest = line.text.slice(1).trim();
    if (rest === '') {
      r.i++;
      out.push(parseBlock(r, base + 1) ?? '');
    } else if (splitKey(rest) && !rest.startsWith('"') && !rest.startsWith("'")) {
      // `- name: x`: a map whose first key sits after the dash.
      const offset = line.text.indexOf(rest);
      r.lines[r.i] = { indent: base + offset, text: rest, raw: ' '.repeat(base + offset) + rest };
      out.push(parseMap(r, base + offset));
    } else {
      r.i++;
      out.push(scalarOrFlow(rest));
    }
  }
  return out;
}

function parseMap(r: Reader, base: number): { [key: string]: Y } {
  const out: { [key: string]: Y } = {};
  for (let line = r.peek(); line && line.indent === base; line = r.peek()) {
    const entry = splitKey(line.text);
    if (!entry) throw new Unreadable('not a key');
    r.i++;
    let value: Y;
    if (entry.rest === '') {
      const next = r.peek();
      if (next && next.indent === base && isItem(next.text)) value = parseList(r, base);
      else value = parseBlock(r, base + 1) ?? '';
    } else if (/^[|>][+-]?\d*$/.test(entry.rest)) {
      value = blockScalar(r, base, entry.rest);
    } else {
      value = scalarOrFlow(entry.rest);
      // A plain scalar may continue on the following, more indented lines.
      if (typeof value === 'string' && !entry.rest.startsWith('"') && !entry.rest.startsWith("'")) {
        for (let next = r.peek(); next && next.indent > base && !isItem(next.text); next = r.peek()) {
          value = `${value} ${next.text}`;
          r.i++;
        }
      }
    }
    out[entry.key] = value;
  }
  return out;
}

const TYPES: readonly string[] = ['string', 'boolean', 'choice', 'number', 'environment'];

const asText = (v: Y | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

function toSpec(name: string, node: Y | undefined): WorkflowInputSpec {
  const spec = isMap(node) ? node : {};
  const options = Array.isArray(spec.options)
    ? spec.options.filter((o): o is string => typeof o === 'string')
    : undefined;
  const declared = asText(spec.type)?.trim();
  const type = (
    declared && TYPES.includes(declared) ? declared : options && options.length > 0 ? 'choice' : 'string'
  ) as WorkflowInputType;
  const out: WorkflowInputSpec = {
    name,
    required: asText(spec.required)?.trim().toLowerCase() === 'true',
    type,
  };
  const description = asText(spec.description)?.trim();
  if (description) out.description = description;
  const fallback = asText(spec.default);
  if (fallback !== undefined) out.default = fallback;
  if (options && options.length > 0) out.options = options;
  return out;
}

export function parseWorkflowDispatch(yaml: string): WorkflowDispatchInfo {
  try {
    const lines: Line[] = yaml.split(/\r?\n/).map((raw) => {
      const indent = raw.length - raw.trimStart().length;
      return { indent, text: stripComment(raw).trim(), raw };
    });
    const top = parseBlock(new Reader(lines), 0);
    if (!isMap(top)) return { dispatchable: null, parsed: false, inputs: [] };
    const on = top.on ?? top.true;
    if (on === undefined) return { dispatchable: false, parsed: true, inputs: [] };
    if (typeof on === 'string') {
      return { dispatchable: on.trim() === 'workflow_dispatch', parsed: true, inputs: [] };
    }
    if (Array.isArray(on)) {
      return { dispatchable: on.includes('workflow_dispatch'), parsed: true, inputs: [] };
    }
    if (!('workflow_dispatch' in on)) return { dispatchable: false, parsed: true, inputs: [] };
    const dispatch = on.workflow_dispatch;
    const inputs = isMap(dispatch) && isMap(dispatch.inputs) ? dispatch.inputs : {};
    return {
      dispatchable: true,
      parsed: true,
      inputs: Object.entries(inputs).map(([name, node]) => toSpec(name, node)),
    };
  } catch {
    return { dispatchable: null, parsed: false, inputs: [] };
  }
}
