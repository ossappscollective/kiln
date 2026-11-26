# The state model (what is true about an app, in one place)

Status: the model and its store are in `apps/web/src/lib/app-state/`. This page has three parts: the inventory of what decided or
showed app state before the model (the audit that led to it), the model itself (phases, priority rules, invariants), and how it is
enforced by tests.

## 1. Inventory (before the model)

Every place in `apps/web/src` that decided or displayed app or workspace state, or offered a state-dependent action. "Count" is which
number the place showed. The columns "Reads" and "Derives" are what it did by itself; that duplication is what produced the
inconsistencies (a failed publish that the top bar, the Next step card and the promote button each saw differently).

### Reads and stores

| Source | What it holds | Endpoint |
| --- | --- | --- |
| `cartSummaryStore` (`cart-summary*.ts`) | pending CART count per app record (stored changes, the "29") | `GET /pending/cart-summary` |
| `pendingStore` (`pending-store.svelte.ts`) | pending VIEW per app (`lineOfView`: actionable / waiting / blocking), workspace summary (`lineFor`), batch switch | `GET /pending/summary`, `GET /apps/{id}/pending`, publish config |
| `publishingStore` (`publishing*.ts`) | publishing claims, the latest run that did not complete, dismissals | `GET /pending/publishing`, `POST .../runs/{id}/dismiss` |
| `pipelineStore` | release pipeline per app (trains) and workspace summary (stalled releases) | `GET /apps/{id}/release-pipeline`, summary |
| `stagedStore`, `submitStore`, `releaseStore` | staged content, "pushed draft waits for submit", store release state | `.../staged`, `.../store-submit`, `.../store-release` |
| `navSignals` | apps, releases by app, unanswered reviews, insight counts | several |
| `cartButton` | UI plumbing of the top bar button (count, visible, press) written by `PendingCart` | none (written by a component) |
| page reads | `AppShell` release lists, `AppDashboard` builds, drift, plans, reviews | per app |

### Surfaces (before)

