import { coded } from '../../i18n/problem.ts';
import { type Failure, failure, isTimeoutError, withTimeout } from '../../services/repositories.ts';

/**
 * A time limit for a read that compares the repository with the store (the Assets step of Prepare release: `GET assets/diff` and
 * `GET release/asset-proposal`). Each repository call already has its own limit, but a comparison makes several (the store, the index,
 * up to 60 file reads), so without one limit for the whole a slow repository could keep the request open for many minutes and the
 * page showed "comparing" for ever. After the limit the person gets `504 compare_timeout` (translated, retryable); the work that was
 * started finishes in the background and its index is cached, so asking again is usually quick.
 */
export const COMPARE_DEADLINE_MS = 25_000;

/** The limit of `POST release/asset-proposal/stage`: it recomputes the proposal and reads the repository for every graphics set it stages. */
export const STAGE_DEADLINE_MS = 45_000;

/** The time the item loop of a staging request may run before the items still waiting are answered `failed` / `stage_timeout`. */
export const STAGE_BUDGET_MS = 35_000;

/** The time the proposal that answers a staging request (what is left now) may take; without it the client reads the card again. */
export const AFTER_STAGE_DEADLINE_MS = 15_000;

/** The time the checksum reads of one comparison may take before the remaining files are compared by size only. */
export const CHECKSUM_BUDGET_MS = 12_000;

export async function withinDeadline<T>(work: Promise<T>, ms: number = COMPARE_DEADLINE_MS): Promise<T | Failure> {
  try {
    return await withTimeout(work, ms);
  } catch (error) {
    if (!isTimeoutError(error)) throw error;
    return failure(504, 'compare_timeout', 'The comparison took too long. Try again.', coded('assets.compareTimeout'));
  }
}

/** The same for staging: the answer says that some items may be staged already (the card reads again to show which). */
export async function withinStageDeadline<T>(work: Promise<T>, ms: number = STAGE_DEADLINE_MS): Promise<T | Failure> {
  try {
    return await withTimeout(work, ms);
  } catch (error) {
    if (!isTimeoutError(error)) throw error;
    return failure(504, 'stage_timeout', 'Staging took too long. Some items may be staged already. Check the card and try again.', coded('assetProposal.stageTimeout'));
  }
}
