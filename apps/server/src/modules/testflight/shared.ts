import {
  AppleTestFlightFeedbackConnector,
  appleScope,
  connectorFactory,
  type StoreConnectorInput,
  type StoreTestFlightFeedbackConnector,
} from '@kiln/connectors';
import type { Database } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';
import { type Failure, failure } from '../../services/repositories.ts';

/**
 * What the sync, the reads and the triage of TestFlight feedback share (docs/adr/0049-testflight-feedback.md). Reading is the whole of the store
 * side: nothing here writes to Apple. The credential, the timeout and the way a store refusal becomes an answer are the ones of the in-app
 * products (modules/monetization/shared.ts), which this module imports.
 */

/** The purposes recorded when a credential is used (the audit row `credential.use`). */
export const TESTFLIGHT_SYNC_PURPOSE = 'testflight.sync';
export const TESTFLIGHT_SCREENSHOT_PURPOSE = 'testflight.screenshots';
/** A sync reads two lists, the versions of a few builds and some crash logs: it can take a while. */
export const DEFAULT_TESTFLIGHT_SYNC_TIMEOUT_MS = 120_000;
export const DEFAULT_TESTFLIGHT_READ_TIMEOUT_MS = 30_000;
/** Crash logs read by one sync (newest first); the rest wait for the next one. */
export const MAX_CRASH_LOGS_PER_SYNC = 40;
/** New submissions of one kind that raise an alert each; more raise one grouped alert. */
export const MAX_EVENTS_PER_KIND_PER_SYNC = 10;

export type TestflightConnectorInput = StoreConnectorInput;
/** Null for a store with no such API (Google Play): the service refuses before it asks for one. */
export type TestflightConnectorFactory = (
  input: TestflightConnectorInput,
) => StoreTestFlightFeedbackConnector | null;

export const defaultTestflightConnectorFactory: TestflightConnectorFactory = connectorFactory<
  StoreTestFlightFeedbackConnector | null
>({
  app_store_connect: (input) =>
    AppleTestFlightFeedbackConnector.fromSecret(input.secret, {
      appStoreId: input.storeAppId ?? '',
      scope: appleScope(input),
      fetch: input.fetch,
    }),
  google_play: () => null,
});

export type TestflightContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** The per workspace budget of syncs: the one of the app sync. */
  limiter: TestLimiter;
  readFactory: TestflightConnectorFactory;
  readTimeoutMs: number;
};

export const notSupportedFailure = (): Failure =>
  failure(
    422,
    'testflight_not_supported',
    'The store of this app has no TestFlight feedback API. Only App Store Connect apps (iOS and macOS) have it.',
    coded('testflight.unsupported'),
  );

export const feedbackNotFoundFailure = (): Failure =>
  failure(404, 'not_found', 'No such feedback.', coded('testflight.notFound'));

export const assigneeNotMemberFailure = (): Failure =>
  failure(
    422,
    'assignee_not_member',
    'The assignee is not a member of this workspace.',
    coded('testflight.assigneeNotMember'),
  );

export const rateLimitedBody = (wait: number) => ({
  error: 'rate_limited',
  message: `Too many syncs. Try again in ${wait} seconds.`,
  ...coded('sync.tooManySyncs', { count: wait }),
  retryAfterSeconds: wait,
});
