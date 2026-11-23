# API: reports

`GET /api/workspaces/{workspaceId}/apps/{appId}/reports`, operation `getAppReport`. Read-only from what is stored; `analytics.read`. Decision and honesty rules:
docs/adr/0053-timeline-and-reports.md.

Query: `kind` `week` (Monday to Sunday), `month` or `year` (calendar, UTC days; default `week`), `day` (any day inside the period; default the newest period that has ended).
`400 invalid_request` with `issues` for a bad value, `404 not_found` for an unknown app. There is no custom range and no "last N days".

Answer: `app`, `kind`, `through` (the newest day with final numbers), `comparison` (`period`, `current`, `previous`, `currentDays`, `previousDays`, `partial`, `lengthsDiffer`: a running
period is compared with the same number of days of the one before), `figures` (per metric and currency: `value`, `previous`, `change`, `uncompared` = `no_data` |
`previous_incomplete` | `current_incomplete`, `days`, `previousDays`; a change needs 80% of the days on both sides), `countries` (top 8 by downloads: `code`, `value`, `share`, `change`),
`sources` (App Store only: `source`, `seen`, `pageViews`, `downloads`), `reviews` (written reviews Kiln stored, `current` and `previous`: `count`, `average`, `lowUnanswered`),
`events` (the timeline events of the period), `missingDays`, `downloadMetric`.

The web section (`#/portfolio/<app>/insights?view=timeline&section=reports&report=week|month|year&on=YYYY-MM-DD`) draws this, and builds Markdown and CSV from it in the
browser. No scheduled digest, PDF or sharing link exists.
