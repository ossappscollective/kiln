import { alertOperations } from '../modules/alerts/operations.ts';
import { analyticsOperations } from '../modules/analytics/operations.ts';
import { asoOperations } from '../modules/aso/operations.ts';
import { searchTermsOperations } from '../modules/aso/search-terms-operations.ts';
import { buildsOperations } from '../modules/builds/operations.ts';
import { ciOperations } from '../modules/ci/operations.ts';
import { listingOperations } from '../modules/listing/operations.ts';
import { reviewsOperations } from '../modules/reviews/operations.ts';
import { aiOperations } from './ai.ts';
import { mcpOperations } from './mcp.ts';
import { plansOperations } from './plans.ts';
import { pendingOperations } from './pending.ts';
import { releasesOperations } from './releases.ts';
import { repositoriesOperations } from './repositories.ts';
import { rolloutOperations } from './rollout.ts';
import { stagedChangesOperations } from './staged-changes.ts';
import { submitOperations } from './submit.ts';
import type { Draft } from './shared.ts';
import { stepUpOperations } from './step-up.ts';
import { storeVersionOperations } from './store-version.ts';
import { twoFactorOperations } from './two-factor.ts';
import { workspaceOperations } from './workspace.ts';
import type { Operation } from './openapi.ts';

/**
 * The registry: every operation of the API that is documented, with the permission it needs and
 * the risk it carries. It feeds `GET /api/openapi.json` and decides which routes an API token may
 * call (bearer.ts): a route that is not listed here is reachable with a session cookie only.
 *
 * Request bodies for the routes that existed before this file mirror the schemas in their route
 * files (they are not exported). Where a route's body or answer is large or still moving, the
 * operation says `partial` and describes only what is stable. Each feature keeps its operations next to its routes
 * (`modules/<id>/operations.ts`); the rest are in `services/operations/`. The tests check that every listed
 * operation exists in the app and that the permission listed here is the one the route enforces.
 */

const drafts: Draft[] = [
  ...workspaceOperations,
  ...repositoriesOperations,
  ...ciOperations,
  ...plansOperations,
  ...reviewsOperations,
  ...asoOperations,
  ...searchTermsOperations,
  ...listingOperations,
  ...stagedChangesOperations,
  ...submitOperations,
  ...rolloutOperations,
  ...releasesOperations,
  ...pendingOperations,
  ...storeVersionOperations,
  ...buildsOperations,
  ...aiOperations,
  ...analyticsOperations,
  ...alertOperations,
  ...stepUpOperations,
  ...twoFactorOperations,
  ...mcpOperations,
];

export const operations: readonly Operation[] = drafts.map((d) => ({ ...d, tags: d.tags ?? [] }));
