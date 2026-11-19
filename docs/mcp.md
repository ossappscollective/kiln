# Connect an AI assistant (MCP)

Mobile Release Manager can act as an [MCP](https://modelcontextprotocol.io) server, so Claude, Cursor and other assistants can read a workspace:
which apps are blocked, what the new reviews say, how keywords and downloads moved. Design and rules: [ADR 0023](adr/0023-mcp-server.md). Wire
details: [api/mcp](api/mcp.md).

**Status: tested against a fake MCP client only. See [Unverified](#unverified).**

## Turn it on

1. Set `MRM_MCP_ENABLED=true` in the server's environment and restart. While it is off, `/mcp` answers 404. Behind a proxy also set `MRM_PUBLIC_ORIGIN`
   (the links the assistant gives you to confirm things point there).
2. In the web app, **Settings → Connect an AI assistant** (owners and admins): **Create an "MCP read-only" token**. It is a `viewer` token that names only
   the read tools' actions and expires after 90 days. It is shown once, together with the configuration to paste.

## Configure the assistant

Replace the token. HTTP needs the assistant to reach the server; stdio runs a small local command that talks to the server for it (Node 22.18 or
newer; use the real path of this repository).

Claude Code, HTTP:

```sh
claude mcp add --transport http mobile-release-manager https://mrm.example.com/mcp --header 'Authorization: Bearer mrm_...'
```

Claude Code, stdio:

```sh
claude mcp add mobile-release-manager --env MRM_URL=https://mrm.example.com --env MRM_TOKEN=mrm_... -- node /path/to/mobile-release-manager/apps/server/src/mcp/stdio.ts
```

Claude Desktop, `claude_desktop_config.json` (stdio):

```json
{ "mcpServers": { "mobile-release-manager": { "command": "node", "args": ["/path/to/mobile-release-manager/apps/server/src/mcp/stdio.ts"],
  "env": { "MRM_URL": "https://mrm.example.com", "MRM_TOKEN": "mrm_..." } } } }
```

Cursor, `~/.cursor/mcp.json` (HTTP; the stdio form is the same as Claude Desktop's):

```json
{ "mcpServers": { "mobile-release-manager": { "url": "https://mrm.example.com/mcp", "headers": { "Authorization": "Bearer mrm_..." } } } }
```

The stdio command refuses a plain `http` address unless it is this machine, never prints the token, and is a transport only: every rule below is the
server's.

## What an assistant can do

**Read tools** (all on for the read-only token): `list_apps`, `get_app`, `list_releases`, `get_app_status` (where the release is and the next step),
`get_release_overview`, `list_release_candidates`, `get_editable_release`, `get_release_notes_history`, `get_pending_changes`, `get_pending_overview`,
`get_listing` (texts per locale), `get_listing_drift`, `get_staged_changes`, `list_reviews`, `list_workspace_reviews`, `get_review`,
`get_reviews_summary`, `get_reviews_overview`, `get_aso_summary`, `list_aso_keywords`, `get_aso_keyword_history`, `list_aso_competitors`, `get_aso_coach`,
`get_aso_gaps`, `get_analytics_overview`, `get_analytics_status`, `list_build_artifacts` (links only), `list_builds`, `list_internal_shares`,
`list_release_plans`, `list_events`, and `whoami` (what this token may do).

**Write tools** (change only this workspace's own data; the token must name the action):

| Tool | Action | Also needs |
| --- | --- | --- |
| `triage_review` | `reviews.triage` | nothing |
| `save_reply_draft` | `reviews.triage` | `MRM_REVIEW_REPLY_ENABLED=true` |

A reply is only ever saved as a **draft**; a person reviews and sends it in the web app. Nothing is sent to a store from here.

**Preview tools** (show what a store action would do; never apply it). The token must name the action; the server switch must be on:

| Tool | Action | Server switch | Confirm at |
| --- | --- | --- | --- |
| `preview_rollout` | `releases.rollout` | `MRM_STORE_ROLLOUT_ENABLED` | Releases |
| `preview_store_release` | `store.release` | `MRM_STORE_RELEASE_ENABLED` | Releases |
| `preview_store_submit` | `store.submit` | `MRM_STORE_SUBMIT_ENABLED` | Pending changes |
| `preview_staged_push` | `store.push_draft` | `MRM_STORE_DRAFT_WRITE_ENABLED` | Pending changes |
| `preview_publish_batch` | `store.publish` | `MRM_STORE_PUBLISH_BATCH_ENABLED` | Pending changes |
| `preview_internal_share` | `builds.share` | `MRM_PLAY_INTERNAL_SHARING_ENABLED` | Builds |

A preview answer holds the preview, `confirmHash` (the `planHash` for a batch), `applied: false` and `confirmInApp.url`. **There is no apply tool and
there will not be one**: confirming needs a passkey or password ([ADR 0019](adr/0019-step-up-confirmation.md)), which an API token cannot give. You open
the link, read the preview and confirm in the app. To let an assistant preview, make a token under **API tokens** whose actions name the preview's
action (an admin token without a list never gets one).

**Resources:** `mrm://apps/{appId}/overview`, `mrm://apps/{appId}/release-state`, `mrm://apps/{appId}/listing/{locale}` (listing and template listing
available through `resources/list` and `resources/templates/list`).
**Prompts:** `release_readiness_check`, `summarise_new_reviews`, `aso_review`.

## What never happens

- No tool changes credentials, workspace settings, AI settings, feature switches, members, tokens or webhooks, and none applies, submits, publishes,
  releases, rolls out, shares a build or sends a reply.
- No secret is in a result: no credential, token, private key or download link (filtered by key name and by shape), and no binary.
- Review, listing and release-note text is returned inside `<untrusted-data id="…">` markers with an id that changes with every result; the server's
  `instructions`, the tool descriptions and every result `notice` tell the assistant to treat it as data. This lowers the risk of prompt injection; it
  cannot remove it. Keep write tokens off assistants that read untrusted text unless you want them to triage on its say-so.
- Results are capped (24,000 characters, 50 items per list, 2,000 characters per text) and say when something was cut.

## Limits and logs

120 MCP requests a minute per token (the API's own 300 a minute applies too); 429 with `Retry-After`. Bad tokens from one address are limited like on
the API. The audit log shows the token for every change it made (`actorType: "token"`) and one `mcp.tool_call` event per write or preview call (tool,
app id, outcome; no arguments or text). Revoke the token under **API tokens** to cut an assistant off at once.

## Unverified

- **No real client was used.** Claude Desktop, Claude Code, Cursor and the MCP Inspector were never connected. The protocol surface was built from the
  specification (revisions 2024-11-05, 2025-03-26, 2025-06-18) and tested with a fake client that speaks JSON-RPC to the app; the stdio bridge was tested
  against the real app through an in-process fetch, not as a spawned process by a real client.
- The configuration snippets follow each product's documentation as remembered; check the exact keys against its current docs.
- Remote connectors of Claude (web and desktop "custom connectors") expect OAuth, which this server does not offer (bearer tokens only): use stdio or
  Claude Code/Cursor over HTTP.
- No server-to-client stream (GET), sessions, resource subscriptions, logging or completion are implemented; clients that insist on them will not work.
- Output was checked against fakes for size and shape; real store data (very long listings, many locales) may need other caps.
