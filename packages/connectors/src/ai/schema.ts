import type { JsonSchema } from './types.ts';

/**
 * A small JSON Schema validator for the answers of AI tasks, and the helper that turns a task's schema
 * into the subset every provider accepts. No dependency, no `eval`, and no value ever appears in an
 * issue: an issue names a PATH and a fixed reason, because the value is what the model wrote about
 * somebody's review.
 *
 * Supported keywords: `type` (a name or a list), `enum`, `const`, `properties`, `required`,
 * `additionalProperties` (`false` or a schema), `items`, `minItems`, `maxItems`, `minLength`, `maxLength`
 * (in code points), `minimum`, `maximum`. Annotation keywords (`description`, `title`, `$comment`,
 * `default`, `examples`) are ignored. Any other keyword THROWS when a schema is used, so a task author
 * notices at once instead of shipping a constraint that is not checked.
 */

export type SchemaIssue = { path: string; reason: string };

const ANNOTATIONS = new Set(['description', 'title', '$comment', 'default', 'examples']);
const SUPPORTED = new Set([
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
]);

/** Keywords the providers' structured output modes do not accept (or accept only in part). They are checked here, not there. */
const PROVIDER_UNSUPPORTED = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const typeOf = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value;

const matchesType = (name: string, value: unknown): boolean => {
  const actual = typeOf(value);
  return name === actual || (name === 'number' && actual === 'integer');
};

const codePoints = (value: string): number => Array.from(value).length;

const join = (path: string, key: string | number): string => (path === '' ? String(key) : `${path}.${key}`);

