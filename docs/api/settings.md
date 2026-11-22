# Workspace settings

A small, typed list of settings per workspace. It is not a general key-value store: only the keys
below exist, each with a type, a default and a rule. Reference for the routes
`GET` and `PUT /api/workspaces/{workspaceId}/settings` and `POST .../translate/test`
(also in `GET /api/openapi.json`).

**Secrets are never settings.** Provider keys live in the credential vault
([credentials](../credentials.md#review-translation-provider-keys)); a settings value is stored as
plain JSON in `workspace_settings` and is shown to every member who may read settings.

## Rights

| Action           | Who                     | Used for                                 |
| ---------------- | ----------------------- | ---------------------------------------- |
| `settings.read`  | members, admins, owners | `GET /settings`. Viewers get `403`.      |
| `settings.write` | admins and owners       | `PUT /settings`, `POST /translate/test`. |

Non-members, and members of another workspace, get `404 { "error": "not_found" }`. An API token may
hold either action (an app-limited token cannot call these workspace-wide routes). Every change is
audited as `settings.update` with the key names and the old and new values (configuration only, never
a secret). A `PUT` that changes nothing writes no entry.

## The keys

| Key                               | Type                                         | Default     | Meaning                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviews.lowRatingThreshold`      | integer 1 to 4                               | `2`         | Reviews rated at or below this raise `review.new_low_rating` and show as "Low rating". See [what a change does](#what-changing-the-low-rating-threshold-does).                                                                                                                                                                                                                |
| `translation.enabled`             | boolean                                      | `false`     | While `false`, no review text is sent to any provider.                                                                                                                                                                                                                                                                                                                        |
| `translation.provider`            | `google`, `deepl`, `azure`, `libretranslate` | `google`    | Which service translates. Each needs a credential of its own kind.                                                                                                                                                                                                                                                                                                            |
| `translation.targetLanguage`      | BCP-47 tag                                   | `en`        | The language reviews are translated into. `pt_BR` is stored as `pt-BR`.                                                                                                                                                                                                                                                                                                       |
| `translation.mode`                | `off`, `on_demand`, `auto`                   | `on_demand` | `auto` translates new reviews after a sync (see [reviews](reviews.md#translation)).                                                                                                                                                                                                                                                                                           |
| `translation.dailyCharBudget`     | integer 0 to 100,000,000                     | `50000`     | Characters this workspace may send per UTC day. `0`: no limit here.                                                                                                                                                                                                                                                                                                           |
| `translation.libretranslate.url`  | text                                         | `""`        | The LibreTranslate server, `https://host[/path]`. Empty: none.                                                                                                                                                                                                                                                                                                                |
| `release.stalledAfterHours`       | integer 0 to 720                             | `6`         | A release that has stood still for longer than this many hours is **stalled** ([release pipeline](release-pipeline.md)); it raises `release.stalled`. `0` turns the signal off for the workspace (the pipeline is still shown).                                                                                                                                               |
| `release.stalledRepeatHours`      | integer 0 to 720                             | `24`        | The same stall is reminded again after this many hours. `0`: once per stall, never again.                                                                                                                                                                                                                                                                                     |
| `sync.enabled`                    | boolean                                      | `true`      | The scheduled refresh of the stores for this workspace ([scheduled sync](ci.md#scheduled-sync)). On by default; it only reads. No effect when the server has `KILN_SYNC_INTERVAL_MINUTES=0`.                                                                                                                                                                                  |
| `sync.intervalMinutes`            | integer 5 to 10080                           | `30`        | Minutes between two scheduled refreshes of one app (the screen offers 15, 30, 60, 360, 1440). Never set: the server's interval applies, and `values` shows that.                                                                                                                                                                                                              |
| `reviews.unansweredReminderHours` | integer 0 to 720                             | `0`         | `review.unanswered`: one digest at most every this many hours, when a review rated at or below `reviews.unansweredMaxRating` has waited that long without an answer. `0` (the default) is off.                                                                                                                                                                                |
| `reviews.unansweredMaxRating`     | integer 1 to 5                               | `5`         | The highest rating the digest counts (`2` means only 1 and 2 stars).                                                                                                                                                                                                                                                                                                          |
| `analytics.enabled`               | boolean                                      | `false`     | While `false`, no analytics sync, scheduled job or Apple enable action reaches a store. Reading stored numbers and importing a file still work ([analytics](analytics.md)). Written with `analytics.manage` (admins and owners).                                                                                                                                              |
| `analytics.appleVendorNumber`     | text                                         | `""`        | The vendor number of App Store Connect Sales and Trends (5 to 12 digits). Empty: Apple sales (also by product) are not read.                                                                                                                                                                                                                                                  |
| `analytics.playBucketId`          | text                                         | `""`        | The Cloud Storage bucket of the Google Play monthly reports (`pubsite_prod_rev_` and digits, as shown in Play Console; a leading `gs://` is dropped). Empty: those reports are not read. The Google Play estimated sales, monthly earnings and subscription statistics files are in the same bucket (they also need the Play Console permission View financial data, Global). |

The address rules for `translation.libretranslate.url` (checked on save, and again at every call,
because DNS can change): `https` only; no user name, password, query or fragment; a private,
loopback or link-local address is refused; cloud metadata addresses (169.254.169.254,
100.100.100.200, fd00:ec2::254) are **always** refused. With `KILN_TRANSLATE_ALLOW_PRIVATE_URLS=true`
on the server ([deployment](../deployment.md#review-translation)) private and loopback addresses are
accepted, and plain `http` only for loopback (`localhost`, `127.0.0.0/8`, `::1`).

## `GET /settings`

Any member (`settings.read`). Answer:

```json
{
  "values": { "reviews.lowRatingThreshold": 2, "translation.enabled": false, "...": "..." },
  "defaults": { "...": "..." },
  "overridden": ["translation.enabled"],
  "writable": ["reviews.lowRatingThreshold", "..."],
  "docs": { "reviews.lowRatingThreshold": "A review with this rating or lower ..." },
  "sync": {
    "serverMinutes": 30,
    "enabled": true,
    "intervalMinutes": 30,
    "running": true,
    "lastScheduledAt": 1781092800000
  },
  "translation": {
    "provider": "google",
    "credentialRequired": true,
    "credentialConfigured": true,
    "credential": { "id": "...", "label": "Google key" },
    "usage": { "day": "2026-06-10", "used": 1200, "budget": 50000 }
  }
}
```

`writable` is empty for a member and lists every key for an admin. `credential` (id and label) is
only present for those who may read credentials. `usage` is today's count (UTC) against the budget.

`sync` is how the scheduled refresh stands for this workspace: `serverMinutes` is `KILN_SYNC_INTERVAL_MINUTES` (`0`: off for every
workspace), `enabled` and `intervalMinutes` are what applies (`values["sync.intervalMinutes"]` is the same number: the workspace's choice,
else the server's interval), `running` is whether a scheduled refresh runs for the workspace at all, `off` is `server_off` or
`workspace_off` when it does not, and `lastScheduledAt` is the time (epoch milliseconds, or `null`) of the last scheduled sync of any of its
apps, read from the `app.sync` audit events whose `requestedBy` is `scheduler`. Google Play reports no review state, so for Android the
alerts a refresh enables cover track, rollout and halted. `PUT` answers with the same `sync` block.

## `PUT /settings`

Admins and owners. A partial update: send only the keys to change; `null` resets a key to its
default. **All or nothing**: if one value is invalid, nothing changes.

- `400 unknown_setting`: a key that does not exist (`issues` lists them). This is also what a try to
  store a secret (`translation.apiKey`) gets.
- `400 invalid_setting`: a value of the wrong type or outside its range, or an address that is not
  allowed. `issues` is `[{ path, message }]`.
- `400 invalid_request`: the body is not a JSON object.
- Answer `200`: `{ changed: [keys], values, defaults, overridden, writable, docs }`.

## `POST /translate/test`

Admins and owners; rate limited per workspace. Translates one fixed word (not review text) with the
**saved** provider, credential and address and answers `{ ok, message, provider?, reason? }`.
`message` is a fixed sentence per failure; it never contains the key, an address or the provider's own
words. It uses no daily budget and is audited as `translation.test` (provider and result only). It
works while translation is switched off, so a setup can be tested before turning it on.

## What changing the low rating threshold does

A review raises `review.new_low_rating` **at most once**. The threshold is read at the start of each
sync, so a change applies from the next read on, and:

- **Raising it** (say 2 to 3) does **not** send events for reviews already stored: they come back
  from the store on later reads (Apple's read overlaps by 14 days) but are not new. Only reviews
  first seen from then on, and reviews whose **rating changes** to a value at or below the threshold,
  can raise an event.
- **Lowering it** only narrows what is new from then on. Events already sent stay sent.
- An edit that does not change the rating never raises an event; a rating changed to a low one does
  (`source: "edited"`), once.
- The first read of an app is still a quiet baseline, and at most 50 events are sent per read.
- The event payload carries the `threshold` in force, and the last sync result `lowRatingThreshold`.

The constant `LOW_RATING_THRESHOLD = 2` in `review-sync.ts` is only the default for a workspace that
has not set the key.
