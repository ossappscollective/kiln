/**
 * The limits and lifetimes the server applies to store facts and requests: counts, sizes and TTLs that were literals in server modules.
 * One number, one owner (the server guard S1 forbids a literal limit in a server module); the browser reads the same names where it needs them.
 */

/** Moved from modules/builds/service.ts. */
export const BUILD_LINK_TTL_MS = 10 * 60_000;

/** More media files than this in a target are not listed. */
export const ASSET_MAX_LISTED = 2000;

/** Moved from modules/listing/asset-proposal-summary.ts. */
export const PROPOSAL_SUMMARY_MAX_ENTRIES = 500;

/** Moved from modules/listing/asset-pull.ts. */
export const ASSET_MAX_PULL_MS = 120_000;

/** Largest file the file route serves, in bytes. Bigger files are listed and refused (413). */
export const ASSET_MAX_SERVED_BYTES = 8 * 1024 * 1024;

/** Moved from modules/listing/live.ts. */
export const LISTING_LIVE_ERROR_MAX_CHARS = 500;

/** Moved from modules/listing/routes.ts. */
export const LISTING_MAX_PULL_LOCALES = 100;

/** Moved from modules/listing/schedule.ts. */
export const SCHEDULE_MAX_DEFERRALS = 10;

/** Header probes (pixel size and length of images whose store gives neither): at most this many per read, this many at once. */
export const IMAGE_PROBE_MAX_PER_READ = 80;

/** Moved from modules/planning/plan-reminders.ts. */
export const PLAN_REMINDERS_MAX_PER_RUN = 100;

/** Moved from modules/planning/release-pipeline.ts. */
export const PIPELINE_MAX_RUNS_READ = 2000;

/** Moved from modules/planning/release-watch.ts. */
export const RELEASE_WATCH_MAX_EVENTS_PER_RUN = 100;

/** Most images per side in a graphics detail. */
export const CART_DETAIL_IMAGES_MAX = 30;

/** Moved from modules/publish/staged-release.ts. */
export const RELEASE_MAX_CODES_SHOWN = 10;

/** Longer than the timeout, so a claim is never trusted less than the write it guards can still run. */
export const STORE_CALL_CLAIM_TTL_MS = 300_000;

/** The longest sentence of the server's own that is kept next to it. */
export const STORE_FAILURE_MESSAGE_MAX_CHARS = 500;

/** The least time between two lines of "what the step is doing" written to the claim (a screen polls every few seconds). */
export const PUBLISH_DETAIL_THROTTLE_MS = 2_000;

/** Moved from modules/testflight/routes.ts. */
export const TESTFLIGHT_MAX_PAGE = 100;

/** New submissions of one kind that raise an alert each; more raise one grouped alert. */
export const TESTFLIGHT_MAX_EVENTS_PER_KIND_PER_SYNC = 10;

/** Moved from modules/testflight/store.ts. */
export const TESTFLIGHT_NOTE_MAX_CHARS = 2000;

/** Moved from modules/timeline/events.ts. */
export const TIMELINE_MAX_EVENTS_PER_APP = 500;

/** Moved from services/apps.ts. */
export const SYNC_ERROR_MAX_CHARS = 500;

/** The most places listed per text. */
export const NOTES_HISTORY_MAX_USES_PER_NOTE = 10;

/** Moved from services/repo-snapshot.ts. */
export const REPO_SNAPSHOT_TTL_MS = 5 * 60_000;

/** Moved from services/repositories.ts. */
export const REPOSITORY_MAX_WARM_PATHS = 2000;

/** Moved from services/smtp-client.ts. */
export const SMTP_MAX_REPLY_LINES = 100;

/** Moved from services/step-up.ts. */
export const STEP_UP_LOCKOUT_MAX_MS = 15 * 60_000;

/** The longest a gate holds every request of a host after one 429. A longer Retry-After is still passed on to the caller. */
export const SYNC_MAX_COOLDOWN_MS = 120_000;

/** Moved from services/text-merge.ts. */
export const TEXT_MERGE_DEFAULT_MAX_EDITS = 2000;

/** Moved from services/tokens.ts. */
export const TOKENS_MAX_ACTIVE = 100;

/** Moved from services/two-factor.ts. */
export const TWO_FACTOR_EMAIL_CODE_TTL_MS = 10 * 60_000;

/** Moved from services/webauthn.ts. */
export const WEBAUTHN_MAX_CBOR_DEPTH = 8;

/** Moved from services/webhooks.ts. */
export const WEBHOOK_MAX_DELIVERIES_LIMIT = 100;

/** Moved from modules/listing/store-images.ts. */
export const IMAGE_PROBE_CACHE_MAX = 4000;

/** Moved from modules/timeline/events.ts. */
export const TIMELINE_NOTE_MAX_CHARS = 500;

/** Moved from services/notes-history.ts. */
export const NOTES_HISTORY_MAX_LIMIT = 100;

/** Moved from services/step-up.ts. */
export const STEP_UP_CHALLENGE_TTL_MS = 2 * 60_000;

/** Moved from services/two-factor.ts. */
export const TWO_FACTOR_LOGIN_CHALLENGE_TTL_MS = 5 * 60_000;

/** Moved from modules/listing/store-images.ts. */
export const IMAGE_REF_MAX = 4000;

/** Moved from services/notes-history.ts. */
export const NOTES_HISTORY_DEFAULT_LIMIT = 30;

/** Moved from services/step-up.ts. */
export const STEP_UP_MAX_PASSKEYS = 10;

/** Moved from services/step-up.ts. */
export const STEP_UP_GRANT_TTL_MS = 5 * 60_000;

/** The runs of a repository read for the builds of an app (one page). */
export const BUILD_RUNS_READ_LIMIT = 100;

/** `Retry-After` of the 429 a build download answers while other downloads are still running. */
export const BUILD_BUSY_RETRY_AFTER_SECONDS = 10;

/** A local clone reads from disk: the most files an asset index lists from one. */
export const ASSET_LOCAL_CLONE_MAX_FILES = 2000;

/** The largest request body of an upload route (screenshots, asset files): 8 MiB. */
export const UPLOAD_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/** Pushed items that differ from the draft, listed one by one before the rest is counted ("N more pushed items differ"). */
export const STORE_SUBMIT_MAX_DIFFERS_SHOWN = 30;

/** The longest `build` / `version` filter a TestFlight list accepts. */
export const TESTFLIGHT_FILTER_MAX_CHARS = 100;

/** The Play search terms listed in a summary. */
export const PLAY_SEARCH_TERMS_SUMMARY_LIMIT = 10;

/** The longest login challenge token the server looks up (`lgc_...`). */
export const LOGIN_CHALLENGE_TOKEN_MAX_CHARS = 100;

/** A secret shorter than this is not scrubbed out of a stored webhook response (it would blank ordinary text). */
export const REDACT_MIN_SECRET_CHARS = 8;

/** Builds whose number is read in the background per app and page view (see `BUILD_AUTO_READ_PAUSE_MS` of the timings). */
export const BUILD_AUTO_READ_BATCH = 3;
