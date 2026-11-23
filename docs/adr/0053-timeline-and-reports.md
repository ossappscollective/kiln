# ADR 0053: Timeline and reports

Status: accepted (2026-11-23). The idea (an event line next to the numbers, and a period summary) is adapted from the Growth tools of Open
Screenshot Generator (MIT, see THIRD_PARTY_NOTICES.md). The server logic under `apps/server/src/modules/timeline/` and `packages/core/src/timeline-*.ts`,
`report-figures.ts` carries that notice; the web screens are written for Kiln and copy no markup, wording or images. (The code comments call this
decision `0053-timeline-and-reports`; this is that file.)

## Context

A number moves for a reason people half remember: a release, new screenshots, a price change, a campaign. The stores show the number, not the reason,
and a retrospective ("how was March?") is an hour of screenshots. Kiln already holds most of the reasons (releases, listing pushes, experiments).

## Decision

- **Events Kiln records by itself** are read from where they already live, never copied: versions that came out or began a staged rollout
  (`release`), phased rollout steps marked done (`rollout`), graphics and listing texts pushed to a store draft (`graphics`, `listing_text`, from
  the audit log: counts only), changes of the live listing that Kiln did not make (`listing_drift`, from stored listing snapshots) and
  experiments starting and ending (`experiment_started`, `experiment_ended`, Apple tests and the manual tracker). Duplicates are merged: the same
  version released and rolled out on one day is one `release`; a drift that follows a Kiln push is dropped. An App Store graphics or text change
  goes live with the next version (`waitsForRelease`, `liveDay`); the screen says "goes live with the next release" until that version is out.
- **Events a person adds** are `ad_campaign`, `price_change`, `press` and `other`: a day, a title (120 characters), a note (500), kept in
  `timeline_events` (migration 57), at most 500 per app, audited without the text. They are Kiln data only: nothing is sent to a store.
- **Not recorded**: rating or crash changes (they live in Ratings and health, ADR 0052), reviews, builds, store price changes (Kiln does not read
  prices from the store: a price change is a person's note), RevenueCat events. The list has no link for those because the API has no such event.
- **On the charts**: Insights Overview and its rail sections draw one marker per day that has events (a diamond on a short stem at the axis, the
  number of events when more than one), only for the visible days, at most 24 per chart (the busiest days stay and the chart says how many days
  were left out). A day under the cursor or the keyboard lists its events in the tooltip and in the chart's live region, so the marker never
  carries meaning by shape alone. "Show events" is a toggle next to "Show data", off by default, remembered per person in this browser
  (`kiln.timeline.markers.<userId>`); events are read only while it is on.
- **The Timeline tab** (Insights, `?view=timeline`, needs `analytics.read`, so every role): a rail with two sections, Timeline (`?view=timeline`,
  default) and Reports (`?view=timeline&section=reports`). Timeline is a vertical list under the range bar, one heading per day, newest first;
  chips filter by kind (none pressed is all), the platform is the scope of the page header (docs/ux-ia.md 0e: scope lives only there), the
  number of matches is read aloud in a polite live region, and a long list is cut into pages of 60 with "Show more". Rows link to the release,
  the Store listing (Graphics for graphics) or Insights, Experiments. "Add note" needs `aso.write`; own notes can be deleted (not edited, yet).
  Sync of this page reads the app, reviews and analytics (`PAGE_KINDS.timeline`).
- **A report** is one calendar week (Monday to Sunday), month or year (UTC days), chosen with chips and previous/next, against the period
  before it (`GET .../reports`, docs/api/reports.md). It holds: a table of figures (impressions, product page views, first-time downloads,
  download rate, conversion, redownloads, installs, Google Play visitors and acquisitions, units, proceeds and gross sales per currency) each with
  its previous value and change; the written reviews of the period (count, average, unanswered 1-2 star reviews); downloads by country and by source
  (App Store only); the events of the period; and "About the data" notes. Output: the page itself with a print stylesheet (the app chrome carries
  `no-print`), "Copy as Markdown" and "Download CSV" (raw numbers with a dot, ISO days, a BOM, spreadsheet formulas defused), both built in the
  browser from the API answer. There are no sharing links.

## Honesty rules (tested)

1. A figure with no number is "no data", never zero. A change needs data for at least 80% of the days on both sides (`MIN_COVERAGE`); otherwise the
   row says why it is not compared.
2. A period still running is compared with the same number of days of the one before and says so; periods of unequal length say that totals are not
   like for like.
3. Rates are computed from the two counts, never averaged; money is never converted or added across currencies (one row per currency).
4. The rating in a report is the average of written reviews Kiln stored, labelled as such; under 30 it is flagged as not reliable.
5. A marker means "something was recorded this day", never "this caused a change".

## Not available

A free date range or "last 7/28/90 days" for reports (the API has calendar periods only); RevenueCat revenue or MRR and crash rate inside a report
(they are in Insights, Overview and Ratings and health); impact per event on screen (the API computes it, the tab does not draw it yet); editing a
note; a server-rendered PDF; sharing links.

## Next

Scheduled e-mail digest of the weekly report and a server-rendered PDF (neither exists; the e-mail module could carry it); a "last N days" report
if the API grows a window; RevenueCat and health figures in the report; the impact verdict next to each event.

## Consequences

The markers cost one extra timeline read per app record while the toggle is on (the endpoint also reads the series); that is why it is off by
default. Events from a store that Kiln has not synced are missing, and the screens say "No events in this range" rather than implying nothing happened.

UNVERIFIED: the screens were type-checked and their view models unit-tested, but not opened in a browser; the server tests that need a database
(`KILN_TEST_POSTGRES_URL`) were skipped in this run.
