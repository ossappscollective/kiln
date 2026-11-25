import {
  AppleExperimentsConnector,
  appleScope,
  connectorFactory,
  type StoreConnectorInput,
  type StoreExperimentsConnector,
} from '@kiln/connectors';
import type { Database } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';
import { type Failure, failure } from '../../services/repositories.ts';

/**
 * What the sync, the reads and the manual tracker of store experiments share (docs/adr/0048-store-experiments.md). Reading is the whole of the
 * store side: nothing here writes to a store. The credential, the timeout and the way a store refusal becomes an answer are the ones of the
 * in-app products (modules/monetization/shared.ts), which this module imports.
 */

/** The purpose recorded when a credential is used (the audit row `credential.use`). */
export const EXPERIMENTS_SYNC_PURPOSE = 'experiments.sync';
/** A sync reads two lists and, per item, a few resources: it can take a while. */
export const DEFAULT_EXPERIMENTS_SYNC_TIMEOUT_MS = 150_000;

export type ExperimentsConnectorInput = StoreConnectorInput;
/** Null for a store with no API for experiments (Google Play): the service refuses before it asks for one. */
export type ExperimentsConnectorFactory = (
  input: ExperimentsConnectorInput,
) => StoreExperimentsConnector | null;

export const defaultExperimentsConnectorFactory: ExperimentsConnectorFactory =
  connectorFactory<StoreExperimentsConnector | null>({
    app_store_connect: (input) =>
      AppleExperimentsConnector.fromSecret(input.secret, {
        appStoreId: input.storeAppId ?? '',
        scope: appleScope(input),
        fetch: input.fetch,
      }),
    google_play: () => null,
  });

export type ExperimentsContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** The per workspace budget of syncs: the one of the app sync. */
  limiter: TestLimiter;
  readFactory: ExperimentsConnectorFactory;
  readTimeoutMs: number;
};

export const MAX_NOTES_PER_APP = 200;

export const notSupportedFailure = (): Failure =>
  failure(
    422,
    'experiments_not_supported',
    'The store of this app has no API for experiments or custom pages. Use the manual tracker and the links to its console.',
    coded('experiments.unsupported'),
  );

export const noteNotFoundFailure = (): Failure =>
  failure(404, 'note_not_found', 'No such note.', coded('experiments.noteNotFound'));

export const tooManyNotesFailure = (): Failure =>
  failure(
    409,
    'too_many_notes',
    `An app can have ${MAX_NOTES_PER_APP} notes. Delete one first.`,
    coded('experiments.tooManyNotes', { limit: MAX_NOTES_PER_APP }),
  );