| Surface | File | Count it showed | Publishing / failure | Derived by itself | Actions it enabled |
| --- | --- | --- | --- | --- | --- |
| Top bar button | `PendingCartButton`, `Shell`, `cart-button` | rows of the per-app cart (`PendingCart.rows`) | publishing only; NO failure | `visible`, `busy` | open drawer |
| Next step card | `NextStep`, `next-step.ts`, `nextStepTrains` | none (a link text from `lineFor`) | publishing banner only; NO failure | trains from `pipelineStore`, `canStart`, `canPrepare`, `off()` | Start release, Prepare, train buttons, Promote |
| Overview page | `AppDashboard` (`pending` prop from `AppShell`) | `lineFor` count (actionable items) | none | attention items incl. "staged not pushed" (a 3rd count) | none |
| App header strip | `AppShell` (`pendingBar`, `pendingPlacement`) | `lineFor` count | none | bar text, placement | link to pending |
| Releases page | `AppReleases`, `NextStep`, `ReleaseTable`, `ReleaseRowDetail` | none | publishing on Promote in the detail only (the table link had no guard) | `promoteOption(s)` per row | Promote (table link, detail button) |
| Prepare release | `ReleaseStepper`, `CreateVersion`, `StoreRelease`, `StepBuild`, `StepNotes`, `PlayCheck` | none | `publishingStore.isPublishing` | `publishingNow` | create version, release |
| Submit | `SubmitReady`, `StagedTrayApp` | none | `publishingStore.isPublishing` | `publishingNow`, availability | submit, push draft, clear |
| Rollout | `RolloutAppControl`, `Rollout` | none | `publishingStore.isPublishing` | `publishingNow` | rollout steps |
| Pending drawer | `PendingCart`, `PendingCartDrawer` | `rows.length` of ALL records (not the platform scope) | claims and failures per member | `publishing`, `failures`, `visible` | publish, review, discard, dry run |
| Pending page | `PendingChanges` | views (`lineOfView`) | claims and failures per member | `publishing`, `failures`, `availability` | review and publish, discard |
| Workspace pending | `WorkspacePending`, `Shell` nav entry | cart summary total | claims and failures | `pendingRows`, `pendingTotals` | none |
| Sidebar badges | `Shell` `appCounts`, `nav-badges` | `lineFor` count | none | pending, blocking | none |
| App switcher chips | `Shell` `switcherList`, `PendingChip`, `chipFor` | `lineFor` count | none | chip text and tone | none |
| Portfolio overview, Board | `Portfolio`, `app-overview`, `Board` | `lineFor` count | none | rows | none |
| Platform switch | `AppShell` (`resolveScope`) | scopes some counts, not others (cart rows were not scoped) | n/a | `scoped` | none |
| Connect callouts, expo notice | `connect/*`, `ExpoOverviewCard` | n/a (about credentials, a repository, Expo) | n/a | own conditions | link |
| Notifications bell | `AlertBell`, `alerts/store` | n/a (the user's alert inbox, not app state) | n/a | unread | none |

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
- `app-state-store.svelte.ts`: the one rune store. It reads the facts once and exposes the derived state.

### Phases and priority

For the platforms in scope, the first row that applies wins:

| # | Phase | When | Primary action | Secondary |
| --- | --- | --- | --- | --- |
| 1 | `publishing` | a publish claim exists for a record in scope | `show_pending` | none |
| 2 | `publish_failed` | the latest run did not complete and was not dismissed (and no newer publish runs) | `show_pending` | `publish_again` |
| 3 | `changes_pending` | the pending count in scope is above 0 | `show_pending` ("Review and publish") | the release step of the flow, `publish_again` is not offered |
| 4 | `release_needs_you` | a release failed, was rejected, or waits for a person | the train's button (`attach_build`, `open_release`) | Promote when offered |
| 5 | `in_review` | a release waits on the store | `follow_review` | |
| 6 | `release_running` | a release waits on CI | `open_release` | |
| 7 | `ready_to_release` | nothing in flight, a release can be started or prepared | `start_release` or `prepare_release` | |
| 8 | `idle` | nothing to do and no right to start | `none` | |

"Nothing is waiting for you" is only ever said by phases 7 and 8, which need: no publish running, no undismissed failure, a pending
count of 0 in scope. That is how the Next step card can no longer say it while 29 changes wait.

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

`deriveTopBar` returns `idle | pending(count) | publishing | failed(count)`. Priority: the open app publishing, then another app of the
workspace publishing (the button follows it), then a failure in scope, then pending in scope. It never shows `idle` while the card
says something is pending, because both read the same `AppState`.

## 3. Enforcement (so it cannot regress)

| Test | File | What fails it |
| --- | --- | --- |
| Exhaustive invariants | `app-state/derive.test.ts` | any combination of pending x publishing x last run x release x scope x role that breaks an invariant |
| Named scenarios | `app-state/scenarios.test.ts` | the user's failing scenario and the other incidents (drawer 0 vs 29, count kept after publish, iOS shown on Android, promote while publishing) |
| Source wiring | `app-state/wiring.test.ts` | a component outside the allowlist that imports a low-level state source or computes `disabled` from a raw state fact |
| Action registry | `app-state/surfaces.test.ts` | an action of the closed enum that a surface does not handle (a dead button) |

If the wiring test fails: read state with `appStateStore.of(...)` (`apps/web/src/lib/app-state/app-state-store.svelte.ts`), never from
`publishingStore`, `cartSummaryStore`, `pendingStore.summary`, `pipelineStore.app` or `nextStepTrains` directly.

## 4. Migration status

Migrated (they read `appStateStore` and decide nothing themselves): the top bar button, the Shell (sidebar badges, switcher chips, workspace
Pending count), AppShell, the app Overview card (`NextStep`, `StartRelease`), the cart (`PendingCart`, `PendingCartDrawer`), the Pending page
(`PendingChanges`), the workspace Pending page (`WorkspacePending`), `PendingChip`, `PublishingNote`, the board, the portfolio Overview
(rows and their next action), the releases table and its row detail (promote), and the buttons that write: `SubmitReady`, `StoreRelease`,
`CreateVersion`, `RolloutAppControl`, `StagedTrayApp`.

Not migrated, on purpose or not yet:

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