function check(schema: JsonSchema, value: unknown, path: string, issues: SchemaIssue[]): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key) && !ANNOTATIONS.has(key)) throw new Error(`Unsupported JSON Schema keyword: ${key}`);
  }
  const type = schema.type;
  if (type !== undefined) {
    const names = Array.isArray(type) ? (type as string[]) : [String(type)];
    if (!names.some((name) => matchesType(name, value))) {
      issues.push({ path, reason: `expected ${names.join(' or ')}` });
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    issues.push({ path, reason: 'not one of the allowed values' });
    return;
  }
  if ('const' in schema && schema.const !== value) {
    issues.push({ path, reason: 'not the expected value' });
    return;
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && codePoints(value) < schema.minLength) issues.push({ path, reason: `shorter than ${schema.minLength}` });
    if (typeof schema.maxLength === 'number' && codePoints(value) > schema.maxLength) issues.push({ path, reason: `longer than ${schema.maxLength}` });
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push({ path, reason: `below ${schema.minimum}` });
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push({ path, reason: `above ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) issues.push({ path, reason: `fewer than ${schema.minItems} items` });
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) issues.push({ path, reason: `more than ${schema.maxItems} items` });
    if (isRecord(schema.items)) {
      const items = schema.items as JsonSchema;
      value.forEach((item, index) => check(items, item, join(path, index), issues));
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
    if (Array.isArray(schema.required)) {
      for (const name of schema.required as string[]) {
        if (!Object.prototype.hasOwnProperty.call(value, name)) issues.push({ path: join(path, name), reason: 'missing' });
      }
    }
    for (const name of Object.keys(value)) {
      const sub = properties[name];
      if (sub !== undefined) check(sub, value[name], join(path, name), issues);
      else if (schema.additionalProperties === false) issues.push({ path: join(path, name), reason: 'not allowed' });
      else if (isRecord(schema.additionalProperties)) check(schema.additionalProperties as JsonSchema, value[name], join(path, name), issues);
    }
  }
}

/** The issues of `value` against `schema`, at most 20. Empty: it matches. Issues hold paths and fixed reasons, never values. */
export function validateJson(schema: JsonSchema, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  check(schema, value, '', issues);
  return issues.slice(0, 20);
}

/**
 * The schema as it is sent to a provider: the same, without the keywords their structured output modes do not
 * accept (`minLength`, `maxLength`, `minItems`, `maxItems`, `minimum`, `maximum`). Those are still checked by
 * `validateJson` on the answer. The input is not changed.
 */
export function providerSchema(schema: JsonSchema): JsonSchema {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node)) {
      if ((PROVIDER_UNSUPPORTED as readonly string[]).indexOf(key) !== -1) continue;
      // `properties` maps names to schemas: its keys are names, not keywords.
      if (key === 'properties' && isRecord(node[key])) {
        const props: Record<string, unknown> = {};
        for (const name of Object.keys(node[key] as Record<string, unknown>)) props[name] = strip((node[key] as Record<string, unknown>)[name]);
        out[key] = props;
      } else {
        out[key] = strip(node[key]);
      }
    }
    return out;
  };
  return strip(schema) as JsonSchema;
}

/**
 * Whether a schema is in the strict form OpenAI's structured outputs want: every object lists all its properties as
 * required and closes itself with `additionalProperties: false`. Used by the tests of the tasks.
 */
export function isStrictCompatible(schema: JsonSchema): boolean {
  const walk = (node: unknown): boolean => {
    if (!isRecord(node)) return true;
    if (node.type === 'object' || isRecord(node.properties)) {
      const names = Object.keys(isRecord(node.properties) ? node.properties : {});
      const required = Array.isArray(node.required) ? (node.required as string[]) : [];
      if (node.additionalProperties !== false) return false;
      if (names.some((n) => required.indexOf(n) === -1)) return false;
      if (!names.every((n) => walk((node.properties as Record<string, unknown>)[n]))) return false;
    }
    if (node.items !== undefined && !walk(node.items)) return false;
    return true;
  };
  return walk(schema);
}

/** Parses the text of a model answer as JSON. Tolerates one Markdown code fence, which local models add. Undefined when it is not JSON. */
export function parseModelJson(text: string): unknown {
  // A model that thinks first may put its reasoning in <think> blocks, and many wrap the answer in a Markdown fence or
  // a sentence. Take the answer out of that, then the first balanced JSON object; the result is validated by the caller.
  let body = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  const fence = /```[A-Za-z]*\s*\n([\s\S]*?)\n?```/.exec(body);
  if (fence) body = (fence[1] ?? '').trim();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // fall through to the first balanced object
  }
  const start = body.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * A small example of VALID output built from a schema, for a prompt that must be short (a model that is too small for the full
 * schema can copy a shape): booleans `true`, strings `"example"` (the first allowed value for an `enum`, the `const` for a `const`),
 * integers and numbers the lowest allowed value (or 1), arrays with one item, objects with all their properties. The values are
 * placeholders, never data. Built from the keywords `validateJson` knows; anything else gives `null`.
 */
export function exampleOf(schema: JsonSchema): unknown {
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const properties = isRecord(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
      for (const name of Object.keys(properties)) out[name] = exampleOf(properties[name] as JsonSchema);
      return out;
    }
    case 'array':
      return isRecord(schema.items) ? [exampleOf(schema.items as JsonSchema)] : [];
    case 'string':
      return 'example';
    case 'boolean':
      return true;
    case 'integer':
    case 'number': {
      const low = typeof schema.minimum === 'number' ? schema.minimum : 1;
      return typeof schema.maximum === 'number' ? Math.min(low, schema.maximum) : low;
    }
    default:
      return null;
  }
}

/**
 * Repairs the one cut-off that is obvious: a JSON OBJECT whose text ends early, missing only what closes it (a `"` and the `]` and
 * `}` still open). It adds closing characters at the very end and nothing else: no key, no value, no digit. It gives up (undefined)
 * when the text ends in a dangling key or colon, right after an opening bracket (it would become an empty container), in the middle of a number, in a half written `true`, `false` or `null`, or when the
 * closed text is not valid JSON; one trailing comma at the cut is dropped. The caller must still validate the result against the
 * schema, and a repaired string is a string that was cut where the model stopped. Undefined when the text needs no repair or has none.
 */
export function repairModelJson(text: string): unknown {
  let body = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  // A fence that was opened and never closed (the cut happened inside it).
  const open = /^```[A-Za-z]*\s*\n/.exec(body);
  if (open) body = body.slice(open[0].length).trim();
  const start = body.indexOf('{');
  if (start < 0) return undefined;
  body = body.slice(start);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return undefined;
      // The object is whole: this is not a cut-off, it is something else.
      if (stack.length === 0) return undefined;
    }
  }
  if (stack.length === 0 && !inString) return undefined;
  let tail = body;
  if (inString) {
    // A lone backslash at the cut has nothing to escape.
    if (escaped) tail = tail.slice(0, -1);
    // A half written \uXXXX escape is cut off too.
    tail = tail.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
    tail += '"';
  } else {
    tail = tail.replace(/\s+$/, '');
    // A number cut in the middle cannot be told from a whole one: never guess a digit.
    if (!tail.endsWith('"') && /^-?[0-9]/.test(/[^\s,:[\]{}]+$/.exec(tail)?.[0] ?? '')) return undefined;
    // A cut right after an opening bracket would become an empty list or object the model never wrote.
    if (/[[{]$/.test(tail)) return undefined;
    tail = tail.replace(/,$/, '');
  }
  try {
    const value = JSON.parse(tail + stack.reverse().join('')) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
