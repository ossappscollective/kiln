# API overview

Everything the web app does goes through an HTTP API, and you can call it from scripts, CI jobs and assistants.

## Authentication

- **Session cookie** (`kiln_session`): what the web app uses after sign-in.
- **API token**: a long random string starting with `kiln_`, sent as `Authorization: Bearer kiln_...`. A token acts for the person who made it, with a role ceiling and, optionally, a list of apps and a list of actions. Owners and admins create tokens in the web app. See the [token guide](../../docs/api/tokens.md).

```sh
curl -H "Authorization: Bearer kiln_..." \
  https://kiln.example.com/api/workspaces/<workspaceId>/apps
```

Errors are JSON: `{ "error": "<code>", "message": "..." }`. A request from a non-member and a request for a missing workspace both answer 404. A member without the right answers 403.

## The OpenAPI description

`GET /api/openapi.json` returns an OpenAPI 3.1 description of your server's API, generated when the server starts. It needs a sign-in because it names every route of a private server. Each operation carries vendor extensions such as `x-kiln-risk` (`read`, `write` or `destructive`) and `x-kiln-action` (the permission it needs), so a client or an assistant can tell what needs a person's approval. See [the OpenAPI notes](../../docs/api/openapi.md).

## Route guides

Each area has a page in the repository with its routes, permissions and the limits of what was verified:

- [Apps and sync](../../docs/api/apps.md), [releases](../../docs/api/releases-write.md) and [release pipeline](../../docs/api/release-pipeline.md)
- [Pending cart](../../docs/api/pending.md) and [staged changes](../../docs/api/staged-changes.md)
- [Store listing](../../docs/api/listing.md) and [assets](../../docs/api/assets.md)
- [ASO](../../docs/api/aso.md), [competitor reviews](../../docs/api/competitor-reviews.md) and [ratings](../../docs/api/ratings.md)
- [Reviews](../../docs/api/reviews.md) and [review summaries](../../docs/api/review-summary.md)
- [Analytics](../../docs/api/analytics.md), [insights](../../docs/api/insights.md), [timeline](../../docs/api/timeline.md) and [reports](../../docs/api/reports.md)
- [RevenueCat](../../docs/api/revenuecat.md) and [in-app products](../../docs/api/products.md)
- [EAS builds](../../docs/api/eas-builds.md), [EAS Update](../../docs/api/eas-update.md) and [CI](../../docs/api/ci.md)
- [Alerts](../../docs/api/alerts.md), [events](../../docs/api/events.md) and [webhooks](../../docs/api/webhooks.md)
- [Members](../../docs/api/members.md), [tokens](../../docs/api/tokens.md), [step-up confirmation](../../docs/api/step-up.md) and [two-factor](../../docs/api/two-factor.md)
- [AI](../../docs/api/ai.md) and [MCP](../../docs/api/mcp.md)

The complete list is the [`docs/api`](../../docs/api/) folder.
