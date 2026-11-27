/**
 * Every time to live, freshness window and liveness threshold that the server and the browser must AGREE on, in one place.
 *
 * Why this file exists: the same fact used to be cached or judged in two or three places, each with its own copy of the number (a 30
 * second readiness on the server and another 30 in the browser, a 60 second silence on the server and 45 in the browser...). Two copies
 * drift, and then two screens disagree about the same thing. A number that two parts of the app depend on lives here, with the
 * relation to the others stated in code (a derived constant, or a compile-time check below), never as a second literal.
 *
 * Times are milliseconds, named `*_MS`, unless the name says otherwise. Pure: no imports, no clock.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

// ---------------------------------------------------------------------------------------------
// What a store holds (the reads of the App Store Connect / Google Play APIs)

/**
 * The server keeps the last read of what the store holds for an app (its images, `modules/listing/store-images.ts`) this long. A staged
 * change does not drop it; a push, a sync and a "Read again" do (the cache registry event `store_read` / `sync` / `publish`).
 */
export const STORE_VIEW_TTL_MS = MINUTE;

/**
 * The server keeps the answer to "what blocks a submit now" (`GET /apps/:id/publish/readiness`) this long. It reads the same store as the
 * images view, so it is never longer-lived than it (checked below).
 */
export const CURRENT_READINESS_TTL_MS = 30 * SECOND;

/**
 * The browser reuses a readiness reading this long (`app-state/readiness-store`). DERIVED from the server's value: a reading the browser
 * holds is never older than what the server would itself serve, so the two cannot show different ages of the same read.
 */
export const READINESS_FRESH_MS = CURRENT_READINESS_TTL_MS;

/**
 * Younger than this, a browser that comes back to the Graphics tab does not ask for the images again (stale while revalidate,
 * `lib/assets/store-cache.ts`). Shorter than the server's view TTL on purpose: the server would answer from its cache anyway.
 */
export const GRAPHICS_FRESH_MS = 20 * SECOND;

/**
 * The browser's default time to keep a page read (`lib/read-cache.ts`: pipeline, candidates, editable draft, live listing, asset
 * comparison). DERIVED from the server's store view TTL so that a page never holds a store read longer than the server does.
 */
export const READ_CACHE_TTL_MS = STORE_VIEW_TTL_MS;

/**
 * The browser keeps the store builds of an app (`app-state/store-builds-store`) this long. Longer than the server's artifact list on
 * purpose (a build list changes rarely and every read costs a store call); `build_changed` and `sync` drop it at once when it does.
 */
export const STORE_BUILDS_READ_TTL_MS = 2 * MINUTE;

/** The shell's app list (`lib/nav-signals`) is read again when older than this and somebody asks. Same as the page read cache. */
export const APP_LIST_MAX_AGE_MS = READ_CACHE_TTL_MS;

// ---------------------------------------------------------------------------------------------
// Builds

/** The server keeps a list of build artifacts (CI artifacts, TestFlight groups) this long (`modules/builds/service.ts`). */
export const BUILD_LIST_TTL_MS = 30 * SECOND;

/** The server keeps the reason a build list could not be read this long, so a broken credential is not asked again every request. */
export const BUILD_PROBLEM_TTL_MS = MINUTE;

/**
 * Lazy build reads (`modules/builds/facts.ts`): when the builds of an app are listed and downloads are on, the server reads the build
 * number inside up to `BUILD_AUTO_READ_BATCH` of the newest unread CI artifacts in the background, so a build gets its version name and
 * its DATE without anybody pressing "Read build info from CI". At most one batch per app every `BUILD_AUTO_READ_PAUSE_MS`, a failed
 * download included, so a broken artifact is not downloaded on every page view.
 */
export const BUILD_AUTO_READ_BATCH = 3;
export const BUILD_AUTO_READ_PAUSE_MS = 5 * MINUTE;

// ---------------------------------------------------------------------------------------------
// Images, notes, proposals

/**
 * An opaque image ref (what a client holds instead of a store address) is known to the server this long after the read that made it.
 * Much longer than the view that produced it, because a page that shows images does not read again for a while; but the cache registry
 * also drops an app's refs with its view (`store_read`, `sync`, `publish`): a ref never outlives a read the server threw away.
 */
export const IMAGE_REF_TTL_MS = 15 * MINUTE;

/** The last release notes of the store (and the app's own) are kept this long (`services/notes-history.ts`). */
export const NOTES_HISTORY_TTL_MS = 10 * MINUTE;

/** The summary of a repository's asset proposal ("N changes proposed") is kept this long (`modules/listing/asset-proposal-summary.ts`). */
export const PROPOSAL_SUMMARY_TTL_MS = 10 * MINUTE;

/** An opened repository (its asset index per commit) is shared between requests this long (`modules/listing/asset-repo.ts`). */
export const ASSET_REPO_OPENED_TTL_MS = 30 * SECOND;

// ---------------------------------------------------------------------------------------------
// Publishing liveness

/** A batch that has not renewed its heartbeat for this long is a process that died (its claim runs out). */
export const PUBLISH_CLAIM_TTL_MS = 2 * MINUTE;

/** How often a running batch renews its heartbeat, also while one step waits for the store. */
export const PUBLISH_HEARTBEAT_MS = 20 * SECOND;

/**
 * A publish that has been silent this long (no heartbeat) is shown as "the server has not reported for ..." and a person may end it.
 * ONE value for the server and the browser: the browser used to say "quiet" after 45 seconds while the server only let a person end the
 * claim after 60, so for 15 seconds the row warned of a problem nobody could act on. The server's 60 is the one kept.
 */
export const PUBLISH_SILENT_AFTER_MS = MINUTE;

/** A publish that has run this long is shown as stuck and may be ended even when it still beats (a step is cut at 8 minutes). */
export const PUBLISH_STUCK_AFTER_MS = 15 * MINUTE;

/** How often the browser asks which publishes are running (the claims) while the tab is visible, hidden, and at the slowest back-off. */
export const PUBLISH_POLL_VISIBLE_MS = 5 * SECOND;
export const PUBLISH_POLL_HIDDEN_MS = 30 * SECOND;
export const PUBLISH_POLL_MAX_MS = MINUTE;
