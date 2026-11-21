import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import { createTranslateDraft } from '../../services/translation.ts';
import type { ServerModule } from '../module.ts';
import { type ReviewRoutesContext, reviewRoutes } from './routes.ts';
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  defaultReviewConnectorFactory,
  type RatingFetcher,
  type ReviewConnectorFactory,
} from './sync.ts';
import { reviewTranslationRoutes } from './translation-routes.ts';

/**
 * Customer reviews (docs/api/reviews.md), read-only. `connectorFactory` builds the App Store
 * Connect / Google Play reviews connector (overridable for tests), `ratingFetcher` the store-wide
 * rating (null turns it off), `timeoutMs` the longest one sync may run (default 90 seconds).
 * `limiter` defaults to the one of the app syncs. `retentionDays` (KILN_REVIEW_RETENTION_DAYS) is
 * only shown to people; the pruning is the scheduler's.
 */
export type ReviewsDeps = {
  connectorFactory?: ReviewConnectorFactory;
  ratingFetcher?: RatingFetcher | null;
  timeoutMs?: number;
  limiter?: TestLimiter;
  lowRatingThreshold?: number;
  retentionDays?: number;
  /**
   * Replying to reviews, a store write that is OFF unless `enabled` (KILN_REVIEW_REPLY_ENABLED).
   * `connectorFactory` builds the connector that can reply (fakes in tests), `translateDraft` is
   * the optional seam for translating a draft (wired to services/translation.ts by the lead).
   */
  reply?: NonNullable<ReviewRoutesContext['reply']>;
};

// Customer reviews: an inbox with internal triage. Replying (a store write) is off unless KILN_REVIEW_REPLY_ENABLED.
export const reviewsModule: ServerModule<ReviewsDeps> = {
  id: 'reviews',
  mount(app, services, deps, shared) {
    // Translation of stored reviews is mounted first, so its paths are never read as a review id.
    app.route(
      '/api/workspaces',
      reviewTranslationRoutes({
        db: services.db,
        masterKey: services.masterKey,
        now: services.now,
        ...shared.translation,
        limiter: shared.translationLimiter ?? createTestLimiter({ now: services.now, limit: 20 }),
      }),
    );
    app.route(
      '/api/workspaces',
      reviewRoutes({
        db: services.db,
        masterKey: services.masterKey,
        now: services.now,
        connectorFactory: deps?.connectorFactory ?? defaultReviewConnectorFactory,
        ...(deps?.ratingFetcher !== undefined ? { ratingFetcher: deps.ratingFetcher } : {}),
        timeoutMs: deps?.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
        ...(deps?.lowRatingThreshold !== undefined
          ? { lowRatingThreshold: deps.lowRatingThreshold }
          : {}),
        ...(deps?.retentionDays !== undefined ? { retentionDays: deps.retentionDays } : {}),
        // Reply drafts can be translated with the workspace's translation provider, unless a test supplies its own.
        ...(deps?.reply
          ? {
              reply: {
                ...deps.reply,
                translateDraft:
                  deps.reply.translateDraft ??
                  createTranslateDraft({
                    db: services.db,
                    masterKey: services.masterKey,
                    now: services.now,
                    ...shared.translation,
                  }),
              },
            }
          : {}),
        translation: shared.translation,
        limiter: deps?.limiter ?? shared.appSyncLimiter,
      }),
    );
  },
};
