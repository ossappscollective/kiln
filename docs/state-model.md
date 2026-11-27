# The state model (what is true about an app, in one place)

Status: the model and its store are in `apps/web/src/lib/app-state/`. This page has three parts: the inventory of what decided or
showed app state before the model (the audit that led to it), the model itself (phases, priority rules, invariants), and how it is
enforced by tests.

## 1. Inventory (before the model)

Every place in `apps/web/src` that decided or displayed app or workspace state, or offered a state-dependent action. "Count" is which
number the place showed. The columns "Reads" and "Derives" are what it did by itself; that duplication is what produced the
inconsistencies (a failed publish that the top bar, the Next step card and the promote button each saw differently).

### Reads and stores

| Source                                       | What it holds                                                                                                     | Endpoint                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `cartSummaryStore` (`cart-summary*.ts`)      | pending CART count per app record (stored changes, the "29")                                                      | `GET /pending/cart-summary`                                      |
| `pendingStore` (`pending-store.svelte.ts`)   | pending VIEW per app (`lineOfView`: actionable / waiting / blocking), workspace summary (`lineFor`), batch switch | `GET /pending/summary`, `GET /apps/{id}/pending`, publish config |
| `publishingStore` (`publishing*.ts`)         | publishing claims, the latest run that did not complete, dismissals                                               | `GET /pending/publishing`, `POST .../runs/{id}/dismiss`          |
| `pipelineStore`                              | release pipeline per app (trains) and workspace summary (stalled releases)                                        | `GET /apps/{id}/release-pipeline`, summary                       |
| `stagedStore`, `submitStore`, `releaseStore` | staged content, "pushed draft waits for submit", store release state                                              | `.../staged`, `.../store-submit`, `.../store-release`            |
| `navSignals`                                 | apps, releases by app, unanswered reviews, insight counts                                                         | several                                                          |
| `cartButton`                                 | UI plumbing of the top bar button (count, visible, press) written by `PendingCart`                                | none (written by a component)                                    |
| page reads                                   | `AppShell` release lists, `AppDashboard` builds, drift, plans, reviews                                            | per app                                                          |

### Surfaces (before)

