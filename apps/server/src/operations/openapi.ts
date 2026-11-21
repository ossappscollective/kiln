import { type Action, tokenForbiddenActions } from '@kiln/core';
import type { ZodTypeAny } from 'zod';

/**
 * A small OpenAPI 3.1 generator. There is no `@hono/zod-openapi` here (no new dependencies), so
 * operations are listed in a registry (api-operations.ts) and turned into a document by the
 * functions below: a converter for the subset of zod the routes use, a builder, and a structural
 * validator that the tests run over the result. The registry is also what decides which routes an
 * API token may call (bearer.ts), so a route that is not in it cannot be reached with a token.
 */

export type Risk = 'read' | 'write' | 'destructive';
export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** `public`: no sign-in. `user`: any signed-in session. `member`: any member of the workspace. Else: a member whose role allows the action. */
export type Access = 'public' | 'user' | 'member' | { action: Action };

export type ResponseSpec = { description: string; schema?: ZodTypeAny; contentType?: string };

export type Operation = {
  /** Unique, camel case. */
  id: string;
  method: Method;
  /** OpenAPI style, `/api/workspaces/{workspaceId}/apps/{id}`. Must equal the Hono route with `:x` for `{x}`. */
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  /** `x-mrm-risk`: what calling it can do. Assistants use it to decide what needs a person's approval. */
  risk: Risk;
  access: Access;
  /** Can an API token call this? Default: yes when `access` is an action tokens may hold. */
  token?: boolean;
  /**
   * How a token restricted to some apps is treated: `param` the path parameter named here is an app
   * id and must be one of them; `list` the answer is filtered to them; `events` the events are.
   * Without it an app restricted token cannot call the operation (it is workspace wide).
   */
  appScope?: { kind: 'param'; name: string } | { kind: 'list' } | { kind: 'events' };
  /** Query parameters, as a zod object (every key a parameter). */
  query?: ZodTypeAny;
  body?: ZodTypeAny;
  /** The request body may be left out (the operation then does what it did before the body existed). */
  bodyOptional?: boolean;
  /** Largest body in bytes (documented only; the limit is enforced by the app). */
  bodyLimit?: number;
  /** Success responses by status. Error responses are added by the builder. */
  responses: Record<string, ResponseSpec>;
  /** The operation is described only in part (the response is not fully typed). */
  partial?: boolean;
  /** Answers 429 on its own budget. */
  rateLimited?: boolean;
};

/** Whether a token may call the operation: it needs an action tokens can hold, or says so itself. */
export function tokenAllowedFor(op: Pick<Operation, 'access' | 'token'>): boolean {
  if (op.token !== undefined) return op.token;
  return typeof op.access === 'object' && !tokenForbiddenActions.includes(op.access.action);
}

// ---------------------------------------------------------------------------------------------
// zod -> JSON Schema (the subset the routes use). Anything else throws, so a new kind of schema is
// noticed by the tests instead of being documented wrongly.

export type JsonSchema = Record<string, unknown>;

type Def = { typeName: string; [key: string]: unknown };
const defOf = (schema: ZodTypeAny): Def => (schema as unknown as { _def: Def })._def;

type Check = { kind: string; value?: unknown; inclusive?: boolean; regex?: RegExp };

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const out = convert(schema);
  const description = (schema as unknown as { description?: string }).description;
  return description && out.description === undefined ? { ...out, description } : out;
}

function isOptional(schema: ZodTypeAny): boolean {
  const name = defOf(schema).typeName;
  if (name === 'ZodOptional' || name === 'ZodDefault') return true;
  if (name === 'ZodEffects') return isOptional(defOf(schema).schema as ZodTypeAny);
  return false;
}

