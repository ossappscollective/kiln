import assert from 'node:assert/strict';
import { test } from 'node:test';
import { can, type roles, tokenExplicitOnlyActions } from '@mrm/core';
import { dbTest } from '@mrm/db/testing';
import { z } from 'zod';
import { bootRepoApp } from './repo-test-helpers.ts';
import { operations } from './services/api-operations.ts';
import {
  buildOpenApiDocument,
  compilePath,
  type Operation,
  pathParams,
  tokenAllowedFor,
  validateOpenApiDocument,
  zodToJsonSchema,
} from './services/openapi.ts';

// ----- zod to JSON Schema ---------------------------------------------------------------------

test('zodToJsonSchema covers what the routes use', () => {
  assert.deepEqual(zodToJsonSchema(z.string().trim().min(1).max(5)), {
    type: 'string',
    minLength: 1,
    maxLength: 5,
  });
  assert.deepEqual(zodToJsonSchema(z.string().email()), { type: 'string', format: 'email' });
  assert.deepEqual(zodToJsonSchema(z.string().length(3)), {
    type: 'string',
    minLength: 3,
    maxLength: 3,
  });
  assert.deepEqual(zodToJsonSchema(z.string().regex(/^a+$/)), { type: 'string', pattern: '^a+$' });
  assert.deepEqual(zodToJsonSchema(z.number().int().min(1).max(9)), {
    type: 'integer',
    minimum: 1,
    maximum: 9,
  });
  assert.deepEqual(zodToJsonSchema(z.number().gt(0)), { type: 'number', exclusiveMinimum: 0 });
  assert.deepEqual(zodToJsonSchema(z.boolean()), { type: 'boolean' });
  assert.deepEqual(zodToJsonSchema(z.literal('x')), { const: 'x' });
  assert.deepEqual(zodToJsonSchema(z.enum(['a', 'b'])), { type: 'string', enum: ['a', 'b'] });
  assert.deepEqual(zodToJsonSchema(z.array(z.string()).min(1).max(3)), {
    type: 'array',
    items: { type: 'string' },
    minItems: 1,
    maxItems: 3,
  });
  assert.deepEqual(zodToJsonSchema(z.record(z.number())), {
    type: 'object',
    additionalProperties: { type: 'number' },
  });
  assert.deepEqual(zodToJsonSchema(z.string().nullable()), {
    anyOf: [{ type: 'string' }, { type: 'null' }],
  });
  assert.deepEqual(zodToJsonSchema(z.union([z.string(), z.number()])), {
    anyOf: [{ type: 'string' }, { type: 'number' }],
  });
  assert.deepEqual(zodToJsonSchema(z.string().default('x')), { type: 'string', default: 'x' });
  assert.deepEqual(zodToJsonSchema(z.unknown()), {});
  assert.deepEqual(zodToJsonSchema(z.string().describe('Words.')), {
    type: 'string',
    description: 'Words.',
  });
  // Refinements and transforms keep the inner shape.
  assert.deepEqual(zodToJsonSchema(z.string().refine((s) => s !== '')), { type: 'string' });
});

