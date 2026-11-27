import type { Api } from '../api.ts';
import type { ReleaseSettingsView } from '../release-settings.ts';

/**
 * The release settings of each app, a read of our own database (no store is contacted). A failed read leaves nothing: the screens then
 * offer the share as they always did. A read that started before a newer one arrived is dropped.
 */
let views = $state<Record<string, ReleaseSettingsView | undefined>>({});
const generations: Record<string, number> = {};

export const releaseSettingsStore = {
  get(appId: string): ReleaseSettingsView | null {
    return views[appId] ?? null;
  },
  async load(api: Api, workspaceId: string, appId: string): Promise<void> {
    const mine = (generations[appId] = (generations[appId] ?? 0) + 1);
    try {
      const out = await api.appReleaseSettings(workspaceId, appId);
      if (mine === generations[appId] && out && out.settings) views[appId] = out;
    } catch {
      // Not readable (an older server, a role without the right): the share is asked as before.
    }
  },
  set(appId: string, view: ReleaseSettingsView): void {
    generations[appId] = (generations[appId] ?? 0) + 1;
    views[appId] = view;
  },
};
