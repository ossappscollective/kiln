# ADR 0023: Mobile Release Manager as an MCP server

Status: implemented and tested against a fake MCP client. **Never run against a real client** (Claude, Cursor): see
[mcp](../mcp.md#unverified).

## Context

People want to ask an AI assistant "which of my apps is blocked, what do the new one-star reviews say, how did our keywords move" and have it
read the real workspace. The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is how Claude, Cursor and others connect to such a
source. The risks are the ones this project already guards against by hand: an assistant must not publish, submit, release or send anything
by itself ([0008](0008-store-rollout-writes.md), [0010](0010-store-submit.md), [0014](0014-release-management.md), [0020](0020-play-internal-sharing.md)),
it must not see credentials, and text written by strangers (reviews, store listings) must not be able to steer it (prompt injection).

## Decision

1. **Tools are views of registry operations, not a second API.** Every tool names one operation of the API registry
   (`services/api-operations.ts`) and maps its arguments onto that operation's path, query and body. A tool call becomes an HTTP request to the
   app's own routes with the caller's own bearer token. So the token check, the operation allow-list (default deny), the role ceiling, the app
   restriction, the per-token rate limit and the audit attribution (by token id) are the routes' own. Nothing is re-implemented, so nothing can drift.
2. **Off by default** (`MRM_MCP_ENABLED=false`): `/mcp` answers 404 like a route that does not exist. The web app shows the state and where to set it.
3. **Read by default.** The "MCP read-only" token is a `viewer` whose `actions` list names the read tools' actions. Tools the token may not use are not
   listed, and calling one answers exactly like an unknown name.
4. **Writes** (triage a review, save a reply **draft**) change only the workspace's own data. They are offered only when the token's `actions` list
   **names** the action (a token without a list never gets one: widening an old token cannot switch them on) and, where the route needs it, the server
   switch is on (`MRM_REVIEW_REPLY_ENABLED` for drafts).
5. **Dangerous actions are previews, never applies.** Publish, submit, release, rollout, pushing a store draft, internal sharing exist only as
   `preview_*` tools: the answer is the preview, its `confirmHash` (or `planHash` for a batch) and a link to the web app
   (`/#/portfolio/<app>/<pending|releases|builds>`) where a person confirms. This is not a missing feature: confirming needs a passkey or a password
   ([0019](0019-step-up-confirmation.md)), which an API token cannot give, so even a token that was allowed to apply would be refused
   (`step_up_required_human`). A preview tool needs the explicit action and the store feature's server switch, like the real write. Credentials, flags,
   settings, tokens, members and webhooks are not exposed at all (no tool, and the registry keeps tokens out of most of them anyway). A test pins that no
   tool maps to a `destructive` operation, to an apply/send/push/publish operation, or has an apply-like name.
6. **Untrusted text stays data.** The server `instructions` say that text from stores, customers and repositories is untrusted. Such fields (review
   title, body, author, notes, reply drafts, listing texts, release notes, keywords, competitor names, CI titles) are wrapped in
   `<untrusted-data id="…">…</untrusted-data>` with an id that is random for every result, any marker inside the text is defused (`<` becomes `&lt;`),
   and the result carries a `notice`. Prompts put validated arguments into their text and repeat the rule.
7. **No secrets.** Results are filtered by key (secret, password, api key, private key, authorization, cookie, signing, download URL, token) and by shape
   (our tokens, private key blocks, JWTs, bearer values). Tools never return credential ids, download links or binaries.
8. **Capped.** Strings (2,000 characters; more for listing texts), arrays (50), depth (8) and the whole result (24,000 characters) are capped; what was cut
   is reported in `truncated`. Lists are paged (`limit`, `nextCursor`). Request bodies are capped at 256 KiB, batches at 16.
9. **Strict input, fixed errors.** Arguments are zod objects that refuse unknown keys. Errors come from a fixed vocabulary (`invalid_input` with
   `path` and zod issue code only, `not_found`, `forbidden`, `confirmation_required`, `feature_disabled`, `conflict`, `rate_limited`, `too_large`,
   `unavailable`, `unauthorized`). Nothing a client sent and no route message is echoed.
10. **Transport.** Streamable HTTP, stateless: `POST /mcp` with JSON-RPC, answered as `application/json`; notifications get 202; GET and DELETE get 405 (no
    server stream, no sessions). A small dependency-free stdio bridge (`apps/server/src/mcp/stdio.ts`, `MRM_URL` + `MRM_TOKEN`) serves clients that start a
    local command. No SDK: the protocol surface is a handful of methods and the repository avoids new dependencies.
11. **Local safety.** `Authorization: Bearer` is required and the session cookie is ignored; a request with an `Origin` header is refused unless it is
    `MRM_PUBLIC_ORIGIN` or in `MRM_TRUSTED_ORIGINS` (clients are not browsers; a rebound DNS name arrives with a foreign origin); single-user mode's host
    guard runs first. Bad tokens count against the client address; each token has 120 MCP requests a minute on top of the API's 300.
12. **Audit.** Route audits are attributed to the token as for any API call. Write and preview tool calls add one `mcp.tool_call` event (tool name, kind,
    ok/error code, app id; never arguments or text).

## Consequences

- Adding a tool is a catalog entry (`mcp/tool-defs.ts`) naming a registry operation; the tests check its operation exists, its path parameters are covered,
  tokens may call it, and it is not dangerous. An operation that is not in the registry cannot become a tool.
- A client must understand `isError` results; protocol errors are used only for protocol problems and unknown tools.
- The preview links need the right origin: set `MRM_PUBLIC_ORIGIN` behind a proxy, otherwise the request's own origin is used.
- Alerts were being built in parallel; there is no alert tool yet. Add an entry when its operation is in the registry.
- The `confirmHash` in a preview answer is not secret and cannot apply anything by itself.
