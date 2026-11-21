import type { Database } from '@kiln/db';
import { sendDueDigests } from './digest.ts';
import { runAlertEvaluator } from './evaluator.ts';
import { pruneAlerts } from './inbox.ts';

/**
 * What the scheduler runs for alerts (scheduler.ts, option `alerts`): the state evaluator, the due digests, and once an hour the
 * pruning of old alerts. Alerts only read what the app already stores and write alerts; they never call a store.
 */

/** Minutes between passes. State conditions are minutes-old news at worst; the digests are hourly at best. */
export const ALERT_PASS_INTERVAL_MS = 5 * 60_000;

export function createAlertRunner(options: {
  db: Database;
  now?: (() => number) | undefined;
  onError?: ((message: string, error: unknown) => void) | undefined;
}) {
  const now = options.now ?? Date.now;
  let lastPrune = 0;
  return {
    async run() {
      const at = now();
      const evaluated = await runAlertEvaluator(options.db, at, { onError: options.onError });
      const digests = await sendDueDigests(options.db, at);
      let pruned: { alerts: number; deliveries: number } | undefined;
      if (at - lastPrune >= 60 * 60_000) {
        lastPrune = at;
        pruned = await pruneAlerts(options.db, at);
      }
      return { evaluated, digests, ...(pruned ? { pruned } : {}) };
    },
  };
}