test('zodToJsonSchema: objects list only required keys, and strict objects close', () => {
  const schema = z.object({
    a: z.string(),
    b: z.number().optional(),
    c: z.string().default('x'),
    d: z.string().nullable(),
  });
  assert.deepEqual(zodToJsonSchema(schema), {
    type: 'object',
    properties: {
      a: { type: 'string' },
      b: { type: 'number' },
      c: { type: 'string', default: 'x' },
      d: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['a', 'd'],
  });
  assert.equal(
    (zodToJsonSchema(z.object({}).strict()) as { additionalProperties?: boolean })
      .additionalProperties,
    false,
  );
  assert.equal(
    (zodToJsonSchema(z.object({ a: z.string() }).refine(() => true)) as { required?: string[] })
      .required?.[0],
    'a',
    'a refined object keeps its keys',
  );
});

test('zodToJsonSchema refuses what it does not know, so a new kind of schema is noticed', () => {
  assert.throws(() => zodToJsonSchema(z.date()), /unsupported zod type ZodDate/);
  assert.throws(() => zodToJsonSchema(z.object({ a: z.map(z.string(), z.string()) })), /ZodMap/);
});

// ----- the validator --------------------------------------------------------------------------

const small: Operation[] = [
  {
    id: 'getThing',
    method: 'get',
    path: '/api/things/{id}',
    summary: 'A thing',
    tags: ['things'],
    risk: 'read',
    access: 'user',
    responses: { '200': { description: 'The thing.', schema: z.object({ id: z.string() }) } },
  },
];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
// biome-ignore lint/suspicious/noExplicitAny: documents are edited loosely to break them
const doc = (): any => clone(buildOpenApiDocument(small, { version: '1.2.3' }));

test('a small document is valid, and carries the version and the security schemes', () => {
  const d = doc();
  assert.deepEqual(validateOpenApiDocument(d), []);
  assert.equal(d.openapi, '3.1.0');
  assert.equal(d.info.version, '1.2.3');
  assert.deepEqual(Object.keys(d.components.securitySchemes).sort(), ['bearerAuth', 'cookieAuth']);
  const op = d.paths['/api/things/{id}'].get;
  assert.equal(op.operationId, 'getThing');
  assert.deepEqual(op.parameters, [
    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
  ]);
  assert.equal(op['x-mrm-risk'], 'read');
});

test('the validator catches what would break a consumer', () => {
  const breakers: [string, (d: ReturnType<typeof doc>) => void, RegExp][] = [
    [
      'not 3.1',
      (d) => {
        d.openapi = '3.0.3';
      },
      /openapi: must be a 3\.1/,
    ],
    [
      'no title',
      (d) => {
        d.info.title = '';
      },
      /info:/,
    ],
    [
      'no paths',
      (d) => {
        d.paths = {};
      },
      /paths: must be a non-empty/,
    ],
    [
      'path without slash',
      (d) => {
        d.paths.nope = d.paths['/api/things/{id}'];
      },
      /a path starts with \//,
    ],
    [
      'unknown method',
      (d) => {
        d.paths['/api/things/{id}'].fetch = {};
      },
      /unknown method/,
    ],
    [
      'no operationId',
      (d) => {
        d.paths['/api/things/{id}'].get.operationId = '';
      },
      /operationId is required/,
    ],
    [
      'no summary',
      (d) => {
        d.paths['/api/things/{id}'].get.summary = '';
      },
      /summary is required/,
    ],
    [
      'undeclared tag',
      (d) => {
        d.paths['/api/things/{id}'].get.tags = ['ghost'];
      },
      /tag ghost is not declared/,
    ],
    [
      'bad risk',
      (d) => {
        d.paths['/api/things/{id}'].get['x-mrm-risk'] = 'scary';
      },
      /x-mrm-risk/,
    ],
    [
      'path param missing',
      (d) => {
        d.paths['/api/things/{id}'].get.parameters = [];
      },
      /path parameter id is not declared/,
    ],
    [
      'path param optional',
      (d) => {
        d.paths['/api/things/{id}'].get.parameters[0].required = false;
      },
      /must be required/,
    ],
    [
      'extra path param',
      (d) => {
        d.paths['/api/things/{id}'].get.parameters.push({
          name: 'x',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        });
      },
      /parameter x is not in the path/,
    ],
    [
      'duplicate param',
      (d) => {
        d.paths['/api/things/{id}'].get.parameters.push({
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        });
      },
      /duplicate parameter/,
    ],
    [
      'no responses',
      (d) => {
        d.paths['/api/things/{id}'].get.responses = {};
      },
      /responses are required/,
    ],
    [
      'no 2xx',
      (d) => {
        d.paths['/api/things/{id}'].get.responses = { '404': { description: 'x' } };
      },
      /needs a 2xx/,
    ],
    [
      'bad status',
      (d) => {
        d.paths['/api/things/{id}'].get.responses['2000'] = { description: 'x' };
      },
      /bad response status/,
    ],
    [
      'response without description',
      (d) => {
        d.paths['/api/things/{id}'].get.responses['200'] = { content: {} };
      },
      /needs a description/,
    ],
    [
      'dangling ref',
      (d) => {
        d.paths['/api/things/{id}'].get.responses['404'] = {
          $ref: '#/components/responses/Missing',
        };
      },
      /does not resolve/,
    ],
    [
      'bad schema type',
      (d) => {
        d.paths['/api/things/{id}'].get.responses['200'].content['application/json'].schema.type =
          'text';
      },
      /bad type text/,
    ],
    [
      'array without items',
      (d) => {
        d.paths['/api/things/{id}'].get.responses['200'].content['application/json'].schema = {
          type: 'array',
        };
      },
      /needs items/,
    ],
    [
      'required not declared',
      (d) => {
        d.paths['/api/things/{id}'].get.responses['200'].content[
          'application/json'
        ].schema.required = ['ghost'];
      },
      /required must list declared/,
    ],
    [
      'unknown keyword',
      (d) => {
        d.paths['/api/things/{id}'].get.responses['200'].content[
          'application/json'
        ].schema.minLenght = 1;
      },
      /unknown schema keyword "minLenght"/,
    ],
    [
      'empty enum',
      (d) => {
        d.paths['/api/things/{id}'].get.responses['200'].content['application/json'].schema = {
          enum: [],
        };
      },
      /enum must be a non-empty/,
    ],
    [
      'undefined security scheme',
      (d) => {
        d.paths['/api/things/{id}'].get.security = [{ magic: [] }];
      },
      /scheme magic is not defined/,
    ],
    [
      'undefined global scheme',
      (d) => {
        d.security = [{ magic: [] }];
      },
      /scheme magic is not defined/,
    ],
    [
      'request body without content',
      (d) => {
        d.paths['/api/things/{id}'].get.requestBody = { content: {} };
      },
      /requestBody needs content/,
    ],
  ];
  for (const [name, edit, expected] of breakers) {
    const d = doc();
    edit(d);
    const errors = validateOpenApiDocument(d);
    assert.ok(
      errors.some((e) => expected.test(e)),
      `${name}: ${JSON.stringify(errors)}`,
    );
  }
  assert.deepEqual(validateOpenApiDocument(null), ['document: not an object']);
  assert.deepEqual(validateOpenApiDocument('x'), ['document: not an object']);
  // Two operations with one id.
  const twice = buildOpenApiDocument(
    [
      ...small,
      { ...small[0], method: 'delete', path: '/api/things/{id}', risk: 'destructive' } as Operation,
    ],
    { version: '1' },
  );
  assert.ok(validateOpenApiDocument(clone(twice)).some((e) => /duplicate operationId/.test(e)));
});

test('compilePath matches templates and decodes parameters', () => {
  const match = compilePath('/api/workspaces/{workspaceId}/apps/{id}');
  assert.deepEqual(match('/api/workspaces/w1/apps/a%20b'), { workspaceId: 'w1', id: 'a b' });
  assert.equal(match('/api/workspaces/w1/apps'), undefined);
  assert.equal(match('/api/workspaces/w1/apps/a/b'), undefined);
  assert.equal(match('/api/workspaces/w1/apps/%E0%A4%A'), undefined, 'bad encoding is no match');
  assert.deepEqual(compilePath('/api/a.b')('/api/a.b'), {});
  assert.equal(compilePath('/api/a.b')('/api/aXb'), undefined, 'a dot in a path is a dot');
  assert.deepEqual(pathParams('/x/{a}/y/{b}'), ['a', 'b']);
});

// ----- the registry ---------------------------------------------------------------------------

test('the registry is the real document: valid, unique, and consistent', () => {
  const built = clone(buildOpenApiDocument(operations, { version: 'test' }));
  assert.deepEqual(validateOpenApiDocument(built), []);
  assert.equal(
    new Set(operations.map((o) => o.id)).size,
    operations.length,
    'operation ids are unique',
  );
  assert.equal(
    new Set(operations.map((o) => `${o.method} ${o.path}`)).size,
    operations.length,
    'one operation per method and path',
  );
  for (const op of operations) {
    assert.match(op.id, /^[a-z][A-Za-z0-9]*$/, op.id);
    assert.ok(op.summary.length > 0 && op.summary.length <= 120, `${op.id} has a short summary`);
    if (op.method === 'get') assert.equal(op.risk, 'read', `${op.id}: a GET only reads`);
    if (op.method === 'delete')
      assert.equal(op.risk, 'destructive', `${op.id}: a DELETE is destructive`);
    if (op.access !== 'public' && op.access !== 'user') {
      assert.ok(
        op.path.startsWith('/api/workspaces/{workspaceId}'),
        `${op.id}: a workspace operation lives under a workspace`,
      );
    }
    if (op.appScope?.kind === 'param')
      assert.ok(
        pathParams(op.path).includes(op.appScope.name),
        `${op.id}: the app parameter is in the path`,
      );
    // The document says what the registry says.
    const documented = built.paths[op.path]?.[op.method];
    assert.equal(documented?.['x-mrm-token-access'], tokenAllowedFor(op), `${op.id}: token access`);
    assert.equal(documented?.['x-mrm-risk'], op.risk);
    if (typeof op.access === 'object') assert.equal(documented?.['x-mrm-action'], op.access.action);
    const security = documented?.security as unknown[];
    assert.equal(security.length === 0, op.access === 'public');
    assert.equal(
      JSON.stringify(security).includes('bearerAuth'),
      op.access !== 'public' && tokenAllowedFor(op),
    );
  }
  // What a token can never do is not offered to tokens.
  for (const id of [
    'listTokens',
    'createToken',
    'revokeToken',
    'changeMemberRole',
    'createInvitation',
    'createCredential',
    'rotateCredential',
    'listWebhooks',
    'createWebhook',
    'rotateWebhookSecret',
  ]) {
    const op = operations.find((o) => o.id === id);
    assert.ok(op, id);
    assert.equal(tokenAllowedFor(op), false, `${id} is not for tokens`);
  }
  for (const id of [
    'listApps',
    'syncApp',
    'listEvents',
    'createChangeSet',
    'approveChangeSet',
    'getOpenApi',
  ]) {
    assert.equal(
      tokenAllowedFor(operations.find((o) => o.id === id) as Operation),
      true,
      `${id} is for tokens`,
    );
  }
});

dbTest('every route of the app is in the registry, and every operation is a route', async (db) => {
  const t = await bootRepoApp(db);
  const documented = new Set(operations.map((o) => `${o.method.toUpperCase()} ${o.path}`));
  const routes = new Set<string>();
  for (const route of t.app.routes) {
    if (route.method === 'ALL') continue;
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    if (path.startsWith('/api/')) routes.add(`${route.method} ${path}`);
  }
  const undocumented = [...routes].filter((r) => !documented.has(r));
  assert.deepEqual(
    undocumented,
    [],
    'These routes have no entry in services/api-operations.ts: they are missing from /api/openapi.json and closed to API tokens. Add an operation for each.',
  );
  assert.deepEqual(
    [...documented].filter((r) => !routes.has(r)),
    [],
    'documented operations that no route serves',
  );
});

dbTest(
  'the permission in the registry is the one each route enforces (viewer, member, admin)',
  async (db) => {
    const t = await bootRepoApp(db);
    const cookies = {
      viewer: await t.addMember('viewer'),
      member: await t.addMember('member'),
      admin: await t.addMember('admin'),
    };
    const filled = (path: string) =>
      path.replace('{workspaceId}', t.workspaceId).replace(/\{[A-Za-z0-9_]+\}/g, 'x');
    let checked = 0;
    for (const op of operations) {
      if (typeof op.access !== 'object' || op.id === 'streamEvents') continue;
      for (const [role, cookie] of Object.entries(cookies)) {
        const res = await t.app.request(filled(op.path), {
          method: op.method.toUpperCase(),
          headers: { cookie, 'content-type': 'application/json' },
          ...(op.method === 'get' || op.method === 'delete' ? {} : { body: '{}' }),
        });
        await res.body?.cancel();
        const allowed = can(role as (typeof roles)[number], op.access.action);
        assert.equal(
          res.status === 403,
          !allowed,
          `${op.id} as ${role}: got ${res.status}, ${op.access.action} is ${allowed ? 'allowed' : 'not allowed'}`,
        );
        checked++;
      }
    }
    assert.ok(checked > 100, 'the loop actually ran');
  },
);

dbTest(
  'an admin token reaches exactly the operations the registry offers to tokens',
  async (db) => {
    const t = await bootRepoApp(db);
    const minted = await t.call(t.owner, 'POST', '/tokens', { name: 'Everything', role: 'admin' });
    const auth = { authorization: `Bearer ${minted.body.token}` };
    const filled = (path: string) =>
      path.replace('{workspaceId}', t.workspaceId).replace(/\{[A-Za-z0-9_]+\}/g, 'x');
    for (const op of operations) {
      if (op.access === 'public' || op.id === 'streamEvents') continue;
      const res = await t.app.request(filled(op.path), {
        method: op.method.toUpperCase(),
        headers: { ...auth, 'content-type': 'application/json' },
        ...(op.method === 'get' || op.method === 'delete' ? {} : { body: '{}' }),
      });
      const text = await res.text();
      if (typeof op.access === 'object' && tokenExplicitOnlyActions.includes(op.access.action)) {
        // Publishes to a store: a token with no list of actions never gets it, only one that names it.
        assert.equal(res.status, 403, `${op.id} needs the action named in the token`);
        assert.match(text, /does not allow/, op.id);
        const named = await t.call(t.owner, 'POST', '/tokens', {
          name: 'Names it',
          role: 'admin',
          actions: [op.access.action],
        });
        const again = await t.app.request(filled(op.path), {
          method: op.method.toUpperCase(),
          headers: {
            authorization: `Bearer ${named.body.token}`,
            'content-type': 'application/json',
          },
          ...(op.method === 'get' || op.method === 'delete' ? {} : { body: '{}' }),
        });
        await again.body?.cancel();
        assert.notEqual(
          again.status,
          403,
          `${op.id} is open to a token that names ${op.access.action}`,
        );
      } else if (tokenAllowedFor(op)) {
        assert.notEqual(res.status, 403, `${op.id} should be open to a token: ${text}`);
        assert.notEqual(res.status, 401, `${op.id} accepts the token`);
      } else if (op.path.startsWith('/api/workspaces/')) {
        assert.equal(res.status, 403, `${op.id} must be closed to a token`);
        assert.match(text, /token_not_allowed/, op.id);
      } else {
        // Outside a workspace the bearer header is not even looked at: no session, no access.
        assert.equal(res.status, 401, `${op.id} must be closed to a token`);
      }
    }
    // A route nobody registered is closed to tokens, not open by default.
    const unknown = await t.app.request(`/api/workspaces/${t.workspaceId}/not-registered`, {
      headers: auth,
    });
    assert.equal(unknown.status, 403);
  },
);

// ----- the endpoint ---------------------------------------------------------------------------

dbTest('GET /api/openapi.json needs a sign-in and returns a valid 3.1 document', async (db) => {
  const t = await bootRepoApp(db);
  assert.equal((await t.app.request('/api/openapi.json')).status, 401);
  assert.equal(
    (await t.app.request('/api/openapi.json', { headers: { authorization: 'Bearer mrm_nope' } }))
      .status,
    401,
  );

  const res = await t.app.request('/api/openapi.json', { headers: { cookie: t.owner } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = (await res.json()) as {
    openapi: string;
    info: { version: string };
    paths: Record<string, unknown>;
  };
  assert.equal(body.openapi, '3.1.0');
  assert.equal(body.info.version, 'test');
  assert.deepEqual(validateOpenApiDocument(body), []);
  assert.ok(Object.keys(body.paths).length > 40);

  // A viewer may read it, and so may a token of any role.
  const viewer = await t.addMember('viewer');
  assert.equal(
    (await t.app.request('/api/openapi.json', { headers: { cookie: viewer } })).status,
    200,
  );
  const minted = await t.call(t.owner, 'POST', '/tokens', { name: 'Docs', role: 'viewer' });
  const viaToken = await t.app.request('/api/openapi.json', {
    headers: { authorization: `Bearer ${minted.body.token}` },
  });
  assert.equal(viaToken.status, 200);
  assert.deepEqual(await viaToken.json(), body);

  // Nothing in it looks like a secret, an id of a real thing, or a path of this machine.
  const text = JSON.stringify(body);
  assert.equal(/mrm_[A-Za-z0-9_-]{40,}/.test(text), false);
  assert.equal(/whsec_[A-Za-z0-9_-]{40,}/.test(text), false);
  assert.equal(text.includes(t.workspaceId), false);
  assert.equal(text.includes(String(minted.body.token)), false);
});
