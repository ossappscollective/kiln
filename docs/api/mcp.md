# MCP endpoint

`POST /mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io) (JSON-RPC 2.0, Streamable HTTP, stateless). Guide: [mcp](../mcp.md).
Design: [ADR 0023](../adr/0023-mcp-server.md). It is not part of `/api` and not in the OpenAPI document; its tools are views of operations that are.

## Switch

`KILN_MCP_ENABLED` (default `false`). While off, every method answers `404 {"error":"not_found"}`.

## Request

- `Authorization: Bearer mrm_...` is required (an [API token](tokens.md)); the session cookie is ignored. Missing or bad: `401 invalid_token`.
  Bad tokens from one address: `429 too_many_attempts`.
- `Content-Type: application/json` (else `415`), body at most 256 KiB (else `413`). One message, or a batch of at most 16 (`400` otherwise).
- `Origin`, if present, must be `KILN_PUBLIC_ORIGIN` or in `KILN_TRUSTED_ORIGINS` (else `403 bad_origin`). MCP clients send none.
- `MCP-Protocol-Version`, if present, must be `2025-06-18`, `2025-03-26` or `2024-11-05` (else `400`). `structuredContent` is added to tool results only for
  `2025-06-18`.
- 120 requests a minute per token (`429 rate_limited`, `Retry-After`).
- `GET` and `DELETE`: `405`, `Allow: POST`.

## Response

A request gets `200 application/json` with one JSON-RPC response (an array for a batch). A notification, or a batch of notifications, gets `202`. A body that
is not JSON gets `400` with JSON-RPC error `-32700`. Protocol errors use fixed messages: `-32600` invalid request, `-32601` method not found, `-32602`
invalid params or a tool/prompt that does not exist for this token, `-32002` resource not found, `-32003` rate limited, `-32603` internal.

## Methods

`initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`,
and the `notifications/*` messages (accepted, ignored). Capabilities: `tools`, `resources` (no subscribe), `prompts`; none changes at run time.

### `tools/list`

Only the tools this token may use: its role ceiling, its `actions` list, its app restriction and the server switches decide (rules in
[the guide](../mcp.md#what-an-assistant-can-do)). Each tool has a strict JSON Schema (`additionalProperties: false`) and annotations
(`readOnlyHint` false only for write tools, `destructiveHint` always false).

### `tools/call`

`{ "name": "list_reviews", "arguments": { "appId": "…", "rating": [1, 2], "limit": 10 } }`.

- Unknown tool, or one this token may not use: JSON-RPC error `-32602`.
- A tool that ran returns `result.content[0].text`, the JSON of the envelope below, and `isError`. For protocol `2025-06-18` the same envelope is in
  `structuredContent`.
- Envelope: `{ "data": …, "truncated"?: [{ "path", "omitted", "kind" }], "notice"?: "…", "nextCursor"?: … }`. Third party text is inside
  `<untrusted-data id="…">…</untrusted-data>`.
- Error (`isError: true`): `{ "error": <code>, "message": <fixed text>, "issues"?: [{ "path", "code" }], "upstream"?: <route error code>,
  "retryAfterSeconds"?: n }` with `error` one of `invalid_input`, `not_found`, `forbidden`, `confirmation_required`, `feature_disabled`, `conflict`,
  `rate_limited`, `too_large`, `unavailable`, `unauthorized`.
- A `preview_*` tool adds `applied: false`, `confirmHash` (or null) and `confirmInApp: { url, how }` to the envelope.

### Resources

`mrm://apps/{appId}/overview`, `mrm://apps/{appId}/release-state`, `mrm://apps/{appId}/listing/{locale}`; `application/json`. They are composed from tools and gated
like them.

### Prompts

`release_readiness_check(appId)`, `summarise_new_reviews(appId?, days?)`, `aso_review(appId, locale?)`. Arguments are validated before they enter the text.

## `GET /api/workspaces/:wid/mcp/status`

For the Settings card. Owners and admins with a session (tokens can never call it). Answers `{ enabled, endpoint, protocolVersion, envName, switches,
tools: [{ name, title, description, kind, action, switch, switchOn }], preset: { name, role, actions, expiresInDays } }`. `preset` is the body of the
"MCP read-only" token (`POST /tokens` with that name, role and actions, plus an expiry).

## Audit

Whatever a tool changes is audited by its route, attributed to the token. Write and preview calls add `mcp.tool_call` with `{ tool, kind, ok, code?, via:
"mcp", onBehalfOf }` and the app id as target. No argument, no text.
