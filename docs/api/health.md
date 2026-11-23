# App health (crashes and freezes)

Served by `GET .../apps/{appId}/health` (docs/api/ratings.md). Source: stored analytics, no store is called.

- **App Store**: App Analytics "App Crashes" over "App Sessions", opted-in people only, crashes per session. Apple sends crash numbers only for days
  with at least five crashing users, so a day without a number is not a day without crashes: a rate is taken over the days a crash file answered for, and
  a version with crash numbers for under 75% of its days is not compared. There are no freeze numbers.
- **Google Play**: Android vitals, the user-perceived crash and ANR rate (share of the day's users) from the Play Developer Reporting API. When it is not
  turned on, `setup.setupCode` says so and the screen links to the data sources.

## The regression rule

The only place it is written is the header of `apps/server/src/modules/ratings/health.ts`: the newest version with steady numbers (at least 200 sessions
or user-days) against the newest older one that has them, crashes before freezes. It is `worse` when the rate is at least 1.5 times the earlier one and at
least a minimum step higher (1 crash per 1,000 sessions on the App Store, 0.2 percentage points on Google Play), or on Google Play when it crossed
Google's line (1.09% crashes, 0.47% freezes). When it fires for the first time for a version the server emits the `health.crash_regression` event.
`finding.mentions` counts the reviews of that version, since it appeared, that mention crashes.
