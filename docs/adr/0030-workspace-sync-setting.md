# ADR 0030: The scheduled store refresh is a workspace setting

Status: implemented and tested (server, web library). The screen has not been seen in a browser by the author; no real store was read.

## Context

The scheduler (`apps/server/src/scheduler.ts`) reads the stores of every app on an interval (`MRM_SYNC_INTERVAL_MINUTES`, 30 by default,
0 is off) so a change of state, for example an App Store version going from "in review" to approved, raises the usual events and alerts.
The interval was a server environment variable only: nobody using the app could see that the refresh existed, turn it off for their
workspace or choose how often it runs.

## Decision

1. **Two workspace settings** (`workspace_settings`, like `release.stalledAfterHours`; written with `settings.write`, so admins and owners;
   read by every member): `sync.enabled` (boolean, **on by default**) and `sync.intervalMinutes` (whole minutes, 5 to 10080; the screen
   offers 15 minutes, 30 minutes, 1 hour, 6 hours and daily).
2. **The environment stays the server-wide switch.** `MRM_SYNC_INTERVAL_MINUTES=0` turns scheduled syncs off for every workspace and
   the workspace settings then have no effect (the screen says so). Otherwise a workspace that chose an interval uses it (it may be
   shorter or longer than the server's; the shared rate limit and the per-tick caps still apply), and one that chose nothing uses the
   server's interval.
3. **The scheduler reads the settings every tick** with one query (`loadSyncPrefs`); a stored value that no longer validates is
   ignored. Apps of a workspace that turned the refresh off are counted in `skipped.disabled`.
4. **"When did it last run" needs no new table**: the audit trail already records every `app.sync` with `requestedBy: "scheduler"` for
   scheduled ones. `GET /settings` returns `sync.lastScheduledAt` from it (a failed attempt counts: it shows the scheduler is working).
5. **Honest about Google Play**: Play reports no review state, so Android alerts cover what Play reports (track, rollout, halted). The
   screen says so.
6. Changes are audited by the existing `settings.update` event (key names and old and new values; configuration only, no secret and no
   personal data).

## Not done

- A per-app interval, and "next refresh at" (the next run depends on the jitter, the rate limit and the queue).
- A migration: none was needed (migration 43 stays free).
