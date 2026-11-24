import type { RunState } from './sync-sources.ts';

/**
 * The state of the header's sync pieces (SyncButton, Status popover, "Updated X ago") belongs to ONE focused app. These two helpers keep it so
 * when the address moves to another app without the component being recreated (docs/ux-ia.md "Sync is per page"). Pure; no DOM.
 */

/** `scopeKey` names what the readings are for: the workspace and the ids of the records in scope. */
export const scopeKey = (workspaceId: string, appIds: readonly string[]): string => `${workspaceId}|${appIds.join(',')}`;

/**
 * A race guard keyed on the scope. `begin(key)` starts a read and says whether the scope changed (then the old readings must be dropped now, not
 * when the new ones arrive); `accepts(token)` is false for every read that is not the latest, so a late answer of the app left behind is ignored.
 */
export function createReadingsScope(): { begin: (key: string) => { token: number; changed: boolean }; accepts: (token: number) => boolean } {
  let current = '';
  let latest = 0;
  return {
    begin(key) {
      const changed = key !== current;
      current = key;
      latest += 1;
      return { token: latest, changed };
    },
    accepts: (token) => token === latest,
  };
}

/** The runs of the given apps only (`runs` is keyed `appId:kind` and is kept for the whole page): a run of another app is not this app's. */
export function runsOfApps(runs: Readonly<Record<string, RunState | undefined>>, appIds: readonly string[]): Record<string, RunState | undefined> {
  const out: Record<string, RunState | undefined> = {};
  for (const [key, state] of Object.entries(runs)) {
    const at = key.indexOf(':');
    if (at > 0 && appIds.includes(key.slice(0, at))) out[key] = state;
  }
  return out;
}
