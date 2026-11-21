# OpenAPI description

`GET /api/openapi.json` returns an [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) description
of this server's API, for client generators, API explorers and assistants. It needs a sign-in, a
session cookie or an API token of any role, and is not public: it names every route of a private
server. It is generated when the server starts from the operation registry; nothing is written to
disk.

```sh
curl -H "Authorization: Bearer kiln_..." https://kiln.example.com/api/openapi.json > kiln-openapi.json
```

## What is in it

- Every operation with its path, method, `operationId`, summary, path and query parameters,
  request body and success responses as JSON Schema, and the error responses that can happen
  (400, 401, 403, 404, 413, 429), shared as components.
- Two security schemes: `cookieAuth` (the `kiln_session` cookie) and `bearerAuth` (a `kiln_` token).
  Operations a token may not call list only `cookieAuth`; public operations list none.
- Vendor extensions that tell a client, or an assistant deciding what needs a person's approval,
  what an operation does:

| Extension            | Meaning                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-kiln-risk`         | `read` (changes nothing), `write` (changes something that can be undone or is ours to keep) or `destructive` (deletes, revokes or discards).                                        |
| `x-kiln-action`       | The permission the operation needs (`apps.sync`, `changesets.approve`, ...). The role table is in `packages/core/src/roles.ts`. Absent for public and any-member operations.        |
| `x-kiln-token-access` | Whether an API token may call it at all. `false` operations are for people with a session; see [tokens](tokens.md).                                                                 |
| `x-kiln-app-scope`    | How an app-restricted token is treated: `param` (the app in the path must be allowed), `list` (the answer is filtered) or `events`. Absent: an app-restricted token cannot call it. |
| `x-kiln-body-limit`   | The largest request body in bytes where a route sets its own limit.                                                                                                                 |
| `x-kiln-partial`      | The operation is described only in part: its response (or body) is a loose object because the shape is still moving. The paths, methods, permissions and risk are exact.            |

## It is the same registry that guards the API

`apps/server/src/operations/registry.ts` lists every documented operation once. The same list
decides which routes an API token may call: a route that is not in the registry is reachable with a
session only, so a new route cannot become reachable by tokens by accident. The tests check that:

- every route of the app has an entry, and every entry has a route (a new route without an entry
  fails `openapi.test.ts` with the path to add);
- the permission in the entry is the one the route enforces, by calling each operation as a viewer,
  member and admin and comparing with the role table;
- an admin token reaches exactly the operations marked open to tokens and gets 403 on the rest;
- the generated document passes the structural validator, `operationId`s and method and path pairs
  are unique, a GET is `read` and a DELETE is `destructive`, and no document text looks like a
  secret.

## Adding an operation

Add an entry to the operations file of the feature that owns the route (`modules/<module>/operations.ts`,
or `operations/<name>.ts` for routes that are not in a module). `operations/registry.ts` only collects those
files into `drafts`; a new feature adds its array there. The entry:

```ts
{ id: 'listThings', method: 'get', path: `${W}/things`, tags: ['things'], summary: 'List things',
  risk: 'read', access: { action: 'things.read' },
  responses: { '200': { description: 'Things.', schema: z.object({ things: z.array(thingSchema) }) } } },
```

`path` uses `{name}` where the Hono route has `:name`. `access` is `{ action }`, `'member'`, `'user'`
or `'public'`. Add `appScope` when the route is about one app, `body` and `query` as zod schemas,
`bodyLimit`, `rateLimited` and `partial` as they apply. Add the tag to `TAG_DESCRIPTIONS` in
`openapi.ts` when it is new. Whether a token may call it follows from the action: tokens may hold
every action except the ones in `tokenForbiddenActions` (`packages/core/src/roles.ts`); set
`token: false` to close an operation that is otherwise open.

## The generator

`apps/server/src/operations/openapi.ts` has no dependency: `zodToJsonSchema` converts the subset of zod
that the routes use (strings with their limits, numbers, enums, literals, arrays, objects, records,
unions, nullable, optional, default, refinements) and **throws** on anything else, so a new kind of
schema is noticed by the tests instead of being documented wrongly. `buildOpenApiDocument` assembles
the document and `validateOpenApiDocument` checks it: version, required fields, unique operation
ids, declared tags, every path parameter declared once and required, resolvable `$ref`s, known schema
keywords, a 2xx response per operation and defined security schemes. It is a structural check, not a
full OpenAPI validator.

## Limits

- Request bodies of operations marked `x-kiln-partial` are `object`, and so are many responses of the
  newer routes (plans, listing, CI). Read the matching page in this folder for their shape.
- Request body schemas of the routes that existed before the registry mirror the schemas in their
  route files by hand (those are not exported). The permission and route coverage is tested; the
  field-by-field match of each body is not.
- The document was validated by our own checker only. It was not run through an external OpenAPI
  validator or a client generator, because nothing can be installed here.