function convert(schema: ZodTypeAny): JsonSchema {
  const def = defOf(schema);
  switch (def.typeName) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      for (const check of (def.checks as Check[]) ?? []) {
        if (check.kind === 'min') out.minLength = check.value;
        else if (check.kind === 'max') out.maxLength = check.value;
        else if (check.kind === 'length') {
          out.minLength = check.value;
          out.maxLength = check.value;
        } else if (check.kind === 'email') out.format = 'email';
        else if (check.kind === 'url') out.format = 'uri';
        else if (check.kind === 'uuid') out.format = 'uuid';
        else if (check.kind === 'regex' && check.regex) out.pattern = check.regex.source;
        // trim, toLowerCase and the like change the value, not what is accepted.
      }
      return out;
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: 'number' };
      for (const check of (def.checks as Check[]) ?? []) {
        if (check.kind === 'int') out.type = 'integer';
        else if (check.kind === 'min')
          out[check.inclusive === false ? 'exclusiveMinimum' : 'minimum'] = check.value;
        else if (check.kind === 'max')
          out[check.inclusive === false ? 'exclusiveMaximum' : 'maximum'] = check.value;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodLiteral':
      return { const: def.value };
    case 'ZodEnum':
      return { type: 'string', enum: [...(def.values as string[])] };
    case 'ZodArray': {
      const out: JsonSchema = { type: 'array', items: zodToJsonSchema(def.type as ZodTypeAny) };
      const min = def.minLength as { value: number } | null;
      const max = def.maxLength as { value: number } | null;
      const exact = def.exactLength as { value: number } | null;
      if (min) out.minItems = min.value;
      if (max) out.maxItems = max.value;
      if (exact) {
        out.minItems = exact.value;
        out.maxItems = exact.value;
      }
      return out;
    }
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptional(value)) required.push(key);
      }
      const out: JsonSchema = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      if (def.unknownKeys === 'strict') out.additionalProperties = false;
      return out;
    }
    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToJsonSchema(def.valueType as ZodTypeAny) };
    case 'ZodOptional':
      return zodToJsonSchema(def.innerType as ZodTypeAny);
    case 'ZodNullable':
      return { anyOf: [zodToJsonSchema(def.innerType as ZodTypeAny), { type: 'null' }] };
    case 'ZodDefault':
      return {
        ...zodToJsonSchema(def.innerType as ZodTypeAny),
        default: (def.defaultValue as () => unknown)(),
      };
    case 'ZodEffects':
      // refine, superRefine and transform: the checks are not representable, the shape is the inner one.
      return zodToJsonSchema(def.schema as ZodTypeAny);
    case 'ZodReadonly':
    case 'ZodBranded':
      return zodToJsonSchema((def.innerType ?? def.type) as ZodTypeAny);
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = def.options as ZodTypeAny[] | Map<string, ZodTypeAny>;
      const list = options instanceof Map ? [...options.values()] : options;
      return { anyOf: list.map((o) => zodToJsonSchema(o)) };
    }
    case 'ZodUnknown':
    case 'ZodAny':
      return {};
    default:
      throw new Error(`zodToJsonSchema: unsupported zod type ${def.typeName}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The document

export const OPENAPI_VERSION = '3.1.0';

export type OpenApiDocument = {
  openapi: string;
  info: Record<string, unknown>;
  servers: { url: string; description?: string }[];
  tags: { name: string; description?: string }[];
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: {
    securitySchemes: Record<string, Record<string, unknown>>;
    schemas: Record<string, JsonSchema>;
    responses: Record<string, Record<string, unknown>>;
  };
  security: Record<string, string[]>[];
};

const errorContent = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };

const standardResponses: Record<string, Record<string, unknown>> = {
  InvalidRequest: {
    description: 'The request is not valid. `issues` lists the fields.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } },
  },
  Unauthenticated: {
    description: 'No valid session cookie or bearer token.',
    content: errorContent,
  },
  Forbidden: { description: 'The role (or the token) does not allow this.', content: errorContent },
  NotFound: {
    description: 'Not found. A workspace that does not exist and one you are not in look the same.',
    content: errorContent,
  },
  PayloadTooLarge: { description: 'The request body is too large.', content: errorContent },
  RateLimited: {
    description: 'Too many requests. `Retry-After` says how many seconds to wait.',
    headers: { 'Retry-After': { description: 'Seconds to wait.', schema: { type: 'integer' } } },
    content: errorContent,
  },
};

export const pathParams = (path: string) =>
  [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1] as string);

export const TAG_DESCRIPTIONS: Record<string, string> = {
  auth: 'Sign-in and the first-run setup.',
  workspaces: 'The workspace, its audit log and the OpenAPI document.',
  credentials: 'Encrypted store and repository credentials. Secrets are write-only.',
  members: 'People in the workspace.',
  invitations: 'Invitation links.',
  repositories: 'Connected GitHub repositories and their listings.',
  'change-sets': 'Drafted, approved and applied changes. The only way to write.',
  apps: 'Apps, their store snapshot and sync.',
  tokens: 'API tokens for scripts and CI.',
  events: 'The event log and its live stream.',
  webhooks: 'Outbound webhooks and their delivery log.',
  plans: 'Release plans, their checklists and release notes.',
  listing: 'The store listing as it is live, how it drifts from the repository, and its history.',
  ci: 'GitHub Actions workflows, runs and builds.',
  submit:
    'Handing the pushed store draft to the store’s review: preview, typed confirmation, submit. Irreversible, off by default, never releases.',
  system: 'Health.',
};

const INFO_DESCRIPTION =
  'Every call needs a session cookie or an API token (`Authorization: Bearer mrm_...`), except the few marked public. ' +
  '`x-mrm-risk` says what an operation can do (read, write, destructive); `x-mrm-action` is the permission it needs; ' +
  '`x-mrm-token-access` says whether an API token may call it. Operations marked `x-mrm-partial` have responses that are ' +
  'described only in part. See docs/api/openapi.md.';

function operationObject(op: Operation): Record<string, unknown> {
  const parameters: Record<string, unknown>[] = pathParams(op.path).map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  if (op.query) {
    const schema = zodToJsonSchema(op.query) as {
      properties?: Record<string, JsonSchema>;
      required?: string[];
    };
    for (const [name, value] of Object.entries(schema.properties ?? {})) {
      const { description, ...rest } = value as JsonSchema & { description?: string };
      parameters.push({
        name,
        in: 'query',
        required: schema.required?.includes(name) ?? false,
        ...(description ? { description } : {}),
        schema: rest,
      });
    }
  }

  const responses: Record<string, unknown> = {};
  for (const [status, spec] of Object.entries(op.responses)) {
    responses[status] = {
      description: spec.description,
      ...(spec.schema || spec.contentType
        ? {
            content: {
              [spec.contentType ?? 'application/json']: spec.schema
                ? { schema: zodToJsonSchema(spec.schema) }
                : {},
            },
          }
        : {}),
    };
  }
  const viaToken = tokenAllowedFor(op);
  if (op.body || op.query) responses['400'] = { $ref: '#/components/responses/InvalidRequest' };
  if (op.access !== 'public') responses['401'] = { $ref: '#/components/responses/Unauthenticated' };
  if (typeof op.access === 'object' || op.access === 'member') {
    responses['403'] = { $ref: '#/components/responses/Forbidden' };
    responses['404'] = { $ref: '#/components/responses/NotFound' };
  }
  if (op.body) responses['413'] = { $ref: '#/components/responses/PayloadTooLarge' };
  if (op.rateLimited || viaToken) responses['429'] = { $ref: '#/components/responses/RateLimited' };

  const security =
    op.access === 'public'
      ? []
      : viaToken
        ? [{ cookieAuth: [] }, { bearerAuth: [] }]
        : [{ cookieAuth: [] }];

  return {
    operationId: op.id,
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    tags: op.tags,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(op.body
      ? {
          requestBody: {
            required: op.bodyOptional !== true,
            content: { 'application/json': { schema: zodToJsonSchema(op.body) } },
          },
        }
      : {}),
    responses,
    security,
    'x-mrm-risk': op.risk,
    ...(typeof op.access === 'object' ? { 'x-mrm-action': op.access.action } : {}),
    'x-mrm-token-access': viaToken,
    ...(op.appScope ? { 'x-mrm-app-scope': op.appScope.kind } : {}),
    ...(op.bodyLimit ? { 'x-mrm-body-limit': op.bodyLimit } : {}),
    ...(op.partial ? { 'x-mrm-partial': true } : {}),
  };
}

export function buildOpenApiDocument(
  operations: readonly Operation[],
  info: { version: string },
): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};
  const tags = new Set<string>();
  for (const op of operations) {
    for (const tag of op.tags) tags.add(tag);
    (paths[op.path] ??= {})[op.method] = operationObject(op);
  }
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Kiln API',
      version: info.version,
      summary: 'The HTTP API of one Kiln server.',
      description: INFO_DESCRIPTION,
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: '/', description: 'This server' }],
    tags: [...tags].sort().map((name) => ({
      name,
      ...(TAG_DESCRIPTIONS[name] ? { description: TAG_DESCRIPTIONS[name] } : {}),
    })),
    paths,
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'mrm_session',
          description:
            'The session cookie set by sign-in. State-changing requests must come from this server’s own origin.',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'mrm_ token',
          description:
            'An API token made under API tokens. A token is limited to one workspace, a role ceiling, and optionally apps and actions.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', description: 'A stable code.' },
            message: { type: 'string' },
          },
          required: ['error'],
        },
        ValidationError: {
          type: 'object',
          properties: {
            error: { const: 'invalid_request' },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                properties: { path: { type: 'string' }, message: { type: 'string' } },
                required: ['path', 'message'],
              },
            },
          },
          required: ['error'],
        },
      },
      responses: standardResponses,
    },
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  };
}

// ---------------------------------------------------------------------------------------------
// Structural validation: not a full OpenAPI validator, but it catches what breaks consumers.

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']);
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const KNOWN_SCHEMA_KEYS = new Set([
  '$ref',
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'additionalProperties',
  'description',
  'default',
  'title',
  'example',
  'examples',
  'uniqueItems',
  'readOnly',
  'writeOnly',
  'deprecated',
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateOpenApiDocument(doc: unknown): string[] {
  const errors: string[] = [];
  const bad = (where: string, message: string) => {
    errors.push(`${where}: ${message}`);
  };
  if (!isObject(doc)) return ['document: not an object'];

  if (typeof doc.openapi !== 'string' || !/^3\.1\.\d+$/.test(doc.openapi))
    bad('openapi', 'must be a 3.1.x version string');
  const info = doc.info;
  if (
    !isObject(info) ||
    typeof info.title !== 'string' ||
    !info.title ||
    typeof info.version !== 'string' ||
    !info.version
  ) {
    bad('info', 'title and version are required strings');
  }
  const components = isObject(doc.components) ? doc.components : {};
  const schemes = isObject(components.securitySchemes) ? components.securitySchemes : {};
  const schemas = isObject(components.schemas) ? components.schemas : {};
  const responseComponents = isObject(components.responses) ? components.responses : {};
  const declaredTags = new Set(
    Array.isArray(doc.tags)
      ? doc.tags.flatMap((t) => (isObject(t) && typeof t.name === 'string' ? [t.name] : []))
      : [],
  );

  const checkRef = (where: string, ref: unknown) => {
    if (typeof ref !== 'string' || !ref.startsWith('#/components/'))
      return bad(where, `bad $ref ${String(ref)}`);
    const [, , kind, name] = ref.split('/');
    const pool =
      kind === 'schemas' ? schemas : kind === 'responses' ? responseComponents : undefined;
    if (!pool || !name || !(name in pool)) bad(where, `$ref ${ref} does not resolve`);
  };

  const checkSchema = (where: string, schema: unknown, depth = 0): void => {
    if (!isObject(schema)) return bad(where, 'a schema must be an object');
    if (depth > 20) return bad(where, 'schema nests too deeply');
    for (const key of Object.keys(schema)) {
      if (!KNOWN_SCHEMA_KEYS.has(key) && !key.startsWith('x-'))
        bad(where, `unknown schema keyword "${key}"`);
    }
    if ('$ref' in schema) checkRef(where, schema.$ref);
    if ('type' in schema) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      for (const t of types)
        if (typeof t !== 'string' || !SCHEMA_TYPES.has(t)) bad(where, `bad type ${String(t)}`);
    }
    if ('properties' in schema) {
      if (!isObject(schema.properties)) bad(where, 'properties must be an object');
      else
        for (const [k, v] of Object.entries(schema.properties))
          checkSchema(`${where}.properties.${k}`, v, depth + 1);
    }
    if ('required' in schema) {
      const props = isObject(schema.properties) ? schema.properties : {};
      if (
        !Array.isArray(schema.required) ||
        schema.required.some((r) => typeof r !== 'string' || !(r in props))
      ) {
        bad(where, 'required must list declared properties');
      }
    }
    if (schema.type === 'array') {
      if ('items' in schema) checkSchema(`${where}.items`, schema.items, depth + 1);
      else bad(where, 'an array schema needs items');
    }
    if ('enum' in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0))
      bad(where, 'enum must be a non-empty array');
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (!(key in schema)) continue;
      const list = schema[key];
      if (!Array.isArray(list) || list.length === 0) bad(where, `${key} must be a non-empty array`);
      else list.forEach((s, i) => checkSchema(`${where}.${key}[${i}]`, s, depth + 1));
    }
    if (isObject(schema.additionalProperties))
      checkSchema(`${where}.additionalProperties`, schema.additionalProperties, depth + 1);
  };

  for (const [name, schema] of Object.entries(schemas))
    checkSchema(`components.schemas.${name}`, schema);

  const operationIds = new Set<string>();
  if (!isObject(doc.paths) || Object.keys(doc.paths).length === 0)
    bad('paths', 'must be a non-empty object');
  for (const [path, item] of Object.entries(isObject(doc.paths) ? doc.paths : {})) {
    if (!path.startsWith('/')) bad(`paths.${path}`, 'a path starts with /');
    if (!isObject(item)) {
      bad(`paths.${path}`, 'not an object');
      continue;
    }
    for (const [method, operation] of Object.entries(item)) {
      const where = `${method.toUpperCase()} ${path}`;
      if (!METHODS.has(method)) {
        bad(where, 'unknown method');
        continue;
      }
      if (!isObject(operation)) {
        bad(where, 'operation is not an object');
        continue;
      }
      const id = operation.operationId;
      if (typeof id !== 'string' || !id) bad(where, 'operationId is required');
      else if (operationIds.has(id)) bad(where, `duplicate operationId ${id}`);
      else operationIds.add(id);
      if (typeof operation.summary !== 'string' || !operation.summary)
        bad(where, 'summary is required');
      for (const tag of Array.isArray(operation.tags) ? operation.tags : []) {
        if (!declaredTags.has(String(tag))) bad(where, `tag ${String(tag)} is not declared`);
      }
      const risk = operation['x-mrm-risk'];
      if (risk !== 'read' && risk !== 'write' && risk !== 'destructive') {
        bad(where, 'x-mrm-risk must be read, write or destructive');
      }

      // Every {name} in the path is declared once as a required path parameter, and nothing else is.
      const declared = new Set<string>();
      for (const [i, p] of (Array.isArray(operation.parameters)
        ? operation.parameters
        : []
      ).entries()) {
        if (
          !isObject(p) ||
          typeof p.name !== 'string' ||
          (p.in !== 'path' && p.in !== 'query' && p.in !== 'header')
        ) {
          bad(`${where} parameters[${i}]`, 'needs name and in');
          continue;
        }
        const key = `${p.in}:${p.name}`;
        if (declared.has(key)) bad(where, `duplicate parameter ${key}`);
        declared.add(key);
        if (p.in === 'path' && p.required !== true)
          bad(where, `path parameter ${p.name} must be required`);
        checkSchema(`${where} parameter ${p.name}`, p.schema);
      }
      const inPath = pathParams(path);
      for (const name of inPath)
        if (!declared.has(`path:${name}`)) bad(where, `path parameter ${name} is not declared`);
      for (const key of declared) {
        if (key.startsWith('path:') && !inPath.includes(key.slice(5)))
          bad(where, `parameter ${key.slice(5)} is not in the path`);
      }

      if ('requestBody' in operation) {
        const rb = operation.requestBody;
        const content = isObject(rb) && isObject(rb.content) ? rb.content : undefined;
        if (!content || Object.keys(content).length === 0) bad(where, 'requestBody needs content');
        else {
          for (const [type, media] of Object.entries(content)) {
            if (isObject(media) && media.schema)
              checkSchema(`${where} requestBody ${type}`, media.schema);
          }
        }
      }

      const responses = operation.responses;
      if (!isObject(responses) || Object.keys(responses).length === 0) {
        bad(where, 'responses are required');
      } else {
        for (const [status, response] of Object.entries(responses)) {
          if (!/^[1-5][0-9]{2}$|^default$/.test(status))
            bad(where, `bad response status ${status}`);
          if (!isObject(response)) {
            bad(where, `response ${status} is not an object`);
          } else if ('$ref' in response) {
            checkRef(`${where} response ${status}`, response.$ref);
          } else {
            if (typeof response.description !== 'string' || !response.description) {
              bad(where, `response ${status} needs a description`);
            }
            if (isObject(response.content)) {
              for (const [type, media] of Object.entries(response.content)) {
                if (isObject(media) && media.schema)
                  checkSchema(`${where} response ${status} ${type}`, media.schema);
              }
            }
          }
        }
        if (!Object.keys(responses).some((s) => s.startsWith('2')))
          bad(where, 'needs a 2xx response');
      }

      for (const requirement of Array.isArray(operation.security) ? operation.security : []) {
        if (!isObject(requirement)) bad(where, 'security entry is not an object');
        else
          for (const name of Object.keys(requirement))
            if (!(name in schemes)) bad(where, `security scheme ${name} is not defined`);
      }
    }
  }
  for (const requirement of Array.isArray(doc.security) ? doc.security : []) {
    if (isObject(requirement)) {
      for (const name of Object.keys(requirement))
        if (!(name in schemes)) bad('security', `scheme ${name} is not defined`);
    }
  }
  return errors;
}

/** `/api/a/{x}/b` as a matcher. Returns the parameter values by name, or undefined. */
export function compilePath(path: string): (url: string) => Record<string, string> | undefined {
  const names: string[] = [];
  const source = path
    .split(/(\{[A-Za-z0-9_]+\})/)
    .map((part) => {
      const m = /^\{([A-Za-z0-9_]+)\}$/.exec(part);
      if (m) {
        names.push(m[1] as string);
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  const regex = new RegExp(`^${source}$`);
  return (url) => {
    const match = regex.exec(url);
    if (!match) return undefined;
    try {
      return Object.fromEntries(
        names.map((name, i) => [name, decodeURIComponent(match[i + 1] as string)]),
      );
    } catch {
      return undefined;
    }
  };
}
