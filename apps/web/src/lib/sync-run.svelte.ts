import { type RunState, type SyncKind, type SyncPlanEntry, runActive, runStates } from './sync-sources.ts';

/**
 * The run of the header's Sync, as the Status popover shows it: per app record and kind, queued, running, done, failed or skipped. One instance
 * for the page; the shell writes it, the popover reads it. Memory only.
 */
class SyncRun {
  runs = $state<Record<string, RunState>>({});

  get active(): boolean {
    return runActive(this.runs);
  }

  /** The app sync ran directly: `kind: 'app'` is its own entry. */
  set(appId: string, kind: SyncKind, state: RunState): void {
    this.runs = { ...this.runs, [`${appId}:${kind}`]: state };
  }

  /** The server's plan and the browser's kinds of one record. */
  plan(appId: string, plan: readonly SyncPlanEntry[], extra: Partial<Record<SyncKind, RunState>>): void {
    this.runs = { ...this.runs, ...runStates(appId, plan, extra) };
  }

  /** Everything the server queued is over (the queue drained): what was queued is done. */
  settle(): void {
    const next: Record<string, RunState> = {};
    for (const [key, state] of Object.entries(this.runs)) next[key] = state === 'queued' || state === 'running' ? 'done' : state;
    this.runs = next;
  }

  clear(): void {
    this.runs = {};
  }
}

export const syncRun = new SyncRun();
