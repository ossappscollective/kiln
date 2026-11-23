# API: timeline

Read-only from what is stored (no store is contacted). Reading needs `analytics.read` (every role); a person's own events need `aso.write`. Operations
`getAppTimeline`, `getAppGraphicsImpact`, `createTimelineEvent`, `updateTimelineEvent`, `deleteTimelineEvent` (openapi.md). Decision: docs/adr/0053-timeline-and-reports.md.

## GET /api/workspaces/{workspaceId}/apps/{appId}/timeline

Query: `from`, `to` (YYYY-MM-DD; default the last 90 days up to yesterday; `to` is never after today), `metric` (one of `metrics` of the answer; default first-time
downloads), `days` 7, 14 (default) or 28 (the window before and after an event used for `impact`). The range plus `days` is at most 400 days (`422 invalid_range`).
Answer: `app`, `metrics` (only those with data), `metric`, `from`, `to`, `days`, `latest`, `points` (a day each, `value: null` is no number), `events`.

An event: `id` (`m:<id>` a person's, `k:<source>:<ref>` Kiln's), `day`, `kind` (`release`, `rollout`, `listing_text`, `listing_drift`, `graphics`, `experiment_started`,
`experiment_ended`, `competitor_change`, `ad_campaign`, `price_change`, `press`, `other`), `origin` (`kiln` | `manual`), `label` (`{ code, params }` for Kiln events: `release`, `releaseRollingOut`,
`rolloutStep`, `graphics`, `listingText`, `listingDrift`, `experimentStarted`, `experimentEnded`, `competitorChange` (params `name`, `kinds`: a followed App Store competitor changed its listing, one event per competitor and day; [ADR 0056](../adr/0056-competitor-listing-watch.md)); the screens translate it), `title` and `note` (a person's), `version`, `liveDay`,
`waitsForRelease`, `impact` (before and after for the chosen metric, or null). There is no author or time of creation in the answer.

## POST .../timeline/events, PATCH and DELETE .../timeline/events/{eventId}

Create: `{ kind: ad_campaign | price_change | press | other, day, title (1 to 120), note? (up to 500) }`, `201 { event }`, `409 too_many_events` at 500 per app.
Update: the same fields, all optional. `eventId` is the part after `m:`; `404 event_not_found`. Delete: `{ ok: true }`. Audited as `timeline.event_created`,
`timeline.event_updated`, `timeline.event_deleted` (id, kind and day only, never the text).

## GET .../timeline/graphics-impact

The newest graphics change against as many days before it (`state`: `no_change`, `waiting`, `ok`); read by the Store listing page, not by the Timeline tab.

The web tab (`#/portfolio/<app>/insights?view=timeline`) calls `timeline` with the range bar (cut to its newest 380 days) and `days=7`, once per platform record, and the
Insights charts call it only while "Show events" is on.
