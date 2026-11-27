/**
 * Module-level `new Map` that is NOT a cache of a fact: a lookup table built once, a lock, work in flight, a per-process memory of a
 * write. Every other module-level Map must be registered (`registerMapCache(<name>, ...)`, services/cache-registry.ts).
 *
 * Key: `<file>:<variable>`; value: WHY it is not a cache (required, non-empty: the server guard and cache-registry.test.ts fail on an
 * empty reason and on an entry whose Map no longer exists).
 */
export const NOT_A_CACHE: Record<string, string> = {
  'mcp/prompts.ts:promptByName': 'static lookup table',
  'mcp/tool-defs.ts:registry': 'static lookup table',
  'mcp/tools.ts:toolByName': 'static lookup table',
  'i18n/runtime.ts:rulesCache': 'Intl.PluralRules per locale: static data',
  'i18n/catalogs.ts:cache': 'message catalogs: static files',
  'modules/alerts/catalog.ts:byId': 'static lookup table',
  'modules/ci/active.ts:inFlight': 'work in flight (single flight), empty when it ends',
  'modules/ci/active.ts:trouble': 'back-off memory of repositories that failed: a rate-limit state, not a read of a fact',
  'modules/builds/service.ts:inFlight': 'work in flight (single flight), empty when it ends',
  'modules/listing/asset-proposal-summary.ts:inflight': 'work in flight (single flight)',
  'modules/ci/service.ts:lastAttempt': 'polling clock per repository (rate limit), not a read',
  'modules/ci/service.ts:lastSuccess': 'polling clock per repository (rate limit), not a read',
  'modules/ci/service.ts:refreshing': 'work in flight (single flight)',
  'modules/ci/service.ts:runEtags': 'ETag of the last runs read: makes the next read conditional, never served',
  'modules/ci/service.ts:runPageIds': 'run ids of that same conditional read',
  'modules/ci/service.ts:jobsInFlight': 'work in flight (single flight)',
  'services/repositories.ts:recordedCommits': 'dedupes a write of the last commit, not a read',
  'services/events.ts:listeners': 'subscribers of the event stream',
  'services/sync-pipeline.ts:lanes': 'concurrency lanes (semaphores)',
  'modules/aso/net.ts:inflight': 'work in flight (single flight) of one outbound store call, empty when it ends',
  'modules/listing/sources.ts:cache': 'a memo of the files read during ONE readListings call: dies with the call, never served to another',
  'services/app-icons.ts:inflight': 'work in flight (single flight), empty when it ends',
  'services/sync-pipeline.ts:active': 'running sync feeds (live state of this process)',
};