| Surface                       | File                                                                                     | Count it showed                                            | Publishing / failure                                                   | Derived by itself                                              | Actions it enabled                             |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| Top bar button                | `PendingCartButton`, `Shell`, `cart-button`                                              | rows of the per-app cart (`PendingCart.rows`)              | publishing only; NO failure                                            | `visible`, `busy`                                              | open drawer                                    |
| Next step card                | `NextStep`, `next-step.ts`, `nextStepTrains`                                             | none (a link text from `lineFor`)                          | publishing banner only; NO failure                                     | trains from `pipelineStore`, `canStart`, `canPrepare`, `off()` | Start release, Prepare, train buttons, Promote |
| Overview page                 | `AppDashboard` (`pending` prop from `AppShell`)                                          | `lineFor` count (actionable items)                         | none                                                                   | attention items incl. "staged not pushed" (a 3rd count)        | none                                           |
| App header strip              | `AppShell` (`pendingBar`, `pendingPlacement`)                                            | `lineFor` count                                            | none                                                                   | bar text, placement                                            | link to pending                                |
| Releases page                 | `AppReleases`, `NextStep`, `ReleaseTable`, `ReleaseRowDetail`                            | none                                                       | publishing on Promote in the detail only (the table link had no guard) | `promoteOption(s)` per row                                     | Promote (table link, detail button)            |
| Prepare release               | `ReleaseStepper`, `CreateVersion`, `StoreRelease`, `StepBuild`, `StepNotes`, `PlayCheck` | none                                                       | `publishingStore.isPublishing`                                         | `publishingNow`                                                | create version, release                        |
| Submit                        | `SubmitReady`, `StagedTrayApp`                                                           | none                                                       | `publishingStore.isPublishing`                                         | `publishingNow`, availability                                  | submit, push draft, clear                      |
| Rollout                       | `RolloutAppControl`, `Rollout`                                                           | none                                                       | `publishingStore.isPublishing`                                         | `publishingNow`                                                | rollout steps                                  |
| Pending drawer                | `PendingCart`, `PendingCartDrawer`                                                       | `rows.length` of ALL records (not the platform scope)      | claims and failures per member                                         | `publishing`, `failures`, `visible`                            | publish, review, discard, dry run              |
| Pending page                  | `PendingChanges`                                                                         | views (`lineOfView`)                                       | claims and failures per member                                         | `publishing`, `failures`, `availability`                       | review and publish, discard                    |
| Workspace pending             | `WorkspacePending`, `Shell` nav entry                                                    | cart summary total                                         | claims and failures                                                    | `pendingRows`, `pendingTotals`                                 | none                                           |
| Sidebar badges                | `Shell` `appCounts`, `nav-badges`                                                        | `lineFor` count                                            | none                                                                   | pending, blocking                                              | none                                           |
| App switcher chips            | `Shell` `switcherList`, `PendingChip`, `chipFor`                                         | `lineFor` count                                            | none                                                                   | chip text and tone                                             | none                                           |
| Portfolio overview, Board     | `Portfolio`, `app-overview`, `Board`                                                     | `lineFor` count                                            | none                                                                   | rows                                                           | none                                           |
| Platform switch               | `AppShell` (`resolveScope`)                                                              | scopes some counts, not others (cart rows were not scoped) | n/a                                                                    | `scoped`                                                       | none                                           |
| Connect callouts, expo notice | `connect/*`, `ExpoOverviewCard`                                                          | n/a (about credentials, a repository, Expo)                | n/a                                                                    | own conditions                                                 | link                                           |
| Notifications bell            | `AlertBell`, `alerts/store`                                                              | n/a (the user's alert inbox, not app state)                | n/a                                                                    | unread                                                         | none                                           |

### The inconsistencies this produced

1. The top bar showed the cart rows count while the Overview linked a different count (`lineFor`), and the sidebar showed a third.
2. A publish that failed was only known to the pending panels. The top bar, the Next step card and the Promote buttons did not read it.
3. "Nothing is waiting for you" and "Start release" came from the release trains alone: pending changes never entered the choice.
4. Every action surface re-derived "is a publish running" with its own `isPublishing` check; the Promote link in the releases table had none.
5. The cart drawer covered every platform record while the page was scoped to one.

## 2. The model

`apps/web/src/lib/app-state/` (pure TypeScript, no Svelte):

- `types.ts`: the facts (`AppFacts`) and the answer (`AppState`).
- `derive.ts`: `deriveAppState(facts, scope)` and `deriveTopBar`.
- `candidates.ts`: the release candidate and the versions left behind (section "Candidates and obsolete versions"); `candidate-trains.ts`
  words a candidate as a release train; `store-builds-store.svelte.ts` reads the store builds (TestFlight rows).
- `app-state-store.svelte.ts`: the one rune store. It reads the facts once and exposes the derived state.

### Phases and priority

For the platforms in scope, the first row that applies wins:

| #   | Phase               | When                                                                              | Primary action                                      | Secondary                                                    |
| --- | ------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| 1   | `publishing`        | a publish claim exists for a record in scope                                      | `show_pending`                                      | none                                                         |
| 2   | `publish_failed`    | the latest run did not complete and was not dismissed (and no newer publish runs) | `show_pending`                                      | `publish_again`                                              |
| 2b  | `publish_failed` (draft pushed, submit blocked) | the latest run applied `push_draft` and only its submit was skipped as `blocked` (nothing failed) | `fix_blockers` ("Fix 2 blockers, then submit 2.0.1 for review"): opens the submit checklist (SubmitReady) with the blockers | `show_pending` |
| 2c  | `ready_to_submit` | the latest run only had its submit blocked, a reading of the store NEWER than the run says nothing blocks any more, and no change is pending | `submit_now` ("Submit 2.0.1 for review"): opens the submit checklist | `show_pending` |
| 3   | `changes_pending`   | the pending count in scope is above 0                                             | `show_pending` ("Review and publish")               | the release step of the flow, `publish_again` is not offered |
| 4   | `release_needs_you` | a release failed, was rejected, or waits for a person                             | the train's button (`attach_build`, `open_release`) | Promote when offered                                         |
| 4b  | `version_in_prep`   | a version for the newest build is being prepared: attach the build, then submit   | `attach_build`, or `prepare_release` ("Submit 2.00.1 for review") |                                                |
| 4c  | `candidate_ready`   | a newer build is in TestFlight and no version takes it: create the release (iOS)  | `create_release`                                    | Promote when offered                                         |
| 5   | `in_review`         | a release waits on the store                                                      | `follow_review`                                     |                                                              |
| 6   | `release_running`   | a release waits on CI                                                             | `open_release`                                      |                                                              |
| 7   | `ready_to_release`  | nothing in flight, a release can be started or prepared                           | `start_release` or `prepare_release`                |                                                              |
| 8   | `idle`              | nothing to do and no right to start                                               | `none`                                              |                                                              |

"Nothing is waiting for you" is only ever said by phases 7 and 8, which need: no publish running, no undismissed failure, a pending
count of 0 in scope. That is how the Next step card can no longer say it while 29 changes wait.

### Blockers of a run: history vs current

A run that pushed the draft and had its submit skipped as `blocked` keeps its blockers (`runBlockers`: what was true when it ran). The model
holds them against a CURRENT reading of the store (`facts.readiness[appId]`, from `GET /apps/{id}/publish/readiness`; `blockersViewOf`
in `app-state/blockers.ts`, pure) and exposes `failure.blockers`: `{ state, current, run, resolved, summary, runLabel, readLabel }`.

- `unverified`: no reading newer than the run (not read yet, no right, the read failed): the run's list is shown as it was, labelled "From
  the last publish, N minutes ago". A reading older than the run is ignored.
- `blocked`: only the blockers of the reading are current (`currentBlockers`); the card says "Fix N blockers" with N of the reading.
- `ready`: nothing blocks: phase `ready_to_submit` (row 2c), the failure block says "everything that blocked the submit is fixed now" with "Submit now" and "Dismiss".
  The run stays as history, visibly separate. Only the codes core can recompute (`RECOMPUTABLE_CODES`) are judged against a reading.
- "Check again" (card, failure block) reads the store fresh and re-derives; sync and "Read again" refresh the reading too. "Store images read
  {time}" is shown next to it.

### Candidates and obsolete versions

`candidates.ts` is the ONE place that decides which build can be released next and which store versions are left behind. It is a pure
function (`analyzeCandidates`) of the synced facts of a record: its store versions with their state (the releases), what is live, and the
store builds (`app_builds`: version, build number, processing state, expired, uploaded). Both platforms read it, and so do the card, the
Releases table (rows and "Ready to release"), the overview tile, the pipeline summary counts (`appStateStore.stalledApps`) and the notices.

- **Version compare** (`compareVersionStrings`): dotted numbers. `2.00.1` is `2.0.1`, `1.0` equals `1.0.0`, a 4-part `2.00.1.90` is after
  `2.00.1`, a leading `v` is ignored. Anything else (`2.0.0-beta`, empty) is UNKNOWN: it is neither older nor newer, it is never judged
  stale, and while something is live it is never a candidate. Build numbers compare the same way; an unknown live build never lets a
  same-version build count as newer.
- **Live** (iOS, macOS): the newest version in `live`, `rolling_out` or `halted` (and its build). Google Play: the production release(s) in
  those states and their version codes.
- **A build is ignored (`obsolete`)** when its version is lower than the live version, or the same version with a build number that is not
  higher than the live build; or when its version is already past Prepare (in review, rejected, approved, rolling out) or the build is
  attached to such a version (that is the release pipeline's train, not a candidate). Ignored builds stay in `analysis.candidates` flagged,
  they are never `best`.
- **The candidate** (`ReleaseCandidate`, `analysis.best`): the newest build (highest version, then highest build number) that is not
  obsolete, `processed` (VALID) and not expired. Channels: `testflight`, `play_internal`, `play_closed`, `play_open`, `play_other`. A newer
  build still processing is a quiet notice, never the headline; an expired, invalid or unreadable one is nothing.
- **The step it asks for** (`analysis.plan`, iOS and macOS): no non-obsolete version in preparation for that version number gives
  `create_release` ("Create release 2.00.1 from TestFlight build 95": primary action `create_release`, a link to the existing create-version
  step with `&version=2.00.1&build=95` in the address: CreateVersion starts with that version, the build step selects that build; no new
  store write exists); a version in preparation without that build gives `attach_build` ("Attach build 95 to 2.00.1"); with it attached,
  `prepare_release` to the confirm step ("Submit 2.00.1 for review"). These become release trains (`candidate-trains.ts`) beside the
  pipeline's own, so rows, the card and the five steps stay one flow; the pipeline's draft train for the same record is replaced by them.
- **Google Play** (`analysis.promote`): a release in a testing track that is serving, has codes, is not already in production, and whose
  codes are higher than the live production codes. The card keeps showing it as the Promote line (`promotion`); it is the same fact.
- **Obsolete versions**: a store version still in a preparable state (draft, build chosen, ready; a rejection that is editable again is a
  draft for Apple) whose version is LOWER than, or the same as, the live version (Google Play: a draft whose codes are all below the live
  production codes). It is never the next step: its pipeline train is silenced (`quietPipeline`), "Release left unfinished" about it is
  dropped, and it shows as `Outdated: 1.19.0 is already live` in the older list of the Releases table, plus a notice "An unused older
  version 1.11.6 is still in preparation. Remove it?" with a link to App Store Connect (or Play Console). There is no "Remove" action:
  no connector deletes a store version, so the model gives advice, never a button that does not exist.
- **Priority**: publishing, publish_failed and changes_pending stay above everything; the candidate comes with the release flow (it is the
  quiet second button of `changes_pending`, off while a publish runs or has failed, with the reason). The platform scope applies as for
  every flow: iOS shows iOS only; with Both the most urgent leads and names its platform; Android keeps Promote.
- **Facts**: the loader reads the store rows of `GET /apps/{id}/builds/artifacts` once per record (`storeBuildsStore`, kept in the read cache
  under `store-builds/<app>`; the Test builds page and the release step's build picker read the same endpoint DIRECTLY, with no cache shared
  with the model, so they can be older or newer than the model's copy until they move onto it) in the same refresh as the pipelines; until they are read the model knows the newest build of the
  release pipeline, and the version the pipeline names when the page did not load the releases. Nothing is added to the server.

### The pending count

ONE number: the length of the cart (`GET /pending/cart-summary`, the same function as `GET /apps/{id}/pending/cart`), summed over
the records in scope. The top bar, the Next step card, the header strip, the sidebar badge, the app switcher, the Pending page's total
and the drawer all show it. `blocking` (items with an error) comes from `GET /pending/summary` and is a quality of the same count,
never a second count. "Staged but not pushed" in the attention list is dropped while changes are pending (it says the same thing in
another number).

### Verdicts for every state-dependent action

`canDo(action, platform?)` answers `{ enabled, reason, code }`. Actions: `publish`, `push`, `discard`, `submit`, `release`,
`promote`, `create_version`, `rollout`, `prepare_release`, `start_release`. Rules, in order (the first that applies decides):

1. `no_platform` / `unsupported`: the platform is not in scope, or does not do this (no tracks, no version creation).
2. `role`: the role lacks the right (`store.publish`, `store.push_draft`, `store.submit`, `store.release`, `releases.rollout`,
   `changesets.write`, `ci.dispatch`). A role without the right NEVER gets an enabled mutating action.
3. `publishing`: a publish of that record runs. Every mutating action is off (the server answers `409 publish_in_progress` for
   publish, store-release, store-submit, rollout, store-version, staged push, discard and cart publish; dispatching CI and opening the
   release steps are held back too: nothing mutates while the batch writes).
4. `publish_failed`: an undismissed failure of that record. DECISION: `promote`, `release`, `submit`, `create_version`,
   `prepare_release` and `start_release` are off with the reason "Resolve the failed publish first" (they would act on a store
   state the failed publish left half written). `publish` (publish again), `push`, `discard` and `rollout` stay: they are the ways
   out, and halting or resuming a live rollout must never be blocked by a failed draft push.
5. `nothing_to_publish`, `switch_off`: for `publish` only.

### Top bar

`deriveTopBar` returns `idle | pending(count) | publishing | failed(count)` (`failed` carries `ready: true` when every kept blocker is fixed: the bar then says it is ready to submit). Priority: the open app publishing, then another app of the
workspace publishing (the button follows it), then a failure in scope, then pending in scope. It never shows `idle` while the card
says something is pending, because both read the same `AppState`.

## 2b. Caches, freshness and invalidation (one cache, one list, one event)

The rule: a fact has ONE reader, ONE cache and ONE invalidation event. Nobody writes `readCache.forget(...)` or a hand-made `dropXCaches()`:
a change says WHAT happened (`sync`, `publish`, `staged_changed`, ...) and the registry drops what declared that event.

### Times that server and browser must agree on: `packages/core/src/timings.ts`

Every TTL, freshness window and liveness threshold that two parts depend on lives there with its relation to the others in code
(`timings.test.ts` pins the relations). The browser's value is DERIVED from the server's, never a second literal:

| Constant                                           | Value  | Server user                          | Browser user                                          | Relation                                                |
| -------------------------------------------------- | ------ | ------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------- |
| `STORE_VIEW_TTL_MS`                                | 60 s   | store images view                    | (`READ_CACHE_TTL_MS`)                                 | `ASSET_SYNC_LIMITS.storeCacheSeconds` derives from it   |
| `CURRENT_READINESS_TTL_MS`                         | 30 s   | `GET publish/readiness`              | `READINESS_FRESH_MS` = same                           | readiness <= store view                                 |
| `GRAPHICS_FRESH_MS`                                | 20 s   | -                                    | Graphics tab (`storeMediaCache`)                      | <= store view                                           |
| `READ_CACHE_TTL_MS`                                | 60 s   | -                                    | `readCache` default                                   | = store view                                            |
| `STORE_BUILDS_READ_TTL_MS`                         | 120 s  | -                                    | `storeBuildsStore`                                    | >= server build list; `build_changed`/`sync` drop it    |
| `BUILD_LIST_TTL_MS` / `BUILD_PROBLEM_TTL_MS`       | 30/60 s | build artifacts, TestFlight groups  | -                                                     |                                                         |
| `IMAGE_REF_TTL_MS`                                 | 15 min | image refs                           | -                                                     | >= store view; also dropped WITH the view's events      |
| `NOTES_HISTORY_TTL_MS`, `PROPOSAL_SUMMARY_TTL_MS`  | 10 min | notes history, proposal summary      | -                                                     |                                                         |
| `PUBLISH_SILENT_AFTER_MS`                          | 60 s   | a person may end a silent claim      | `QUIET_AFTER_MS` = same ("the server has not reported") | was 45 s in the browser, 60 s on the server: 60 kept  |
| `PUBLISH_STUCK_AFTER_MS`, `PUBLISH_CLAIM_TTL_MS`, `PUBLISH_HEARTBEAT_MS` | 15 min / 2 min / 20 s | claim liveness | `STUCK_AFTER_MS` = same | heartbeat x 3 <= claim TTL |
| `PUBLISH_POLL_*_MS`                                | 5/30/60 s | -                                 | claims poll (visible / hidden / back-off cap)         |                                                         |

### Server: `apps/server/src/services/cache-registry.ts`

Every in-memory cache is born on the list: `timedCache(ttl, max, { name, owner, invalidatedBy, keys })`, `registerMapCache(map, ...)` or
`registerCache(...)`. A cache that no event can make stale must say why (`why`). `emitCacheEvent(event, { workspaceId, appId })` drops what
declared the event for that app (a cache keyed by repository drops the workspace's entries). `cache-registry.test.ts` fails when a
`timedCache(` has no declaration, when a module-level `Map` is neither registered nor listed as not a cache, when the registered caches differ
from this table, or when this file does not name a cache or an event; `cache-events.test.ts` checks that the code that changes things fires the event.

| Cache (`name`)                                                                                                                  | TTL     | Dropped by (`invalidatedBy`)                                                          |
| ------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `publish.current_readiness`                                                                                                     | 30 s    | `store_read`, `sync`, `publish`, `release_changed`, `build_changed`, `staged_changed`  |
| `listing.store_images_view`                                                                                                     | 60 s    | `store_read`, `sync`, `publish`, `release_changed`                                     |
| `listing.image_refs` (an app's refs go WITH its view)                                                                           | 15 min  | `store_read`, `sync`, `publish`, `release_changed`                                     |
| `listing.proposal_summary`                                                                                                      | 10 min  | `sync`, `staged_changed`, `release_changed`, `build_changed`, `publish`                |
| `notes.history`                                                                                                                 | 10 min  | `store_read`, `sync`, `publish`, `release_changed`                                     |
| `builds.repo_artifacts`, `builds.artifact_trouble`, `builds.testflight_groups`, `builds.testflight_trouble`                     | 30/60 s | `sync`, `build_changed`                                                                |
| `ci.active_runs`                                                                                                                | 5 s     | `build_changed`                                                                        |
| `listing.image_thumbs`, `listing.image_probes`, `listing.asset_index`, `builds.repo_artifacts_etag`                             | none    | none: keyed by content (checksum, commit) or only used for conditional requests        |
| `listing.asset_repo_opened`                                                                                                     | 30 s    | none: an opened connector, not a fact                                                  |
| `ci.tag_data`, `ci.commit_facts`, `ci.workflows`, `ci.workflow_inputs`, `ci.compare`, `ci.tags_preview`, `ci.run_actor`, `ci.run_jobs`, `repo.snapshot` | 5 s - 24 h | none: reads of the CI host / repository keyed by repository, sha or ref   |
| `aso.competitor_search_refs`, `aso.competitor_thumbs`, `aso.searches`, `aso.lookups`, `aso.app_searches`, `aso.hint_lists`      | by `cacheMs` | none: public store pages of other apps                                            |

Where each event is fired on the server:

- `store_read`: `GET .../assets/store?fresh=1` and `GET .../publish/readiness?fresh=1` ("Read again", "Check again").
- `sync`: `syncApp`, after the release rows are written (the Sync button, the sync job, the scheduled listing read that goes through it, the
  change-set fix-up) and `syncListing` (the scheduled listing read on its own, `modules/listing/schedule.ts`).
- `publish`: a push that succeeded, partly succeeded, applied with differences or whose outcome is unknown (`store-draft.ts`), the end of every
  `applyPublish` run whatever its outcome, a submit that succeeded.
- `staged_changed`: `stageText`, `stageAssets`, `unstage`, `clearStaged`, `stageReleaseField`, `replaceAssetSet`.
- `release_changed`: `applyVersion` (a version was created), `applyRelease`, `createPlan` / `updatePlan` / `deletePlan`.
- `build_changed`: `putBuildLink` / `removeBuildLink` (a build attached or detached), a CI run that finished (`announce`).
- There is no inbound store webhook: the store is seen by a sync, a read or the person's own action.

### Browser: `apps/web/src/lib/facts/invalidate.ts`

`invalidate(event, { workspaceId, appId | appIds })` with `event` one of `sync | publish | staged_changed | store_read | release_created |
build_changed` (`release_created` is the server's `release_changed`). It (1) forgets the read-cache key families of the event
(`FAMILIES_FOR`: `pipeline/`, `store-builds/`, `editable/`, `candidates/`, `live/`, `assetdiff/`; keys are built by `readKeys`, and
`readFact` reads with a typed family), (2) drops the Graphics tab's last read (`storeMediaCache`) for the events that may change the store,
(3) tells the screens that subscribed with `onInvalidated`, and (4) lets the model read again (`appStateStore.react`: `refresh` with the apps
named, collected for 150 ms so twenty syncs are one refresh; `staged_changed` has the lighter cart + pending summary reaction).

| Event             | Read-cache families forgotten                                   | Graphics read | Model                       | Raised by                                                                                       |
| ----------------- | --------------------------------------------------------------- | ------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `sync`            | pipeline, storeBuilds, editable, candidates, live, assetDiff    | dropped       | `refresh(appIds)`           | AppShell, Portfolio (each app and the batch), AppDetail, ImportFromCredential                    |
| `publish`         | the same                                                        | dropped       | `refresh(appIds)`           | `api.publish*` (the browser event, success or failure), so the publish dialog and the cart       |
| `staged_changed`  | assetDiff                                                       | kept          | cart count + pending summary | `api.stage*`, unstage, discard (the browser event `kiln:staged-changed`)                         |
| `store_read`      | editable, candidates, live, assetDiff                           | dropped (kept by the screen that just read) | readiness of a blocked run, by the caller | Graphics "Read again", "Check again" (`appStateStore.checkAgain`) |
| `release_created` | the same as `sync`                                              | dropped       | `refresh(appIds)`           | CreateVersion, NewPlan, ReleaseStepper after a release started                                   |
| `build_changed`   | pipeline, storeBuilds, candidates                               | kept          | `refresh(appIds)`           | AppShell after the rest of a sync (TestFlight, CI runs)                                          |

`kiln:staged-changed` is still the transport from `lib/api.ts` (which cannot import the stores), but it has ONE subscriber: `bindInvalidation`,
bound by `appStateStore.watch`. Announcements that arrive together become one `invalidate` per event. AppShell, the cart, the Graphics tab,
the release step's comparison and the proposal hint listen with `onInvalidated`. `invalidate.test.ts` fails when an event forgets the wrong
families, when anything but `facts/invalidate.ts` calls `readCache.forget(` or `onStagedChanged(`, and when a `readCache.read(` key is not of
a listed family.

Gaps (not done, on purpose or not yet): the browser has no push channel. `GET /workspaces/:id/events/stream` (SSE) exists on the server for
external consumers (role `events.read`, at most 5 streams per person), but it is not per app and is not a browser contract, so another tab,
another person or an MCP caller is still seen only at the next focus, poll or page read; the scheduled listing read is seen at the next
`sync`/focus. A client for `app.synced` over that stream is the next step (then `invalidate('sync', ...)` from it, no other change). The model
also still reads `readinessStore` only for blocked runs. The browser's `navSignals`, `cartSummaryStore`, `pendingStore` and `publishingStore`
keep their own freshness (generation counters and timers) and are refreshed through `appStateStore.refresh`, not registered as key families.

## 2c. Single owners (core)

One fact, one function. Each row names the function in `packages/core` that now OWNS a cross-page fact and what it replaces. The
"replaces" column gives the duplicates found by the audits (`file:line` as of the audit); they stay as thin delegates or are removed by the
consumer migration (Wave 2). `packages/core/src/facts-owners.test.ts` pins the export surface (functions, values and the kept old names), so
a rename or a removal fails a test instead of a page.

### Versions, live, obsolete, create rules (`versions/`)

| Fact | Owner | Replaces |
| ---- | ----- | -------- |
| Version order (dotted, tolerant, total) | `compareVersions`, `tryCompareVersions` (null when unreadable), `sameVersion`, `newestVersionFirst` | web `lib/app-state/candidates.ts:43`, web `lib/portfolio.ts:179`, core `release/store-version.ts:18` (`compareDottedVersions`, now a delegate), core `insights/engine.ts:179` (re-exports), web `lib/build-origin.ts:305-322`, `localeCompare(..., {numeric})` on versions in connectors `apple/appstore-draft.ts:1292`, server `modules/ci/links.ts:212,270`, `modules/ratings/health.ts:106` |
| Build number order | `compareBuildNumbers` (total), `tryCompareBuildNumbers`, `newestBuildFirst`, `compareReleases` | `Number(buildNumber)` sorts: server `services/apps.ts:737,770,799`, `modules/builds/service.ts:614`, `modules/ci/scan.ts:460,490`, `modules/ci/tags.ts:224`, connectors `google/googleplay.ts:447`, web `release-candidates.ts:311,417,445` |
| Which statuses are serving / preparing / past prepare | `SERVING_STATUSES`, `PREPARING_STATUSES`, `PAST_PREPARE_STATUSES`, `isServingStatus`, `isPreparingStatus`, `isPastPrepareStatus` | the status lists inside `portfolio.ts:244`, `releases-table.ts:390-395`, core `release-pipeline.ts:441,546`, server `publish/store-version.ts:233`, `play-live.ts:12`, `play-promote.ts:49`, core `play-rollout-offer.ts:32`, `metadata-lock.ts`, `lifecycle.ts:117`, server `services/apps.ts:285` (overlay), model `candidates.ts:194` |
| What is live for a platform | `liveOf(releases, { platform })` giving `{ serving, live, rollingOut, halted, newestLive, ref }` | `liveRelease` (`portfolio.ts:244`), `newestLive` (`releases-table.ts:390-395`), `liveVersionOf` (`publish/store-version.ts:233`) and the others above |
| Play version codes of a release, the top code | `codesOfRelease`, `topCodeOf`, `topOfCodes` | per-page `Math.max` over `versionCodes` |
| Is a version obsolete (and why) | `isObsolete`, `obsoleteReasonOf`, `isObsoleteVersion`, `isNewerThanLive` | `candidates.ts:252,478,500,525`, `play-promote.ts:60`, `candidates.ts:300` |
| May a release be created (refusals) | `createReleaseRules(version, versions)` giving `invalid_version`, `editable_version_exists`, `version_exists`, `not_higher`; `isCreatableVersion`, `newestNonEditableVersion`, `storeVersionsOf` | the server's refusals at `publish/store-version.ts:~247-265`, and `isDottedVersion` (now a delegate) |
| Release candidates, promote options, stalls | `analyzeCandidates`, `promoteOptionsOf`, `obsoleteVersionsOf`, `pipelineIsObsolete`, `stallLeftBehind` | web `lib/app-state/candidates.ts` (ported; the web file becomes a thin adapter) |
| Play tracks | `PLAY_TRACKS`, `PLAY_TRACK_ORDER`, `trackKind`, `isProductionTrack`, `isInternalTrack`, `isOptInTrack`, `playChannelOf`, `sameTrack` | `candidates.ts:179,243`, `play-promote.ts:21`, server `builds/service.ts:605`, `release-candidates.ts:476`, `ReleaseStepper.svelte:104`, `StepBuild.svelte:73`, `expo/eas-config.ts:236` |
| Where a build came from, its number | `joinBuildOrigin`, `originOfBuild`, `buildNumberOfBuild` | server `publish/candidate-origin.ts`, `publish-summary.ts:498`, `candidate-trains.ts:565`, `builds.ts:990` (`buildNumberOfTitle`), `StepBuild.svelte:172,307` |

Decisions to review:

- **Serving set**: `SERVING_STATUSES` is `live`, `rolling_out`, `halted` (a halted rollout is still the current version for the people who got
  it, and its number is taken). `propagating` (Play, committed but not visible yet), `approved`, `in_review`, `rejected` and the preparing
  states do not serve. On Google Play only the PRODUCTION track serves; an internal release that is `live` is not what is live (the pipeline
  used to count it). `liveOf` returns `serving` (newest first by version, then build, then highest version code on Play, `statusSince` only
  breaks a tie), `live`, `rollingOut` and `halted` as separate lists, `newestLive` (the first serving release) and `ref`, so no page
  re-filters. Before, "live" was only `live` in one place, live + rolling_out + halted in another and ordered by `status_since` in a third.
- **Orders are total**: `compareVersions` and `compareBuildNumbers` never return `NaN`; unreadable values sort below readable ones and then
  naturally. Code that needs "unknown" uses the `try*` variants (null).
- **Create rules mirror the server**: the browser may say "not higher than 2.3.0" before the call, the server stays the authority.

### Store images (`images/`)

| Fact | Owner | Replaces |
| ---- | ----- | -------- |
| Count limit of a slot, saved and staged | `limitOf(store, kind, device?)` giving `{ max, rule, stagedMax }`; `assetCountLimit` in `listing/store-asset-specs.ts` | `maxFor` (`store-asset-specs.ts:616`), `slotMaxFiles` (`staged-changes.ts:254`, now a delegate), web `staged.ts:427`, `AssetSetEditor.svelte:95`, `over-limit.ts:324` |
| Display sets (an iPad 13" display spans several Apple placement groups, each with its own limit of 10) | `groupStoreImages`, `displayKeyOf`, `findDisplay`, `findStoreImage`, `refsOfDisplay` | `graphic-sets.ts:81-116,114,159,118`, `storeSideOf` (`store-images.ts:326`), `asset-diff.ts:141-157`, `staged-store-seed.ts:37-41`, `asset-sync-routes.ts:530-545`, `cart.ts:228-236,607-621,229`, `asset-pull.ts:138-148` |
| One image fact for every check (path `locale/kind/device#position`) | `assetFact`, `storeImageFacts`, `displayImageFacts`, `validateImageFacts`, `measuredPathsOf`, `imagePathOf` | the four builders `checkStoreImages` (`asset-sync.ts`, now a delegate), `assetFactsOf` (`draft-readiness.ts`), `staged-changes.ts:263-280`, `asset-index.ts:331-351` |
| Compare sentence and compare rows (carry `storeRef`, so a pull needs no second lookup) | `compareRows`, `compareDisplay`, `compareSentence`, `pullRefOf`, `pullRefsOfDisplay` | `compareSet` (`asset-sync.ts:287`), `pullableKeys` (`sync.ts:294`), `AssetCompareDialog:132`, `compareSummary` (`sync.ts:242`), `assetsLine` (`release-assets.ts:14`) |
| What the store will show after the staged changes | `predictedImagesOf(view, staged, { pushed })` | `cart.ts` and the stepper's own predictions |
| Staged counts | `isUnpushed`, `stagedCountsOf` | `release-stepper.ts:180-186`, `app-attention.ts:90`, `staged.ts:210,220-225`, `StepAssets.svelte:100-101`, `staged-marks.ts:61` |
| What the submit gates read about images | `readinessImagesOf(view)` | `appstore-submit.ts:170-181`, `play-submit.ts:79,169-290` |

Decisions to review:

- **Unknown size** (an Apple image no display classifies): it belongs to no set and is counted as `unplaced` ONCE, never added to a group's
  count. Readiness reports it as a WARNING (`images_unplaced`, with the number), never a blocker, and the Graphics tab shows the same
  number. Before, the Graphics tab left it out of every set while readiness counted it in the group of the first image with a size, so
  "over the limit of 10" held in one and not in the other. Google Play: every image type counts (TV, Wear, TV banner included); no size at
  all is never an error.
- **Item path changed**: the readiness item for an image is now `asset_spec:<locale>:<locale>/<kind>/<device>#<position>` (was
  `.../group-iphone-65/1`). A blocker persisted under the old key shows once as history.

### Listing text, locales, copy and notes (`listing-facts/`)

| Fact | Owner | Replaces |
| ---- | ----- | -------- |
| Locale codes: parse, normalise, equal, equivalent, base locale | `parseLocale`, `normalizeLocaleCode`, `isLocaleCode`, `isLocaleOrDefault`, `localeKey`, `localesMatch(a, b, { mode: 'exact' \| 'equivalent' \| 'language' })`, `matchLocale`, `mergeLocales`, `baseLocaleOf`, `LOCALE_EQUIVALENTS` | validators and normalisers: fastlane `fastlane.ts:91`, staged `LOCALE`, routes `routes.ts:54`, `routes/repositories.ts:114`, `isNoteLocale` (server `release-notes-translate.ts:40`, web `release-notes.ts:455`), `canonicalLocale` (`listing/locales.ts:23`), `notes-history.ts:71`, `aso/insights.ts:64`, web `aso/budget.ts:97`, the three `sameLocale` |
| Which copy of the store listing a page reads (live or editable) | `storeCopyView(channels, { intent })` with `shown`, `editable`, `live`; `pickCopy(view, locale)`; `COPY_INTENT_CONSUMERS` | channel picks: `insights/service.ts:184`, `aso/insights.ts:101,127`, `listing-fixes.ts:73`, `asset-proposal.ts:767`, `pull.ts:601`, `ReleaseStepper.svelte:306-309`, `PublishSummary.svelte:62-71`, `live.ts:903-940` (`getDrift`) |
| Length of a text and its unit | `measureField` (`listing/listing.ts`), `normalizeStoreText`, `sameListingText` | counting: web `edit.ts:140`, `drift.ts:91`, `repositories.ts:405`, `TextDiff.svelte:41`, server `ai-task-listing.ts:123`, `ai-task-aso.ts:68`, web `release-notes.ts:159,325,436`, `cart.ts:~215` (`.length`, `[...s].length`, trimmed or not) |
| The limit of a field | `textLimitOf(store, field)`, `releaseNotesLimitOf(store)`, `fieldSpecOf` | `noteLimitOf` (`release-notes-translate.ts:44-45`, `{apple: 4000, google: 500}`), web `release-notes-translate.ts:26`, `release-plan.ts:30`, `draft-readiness.ts:169`, the `?? 500` / `?? 4000` fallbacks |
| Which fields are required | `requiredFieldsOf(store, { stageableFor })`, `emptyRequiredTexts(platform, values)` | `emptyRequiredFields` (`drift.ts:100`) |
| The one check of a text | `checkTextField(spec, value, opts)`, `validateListingText(store, locales, { copyright })` | `checkListingField` callers in readiness, PlayCheck, the staged view and the Insights `empty` check |
| Release notes over five sources | `notesView(store, sources, { locales })` with `NOTE_SOURCE_ORDER` (`staged`, `store`, `plan`, `repo`, `section`) | `release-plan.ts:118`, `release-stepper.ts:389`, `notes-history.ts` |
| Staged text versus what a push overwrites | `stagedBaselineOf(editableView, locale, field)`, `isUnchangedStaged(staged, baseline)` | `staged-changes.ts:486` (compared with LIVE), `store-draft.ts:1120,1184` (compared with the EDITABLE draft), web `staged.ts:287`, `drift.ts:45` (own normalisers) |

Decisions to review:

- **Counting unit and trim policy**: Unicode code points (UTF-8 bytes for the App Store keywords), white space trimmed at both ends. An
  emoji counts as one, a trailing newline as nothing. This is the store's own rule as far as the official pages state it; where they do not,
  the spec is marked `unverified` and the limit is a warning, not an error.
- **Severity, once**: a limit or `required` that an official page states is an error (blocking); one no page states is a warning. So a Play
  note over 500 is an error in the staged view, a blocker in readiness and a problem in PlayCheck (before: a warning in the staged view), and
  an empty iOS keywords field blocks everywhere (the Insights `empty` check called it a warning).
- **Staged baseline**: the EDITABLE draft's value when the store holds a draft with that locale and field, else the live value; no
  baseline (new text) is never "unchanged". "Unchanged" means "a push would not change it". Before, the cart count compared with live and the
  push preview with the draft, so one text could be "not pending" and "changed" at once.
- **Copy intents**: `shown` is the union of both copies (a locale only the draft has is there, read from live when live has it); `editable`
  is the draft with the live copy standing in when no draft exists; `live` has no fallback. `held` says which copies have a locale.
- **Notes order**: the first non-empty text in `staged` (unpushed only), `store`, `plan`, `repo`, `section` ships; texts that differ are
  reported as conflicts with every candidate, never merged or dropped.

### Old names kept

The previous exports stay, as delegates, so nothing breaks before Wave 2: `compareDottedVersions`, `isDottedVersion`, `nextVersion`,
`newestDottedVersion`, `sameLocale`, `normalizeLocale`, `isPlanLocale`, `slotMaxFiles`, `slotLimitProblem`, `checkStoreImages`,
`assetFactsOf`, `validateAssets`, `summarizeAssets`, `validateListing`, `countCharacters`, `countBytes`, `compareText`, `compareSet`,
`primaryStoreSet`, `releaseNotesLimit`, `releaseNotesLength`, and `insights/engine.ts` `compareVersions` (the same binding re-exported). Those
with a `@deprecated` tag point at the owner; `facts-owners.test.ts` lists them under KEPT and checks that they answer as the owner does.

Not done here, on purpose: moving a consumer onto an owner (Wave 2), and a guard that fails a second implementation of a listed fact
(it belongs with the enforcement tests of section 3 once the consumers have moved).

## 3. Enforcement (so it cannot regress)

| Test                  | File                          | What fails it                                                                                                                                  |
| --------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Exhaustive invariants | `app-state/derive.test.ts`    | any combination of pending x publishing x last run x release x scope x role that breaks an invariant                                           |
| Named scenarios       | `app-state/scenarios.test.ts` | the user's failing scenario and the other incidents (drawer 0 vs 29, count kept after publish, iOS shown on Android, promote while publishing) |
| Source wiring         | `app-state/wiring.test.ts`    | a component outside the allowlist that imports a low-level state source or computes `disabled` from a raw state fact                           |
| Action registry       | `app-state/surfaces.test.ts`  | an action of the closed enum that a surface does not handle (a dead button): `create_release` is handled by the card and the table             |
| Candidates            | `app-state/candidates.test.ts`| version compare edge cases, live x prepared x TestFlight x publishing x failed x pending, the exact scenario of the 2026-11-26 report, scope     |

If the wiring test fails: read state with `appStateStore.of(...)` (`apps/web/src/lib/app-state/app-state-store.svelte.ts`), never from
`publishingStore`, `cartSummaryStore`, `pendingStore.summary`, `pipelineStore.app` or `nextStepTrains` directly. The release flow itself
(`next-step.ts`, `release-trains.ts`, `play-promote.ts`, `candidates.ts`) is internal to the model: no file outside `lib/app-state/` may import
them (wiring test, with the few address-parsing exceptions listed there with a reason).

## 3b. Consistency contract (two surfaces that show one fact must show one value)

The model (section 2) removes the disagreements; this section is what keeps them removed. It has five parts and they share one vocabulary: a
FACT is a named value about an app (`pendingCount`, `liveVersion:<record>`, `imageCount:<locale>/<device>`, `blockerCount`, ...), a SURFACE is a
place that shows facts, and a surface is described by a pure function `project(world)` that returns the facts it shows.

### The parts

| Part                    | Files                                                                                                                 | What it does                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Component guard (R1-R7) | `apps/web/scripts/component-guard/{scan,cli}.ts`, `app-state/component-guard.{test.ts,allowlist.json}`                | AST scan of every `.svelte` and component `.ts` file (script and template expressions); a violation that is not on the allowlist fails the test                     |
| Server guard (S1-S2)    | `apps/server/src/server-guard{,-cli}.ts`, `server-guard.{test.ts,allowlist.json}`                                     | the same for the server: no literal limits or TTLs, no cache outside the registry                                                                                  |
| Consistency harness     | `app-state/{consistency-world,projections,consistency-report}.ts`, `consistency.test.ts`, `consistency.expected.json` | one fixture world per scenario, every surface projected from it; two surfaces that show one fact with different values are a disagreement                           |
| Server contract         | `apps/server/src/modules/publish/state-contract.{test.ts,expected.json}`                                              | the same stored state read through the cart, the summary, the per app view, the staged view, the alert evaluator, last publish and readiness                        |
| Dev monitor             | `app-state/dev-assert.ts`                                                                                             | `reportShown(factKey, value, surfaceId)`: development only; `console.error` when two surfaces on screen show one fact differently; `window.__kilnConsistency()`    |

Every list is SHRINK-ONLY. An allowlist entry or an expected disagreement can be removed at any time; adding one is a decision that needs a
reason, and a stale entry (one that no longer matches) fails the test, so a fix cannot be forgotten.

### Rules of the component guard

| Rule | Name                          | What it flags                                                                                                                                                              |
| ---- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | no-fact-read-in-component     | a component that calls a state-bearing endpoint of `api` (the list `READ_FACT_ENDPOINTS` in `scan.ts`): facts arrive through the model, not through a component's own fetch |
| R2   | no-own-cache-or-clock         | `readCache`, `new Map`/`WeakMap`, module-level cache names, `Date.now()` and `setInterval` for freshness: caches and clocks belong to the registry (`facts/invalidate.ts`) |
| R3   | no-literal-limits             | a count compared with a limit literal (8, 10, 30, 80, 100, 170, 500, 2000, 4000, 8192), `8 * MiB`, a `maxlength` that is a store limit, an import of a limit table         |
| R4   | no-own-version-logic          | comparing, sorting or parsing versions, picking the live or latest release, computing obsolete versions: versions come from the one owner in `@kiln/core`                   |
| R5   | no-own-counts-over-facts      | `.filter(...).length`, `.reduce` or `.length` in a template over a fact collection (items, locales, sets, releases, blockers); read the fact the model already counted    |
| R6   | no-direct-listing-image-reads | `getLiveListing`, `getDrift`, `appListingLive`, `appListingDrift`, `checkStoreImages`, `stalledApps`: one owner reads these                                                  |
| R7   | no-low-level-store-imports    | an import of a `*-store`, `nav-signals`, `cart-summary`, `cart-button`, `cart-preview` or `store-cache` module outside `lib/app-state/`                                     |

Server: S1 no literal limit or TTL in a store-fact module (use `packages/core/src/timings.ts` or the owning limit table); S2 no module-level or
cache-named `new Map`/`WeakMap` and no `timedCache(` outside `services/cache-registry.ts` and `timed-cache.ts` (every cache declares its events).

An allowlist entry is keyed by file, rule and a hash of the whitespace-normalised snippet, and has a `count`. Name-based rules (R1, R4, R6,
R7) count one per name per file. Moving code around does not make an entry stale; editing the flagged expression does (and that is when to
migrate it).

### The burn-down

```
cd apps/web
node scripts/component-guard/cli.ts            # the allowlist grouped by domain (images | releases | listing | state) and rule, with counts
node scripts/component-guard/cli.ts --files    # every file and snippet
node scripts/component-guard/cli.ts --check    # what the test checks; exit 1 on a new violation or a stale entry
node scripts/component-guard/cli.ts --prune    # after a migration: drop the entries that no longer match (never adds one)
node --import ./src/lib/i18n/test-setup.ts scripts/consistency/cli.ts            # the disagreement table by domain
node --import ./src/lib/i18n/test-setup.ts scripts/consistency/cli.ts --prune   # drop expected disagreements that are fixed
cd ../server
node --disable-warning=ExperimentalWarning src/server-guard-cli.ts --prune       # the same for S1 and S2
```

The domain of an entry is where its owner works: `images`, `releases`, `listing`, or `state` (counts, pending, caches, store imports). Migrating
a component to read a model fact removes its entries: run `--prune` and commit the smaller JSON together with the change. In Wave 3 the
allowlists are emptied and `"strict": true` is set in `component-guard.allowlist.json`: then any entry is ignored and every violation fails.
Do not add an entry to make a test pass; if the code is right and the rule is wrong, change the rule in `scan.ts` and say why in the commit.

`consistency.expected.json` and `state-contract.expected.json` work the same way: the test passes while the list is exactly the current
disagreements. A NEW disagreement fails ("fix it, or add it with a note"), a disagreement that stops failing fails ("delete the entry"), and a
changed value fails. Each entry has a `note` that says which definition is wrong.

### How to add a surface

A new screen that shows a fact from the model needs two things: it reads the fact from the model (`appStateStore.of(...)` or a function of
`lib/app-state/`), and it is registered in `projections.ts`:

1. Add an entry to `SURFACES` in `app-state/projections.ts`: `id`, `components` (the files), `mirrors` (`file:line` of each piece of logic that
   the projection copies when it cannot call the component's function directly, so a reader knows what to replace), and `project(world)`,
   which returns an object of fact keys to values using the same helpers the component uses. Where the component computes the value itself,
   call the helper it calls, never a re-implementation.
2. Run `consistency.test.ts`. A surface that shows a fact another surface shows differently makes the test list a new disagreement; that is the
   point: the fix is in the model function both call, not in the projection.
3. `consistency.test.ts` also fails for a surface that returns nothing in every scenario (a dead projection) and for a fact key that is not in
   `FACTS`.

### How to add a fact

1. Add a family to `FACTS` in `projections.ts` (`pendingCount`, `liveVersion`, ...). A key with a suffix (`liveVersion:ios-1`,
   `imageCount:en-US/ipad_13`) is one value per record; surfaces that show different records do not conflict. A list value is compared as a set.
2. Return it from every `project(world)` that shows it; give the model ONE function that computes it.
3. If the world fixture cannot express the situation, add a scenario to `SCENARIOS` in `consistency-world.ts`: plain data (`World`): apps,
   releases, builds, pending views, staged views, store images, readiness. The 11 scenarios cover the reports so far (phased release over an
   obsolete TestFlight build, iPad 10+2 and 8+4 sibling sets, a staged removal that is already pushed, a failed run with blockers that are
   resolved now, a Google Play draft being promoted, a locale with empty texts, a cart against a view, release notes in five places).
4. On the server, add the fact as a key of `read()` in `state-contract.test.ts` with one entry per endpoint that states it, and a scenario that
   creates the stored state.

### The dev monitor

In a component that has just been migrated, `reportShown('pendingCount', n, 'topBar')` (in an `$effect`, or where the number is rendered) tells
the monitor what this surface shows now. In production it is a no-op (`import.meta.env.DEV` is false). In development it compares, once per
tick, every value shown under one fact key by different surfaces, logs `console.error` with both values and both surface ids once per distinct
conflict, and exposes `window.__kilnConsistency()` (`{ latest, conflicts, disagreeingNow }`) to read in the console, in an e2e test or in a
screenshot script. It is not wired into components yet: wire it as each one is migrated, with the same surface id as in `SURFACES`.

## 4. Migration status

Migrated (they read `appStateStore` and decide nothing themselves): the top bar button, the Shell (sidebar badges, switcher chips, workspace
Pending count), AppShell, the app Overview card (`NextStep`, `StartRelease`), the cart (`PendingCart`, `PendingCartDrawer`), the Pending page
(`PendingChanges`), the workspace Pending page (`WorkspacePending`), `PendingChip`, `PublishingNote`, the board, the portfolio Overview
(rows and their next action), the releases table and its row detail (promote), and the buttons that write: `SubmitReady`, `StoreRelease`,
`CreateVersion`, `RolloutAppControl`, `StagedTrayApp`.

Not migrated, on purpose or not yet:

- Board cards and the portfolio rows still word their release state from the releases they load (a draft is "preparing"); they do not
  mention candidates, and the Shell's sidebar badge of "left unfinished" apps filters left-behind stalls from the pipeline and builds only
  (not from the releases of every app, which that screen does not load). The overview tile and the app Overview/Releases cards are on the model.
- `StoreRelease` and the release row detail do not word candidates; the Android Promote headline is unchanged (the Promote line of the card).

- The CONTENT of the Pending page (the list of items, their previews, their "next step" text, the `totalsLine`) comes from `pendingStore`
  views. It is what is listed, not what the app is doing, so it is not a state of the app; but it is a second count of items that can differ
  from the cart count for a moment. The page re-reads a view that is older than the summary and disagrees (`appStateStore.staleViews`).
- `publishAvailability` (PendingChanges) still words the reasons "no right", "switch off", "errors block" from the views and the config; the
  model's `publish` verdict decides the running-publish and failed-publish cases, and the page enables the button only when both agree.
  The reasons for role and switch exist twice (model: `verdict.role`, `verdict.switchOff`).
- `ReleaseStepper` and `AiSuggestionCard` still call `pendingStore.view/loadView/refresh`: they refresh content, they decide nothing.
- `PublishDialog` reports its own publish to the claims store (`started`, `answered`, `refresh`): it writes, it does not read back to decide.
  It is on the wiring allowlist for that reason.
- The server is unchanged: it still answers 409 `publish_in_progress` as the last line of defence; the model makes the client never ask.

Every allowlist entry of `wiring.test.ts` has its reason next to it, and a stale entry fails the test.
