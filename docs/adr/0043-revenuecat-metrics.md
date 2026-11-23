# ADR 0043: RevenueCat metrics on the Products page

Status: accepted. Follows [ADR 0039](0039-revenuecat.md) (the RevenueCat link and configuration read), whose "Not built" section deferred this "overview strip" until the key's
permissions and an owner decision on who may see revenue were settled.

## Context

The Products page joins the store's products to RevenueCat's configuration. People also want RevenueCat's own headline numbers beside it: active subscriptions, active trials,
MRR and the revenue of the last 28 days. RevenueCat's API offers them in one read of the Charts and Metrics domain.

## Decision

1. **One read, cached with the existing sync.** `GET /v2/projects/{project_id}/metrics/overview` (permission `charts_metrics:overview:read`, 25 requests a minute per key,
   a different limit from the configuration reads) is read by `syncRevenueCat` after the configuration, so it runs as part of "Sync products" and of `POST .../revenuecat/sync`.
   Reading the figures never calls RevenueCat: `GET .../revenuecat/metrics` answers from the stored copy.
2. **Independent and best effort.** The metrics step has its own result (`sync.metrics`, and `revenuecat.metrics` in the products sync). A key without the Charts and Metrics
   permission fails only there: the configuration is still replaced, the sync is still `200`, and the answer names the permission in a fixed sentence. A failed read keeps the
   last good figures and records only a fixed sentence and a failure count (a rate limit does not count). It uses its own request client, because its rate limit is a different
   one. A changed link, an unlink and a deleted app clear the copy.
3. **Migration 49: `revenuecat_metrics`** (one row per app record; `project_id`, `currency`, `metrics_json`, `fetched_at`, `last_attempt_at`, `last_error`, `failures`; both
   schema files, a migration test). The metrics are stored as read, so the strip's four figures are chosen at read time and a new RevenueCat metric needs no migration.
4. **Whose numbers, said on the screen.** The figures cover the whole RevenueCat project, every app and store of it, not the linked app alone, and they are RevenueCat's numbers,
   not the store consoles'. The API says `scope: "project"`; the strip says "RevenueCat figures, all stores" and when they were read ("As of ...").
5. **Money carries its currency and is never converted.** RevenueCat names one currency for its money figures; each money metric carries it (`kind: "money"`, `currency`).
   When RevenueCat names none the amount has `currency: null` and is shown as "(currency not reported)", never as dollars. Revenue is RevenueCat's **gross** of the last 28
   days, before store fees and taxes. A figure RevenueCat did not report is `null` and not drawn, never zero.
6. **DECISION (owner): viewers can see revenue.** The route needs `apps.read` and the MCP tool is a read tool: every member who can read the app can read MRR and revenue. There is
   no extra role or permission for money. This matches the sales numbers and the Products page's sales column, which `analytics.read` already shows to every role. The
   sentence is in the operation description, the API page and the MCP docs, so nobody is surprised.
7. **API, registry, MCP.** `GET /api/workspaces/:workspaceId/apps/:appId/revenuecat/metrics` is the operation `getAppRevenueCatMetrics` (so it is in OpenAPI), and the read tool
   `get_revenuecat_metrics` is a view of it.
8. **Web.** A compact strip above the Products table: active subscriptions, active trials, MRR, revenue (28d), "As of ...", "RevenueCat figures, all stores", with an info tip.
   **Moved (2026-11-23):** the figures are no longer on Products (configuration only). They are the "Revenue" block of the Insights overview (`components/analytics/RevenueBlock.svelte`), drawn only for a RevenueCat-linked app, with the "key may not read metrics" sentence and a link to Products where "Sync products" reads them. Products keeps one small link to Insights. The API is unchanged.
   It is drawn only for a linked app that has figures or a reason they are missing; a failed read is said beside the older figures. A failed metrics step of "Sync products" is
   said in the RevenueCat result line and is never shown as a failed sync.

## Not built

- Charts over time (`/metrics/...` chart endpoints), customer lookups, experiments, paywalls, webhooks. The overview only.
- A sandbox/production switch, and per-app figures: the overview is per project.
- Converting currencies. MRR and revenue are shown in the one currency RevenueCat reports.

## UNVERIFIED (nothing ran against a real RevenueCat project)

Confirmed from RevenueCat's API reference and dashboard pages (read 2026-11-21): the path, the answer `{ object: "overview_metrics", metrics: [...], currency }`, a metric as
`{ id, name, description, unit, period, value, last_updated_at }`, `period` `P0D` (now) or `P28D`, the top-level `currency` (default USD), and the permission and rate limit.
Not confirmed:

- the metric **ids** other than the documented sample `active_trials`: the strip looks for `active_subscriptions`, `mrr` and `revenue` and falls back to the display name
  (`Active Subscriptions`, `MRR` or `Monthly Recurring Revenue`, `Revenue`); a figure that matches neither is simply absent;
- that `value` is always a number (RevenueCat says MRR and revenue may be rounded and the type may change; a numeric string is read, anything else is left out);
- whether the figures are production only (the dashboard has a sandbox toggle; the API page does not say);
- how a metric is told to be money: the strip treats `mrr`, `revenue` and any metric whose unit is a single currency-like symbol (`$`) as money; counts use `#`;
- the status RevenueCat answers when the key lacks the permission (403 is assumed, as for the configuration reads).

## Consequences

- The RevenueCat key needs the extra read permission `charts_metrics:overview:read` for the strip ([credentials](../credentials.md#revenuecat-secret-api-key)); without it
  everything else keeps working and the Products page says what to grant.
- ADR 0039's "configuration facts only" rule now holds for the configuration copy; the metrics copy is the one place RevenueCat money is stored, in its own table, as a
  display cache.
